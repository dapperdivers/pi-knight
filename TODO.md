# Pi-Knight Cleanup TODO

## 1. TypeBox migration ✅
- [x] Replace `import { Type } from "@sinclair/typebox"` with `import { Type } from "typebox"` in all three tool files
- [x] Remove `@sinclair/typebox` from `dependencies` in `package.json`
- [x] Add `typebox` as a direct dependency (was previously only transitive)
- [x] `npm run build` passes

## 2. `terminate: true` for nats_publish ✅
- [x] In `src/hooks.ts` `afterToolCall`, return `{ terminate: true }` after a successful `nats_publish` so the agent skips a trailing LLM call
- [x] Only terminates on success (`!isError`) — errors pass through so the agent can react

## 3. Fix dead compaction instructions ✅
- [x] Removed `KNIGHT_COMPACTION_INSTRUCTIONS` constant from `src/memory.ts` — was defined but never used (SDK auto-compaction ignores custom instructions)
- [x] Auto-compaction custom instructions are only injectable via the extension API; not applicable here

## 4. Update subscribe listener signature ✅
- [x] `src/memory.ts`: updated `session.subscribe((event) => {...})` to `async (event, _signal) => {...}` to match 0.65.0 API

## 5. Log `willRetry` on compaction_end ✅
- [x] Added `willRetry: event.willRetry` to the `compaction_end` log line in `src/memory.ts`

## 6. Node version pinning in Dockerfile ✅
- [x] Both `FROM node:22-slim` stages updated to `FROM node:22.19-slim`
