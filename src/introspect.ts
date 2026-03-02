import { log } from "./logger.js";
import { getConnection } from "./nats.js";
import { getActiveSession } from "./knight.js";
import type { KnightConfig } from "./config.js";
import type { Subscription } from "nats";
import { StringCodec } from "./nats.js";

const sc = StringCodec();

interface IntrospectRequest {
  type: "stats" | "recent" | "tree";
  limit?: number;
}

const startTime = Date.now();
let sub: Subscription | null = null;

export function startIntrospect(config: KnightConfig): void {
  const nc = getConnection();
  if (!nc) {
    log.warn("Cannot start introspect — NATS not connected");
    return;
  }

  const subject = `fleet-a.introspect.${config.knightName}`;
  sub = nc.subscribe(subject);
  log.info("Introspect responder started", { subject });

  (async () => {
    for await (const msg of sub) {
      try {
        let req: IntrospectRequest = { type: "stats" };
        try {
          req = JSON.parse(sc.decode(msg.data));
        } catch {
          // default to stats
        }

        const response = handleIntrospect(req, config);
        msg.respond(sc.encode(JSON.stringify(response)));
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.error("Introspect error", { error: errMsg });
        msg.respond(sc.encode(JSON.stringify({ error: errMsg })));
      }
    }
  })();
}

export function handleIntrospect(req: IntrospectRequest, config: KnightConfig): unknown {
  const session = getActiveSession();

  if (!session) {
    return {
      knight: config.knightName,
      session: null,
      runtime: {
        uptime: Math.floor((Date.now() - startTime) / 1000),
        activeTasks: 0,
        model: config.knightModel,
      },
    };
  }

  switch (req.type) {
    case "stats":
      return buildStats(config);
    case "recent":
      return buildRecent(config, req.limit ?? 20);
    case "tree":
      return buildTree(config);
    default:
      return { error: `Unknown introspect type: ${(req as any).type}` };
  }
}

function buildStats(config: KnightConfig) {
  const session = getActiveSession()!;
  const stats = session.getSessionStats();

  return {
    knight: config.knightName,
    session: {
      sessionId: stats.sessionId,
      userMessages: stats.userMessages,
      assistantMessages: stats.assistantMessages,
      toolCalls: stats.toolCalls,
      totalMessages: stats.totalMessages,
      tokens: {
        input: stats.tokens.input,
        output: stats.tokens.output,
        total: stats.tokens.total,
      },
      cost: stats.cost,
    },
    runtime: {
      uptime: Math.floor((Date.now() - startTime) / 1000),
      activeTasks: 0,
      model: config.knightModel,
    },
  };
}

function buildRecent(config: KnightConfig, limit: number) {
  const session = getActiveSession()!;
  const entries = session.sessionManager.getEntries();
  const recent = entries.slice(-limit);

  const items = recent.map((entry) => {
    const base: Record<string, unknown> = {
      id: entry.id,
      parentId: entry.parentId,
      type: entry.type,
      timestamp: entry.timestamp,
    };

    if (entry.type === "message") {
      const msg = entry.message;
      base.role = msg.role;

      if (msg.role === "user" || msg.role === "assistant") {
        const content = msg.content;
        if (typeof content === "string") {
          base.text = content.slice(0, 500);
        } else if (Array.isArray(content)) {
          // Collect all text blocks, then generate separate entries for tool_use/tool_result
          const textParts: string[] = [];
          const toolEntries: Record<string, unknown>[] = [];

          for (const block of content) {
            if (typeof block === "object" && block !== null) {
              if ("text" in block && typeof block.text === "string") {
                textParts.push(block.text);
              }
              if ("type" in block && (block as any).type === "tool_use") {
                toolEntries.push({
                  id: `${entry.id}-tu-${(block as any).id ?? toolEntries.length}`,
                  parentId: entry.parentId,
                  type: "tool_use",
                  timestamp: entry.timestamp,
                  role: msg.role,
                  toolName: (block as any).name,
                  input: JSON.stringify((block as any).input ?? {}).slice(0, 500),
                });
              }
              if ("type" in block && (block as any).type === "tool_result") {
                toolEntries.push({
                  id: `${entry.id}-tr-${toolEntries.length}`,
                  parentId: entry.parentId,
                  type: "tool_result",
                  timestamp: entry.timestamp,
                  role: msg.role,
                  toolName: (block as any).tool_use_id,
                  output: JSON.stringify((block as any).content ?? "").slice(0, 500),
                });
              }
            }
          }

          if (textParts.length > 0) {
            base.text = textParts.join("\n").slice(0, 500);
          }
          // Attach extra entries for tool blocks (picked up after map)
          if (toolEntries.length > 0) {
            (base as any)._extraEntries = toolEntries;
          }
        }
      }

      // Extract usage/cost if present
      if ("usage" in msg && msg.usage) {
        const u = msg.usage as any;
        base.tokens = { input: u.inputTokens ?? 0, output: u.outputTokens ?? 0 };
      }
      if ("cost" in msg && typeof msg.cost === "number") {
        base.cost = msg.cost;
      }
    }

    return base;
  });

  // Flatten: expand _extraEntries into the items list
  const flatItems: Record<string, unknown>[] = [];
  for (const item of items) {
    flatItems.push(item);
    if ((item as any)._extraEntries) {
      flatItems.push(...(item as any)._extraEntries);
      delete (item as any)._extraEntries;
    }
  }

  return {
    knight: config.knightName,
    entries: flatItems,
    total: entries.length,
    returned: items.length,
  };
}

function buildTree(config: KnightConfig) {
  const session = getActiveSession()!;
  const tree = session.sessionManager.getTree();

  function simplifyNode(node: { entry: any; children: any[]; label?: string }) {
    const entry = node.entry;
    const base: Record<string, unknown> = {
      id: entry.id,
      parentId: entry.parentId,
      type: entry.type,
      timestamp: entry.timestamp,
      childrenCount: node.children.length,
    };

    if (node.label) base.label = node.label;

    // Brief summary
    if (entry.type === "message" && entry.message) {
      const msg = entry.message;
      let text = "";
      if (typeof msg.content === "string") {
        text = msg.content.slice(0, 100);
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (typeof block === "object" && block !== null && "text" in block) {
            text = (block.text as string).slice(0, 100);
            break;
          }
        }
      }
      base.summary = `${msg.role}: ${text}`;
    } else {
      base.summary = entry.type;
    }

    return base;
  }

  // Flatten tree to simplified nodes (one level of children info)
  function flattenTree(nodes: any[]): any[] {
    const result: any[] = [];
    for (const node of nodes) {
      result.push(simplifyNode(node));
      if (node.children.length > 0) {
        result.push(...flattenTree(node.children));
      }
    }
    return result;
  }

  return {
    knight: config.knightName,
    nodes: flattenTree(tree),
    totalNodes: flattenTree(tree).length,
  };
}
