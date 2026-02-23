# Pi-Knight Skills System

## Overview

Pi-Knight uses the **Pi SDK's built-in agentskills.io loader** for skill discovery and prompt injection.
This is the same skill system that powers OpenClaw — no custom walker needed.

## How It Works

1. **Discovery**: `loadSkills()` from `@mariozechner/pi-coding-agent` recursively scans skill directories
2. **Parsing**: Reads SKILL.md files with YAML frontmatter (name, description)
3. **Prompt Injection**: `formatSkillsForPrompt()` generates XML `<available_skills>` block per [agentskills.io spec](https://agentskills.io/integrate-skills)
4. **Deduplication**: Resolves symlinks via `realpathSync` to avoid loading duplicates from git-sync worktrees
5. **Validation**: Checks skill names (lowercase, hyphens only, ≤64 chars) and descriptions (required, ≤1024 chars)

## Skill Sources

Pi SDK loads skills from multiple locations (first-write-wins on name collisions):

| Source | Path | Description |
|--------|------|-------------|
| User skills | `/config/skills/` | From ConfigMap (agentDir) |
| Project skills | `/data/.pi/skills/` | From PVC workspace |
| Additional paths | `/skills/` | Arsenal repo via git-sync |

## Git-Sync Integration

The arsenal repo is mounted at `/skills/` via git-sync sidecar:

```
/skills/
├── roundtable-arsenal -> .worktrees/<sha>/   # symlink to current checkout
├── .worktrees/
│   └── <sha>/
│       ├── security/
│       │   ├── opencti-intel/SKILL.md
│       │   └── shodan-recon/SKILL.md
│       ├── shared/
│       │   ├── nats-comms/SKILL.md
│       │   └── web-search/SKILL.md
│       └── ...
```

Pi SDK handles symlink resolution and `.gitignore` respecting natively.

## Startup Race Condition

Git-sync may not have completed its first pull when pi-knight starts.
The startup code retries skill loading up to 6 times with 3s delays.

## Skill Reload

Pi SDK supports skill reload via `AgentSession.reload()` which re-discovers all skills,
rebuilds the system prompt, and picks up any changes from git-sync.
This is triggered by the `/reload` slash command in interactive mode.

For headless knight operation, skills are loaded fresh per task (each task creates a new session).

## SKILL.md Format

Per [agentskills.io](https://agentskills.io) spec:

```markdown
---
name: opencti-intel
description: "Query OpenCTI threat intelligence platform for STIX objects, indicators, and threat data."
---

# OpenCTI Intelligence Skill

## Usage
...scripts and instructions...
```

### Frontmatter Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Lowercase, hyphens only, must match parent dir name |
| `description` | Yes | ≤1024 chars, injected into system prompt |
| `disable-model-invocation` | No | If true, skill only available via explicit `/skill:name` command |

## Category Filtering

Note: Pi SDK's `loadSkills()` does not natively filter by category.
All skills in the provided paths are loaded. The `KNIGHT_SKILLS` env var is retained
for logging/metadata purposes but does not affect discovery.

Knights receive all shared + domain skills. The agent's system prompt and personality
(SOUL.md) guide it to stay within its domain.
