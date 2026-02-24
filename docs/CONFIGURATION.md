# Configuration

> How knights are differentiated through configuration, not code.

## Principle

Every knight runs the **same Docker image**. Identity, personality, capabilities, and model selection are injected via Kubernetes ConfigMaps, Secrets, and environment variables. Skill filtering is managed at the Helm/git-sync layer — the runtime loads all skills from mounted paths.

## Configuration Layers

```
┌─────────────────────────────────┐
│  Environment Variables           │  Model, timeouts, NATS config
├─────────────────────────────────┤
│  ConfigMap (personality files)   │  SOUL.md, IDENTITY.md
├─────────────────────────────────┤
│  ExternalSecret (credentials)    │  API keys, tokens
├─────────────────────────────────┤
│  Image Defaults                  │  AGENTS.md, base TOOLS.md
└─────────────────────────────────┘
```

### File Overlay Priority
1. **PVC** (`/data`) — Knight's own edits (highest priority, persists across restarts)
2. **ConfigMap** (`/config`) — Injected personality files (SOUL.md, IDENTITY.md)
3. **Image Defaults** (`/app/defaults`) — Base operational contract (fallback)

Pi SDK's `DefaultResourceLoader` handles this natively:
- `cwd=/data` — project-local discovery (PVC workspace)
- `agentDir=/config` — global config (ConfigMap personality files, AGENTS.md)
- `additionalSkillPaths=["/skills"]` — arsenal repo via git-sync

Knights can evolve their own files over time — ConfigMap seeds the initial state, the knight's own modifications on PVC take priority.

## Environment Variables

### Required
| Variable | Description | Example |
|----------|-------------|---------|
| `KNIGHT_NAME` | Knight identifier | `galahad` |
| `SUBSCRIBE_TOPICS` | NATS subject filter (comma-separated) | `fleet-a.tasks.security.>` |

### LLM Configuration
| Variable | Description | Default |
|----------|-------------|---------|
| `KNIGHT_MODEL` | LLM provider/model | `anthropic/claude-sonnet-4-5` |
| `KNIGHT_THINKING` | Thinking level (off/minimal/low/medium/high) | `off` |
| `ANTHROPIC_API_KEY` | Anthropic API key | From ExternalSecret |
| `OPENAI_API_KEY` | OpenAI API key (if using GPT models) | From ExternalSecret |
| `GEMINI_API_KEY` | Google API key (if using Gemini) | From ExternalSecret |

### NATS Configuration
| Variable | Description | Default |
|----------|-------------|---------|
| `NATS_URL` | NATS server URL | `nats://nats.database.svc.cluster.local:4222` |
| `TASK_TIMEOUT_MS` | Default task timeout (ms) | `1800000` (30 min) |
| `MAX_CONCURRENT_TASKS` | Max parallel task execution | `2` |

### Observability
| Variable | Description | Default |
|----------|-------------|---------|
| `METRICS_PORT` | Health/metrics HTTP port | `3000` |
| `LOG_LEVEL` | Log verbosity (debug/info/warn/error) | `info` |

## Skill Filtering

Skill filtering is managed at the **deployment layer**, not in pi-knight code:

- **git-sync** mounts the arsenal repo to `/skills`
- **Helm values** control which skill directories are synced per knight
- Pi SDK's `loadSkills()` loads everything from `/skills` — no runtime filtering

This keeps the runtime simple and lets GitOps control what each knight can do.

## Native Tools

Pi-knight registers custom tools alongside Pi SDK's built-in coding tools:

| Tool | Description | Source |
|------|-------------|--------|
| `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls` | File I/O and shell | Pi SDK built-in |
| `nats_publish` | Fire-and-forget NATS message | pi-knight custom |
| `nats_request` | Cross-knight collaboration (send + wait) | pi-knight custom |

## Session Persistence

Knights maintain persistent sessions across tasks:
- Session state stored as JSONL on PVC (`/data`)
- Pi SDK auto-compacts when context grows too large
- Knights remember previous tasks within their session lifetime
- Survives pod restarts (PVC-backed)

## Thinking Level

`KNIGHT_THINKING` can also be overridden per-task by the dispatching agent via the NATS message metadata. This lets Tim request deeper reasoning for complex tasks without changing the knight's default.

## ConfigMap Structure

Each knight gets a ConfigMap with personality files:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: galahad-config
  namespace: roundtable
data:
  SOUL.md: |
    # Galahad — The Shield of the Realm
    ...
  IDENTITY.md: |
    - Name: Sir Galahad
    - Domain: Security & Threat Intelligence
    ...
```

## Secrets Management

API keys and tokens managed via Infisical → ExternalSecret → K8s Secret:

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: galahad-secret
  namespace: roundtable
spec:
  secretStoreRef:
    kind: ClusterSecretStore
    name: infisical
  target:
    name: galahad-secret
  dataFrom:
    - find:
        name:
          regexp: "^ANTHROPIC_.*"
```

## Model Selection Strategy

| Knight | Recommended Model | Reasoning |
|--------|------------------|-----------|
| Galahad | Claude Sonnet 4.5 | Security analysis needs strong reasoning |
| Kay | Gemini 2.5 Pro | Research benefits from 1M+ token context |
| Lancelot | Claude Sonnet 4.5 | Career advice needs nuanced writing |
| Tristan | Claude Sonnet 4.5 | Infrastructure requires precise technical output |
| Percival | Claude Haiku 3.5 | Financial categorization is structured |
| Bedivere | GPT-4o | Household tasks are straightforward |
| Patsy | Claude Haiku 3.5 | Vault metadata is mechanical, high volume |

These are starting points — adjust based on observed task quality and cost.
