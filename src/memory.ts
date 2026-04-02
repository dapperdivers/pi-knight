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
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { KnightConfig } from "./config.js";
import { log } from "./logger.js";

// ─── Directories ────────────────────────────────────────────────

const SESSION_NOTES_DIR = "/data/session-notes";
const SESSION_NOTES_FILE = `${SESSION_NOTES_DIR}/current.md`;
const SCRATCH_DIR = "/data/scratch";

// ─── Custom Compaction Prompt ───────────────────────────────────

/**
 * Knight-specific compaction instructions.
 * Injected into Pi SDK's auto-compaction to preserve Round Table context.
 *
 * Based on Claude Code's context-compaction-summary prompt, adapted for
 * the knight execution model (NATS tasks, vault writes, tool patterns).
 */
const KNIGHT_COMPACTION_INSTRUCTIONS = `
You are a Knight of the Round Table performing context compaction. Your summary
will replace this conversation history, so it must preserve everything needed
to continue working effectively.

Focus on preserving:

1. **Task Context** — What NATS task(s) were executed? What was the task description?
   Include task IDs if mentioned.

2. **Current State** — What was being worked on most recently? What is the current
   state of the work? This is the MOST CRITICAL section — without it, the knight
   loses continuity after compaction.

3. **Files Touched** — Every file path that was read, written, or modified.
   Include vault paths (/vault/...) and workspace paths (/data/...).

4. **Tool Patterns That Worked** — If a particular tool invocation or bash command
   proved effective, preserve the exact command. If something failed, note why.

5. **Decisions and Rationale** — Why was approach X chosen over Y?
   Preserve the reasoning, not just the outcome.

6. **Promises and Commitments** — If the knight committed to writing a file,
   updating memory, or reporting back, preserve that commitment.

7. **Errors and Corrections** — What went wrong and how was it fixed?
   What should NOT be tried again?

Be concise but complete. Err on the side of including information that prevents
duplicate work or repeated mistakes. Convert any relative time references to
absolute dates/times.
`.trim();

/**
 * Hook into Pi SDK's compaction events to inject custom instructions.
 *
 * The Pi SDK fires compaction_start/compaction_end events. We listen for these
 * to log compaction activity. The actual custom instructions are applied via
 * the session's event subscription.
 */
export function setupCompactionHook(session: AgentSession, config: KnightConfig): void {
  // Subscribe to session events for compaction logging
  session.subscribe((event) => {
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
      });
    }
  });

  log.info("Compaction hook installed (knight-specific context preservation)");
}

/**
 * Get the custom compaction instructions for injection into Pi SDK.
 * Called when configuring the session's compaction behavior.
 */
export function getCompactionInstructions(): string {
  return KNIGHT_COMPACTION_INSTRUCTIONS;
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
