# Security Model

> How Pi-Knight enforces isolation, least privilege, and safe agent execution.

## Threat Model

An AI agent with tools (bash, file I/O, network access) is inherently dangerous. Pi-Knight assumes:

1. **The LLM will do unexpected things** — prompt injection, hallucination, unintended tool use
2. **External inputs are untrusted** — NATS task payloads, web content, RSS feeds
3. **Blast radius must be contained** — a compromised knight must not affect other knights or the cluster

## Defense Layers

```
┌──────────────────────────────────────┐
│  Layer 1: Kubernetes Isolation       │  Namespace, NetworkPolicy, RBAC
├──────────────────────────────────────┤
│  Layer 2: Container Security         │  Non-root, read-only FS, dropped caps
├──────────────────────────────────────┤
│  Layer 3: Tool Policy                │  Restricted file paths, command filtering
├──────────────────────────────────────┤
│  Layer 4: Capability Scoping         │  KNIGHT_SKILLS, per-knight API keys
├──────────────────────────────────────┤
│  Layer 5: Observability              │  Audit logging, cost tracking, alerts
└──────────────────────────────────────┘
```

## Layer 1: Kubernetes Isolation

### Namespace
All knights run in the `roundtable` namespace, isolated from:
- `security` (OpenCTI, Wazuh)
- `database` (NATS, PostgreSQL, Redis)
- `ai` (Tim, Munin)
- All other cluster namespaces

### CiliumNetworkPolicy
```yaml
# Default deny all ingress/egress
# Allow only:
- Egress to NATS (database namespace, port 4222)
- Egress to DNS (kube-system)
- Egress to internet (for web research, API calls)
- Ingress from Prometheus (metrics scraping)
```

Knights **cannot** reach:
- Other knights directly (all communication via NATS)
- Internal cluster services not explicitly allowed
- Kubernetes API server (no RBAC needed for most knights)

### Pod Security
```yaml
securityContext:
  runAsNonRoot: true
  runAsUser: 1000
  fsGroup: 1000
  readOnlyRootFilesystem: true  # Writable: /data, /tmp, /skills
  allowPrivilegeEscalation: false
  capabilities:
    drop: [ALL]
```

## Layer 2: Container Security

- **Non-root execution** — UID 1000, no sudo
- **Read-only root filesystem** — Only `/data` (PVC), `/tmp`, and `/skills` (emptyDir) are writable
- **No service account token** — `automountServiceAccountToken: false` (unless knight needs K8s API)
- **Resource limits** — Memory requests for scheduling, no hard limits (homelab pattern)
- **Image pinned to SHA** — No `:latest` tag, deterministic deployments

## Layer 3: Tool Policy

Pi-Knight restricts what the agent's built-in tools can do:

### File Access
| Path | Permission | Notes |
|------|-----------|-------|
| `/data/*` | Read/Write | Knight's workspace (PVC) |
| `/skills/*` | Read-only | Arsenal skills (git-sync) |
| `/vault/*` | Read-only | Shared Obsidian vault |
| `/vault/Briefings/*` | Read/Write | Briefing output |
| `/vault/Roundtable/*` | Read/Write | Inter-knight notes |
| `/vault/**` (Patsy only) | Read/Write | Full vault curator access |
| Everything else | Denied | |

### Bash Restrictions
- Network access controlled by NetworkPolicy (not bash filtering)
- No `sudo`, no privilege escalation (container security handles this)
- Timeout enforcement via AbortController

### Vault Write Scoping
```typescript
// Pseudo-code: vault write guard
function canWriteVault(path: string, knight: string): boolean {
  if (knight === 'patsy') return true;  // Full access
  if (path.startsWith('/vault/Briefings/')) return true;
  if (path.startsWith('/vault/Roundtable/')) return true;
  return false;
}
```

## Layer 4: Capability Scoping

### KNIGHT_SKILLS
Each knight only loads skills for its domain. Galahad can't use finance tools. Percival can't run security scans.

### Per-Knight API Keys
Each knight gets only the API keys it needs via ExternalSecret:
- Galahad: `ANTHROPIC_API_KEY`, `OPENCTI_TOKEN`, `SHODAN_API_KEY`
- Percival: `ANTHROPIC_API_KEY`, `PAPERLESS_TOKEN`
- Tristan: `ANTHROPIC_API_KEY` (+ K8s RBAC if needed)
- Others: `ANTHROPIC_API_KEY` only

### Model-Specific Auth
With multi-provider support, each knight uses only the auth for its configured model:
- Claude knights: `ANTHROPIC_API_KEY`
- GPT knights: `OPENAI_API_KEY`
- Gemini knights: `GEMINI_API_KEY`

## Layer 5: Observability as Security

- **All task executions logged** with full metadata (who, what, when, how long, what cost)
- **NATS message bus is an audit trail** — every task dispatch and result is a durable message
- **Cost tracking = anomaly detection** — a knight suddenly costing 10x normal is suspicious
- **Tool call logging** — every bash command, file read/write logged at debug level
- **Alert on high error rates** — could indicate prompt injection or degraded model behavior

## Trust Model

```
Tim (orchestrator)
  │
  │ dispatches tasks via NATS
  │ validates results before acting
  │
  ├── Galahad (security) ─── OpenCTI, Shodan (scoped API keys)
  ├── Percival (finance) ─── Paperless (scoped token)
  ├── Lancelot (career) ─── No special keys
  ├── Tristan (infra) ───── K8s RBAC (if granted)
  ├── Bedivere (home) ───── HA MCP (if granted)
  ├── Kay (research) ────── Web access only
  └── Patsy (vault) ────── Full vault write
```

**Key principle:** Knights propose, Tim validates. No knight action reaches the external world without orchestrator review (except vault writes and NATS results, which are internal).

## OWASP LLM Top 10 Mitigations

| Risk | Mitigation |
|------|-----------|
| LLM01 Prompt Injection | Tool policy enforcement, capability scoping, content boundary markers |
| LLM02 Insecure Output | Orchestrator validates before external action |
| LLM03 Training Data Poisoning | N/A — using commercial models, not fine-tuned |
| LLM04 Model DoS | AbortController timeout, MAX_CONCURRENT_TASKS, backpressure |
| LLM05 Supply Chain | Docker image SHA pins, skill auditing, npm lockfile |
| LLM06 Sensitive Info | Data segregation, per-knight key scoping, vault read-only |
| LLM07 Insecure Plugins | KNIGHT_SKILLS explicit opt-in, skill audit in arsenal CI |
| LLM08 Excessive Agency | Namespace isolation, network policies, human-in-the-loop |
| LLM09 Misinformation | Confidence scoring, source attribution, verification loops |
| LLM10 Unbounded Consumption | Cost tracking, budget alerts, model selection per task |
