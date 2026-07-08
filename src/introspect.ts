import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { log } from "./logger.js";
import { getConnection } from "./nats.js";
import { getActiveSession } from "./knight.js";
import {
  parseSessionFile,
  recentItemsForEntry,
  summarizeEntry,
  summarizeSession,
} from "./introspect-format.js";
import type { KnightConfig } from "./config.js";
import type { Subscription } from "nats";
import { StringCodec } from "./nats.js";

const sc = StringCodec();

interface IntrospectRequest {
  type: "stats" | "recent" | "tree" | "history" | "session";
  limit?: number;
  offset?: number;
  id?: string;
}

const startTime = Date.now();
let sub: Subscription | null = null;

// Root of the persisted per-session JSONL files (pi SDK writes under
// <agentDir>/sessions; knights use agentDir "/data"). Overridable for tests.
const SESSIONS_ROOT = process.env.KNIGHT_SESSIONS_ROOT ?? "/data/sessions";
// Cap how many past sessions we list and how many entries we page per request
// (keeps the NATS reply under the ~1MB payload limit).
const MAX_HISTORY = 60;
const MAX_SESSION_ENTRIES = 500;
const DEFAULT_SESSION_ENTRIES = 200;

export function startIntrospect(config: KnightConfig): void {
  const nc = getConnection();
  if (!nc) {
    log.warn("Cannot start introspect — NATS not connected");
    return;
  }

  // Derive prefix from natsResultsPrefix (e.g. "rt-dev.results" → "rt-dev")
  const prefix = config.natsResultsPrefix.replace(/\.results$/, "");
  const subject = `${prefix}.introspect.${config.knightName}`;
  sub = nc.subscribe(subject);
  log.info("Introspect responder started", { subject });

  (async () => {
    for await (const msg of sub) {
      try {
        let req: IntrospectRequest = { type: "stats" };
        try {
          req = JSON.parse(sc.decode(msg.data));
        } catch {
          // default to stats
        }

        const response = await handleIntrospect(req, config);
        msg.respond(sc.encode(JSON.stringify(response)));
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.error("Introspect error", { error: errMsg });
        msg.respond(sc.encode(JSON.stringify({ error: errMsg })));
      }
    }
  })();
}

export async function handleIntrospect(req: IntrospectRequest, config: KnightConfig): Promise<unknown> {
  // History browsing reads persisted JSONL files and works regardless of
  // whether an in-memory session is currently active.
  if (req.type === "history") {
    return buildHistory(config);
  }
  if (req.type === "session") {
    return buildSession(config, req.id, req.limit, req.offset);
  }

  const session = getActiveSession();

  if (!session) {
    return {
      knight: config.knightName,
      session: null,
      runtime: {
        uptime: Math.floor((Date.now() - startTime) / 1000),
        activeTasks: 0,
        model: config.knightModel,
      },
    };
  }

  switch (req.type) {
    case "stats":
      return buildStats(config);
    case "recent":
      return buildRecent(config, req.limit ?? 20);
    case "tree":
      return buildTree(config);
    default:
      return { error: `Unknown introspect type: ${(req as any).type}` };
  }
}

function buildStats(config: KnightConfig) {
  const session = getActiveSession()!;
  const stats = session.getSessionStats();

  return {
    knight: config.knightName,
    session: {
      sessionId: stats.sessionId,
      userMessages: stats.userMessages,
      assistantMessages: stats.assistantMessages,
      toolCalls: stats.toolCalls,
      totalMessages: stats.totalMessages,
      tokens: {
        input: stats.tokens.input,
        output: stats.tokens.output,
        total: stats.tokens.total,
      },
      cost: stats.cost,
    },
    runtime: {
      uptime: Math.floor((Date.now() - startTime) / 1000),
      activeTasks: 0,
      model: config.knightModel,
    },
  };
}

function buildRecent(config: KnightConfig, limit: number) {
  const session = getActiveSession()!;
  const entries = session.sessionManager.getEntries();
  const recent = entries.slice(-limit);

  const flatItems = recent.flatMap((entry) => recentItemsForEntry(entry));

  return {
    knight: config.knightName,
    entries: flatItems,
    total: entries.length,
    returned: recent.length,
  };
}

function buildTree(config: KnightConfig) {
  const session = getActiveSession()!;
  const tree = session.sessionManager.getTree();

  function simplifyNode(node: { entry: any; children: any[]; label?: string }) {
    const entry = node.entry;
    const base: Record<string, unknown> = {
      id: entry.id,
      parentId: entry.parentId,
      type: entry.type,
      timestamp: entry.timestamp,
      childrenCount: node.children.length,
    };

    if (node.label) base.label = node.label;
    base.summary = summarizeEntry(entry);

    return base;
  }

  // Flatten tree to simplified nodes (one level of children info)
  function flattenTree(nodes: any[]): any[] {
    const result: any[] = [];
    for (const node of nodes) {
      result.push(simplifyNode(node));
      if (node.children.length > 0) {
        result.push(...flattenTree(node.children));
      }
    }
    return result;
  }

  return {
    knight: config.knightName,
    nodes: flattenTree(tree),
    totalNodes: flattenTree(tree).length,
  };
}

// A persisted session's public id is the uuid embedded in its filename
// (`<iso-timestamp>_<uuid>.jsonl`). Validate ids to this charset so a request
// can never escape the sessions dir.
const SESSION_ID_RE = /^[0-9a-fA-F-]+$/;

function sessionIdFromFilename(name: string): string {
  const stem = name.replace(/\.jsonl$/, "");
  const us = stem.lastIndexOf("_");
  return us >= 0 ? stem.slice(us + 1) : stem;
}

// List every persisted session file under the sessions root (one subdir per
// cwd), newest first by mtime. Returns [] if the dir doesn't exist yet.
async function listSessionFiles(): Promise<Array<{ id: string; path: string; sizeBytes: number; mtimeMs: number }>> {
  let dirents;
  try {
    dirents = await readdir(SESSIONS_ROOT, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs = dirents.filter((d) => d.isDirectory()).map((d) => join(SESSIONS_ROOT, d.name));
  // Defensive: also consider .jsonl files sitting directly in the root.
  if (dirents.some((d) => d.isFile() && d.name.endsWith(".jsonl"))) dirs.push(SESSIONS_ROOT);

  const files: Array<{ id: string; path: string; sizeBytes: number; mtimeMs: number }> = [];
  for (const dir of dirs) {
    let names;
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(dir, name);
      try {
        const st = await stat(path);
        files.push({ id: sessionIdFromFilename(name), path, sizeBytes: st.size, mtimeMs: st.mtimeMs });
      } catch {
        // file vanished between readdir and stat — skip
      }
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files;
}

async function buildHistory(config: KnightConfig) {
  const files = await listSessionFiles();
  const sessions = [];
  for (const f of files.slice(0, MAX_HISTORY)) {
    try {
      const parsed = parseSessionFile(await readFile(f.path, "utf8"));
      sessions.push(summarizeSession(parsed, { id: f.id, sizeBytes: f.sizeBytes }));
    } catch {
      // unreadable file — skip rather than fail the whole listing
    }
  }
  return { knight: config.knightName, sessions, total: files.length };
}

async function buildSession(config: KnightConfig, id: string | undefined, limit?: number, offset?: number) {
  if (!id || !SESSION_ID_RE.test(id)) {
    return { error: "Invalid or missing session id" };
  }
  const files = await listSessionFiles();
  const file = files.find((f) => f.id === id);
  if (!file) {
    return { error: `Session not found: ${id}` };
  }

  const { header, entries } = parseSessionFile(await readFile(file.path, "utf8"));
  const start = Math.max(0, offset ?? 0);
  const count = Math.min(Math.max(1, limit ?? DEFAULT_SESSION_ENTRIES), MAX_SESSION_ENTRIES);
  const page = entries.slice(start, start + count);
  const items = page.flatMap((entry) => recentItemsForEntry(entry));

  return {
    knight: config.knightName,
    id,
    startedAt: header?.timestamp ?? entries[0]?.timestamp ?? null,
    entries: items,
    total: entries.length,
    offset: start,
    returned: page.length,
    hasMore: start + page.length < entries.length,
  };
}
