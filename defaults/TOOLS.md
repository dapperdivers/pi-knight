# Knight Tools

## Built-in Agent Tools
These are native tools in the Pi SDK agent loop — no CLI binary needed:
- **read**: Read file contents
- **write**: Create or overwrite files
- **edit**: Make precise edits to files
- **bash**: Execute shell commands
- **grep**: Search file contents (uses ripgrep)
- **find**: Locate files by pattern
- **ls**: List directory contents

## Custom NATS Tools
Native to pi-knight runtime — no CLI binary needed:
- **nats_publish**: Fire-and-forget message to any NATS subject
- **nats_request**: Send a task to another knight and wait for their response
- **spawn_subagent**: Spin up a temporary focused sub-agent for a subtask

## Vault Access
- **Read**: /vault (shared Obsidian vault — Derek's Second Brain)
- **Write**: /vault/Briefings/ and /vault/Roundtable/ only
- Write to the vault when you produce something Derek would find valuable long-term
- Keep working notes in your local workspace (/data)

## CLI Tools (via mise)
Run `mise ls` to see what's installed. Baseline tools available to all knights:
- `rg` (ripgrep) — fast text search
- `python3` — script execution
- `yq` — YAML processing
- `jq` — JSON processing (system package)
- `curl` — HTTP requests
- `git` — version control

Your knight may have additional tools installed via ConfigMap or self-provisioned.
Run `mise ls` or `which <tool>` to check availability.

Need a tool you don't have? See AGENTS.md for self-provisioning instructions.
