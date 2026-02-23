# Configuration

> How knights are differentiated through configuration, not code.

## Principle

Every knight runs the **same Docker image**. Identity, personality, capabilities, and model selection are injected via Kubernetes ConfigMaps, Secrets, and environment variables.

## Configuration Layers

```
┌─────────────────────────────────┐
│  Environment Variables           │  Model, timeouts, NATS config
├─────────────────────────────────┤
│  ConfigMap (personality files)   │  SOUL.md, IDENTITY.md, TOOLS.md
├─────────────────────────────────┤
│  ExternalSecret (credentials)    │  API keys, tokens
├─────────────────────────────────┤
│  Image Defaults                  │  AGENTS.md, base TOOLS.md
└─────────────────────────────────┘
```

### File Overlay Priority
1. **PVC** (`/data`) — Knight's own edits (highest priority, persists across restarts)
2. **ConfigMap** — Injected personality files (seeded only if missing on PVC)
3. **Image Defaults** — Base operational contract (fallback)

This means knights can evolve their own files over time — ConfigMap seeds the initial state, the knight's own modifications take priority.

## Environment Variables

### Required
| Variable | Description | Example |
|----------|-------------|---------|
| `KNIGHT_NAME` | Knight identifier | `galahad` |
| `SUBSCRIBE_TOPICS` | NATS subject filter | `fleet-a.tasks.security.>` |
| `KNIGHT_SKILLS` | Skill categories to load | `security` |

### LLM Configuration
| Variable | Description | Default |
|----------|-------------|---------|
| `KNIGHT_MODEL` | LLM provider/model | `anthropic/claude-sonnet-4-5` |
| `ANTHROPIC_API_KEY` | Anthropic API key | From ExternalSecret |
| `OPENAI_API_KEY` | OpenAI API key (if using GPT models) | From ExternalSecret |
| `GEMINI_API_KEY` | Google API key (if using Gemini) | From ExternalSecret |
| `KNIGHT_THINKING` | Enable extended thinking | `false` |
| `KNIGHT_EFFORT` | Effort level (low/medium/high) | `medium` |

### NATS Configuration
| Variable | Description | Default |
|----------|-------------|---------|
| `NATS_URL` | NATS server URL | `nats://nats.database.svc.cluster.local:4222` |
| `TASK_TIMEOUT_MS` | Default task timeout | `1800000` |
| `MAX_CONCURRENT_TASKS` | Max parallel task execution | `2` |

### Observability
| Variable | Description | Default |
|----------|-------------|---------|
| `METRICS_PORT` | Health/metrics HTTP port | `3000` |
| `LOG_LEVEL` | Log verbosity | `info` |
| `ENABLE_METRICS` | Prometheus metrics | `true` |

## Knight Configurations

### Galahad (Security)
```yaml
KNIGHT_NAME: galahad
KNIGHT_MODEL: anthropic/claude-sonnet-4-5
SUBSCRIBE_TOPICS: fleet-a.tasks.security.>
KNIGHT_SKILLS: security
TASK_TIMEOUT_MS: "1800000"    # 30 min — deep analysis
```

### Percival (Finance)
```yaml
KNIGHT_NAME: percival
KNIGHT_MODEL: anthropic/claude-haiku-3-5   # Cheaper for structured tasks
SUBSCRIBE_TOPICS: fleet-a.tasks.finance.>
KNIGHT_SKILLS: finance
```

### Kay (Research)
```yaml
KNIGHT_NAME: kay
KNIGHT_MODEL: google/gemini-2.5-pro        # Huge context for research
SUBSCRIBE_TOPICS: fleet-a.tasks.research.>,fleet-a.tasks.intel.>
KNIGHT_SKILLS: research,intel
```

### Lancelot (Career)
```yaml
KNIGHT_NAME: lancelot
KNIGHT_MODEL: anthropic/claude-sonnet-4-5
SUBSCRIBE_TOPICS: fleet-a.tasks.career.>
KNIGHT_SKILLS: career
```

### Tristan (Infrastructure)
```yaml
KNIGHT_NAME: tristan
KNIGHT_MODEL: anthropic/claude-sonnet-4-5
SUBSCRIBE_TOPICS: fleet-a.tasks.infra.>
KNIGHT_SKILLS: infra
```

### Bedivere (Household)
```yaml
KNIGHT_NAME: bedivere
KNIGHT_MODEL: openai/gpt-4o               # Cost-effective for life admin
SUBSCRIBE_TOPICS: fleet-a.tasks.home.>
KNIGHT_SKILLS: home
```

### Patsy (Vault Curator)
```yaml
KNIGHT_NAME: patsy
KNIGHT_MODEL: anthropic/claude-haiku-3-5   # Metadata tasks don't need Sonnet
SUBSCRIBE_TOPICS: fleet-a.tasks.vault.>
KNIGHT_SKILLS: vault
# Special: full vault write access (unlike other knights)
```

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
  TOOLS.md: |
    ## OpenCTI
    - Endpoint: http://opencti-server.security.svc:8080
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
          regexp: "^KNIGHT_.*"
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
| Percival | Claude Haiku 3.5 | Financial categorization is structured, doesn't need Sonnet |
| Bedivere | GPT-4o | Household tasks are straightforward, cost-optimize |
| Patsy | Claude Haiku 3.5 | Vault metadata is mechanical, high volume |

These are starting points — adjust based on observed task quality and cost.
