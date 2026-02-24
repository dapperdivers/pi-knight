# NATS Integration

> Native NATS JetStream integration for task dispatch and knight-to-knight collaboration.

## Architecture

Pi-Knight communicates exclusively via NATS JetStream:

```
Tim (orchestrator)
  │
  ├─ nats pub fleet-a.tasks.security.<id> ──→ Galahad
  ├─ nats pub fleet-a.tasks.finance.<id>  ──→ Percival
  └─ nats pub fleet-a.tasks.career.<id>   ──→ Lancelot
                                                │
                                          fleet-a.results.<id>
                                                │
                                          ──→ Tim (or any subscriber)
```

## Custom Tools

NATS is registered as **native Pi SDK tools** — agents call them directly in the tool loop, no shell scripts needed.

### `nats_publish`

Fire-and-forget message to any NATS subject.

```
Tool: nats_publish
Params:
  subject: "fleet-a.tasks.security.my-task"
  message: '{"task": "Analyze CVE-2026-1234", "task_id": "my-task"}'
```

Use for: broadcasting events, sending notifications, out-of-band messaging.

**Do NOT use for task results** — those are published automatically by the runtime.

### `nats_request`

Send a task to another knight and wait for their response. This is the **branch-and-wait** pattern for cross-knight collaboration.

```
Tool: nats_request
Params:
  knight: "percival"
  domain: "finance"
  task: "What is the estimated financial impact of the Conduent breach?"
  timeout_ms: 600000  (optional, default 10 min)
```

Flow:
1. Generates unique task ID
2. Subscribes to `fleet-a.results.<task-id>` for the response
3. Publishes task to `fleet-a.tasks.<domain>.<task-id>`
4. Blocks the calling agent's tool loop until response arrives
5. Returns the response text — agent continues with that context

Use for: asking another knight a question, delegating subtasks, gathering cross-domain expertise.

## Task Message Format

```json
{
  "task": "Analyze the latest npm supply chain attacks",
  "task_id": "galahad-xreq-1708732800000-abc123",
  "domain": "security",
  "dispatched_by": "knight",
  "timestamp": "2026-02-23T18:00:00.000Z",
  "metadata": {
    "timeout_ms": 600000
  }
}
```

## Result Message Format

```json
{
  "task_id": "galahad-xreq-1708732800000-abc123",
  "knight": "galahad",
  "success": true,
  "result": "Analysis text...",
  "duration_ms": 45000,
  "cost": 0.12,
  "tokens": { "input": 5000, "output": 2000 },
  "model": "anthropic/claude-sonnet-4-5",
  "tool_calls": 3,
  "timestamp": "2026-02-23T18:00:45.000Z"
}
```

## JetStream Configuration

- **Task stream**: `fleet_a_tasks` — subjects `fleet-a.tasks.>`
- **Result stream**: `fleet_a_results` — subjects `fleet-a.results.>`
- **Consumer**: `<knight-name>-consumer` (durable, per-knight)
- **Ack policy**: Explicit, immediate ack (at-most-once delivery)
- **Max deliver**: 1 (no redelivery — tasks are acked before execution)

## Session Persistence

Knights maintain **persistent sessions** across tasks. When a knight processes multiple tasks, it retains context from previous work. Pi SDK handles auto-compaction when context grows too large.

Session data persists to `/data` (PVC) as JSONL files, surviving pod restarts.
