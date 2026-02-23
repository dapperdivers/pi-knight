# Observability

> Structured logging, metrics, cost tracking, and health monitoring for knight agents.

## Overview

Every knight must be observable. In a multi-agent system, you need to know: what's running, how long it took, what it cost, and whether it's healthy. Pi-Knight provides three pillars of observability.

## 1. Structured Logging

All logs are JSON, compatible with Loki/Promtail ingestion on the dapper-cluster.

### Log Format
```json
{
  "level": 30,
  "time": 1771813756000,
  "pid": 1,
  "hostname": "galahad-56f4d46d9b-9qrwl",
  "knight": "galahad",
  "taskId": "security-1771813755-33254",
  "msg": "Task completed",
  "duration_ms": 45000,
  "cost": 0.54,
  "model": "anthropic/claude-sonnet-4-5",
  "tokens": { "input": 12000, "output": 8500 }
}
```

### Log Levels
| Level | Use |
|-------|-----|
| `error` (50) | Task failures, NATS disconnections, unrecoverable errors |
| `warn` (40) | Task timeouts, retry attempts, degraded state |
| `info` (30) | Task received, task completed, NATS connected, health checks |
| `debug` (20) | Tool calls, skill activation, LLM request/response metadata |

### Key Events to Log
- `nats.connected` — NATS connection established
- `nats.disconnected` — NATS connection lost
- `nats.reconnected` — NATS connection restored
- `task.received` — Task message consumed from JetStream
- `task.acked` — Message acknowledged (before execution)
- `task.started` — Pi agent loop invoked
- `task.tool_call` — Individual tool invocation (name, duration)
- `task.skill_activated` — Skill matched and loaded
- `task.completed` — Task finished (success, duration, cost, tokens)
- `task.failed` — Task errored (error message, stack trace)
- `task.timeout` — Task exceeded timeout limit
- `health.check` — Periodic health status

## 2. Prometheus Metrics

Expose metrics on `/metrics` endpoint (HTTP, same port as health check).

### Metric Definitions

```prometheus
# Task execution
pi_knight_tasks_total{knight="galahad",status="success"} 42
pi_knight_tasks_total{knight="galahad",status="error"} 3
pi_knight_tasks_total{knight="galahad",status="timeout"} 1

# Task duration (histogram)
pi_knight_task_duration_seconds_bucket{knight="galahad",le="10"} 5
pi_knight_task_duration_seconds_bucket{knight="galahad",le="30"} 15
pi_knight_task_duration_seconds_bucket{knight="galahad",le="60"} 30
pi_knight_task_duration_seconds_bucket{knight="galahad",le="300"} 40
pi_knight_task_duration_seconds_bucket{knight="galahad",le="1800"} 42
pi_knight_task_duration_seconds_sum{knight="galahad"} 4523.7
pi_knight_task_duration_seconds_count{knight="galahad"} 42

# LLM cost tracking
pi_knight_llm_cost_dollars_total{knight="galahad",model="claude-sonnet-4-5"} 23.47

# Token usage
pi_knight_tokens_total{knight="galahad",direction="input"} 504000
pi_knight_tokens_total{knight="galahad",direction="output"} 357000

# Tool usage
pi_knight_tool_calls_total{knight="galahad",tool="bash"} 120
pi_knight_tool_calls_total{knight="galahad",tool="read"} 89
pi_knight_tool_calls_total{knight="galahad",tool="web_fetch"} 45

# NATS health
pi_knight_nats_connected{knight="galahad"} 1
pi_knight_nats_messages_received_total{knight="galahad"} 46
pi_knight_nats_messages_published_total{knight="galahad"} 42

# Concurrency
pi_knight_active_tasks{knight="galahad"} 1
pi_knight_max_concurrent_tasks{knight="galahad"} 2
```

### Grafana Dashboard

With these metrics, a Grafana dashboard can show:
- Tasks per knight over time (throughput)
- Error rate per knight (reliability)
- P50/P95/P99 task duration (performance)
- Cumulative cost per knight (economics)
- Token usage trends (efficiency)
- Active tasks vs capacity (utilization)
- NATS consumer lag (backpressure)

## 3. Health Checks

HTTP health endpoint for Kubernetes liveness and readiness probes.

### Endpoints

#### `GET /health` — Liveness
Returns 200 if the process is alive. Used by Kubernetes liveness probe.

```json
{
  "status": "ok",
  "uptime_seconds": 86400,
  "knight": "galahad"
}
```

#### `GET /ready` — Readiness
Returns 200 if NATS is connected and the agent is ready to accept tasks. Returns 503 if degraded.

```json
{
  "status": "ready",
  "nats": "connected",
  "consumer": "galahad-consumer",
  "pending_messages": 0,
  "active_tasks": 1,
  "max_concurrent": 2,
  "model": "anthropic/claude-sonnet-4-5",
  "skills_loaded": 8
}
```

#### `GET /metrics` — Prometheus
Prometheus-format metrics scrape endpoint.

### Kubernetes Probe Configuration
```yaml
livenessProbe:
  httpGet:
    path: /health
    port: 3000
  initialDelaySeconds: 10
  periodSeconds: 30
readinessProbe:
  httpGet:
    path: /ready
    port: 3000
  initialDelaySeconds: 15
  periodSeconds: 10
```

## 4. Cost Tracking

Pi's `pi-ai` layer provides built-in cost tracking per LLM call. Pi-Knight aggregates this per task.

### Per-Task Cost
Every task result includes:
- Total cost (input tokens × rate + output tokens × rate)
- Token breakdown (input, output, cache read, cache write)
- Model used
- Duration

### Aggregate Tracking
The Prometheus metrics provide rolling totals. Combined with Grafana:
- Daily/weekly/monthly spend per knight
- Cost per task type (security briefing vs household task)
- Model cost comparison (which knights are expensive?)
- Budget alerts (if spend exceeds threshold)

### Cost Optimization Levers
1. **Model selection per knight** — Galahad gets Sonnet, Bedivere gets Haiku
2. **Context compaction** — Pi's built-in compaction reduces token usage on long sessions
3. **Skill-based routing** — Simple tasks get cheaper models automatically
4. **Caching** — Repeated queries can be cached (future extension)

## 5. Alerting

### Recommended Alerts (via Prometheus/Alertmanager)

| Alert | Condition | Severity |
|-------|-----------|----------|
| KnightDown | `pi_knight_nats_connected == 0` for 5m | Critical |
| HighErrorRate | `rate(pi_knight_tasks_total{status="error"}[15m]) > 0.3` | Warning |
| TaskTimeout | `pi_knight_tasks_total{status="timeout"}` increases | Warning |
| HighCost | `rate(pi_knight_llm_cost_dollars_total[1h]) > 5` | Info |
| ConsumerLag | Pending messages > 10 for 10m | Warning |
| NoTasks | No tasks completed in 24h | Info |

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `METRICS_PORT` | HTTP port for health/metrics | `3000` |
| `LOG_LEVEL` | Minimum log level | `info` |
| `ENABLE_METRICS` | Enable Prometheus metrics | `true` |
