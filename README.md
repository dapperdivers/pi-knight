# Pi-Knight 🛡️

> Universal base agent runtime for the Knights of the Round Table, built on [Pi SDK](https://github.com/badlogic/pi-mono).

## What Is This?

Pi-Knight is a Kubernetes-native AI agent runtime that turns a single Docker image into any specialized agent. Each knight runs the same image — personality, capabilities, and model selection are all configuration.

Built on the same Pi SDK that powers [OpenClaw](https://github.com/openclaw/openclaw).

## Architecture

```
Pi-Knight Pod (Kubernetes)
├── pi-knight          → Agent runtime (Pi SDK + NATS + custom tools)
├── git-sync           → Skill delivery from roundtable-arsenal
└── chrome (optional)  → Headless browser for research tasks
```

**Communication:** NATS JetStream (async, durable, auditable)  
**Skills:** agentskills.io format, filtered per knight via `KNIGHT_SKILLS`  
**Models:** Any LLM via `pi-ai` — Claude, GPT, Gemini, Ollama, etc.  
**Observability:** Structured JSON logs, Prometheus metrics, cost tracking

## Documentation

| Doc | Description |
|-----|-------------|
| [Architecture](docs/ARCHITECTURE.md) | System design, layer map, pod structure |
| [NATS](docs/NATS.md) | Message format, streams, consumer config |
| [Observability](docs/OBSERVABILITY.md) | Logging, metrics, health checks, alerting |
| [Skills](docs/SKILLS.md) | Skill system, arsenal bridge, tool policies |
| [Configuration](docs/CONFIGURATION.md) | Per-knight config, model selection, env vars |
| [Security](docs/SECURITY.md) | Isolation model, threat model, OWASP LLM mitigations |
| [Migration](docs/MIGRATION.md) | Migration path from knight-agent |

## Quick Start

```bash
# Install dependencies
npm install

# Set API key
export ANTHROPIC_API_KEY=sk-ant-...

# Run locally (requires NATS)
npm run dev
```

## Knights

| Knight | Domain | Default Model | Skills |
|--------|--------|---------------|--------|
| Galahad | Security & Threat Intel | Claude Sonnet 4.5 | security |
| Percival | Finance & Tax | Claude Haiku 3.5 | finance |
| Lancelot | Career & Professional | Claude Sonnet 4.5 | career |
| Tristan | Infrastructure & HomeLab | Claude Sonnet 4.5 | infra |
| Bedivere | Household & Life Admin | GPT-4o | home |
| Kay | Research & Entertainment | Gemini 2.5 Pro | research, intel |
| Patsy | Vault Curator | Claude Haiku 3.5 | vault |

## Why Pi?

The previous runtime (`knight-agent`) wrapped the Claude Agent SDK, which spawns Claude Code CLI as a subprocess. That's two layers of indirection, Claude-only, and ~400MB.

Pi-Knight uses Pi's SDK directly:
- **Direct LLM access** — no subprocess spawning
- **Multi-provider** — use the right model for the task
- **Built-in skill system** — sessions, compaction, extensions
- **Smaller footprint** — ~200MB target
- **Hackable** — TypeScript, well-documented, same stack as OpenClaw

## License

MIT
