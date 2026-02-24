import {
  connect as natsConnect,
  type NatsConnection,
  type JetStreamClient,
  type JetStreamManager,
  type ConsumerMessages,
  StringCodec as NatsStringCodec,
  AckPolicy,
  DeliverPolicy,
} from "nats";
import { log } from "./logger.js";
import type { KnightConfig } from "./config.js";

const sc = NatsStringCodec();

// Re-export StringCodec for tools
export { NatsStringCodec as StringCodec };

export interface ParsedTask {
  task: string;
  taskId: string;
  domain?: string;
  from?: string;
  dispatchedBy?: string;
  timestamp?: string;
  timeoutMs?: number;
}

let nc: NatsConnection | null = null;
let js: JetStreamClient | null = null;
let consumer: ConsumerMessages | null = null;
let connected = false;

// --- Accessors for custom tools ---
export function getConnection(): NatsConnection | null { return nc; }
export function getJetStream(): JetStreamClient | null { return js; }

export function getStatus(): { connected: boolean } {
  return { connected };
}

export async function connectNats(config: KnightConfig): Promise<void> {
  log.info("Connecting to NATS", { url: config.natsUrl });

  nc = await natsConnect({
    servers: config.natsUrl,
    name: `pi-knight-${config.knightName}`,
    reconnect: true,
    maxReconnectAttempts: -1,
    reconnectTimeWait: 2000,
  });

  connected = true;
  log.info("NATS connected");

  // Monitor connection status
  (async () => {
    if (!nc) return;
    for await (const status of nc.status()) {
      if (status.type === "disconnect" || status.type === "error") {
        connected = false;
        log.warn("NATS disconnected", { type: status.type });
      } else if (status.type === "reconnect") {
        connected = true;
        log.info("NATS reconnected");
      }
    }
  })();

  js = nc.jetstream();
}

export async function subscribe(config: KnightConfig): Promise<AsyncIterable<ParsedTask>> {
  if (!nc || !js) throw new Error("NATS not connected");

  const jsm: JetStreamManager = await nc.jetstreamManager();

  // Create/bind durable consumer
  const durableName = `${config.knightName}-consumer`;
  const filterSubjects = config.subscribeTopics;

  // Reconcile durable consumer — delete and recreate if config differs.
  // NATS does not allow updating deliver_policy or ack_policy on existing consumers,
  // so we compare the full config and recreate if anything changed.
  const desiredConfig = {
    durable_name: durableName,
    filter_subjects: filterSubjects,
    ack_policy: AckPolicy.Explicit,
    deliver_policy: DeliverPolicy.New,
    max_deliver: 1,
    ack_wait: (config.taskTimeoutMs + 60_000) * 1_000_000, // task timeout + 60s buffer, in nanoseconds
  };

  try {
    const existing = await jsm.consumers.info("fleet_a_tasks", durableName);
    const existingFilters = existing.config.filter_subjects ??
      (existing.config.filter_subject ? [existing.config.filter_subject] : []);
    const desiredFilters = [...filterSubjects].sort();
    const currentFilters = [...existingFilters].sort();

    const expectedAckWait = (config.taskTimeoutMs + 60_000) * 1_000_000;
    const needsRecreate =
      JSON.stringify(currentFilters) !== JSON.stringify(desiredFilters) ||
      existing.config.deliver_policy !== DeliverPolicy.New ||
      existing.config.max_deliver !== 1 ||
      existing.config.ack_wait !== expectedAckWait;

    if (needsRecreate) {
      log.warn("Consumer config mismatch — recreating", {
        durable: durableName,
        reason: {
          filters: JSON.stringify(currentFilters) !== JSON.stringify(desiredFilters),
          deliverPolicy: existing.config.deliver_policy !== DeliverPolicy.New,
          maxDeliver: existing.config.max_deliver !== 1,
          ackWait: existing.config.ack_wait !== expectedAckWait,
        },
      });
      await jsm.consumers.delete("fleet_a_tasks", durableName);
      log.info("Old consumer deleted", { durable: durableName });
    } else {
      log.info("Consumer config matches — reusing", { durable: durableName, filters: currentFilters });
    }
  } catch {
    // Consumer doesn't exist yet — will be created below
    log.info("No existing consumer found, creating new", { durable: durableName });
  }

  await jsm.consumers.add("fleet_a_tasks", desiredConfig);
  log.info("Consumer ready", { durable: durableName, filters: filterSubjects });

  consumer = await js.consumers.get("fleet_a_tasks", durableName).then((c) => c.consume());

  // Return an async iterable that yields parsed tasks
  const msgs = consumer!;
  return {
    async *[Symbol.asyncIterator]() {
      for await (const msg of msgs) {
        // Immediate ack — at-most-once delivery
        msg.ack();

        const raw = sc.decode(msg.data);
        const subject = msg.subject;
        const subjectParts = subject.split(".");
        const subjectTaskId = subjectParts[subjectParts.length - 1] ?? "unknown";

        let parsed: ParsedTask;
        try {
          const json = JSON.parse(raw);
          parsed = {
            task: json.task ?? json.description ?? json.message ?? raw,
            taskId: json.task_id ?? json.taskId ?? subjectTaskId,
            domain: json.domain,
            from: json.from ?? json.payload?.from,
            dispatchedBy: json.dispatched_by ?? json.dispatchedBy,
            timestamp: json.timestamp,
            timeoutMs: json.metadata?.timeout_ms ?? json.metadata?.timeoutMs,
          };
        } catch {
          // Not JSON — treat entire payload as task text
          parsed = {
            task: raw,
            taskId: subjectTaskId,
          };
        }

        // Reject empty/missing task text — don't waste an LLM call on nothing
        if (!parsed.task || parsed.task.trim().length === 0) {
          log.warn("Empty task payload — skipping", { taskId: parsed.taskId, subject, rawLength: raw.length });
          continue;
        }

        log.info("Task received", { taskId: parsed.taskId, subject });
        yield parsed;
      }
    },
  };
}

export async function publishResult(
  taskId: string,
  result: Record<string, unknown>,
): Promise<void> {
  if (!js) throw new Error("NATS not connected — cannot publish result");

  const subject = `fleet-a.results.${taskId}`;
  const data = sc.encode(JSON.stringify(result));
  await js.publish(subject, data);
  log.info("Result published", { taskId, subject });
}

export async function drain(): Promise<void> {
  if (consumer) {
    await consumer.close();
  }
  if (nc) {
    await nc.drain();
    connected = false;
    log.info("NATS drained");
  }
}
