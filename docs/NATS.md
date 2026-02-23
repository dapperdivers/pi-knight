# NATS Integration

> Asynchronous task dispatch and result delivery via NATS JetStream.

## Overview

Knights receive tasks and publish results through NATS JetStream. Tim (orchestrator) publishes tasks to knight-specific subjects; knights consume, execute, and publish results.

## Topology

```
Tim (Orchestrator)                    NATS JetStream                     Knights
─────────────────                    ───────────────                     ───────
                                    ┌──────────────┐
  nats pub ──────────────────────►  │ fleet_a_tasks │  ──────────────►  Galahad
  fleet-a.tasks.security.*         │   Stream      │                   (security)
                                    │               │
  nats pub ──────────────────────►  │  Subjects:    │  ──────────────►  Percival
  fleet-a.tasks.finance.*          │  fleet-a.     │                   (finance)
                                    │  tasks.>      │
  nats pub ──────────────────────►  │               │  ──────────────►  Lancelot
  fleet-a.tasks.career.*           │               │                   (career)
                                    └──────────────┘
                                                                           │
                                    ┌──────────────┐                       │
  ◄──────────────────────────────── │fleet_a_results│  ◄───────────────────┘
  (collect results)                 │   Stream      │   nats pub
                                    └──────────────┘   fleet-a.results.*
```

## Streams

### `fleet_a_tasks`
- **Subjects:** `fleet-a.tasks.>`
- **Retention:** WorkQueue (each message consumed once)
- **Max Deliver:** 1 (no redelivery — immediate ack pattern)
- **Storage:** File

### `fleet_a_results`
- **Subjects:** `fleet-a.results.>`
- **Retention:** Limits (results kept for collection)
- **Storage:** File

## Subject Conventions

### Task Subjects
```
fleet-a.tasks.<domain>.<task-id>
```
- `domain` = knight's area (security, finance, career, infra, home, research, vault)
- `task-id` = unique identifier (e.g., `security-1771813755-33254`)

### Result Subjects
```
fleet-a.results.<task-id>
```

## Consumer Configuration

Each knight creates a **durable consumer** on the `fleet_a_tasks` stream:

```json
{
  "durable_name": "<knight-name>-consumer",
  "filter_subject": "fleet-a.tasks.<domain>.>",
  "ack_policy": "explicit",
  "max_deliver": 1,
  "ack_wait": "30s"
}
```

## Message Format

### Task Message (JSON)
```json
{
  "task": "Analyze the latest CVE advisories and produce a threat briefing",
  "task_id": "security-1771813755-33254",
  "domain": "security",
  "dispatched_by": "tim",
  "timestamp": "2026-02-23T15:00:00Z",
  "metadata": {
    "priority": "normal",
    "timeout_ms": 1800000
  }
}
```

### Result Message (JSON)
```json
{
  "task_id": "security-1771813755-33254",
  "knight": "galahad",
  "success": true,
  "result": "## Threat Briefing\n\n...",
  "duration_ms": 45000,
  "cost": 0.54,
  "tokens": {
    "input": 12000,
    "output": 8500
  },
  "model": "anthropic/claude-sonnet-4-5",
  "timestamp": "2026-02-23T15:00:45Z"
}
```

## Implementation Requirements

### Startup
1. Connect to NATS server (`nats://nats.database.svc.cluster.local:4222`)
2. Bind to JetStream
3. Create/bind durable consumer with filter for knight's domain
4. Begin message loop

### Task Processing
1. Receive message from JetStream
2. **Immediately ack** (at-most-once delivery — prevents redelivery during long tasks)
3. Parse task payload
4. Execute via Pi agent loop (with timeout from `metadata.timeout_ms` or default)
5. Collect result (agent's final output)
6. Publish result to `fleet-a.results.<task-id>`
7. Log completion with duration, cost, token counts

### Error Handling
- Task execution failures → publish error result (success: false, error message in result)
- NATS connection loss → reconnect with backoff (nats.ws handles this)
- Agent timeout → AbortController kills the task, publishes timeout error

### Health Check
- NATS connection status exposed via HTTP health endpoint
- Periodic ping to verify JetStream availability
- Consumer lag monitoring (how many pending messages)

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `NATS_URL` | NATS server URL | `nats://nats.database.svc.cluster.local:4222` |
| `SUBSCRIBE_TOPICS` | Comma-separated subjects to consume | Required |
| `KNIGHT_NAME` | Knight identifier for result publishing | Required |
| `TASK_TIMEOUT_MS` | Default task timeout | `1800000` (30 min) |

## Connection Details

- **Server:** `nats.database.svc.cluster.local:4222`
- **Protocol:** NATS (not WebSocket — pod-to-pod within cluster)
- **Auth:** None (cluster-internal, network policy restricted)
- **Client:** `nats` npm package (not `nats.ws` — that's for browser/external)
