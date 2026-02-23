# Migration from knight-agent

> How to migrate from the current Claude Agent SDK-based knight-agent to Pi-Knight.

## Current State

The existing `knight-agent` runtime (`dapperdivers/knight-agent`):
- Express HTTP server + Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`)
- SDK spawns Claude Code CLI as a child process for task execution
- Custom NATS integration (subscribe, immediate ack, publish results)
- Custom skill discovery (recursive walk, KNIGHT_SKILLS filter, symlink-aware)
- Custom prompt layering (system prompt + context files + skills + task)
- OAuth token workaround (`fixOAuthEnv()` for `sk-ant-oat01-*` tokens)
- Image: `ghcr.io/dapperdivers/knight-agent:<sha>`

## What Changes

| Component | knight-agent | Pi-Knight |
|-----------|-------------|-----------|
| LLM access | Claude SDK → CLI subprocess | `pi-ai` direct API calls |
| Agent loop | SDK manages internally | `pi-agent-core` (visible, hookable) |
| Tools | SDK built-in (read/write/edit/bash) | Pi built-in + custom tools |
| Sessions | Not persisted | JSONL persistence built-in |
| Skills | Custom recursive scanner | Pi skills + agentskills.io bridge |
| NATS | Custom `src/nats.ts` | Extension wrapping same logic |
| Config | Custom `src/config.ts` | Env vars + Pi config |
| Health | Custom Express endpoints | Custom HTTP server (lighter) |
| Auth | OAuth token workaround | `pi-ai` handles auth natively |
| Model | Claude-only | Any provider |

## What Stays the Same

- **Kubernetes manifests** — Same HelmRelease structure, same ConfigMaps, same ExternalSecrets
- **NATS topics and streams** — No changes to message format or subject conventions
- **Skill files** — Same agentskills.io format in the arsenal
- **git-sync sidecar** — Same pattern, same mount points
- **Shared vault mount** — Same CephFS PV/PVC
- **Tim's dispatch scripts** — `dispatch.sh` and `dispatch-wait.sh` unchanged

## Migration Steps

### Phase 1: Build and Test (no cluster changes)
1. Build pi-knight Docker image
2. Run locally against NATS (port-forward or local NATS)
3. Send test tasks, verify:
   - Skills load correctly
   - NATS consume/publish works
   - Tools execute (bash, read, write)
   - Results match knight-agent quality
   - Cost is equal or better

### Phase 2: Canary Deployment
1. Deploy one knight (suggest: Bedivere — lowest risk domain) on pi-knight
2. Keep all other knights on knight-agent
3. Run both for 48 hours
4. Compare:
   - Task success rate
   - Task duration
   - Cost per task
   - Output quality
   - Error rate

### Phase 3: Gradual Rollout
1. Migrate Percival (structured tasks, easy to validate)
2. Migrate Kay (research tasks, test Gemini model)
3. Migrate Lancelot, Tristan
4. Migrate Galahad (security — highest stakes, migrate last)
5. Migrate Patsy (vault ops — needs full write access verified)

### Phase 4: Cleanup
1. Archive `dapperdivers/knight-agent` repo
2. Update dapper-cluster manifests to reference pi-knight image
3. Update arsenal CONTRIBUTING.md if skill format changed
4. Update vault docs (Knight Agent - Architecture.md)

## Rollback Plan

If pi-knight fails for any knight:
1. Change the HelmRelease image back to `knight-agent:<sha>`
2. Flux reconciles, old runtime deploys
3. NATS consumers recreate automatically
4. Zero data loss (tasks are in JetStream, results in vault)

## Manifest Changes

The HelmRelease for each knight needs minimal changes:

```yaml
# Before (knight-agent)
containers:
  app:
    image:
      repository: ghcr.io/dapperdivers/knight-agent
      tag: 7350b70

# After (pi-knight)  
containers:
  app:
    image:
      repository: ghcr.io/dapperdivers/pi-knight
      tag: <sha>
    env:
      # NEW: model selection (previously Claude-only)
      KNIGHT_MODEL: anthropic/claude-sonnet-4-5
```

Everything else (ConfigMap, ExternalSecret, git-sync sidecar, vault mount, NATS env vars) stays the same.

## Risk Assessment

| Risk | Mitigation |
|------|-----------|
| Pi skill format incompatibility | Skill bridge translates agentskills.io → Pi format |
| Model quality regression | Test each model against known tasks before deploying |
| NATS integration bugs | Reuse proven NATS logic from knight-agent |
| Cost increase from model experimentation | Monitor via Prometheus metrics, set budget alerts |
| Pi SDK breaking changes | Pin to specific npm version, test before upgrading |
| Session persistence format change | New format, but knights don't share sessions |
