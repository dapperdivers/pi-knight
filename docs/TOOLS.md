# Tool Management with mise

> Declarative, per-knight tool provisioning via [mise](https://mise.jdx.dev).

## Architecture

```
┌──────────────────────────────────────────────┐
│  Layer 1: Image Baseline (build time)         │
│  /app/mise.toml  → rg, python3, yq           │
│  /app/.mise/     → immutable shims            │
├──────────────────────────────────────────────┤
│  Layer 2: Knight Config (init container)      │
│  /config/mise.toml → kubectl, helm, etc.      │
│  /config/apt.txt   → nmap, whois, dnsutils    │
│  /data/.mise/      → installed shims           │
├──────────────────────────────────────────────┤
│  Layer 3: Self-Provisioned (runtime)          │
│  /data/mise.toml → knight installs on-demand  │
│  /data/.mise/    → persists across restarts    │
└──────────────────────────────────────────────┘

PATH: /data/.mise/shims:/app/.mise/shims:...
      (knight + self)    (baseline)
```

## Three Layers

### Layer 1: Image Baseline (`/app/mise.toml`)

Baked at `docker build` time. Every knight gets these. Zero startup cost.

```toml
[tools]
"ubi:BurntSushi/ripgrep" = "latest"   # rg — required by Pi SDK grep tool
python = "3.12"                        # skill scripts
"ubi:mikefarah/yq" = "latest"         # YAML processing
```

Plus system packages via apt: `jq`, `curl`, `git`, `ca-certificates`.

### Layer 2: Knight-Specific Config (`/config/`)

Injected via ConfigMap, installed by init container (`scripts/mise-init.sh`) at pod start.
Two files supported:

- **`mise.toml`** — Declarative CLI tools (GitHub releases, languages, pip/npm CLIs)
- **`apt.txt`** — System packages (one per line, for tools that aren't on GitHub releases)

Each knight only gets the tools it needs:

| Knight | mise.toml | apt.txt | Why |
|--------|-----------|---------|-----|
| Galahad | shodan CLI | nmap, whois, dnsutils | Security recon |
| Tristan | kubectl, helm, flux, stern | — | Cluster ops |
| Others | — | — | Baseline sufficient |

### Layer 3: Self-Provisioned (`/data/mise.toml`)

Knights can install tools themselves during task execution:

```bash
mise use "ubi:owner/repo"
mise install
```

This writes to `/data/mise.toml` on the PVC — persists across pod restarts.
No image rebuild, no ConfigMap change, no human intervention.

If a knight repeatedly needs a tool, it should mention this in its task results so the tool can be promoted to Layer 2 (ConfigMap).

## Adding Tools to a Knight

### Via ConfigMap (Layer 2 — recommended for known needs)

1. Add `mise.toml` and/or `apt.txt` to the knight's ConfigMap:

```yaml
# kubernetes/apps/roundtable/tristan/app/configmap.yaml
data:
  mise.toml: |
    [tools]
    kubectl = "latest"
    "ubi:helm/helm" = "latest"
    "ubi:fluxcd/flux2" = "latest"
    "ubi:stern/stern" = "latest"
```

2. Mount to `/config/` in the HelmRelease.

3. Flux reconciles → pod restarts → init container installs → tools available.

### Via Self-Provisioning (Layer 3 — ad-hoc needs)

Knights install tools themselves during task execution. See `defaults/AGENTS.md` for knight-facing docs.

## Available Backends

| Backend | Syntax | Best For |
|---------|--------|----------|
| **core** | `python = "3.12"` | Languages (python, node, go, ruby, java) |
| **ubi** | `"ubi:owner/repo" = "latest"` | GitHub releases (pre-built binaries) |
| **npm** | `"npm:pkg" = "latest"` | npm CLI tools |
| **pipx** | `"pipx:pkg" = "latest"` | Python CLI tools |

For system packages (nmap, whois, etc.) that aren't available as GitHub releases, use `apt.txt`.

## Tool Discovery

```bash
mise registry | grep kubectl
mise registry | grep helm
```

## Pinning Versions

```toml
[tools]
kubectl = "1.31.0"
"ubi:helm/helm" = "3.16.0"
```

Use `latest` for tools where you always want the newest (mise caches and only re-fetches periodically).
