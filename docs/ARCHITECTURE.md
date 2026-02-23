# Pi-Knight Architecture

> Universal base agent runtime for the Knights of the Round Table, built on the [Pi SDK](https://github.com/badlogic/pi-mono).

## Overview

Pi-Knight replaces the custom `knight-agent` runtime (Claude Agent SDK wrapper) with a purpose-built agent harness using Pi's layered SDK. Every knight runs the same image — differentiation comes from configuration, not code.

```
┌─────────────────────────────────────────────────────┐
│                   Pi-Knight Pod                      │
│                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────┐ │
│  │  pi-knight   │  │   git-sync   │  │  (chrome)  │ │
│  │  container   │  │   sidecar    │  │  optional  │ │
│  └──────┬───────┘  └──────┬───────┘  └────────────┘ │
│         │                 │                          │
│    ┌────┴────┐      ┌────┴─────┐                    │
│    │  /data  │      │ /skills  │                    │
│    │  (PVC)  │      │(emptyDir)│                    │
│    └─────────┘      └──────────┘                    │
└─────────────────────────────────────────────────────┘
         │                              │
    NATS JetStream                Shared Vault
   (database ns)               (CephFS /vault)
```

## Why Pi Over Claude Agent SDK

| Concern | Current (knight-agent) | Pi-Knight |
|---------|----------------------|-----------|
| LLM Access | Claude-only via OAuth token → CLI subprocess | Direct API calls via `pi-ai`, any provider |
| Tool Execution | Claude Code CLI spawns as child process | Native tool loop in `pi-agent-core` |
| Session Persistence | Custom implementation | Built-in JSONL sessions |
| Context Management | Manual prompt layering | Built-in context compaction |
| Skill System | Custom recursive scanner | Pi's native agentskills.io loader (built-in) |
| Image Size | ~400MB (includes CLI bundle) | ~200MB (just the packages) |
| Model Flexibility | Claude-only | Claude, GPT, Gemini, Ollama, 2000+ models |
| Extension System | None | Pi extensions for lifecycle hooks |
| Cost per Task | Sonnet for everything | Right-size model per knight/task |

## Layer Map

```
┌─────────────────────────────────────────┐
│            pi-knight (this repo)         │
│  NATS integration, skill bridge,         │
│  observability, knight lifecycle         │
├────────────────────┬────────────────────┤
│  pi-coding-agent   │   custom tools     │
│  File I/O, bash,   │   nats-publish,    │
│  sessions, skills, │   vault-access,    │
│  agentskills.io    │   mcp-bridge       │
├────────────────────┴────────────────────┤
│            pi-agent-core                 │
│  Agent loop, tool execution, events      │
├─────────────────────────────────────────┤
│               pi-ai                      │
│  Unified LLM API, streaming, cost track  │
└─────────────────────────────────────────┘
```

## Pod Architecture

Each knight runs as a Kubernetes pod with 2-3 containers:

### pi-knight (main container)
- The agent runtime
- Subscribes to NATS JetStream for task dispatch
- Executes tasks using Pi's agent loop
- Publishes results back to NATS
- Exposes health/metrics endpoints

### git-sync (sidecar)
- Syncs `roundtable-arsenal` repo to `/skills`
- Pi SDK's skill loader handles symlinks and dedup natively

### chrome (optional sidecar)
- Headless Chrome for web research tasks
- Available to knights that need browser access

## Key Design Principles

1. **One image, many knights** — Configuration via ConfigMap (SOUL.md, IDENTITY.md, TOOLS.md) + env vars
2. **Model flexibility** — Each knight can use a different LLM provider/model via `KNIGHT_MODEL`
3. **Native skill support** — Pi SDK's built-in agentskills.io loader discovers arsenal skills directly
4. **Immediate NATS ack** — At-most-once delivery, ack before execution (learned from knight-agent)
5. **Observable** — Structured logging, Prometheus metrics, cost tracking per task
6. **Fail gracefully** — Task timeouts, circuit breakers, health checks, backpressure
