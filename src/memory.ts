/**
 * Memory management for pi-knight — session notes, compaction hooks, and scratch space.
 *
 * Implements a 3-layer memory hierarchy:
 * 1. Custom compaction prompt — preserves knight-specific context during auto-compaction
 * 2. Session notes — structured file updated after every task, survives compaction
 * 3. Long-term memory — MEMORY.md + daily logs (handled by AGENTS.md instructions)
 *
 * Inspired by Claude Code's session memory template and Anthropic's context engineering blog.
 */
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { KnightConfig } from "./config.js";
import { log } from "./logger.js";

// ─── Directories ────────────────────────────────────────────────

const SESSION_NOTES_DIR = "/data/session-notes";
const SESSION_NOTES_FILE = `${SESSION_NOTES_DIR}/current.md`;
const SCRATCH_DIR = "/data/scratch";

/**
 * Hook into Pi SDK's compaction events to inject custom instructions.
 *
 * The Pi SDK fires compaction_start/compaction_end events. We listen for these
 * to log compaction activity. The actual custom instructions are applied via
 * the session's event subscription.
 */
export function setupCompactionHook(session: AgentSession, config: KnightConfig): void {
  // Cast needed until the installed package type catches up to 0.65.0 listener signature
  // (listeners are async and receive an AbortSignal as second argument)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type AnyListener = (event: any, _signal: any) => Promise<void>;
  const listener: AnyListener = async (event, _signal) => {
    if (event.type === "compaction_start") {
      log.info("Context compaction starting", {
        knight: config.knightName,
        reason: event.reason,
      });
    }
    if (event.type === "compaction_end") {
      log.info("Context compaction complete", {
        knight: config.knightName,
        reason: event.reason,
        aborted: event.aborted,
        hasResult: !!event.result,
        willRetry: event.willRetry,
      });
    }
    if (event.type === "auto_retry_start") {
      log.warn("LLM auto-retry triggered", {
        knight: config.knightName,
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        error: event.errorMessage,
      });
    }
    if (event.type === "auto_retry_end") {
      if (event.success) {
        log.info("LLM auto-retry succeeded", { knight: config.knightName, attempt: event.attempt });
      } else {
        log.error("LLM auto-retry exhausted", {
          knight: config.knightName,
          attempt: event.attempt,
          finalError: event.finalError,
        });
      }
    }
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  session.subscribe(listener as any);

  log.info("Session hooks installed (compaction + retry observability)");
}

// ─── Session Notes ──────────────────────────────────────────────

/**
 * Update session notes after each task.
 *
 * This is the "short-term memory" layer — a structured file that persists
 * across context compaction. The "Current State" section is critical because
 * after compaction, the model loses what it was just working on.
 *
 * Based on Claude Code's session memory template (data-session-memory-template.md).
 */
export async function updateSessionNotes(
  knightName: string,
  task: string,
  result: string,
): Promise<void> {
  // Ensure directories exist
  await ensureDir(SESSION_NOTES_DIR);
  await ensureDir(SCRATCH_DIR);

  const now = new Date().toISOString();
  const taskPreview = task.length > 200 ? task.slice(0, 200) + "…" : task;
  const resultPreview = result.length > 500 ? result.slice(0, 500) + "…" : result;

  // Read existing notes if any
  let existing = "";
  try {
    existing = await readFile(SESSION_NOTES_FILE, "utf-8");
  } catch {
    // File doesn't exist yet — that's fine
  }

  // Extract existing sections to preserve non-current-state content
  const previousLearnings = extractSection(existing, "Learnings");
  const previousErrors = extractSection(existing, "Errors & Corrections");

  const notes = `# Current State
_Last updated: ${now}_
_Knight: ${knightName}_

**Most recent task:** ${taskPreview}

**Result summary:** ${resultPreview}

# Task Specification
${taskPreview}

# Files and Functions
_Updated by knight during task execution — check daily logs for details._

# Errors & Corrections
${previousErrors || "_None recorded yet._"}

# Learnings
${previousLearnings || "_None recorded yet._"}

# Key Results
${resultPreview}

# Worklog
- ${now}: Executed task, produced result (${result.length} chars)
`;

  await writeFile(SESSION_NOTES_FILE, notes, "utf-8");
  log.debug("Session notes updated", {
    knight: knightName,
    file: SESSION_NOTES_FILE,
    size: notes.length,
  });
}

// ─── Helpers ────────────────────────────────────────────────────

async function ensureDir(dir: string): Promise<void> {
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
    log.debug("Created directory", { dir });
  }
}

/**
 * Extract a section from markdown by header name.
 * Returns the content between the header and the next header of same or higher level.
 */
function extractSection(markdown: string, sectionName: string): string {
  const pattern = new RegExp(
    `^#\\s+${sectionName}\\s*\\n([\\s\\S]*?)(?=^#\\s+|$)`,
    "m"
  );
  const match = markdown.match(pattern);
  return match ? match[1].trim() : "";
}
