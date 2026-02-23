# Skill System

> How Pi-Knight loads, filters, and executes skills from the roundtable-arsenal.

## Overview

Knights gain capabilities through **skills** — packaged instructions, scripts, and references that teach the agent how to perform domain-specific tasks. Pi-Knight bridges two skill systems:

1. **Pi's native skill system** — built into `pi-coding-agent`
2. **agentskills.io format** — used by the `roundtable-arsenal` repo

The skill bridge reads agentskills.io-format skills and registers them as Pi skills, giving knights access to the full arsenal.

## Skill Sources

### Arsenal (git-sync sidecar)
```
/skills/roundtable-arsenal/
├── shared/           # Available to ALL knights
│   ├── nats-comms/
│   ├── knight-comms/
│   ├── web-research/
│   ├── report-generator/
│   └── vault-access/
├── security/         # Galahad only
│   ├── opencti-intel/
│   ├── threat-briefing/
│   ├── cve-deep-dive/
│   └── shodan-recon/
├── finance/          # Percival only
│   └── tax-prep/
├── career/           # Lancelot only
│   └── interview-prep/
├── infra/            # Tristan only
│   └── cluster-ops/
├── home/             # Bedivere only
│   └── household/
├── research/         # Kay only
│   └── deep-research/
└── vault/            # Patsy only
    ├── vault-curator/
    └── vault-linter/
```

### Filtering via `KNIGHT_SKILLS`
```
KNIGHT_SKILLS=security    # Galahad gets: shared/* + security/*
KNIGHT_SKILLS=finance     # Percival gets: shared/* + finance/*
KNIGHT_SKILLS=vault       # Patsy gets: shared/* + vault/*
```

`shared/` is ALWAYS included regardless of `KNIGHT_SKILLS` value.

## agentskills.io Format

Each skill is a directory with:
```
skill-name/
├── SKILL.md          # Required — YAML frontmatter + markdown body
├── scripts/          # Optional — executable helpers
│   ├── query.sh
│   └── analyze.py
├── references/       # Optional — documentation loaded on demand
│   └── api-docs.md
└── assets/           # Optional — templates, schemas, data
    └── report-template.md
```

### SKILL.md Structure
```markdown
---
name: opencti-intel
description: Query and manage the OpenCTI threat intelligence platform.
tools: [bash, web_fetch]
triggers: [threat, cve, stix, indicator, malware]
---

# OpenCTI Intelligence Skill

## When to Use
When asked about threat intelligence, CVEs, indicators of compromise...

## Available Scripts
- `scripts/query.sh <graphql-query>` — Query OpenCTI GraphQL API
...
```

### Progressive Disclosure
At startup, Pi-Knight loads ONLY the `name` and `description` from each SKILL.md frontmatter (~100 tokens per skill). The full markdown body is loaded only when the skill is activated by the agent, keeping the system prompt small.

## Skill Bridge Implementation

The skill bridge (`src/extensions/skill-loader.ts`) does:

1. **Discovery** — Walk `/skills` recursively (up to 8 levels, follows symlinks for git-sync worktrees)
2. **Filter** — Match against `KNIGHT_SKILLS` env var (`shared/` always included)
3. **Parse** — Extract YAML frontmatter from each SKILL.md
4. **Register** — Create Pi skill entries with name, description, and lazy-load function
5. **Activate** — When agent matches a skill (via triggers or description), load the full SKILL.md body into context

### Pi Skill Registration
```typescript
// Pseudo-code for bridge
for (const skill of discoveredSkills) {
  agent.registerSkill({
    name: skill.frontmatter.name,
    description: skill.frontmatter.description,
    // Full instructions loaded on activation
    activate: async () => readFile(skill.path),
    // Scripts made available as tool hints
    scripts: skill.scripts,
  });
}
```

## Custom Tools

Beyond arsenal skills, Pi-Knight provides built-in tools:

### Default Pi Tools (from pi-coding-agent)
- `read` — Read file contents
- `write` — Write file contents  
- `edit` — Edit files with search/replace
- `bash` — Execute shell commands

### Pi-Knight Custom Tools
- `nats_publish` — Publish a message to a NATS subject (for out-of-band comms)
- `vault_read` — Read from the shared vault mount (`/vault`)
- `vault_write` — Write to allowed vault paths (`/vault/Briefings/`, `/vault/Roundtable/`)
- `knight_ask` — Request collaboration from another knight via NATS

### Tool Policy
Knights have tool policies that restrict what they can do:
- **File access** — Read/write within `/data` (workspace) and allowed `/vault` paths
- **Bash** — Allowed, but network access restricted by K8s NetworkPolicy
- **Vault write** — Only to `/vault/Briefings/` and `/vault/Roundtable/` (Patsy gets full write)

## Skill Development

New skills follow the [arsenal CONTRIBUTING.md](https://github.com/dapperdivers/roundtable-arsenal/blob/main/CONTRIBUTING.md):

1. Create `skills/<category>/<skill-name>/SKILL.md`
2. Add scripts to `scripts/` if needed
3. Test with a knight dispatch
4. PR to arsenal repo
5. git-sync picks it up automatically

Skills are hot-reloaded — git-sync updates the mount, Pi-Knight discovers new skills on next task without restart.
