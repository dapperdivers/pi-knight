/**
 * Tool call hooks for pi-knight — safety, observability, and metrics.
 *
 * Uses pi-agent-core 0.64.0 beforeToolCall/afterToolCall API to intercept
 * tool executions for logging, blocking dangerous operations, and sanitizing
 * results before they enter the agent's context window.
 */
import type {
  BeforeToolCallContext,
  BeforeToolCallResult,
  AfterToolCallContext,
  AfterToolCallResult,
} from "@earendil-works/pi-agent-core";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { log } from "./logger.js";
import { toolCallsTotal, toolCallDuration, toolCallErrors, toolCallsBlocked } from "./metrics.js";

// ─── Dangerous operation patterns ───────────────────────────────────

/** Bash commands that should be blocked outright */
const BLOCKED_BASH_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+-rf\s+\/(?!\w)/, reason: "Recursive delete at root level" },
  { pattern: /\bgit\s+push\s+.*--force(?!\s*-with-lease)/, reason: "Force push without lease (use --force-with-lease or new commits)" },
  { pattern: /\bgit\s+push\s+.*-f\b/, reason: "Force push (use new commits instead)" },
  { pattern: /\bchmod\s+777\b/, reason: "World-writable permissions" },
  { pattern: /\bcurl\b.*\|\s*(?:ba)?sh/, reason: "Piping remote script to shell" },
  { pattern: /\bdd\s+.*of=\/dev\//, reason: "Direct device write" },
  { pattern: /\bmkfs\b/, reason: "Filesystem format" },
];

/** Patterns that indicate secrets in tool output */
const SECRET_PATTERNS: RegExp[] = [
  /(?:api[_-]?key|apikey|secret[_-]?key|access[_-]?token|auth[_-]?token|bearer)\s*[:=]\s*['"]?[A-Za-z0-9_\-/.+=]{20,}/gi,
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/gi,
  /ghp_[A-Za-z0-9_]{36,}/g,     // GitHub PATs
  /ghs_[A-Za-z0-9_]{36,}/g,     // GitHub app tokens
  /sk-[A-Za-z0-9]{40,}/g,       // OpenAI keys
  /xoxb-[A-Za-z0-9\-]+/g,       // Slack bot tokens
  /AKIA[A-Z0-9]{16}/g,          // AWS access keys
];

// ─── Timing tracker ────────────────────────────────────────────────

const toolStartTimes = new Map<string, number>();

// ─── Hook implementations ──────────────────────────────────────────

/**
 * Called before every tool execution. Can block dangerous operations.
 */
async function beforeToolCall(
  context: BeforeToolCallContext,
  signal?: AbortSignal,
): Promise<BeforeToolCallResult | undefined> {
  const { toolCall, args } = context;
  const toolName = toolCall.name;
  const toolCallId = toolCall.id;

  // Start timing
  toolStartTimes.set(toolCallId, Date.now());

  log.debug("Tool call started", {
    tool: toolName,
    toolCallId,
    argsPreview: truncateArgs(args),
  });

  // Check bash commands for dangerous patterns
  if (toolName === "bash" || toolName === "Bash") {
    const command = (args as any)?.command ?? (args as any)?.input ?? "";
    for (const { pattern, reason } of BLOCKED_BASH_PATTERNS) {
      if (pattern.test(command)) {
        log.warn("Blocked dangerous bash command", {
          tool: toolName,
          toolCallId,
          reason,
          command: command.slice(0, 200),
        });
        toolCallsBlocked.inc({ tool: toolName, reason });
        return {
          block: true,
          reason: `🛡️ Blocked: ${reason}. This operation is not allowed for safety. Use a safer alternative.`,
        };
      }
    }
  }

  // Check write tool for attempts to write secrets
  if (toolName === "write" || toolName === "Write") {
    const content = (args as any)?.content ?? "";
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(content)) {
        log.warn("Blocked secret write", {
          tool: toolName,
          toolCallId,
        });
        toolCallsBlocked.inc({ tool: toolName, reason: "secret_in_content" });
        return {
          block: true,
          reason: "🛡️ Blocked: Content appears to contain secrets/credentials. Never write secrets to files.",
        };
      }
    }
  }

  return undefined; // allow execution
}

/**
 * Called after every tool execution. Sanitizes output and logs metrics.
 */
async function afterToolCall(
  context: AfterToolCallContext,
  signal?: AbortSignal,
): Promise<AfterToolCallResult | undefined> {
  const { toolCall, result, isError } = context;
  const toolName = toolCall.name;
  const toolCallId = toolCall.id;

  // Calculate duration
  const startTime = toolStartTimes.get(toolCallId);
  const duration = startTime ? Date.now() - startTime : 0;
  toolStartTimes.delete(toolCallId);

  // Update metrics
  toolCallsTotal.inc({ tool: toolName, status: isError ? "error" : "success" });
  toolCallDuration.observe({ tool: toolName }, duration / 1000);
  if (isError) {
    toolCallErrors.inc({ tool: toolName });
  }

  log.info("Tool call completed", {
    tool: toolName,
    toolCallId,
    duration,
    isError,
    resultSize: JSON.stringify(result.content).length,
  });

  // Sanitize secrets from tool results
  let needsSanitization = false;
  const sanitizedContent = result.content.map((block) => {
    if (block.type === "text" && typeof block.text === "string") {
      let text = block.text;
      for (const pattern of SECRET_PATTERNS) {
        // Reset lastIndex for global patterns
        pattern.lastIndex = 0;
        if (pattern.test(text)) {
          needsSanitization = true;
          pattern.lastIndex = 0;
          text = text.replace(pattern, "[REDACTED]");
        }
      }
      if (text !== block.text) {
        return { ...block, text };
      }
    }
    return block;
  });

  if (needsSanitization) {
    log.warn("Sanitized secrets from tool result", {
      tool: toolName,
      toolCallId,
    });
    return { content: sanitizedContent };
  }

  return undefined; // pass through unmodified
}

// ─── Setup ─────────────────────────────────────────────────────────

/**
 * Wire beforeToolCall and afterToolCall hooks into the agent session.
 */
export function setupToolHooks(session: AgentSession): void {
  session.agent.beforeToolCall = beforeToolCall;
  session.agent.afterToolCall = afterToolCall;
  log.info("Tool hooks installed (safety + observability)");
}

// ─── Helpers ───────────────────────────────────────────────────────

function truncateArgs(args: unknown): string {
  const str = JSON.stringify(args);
  return str.length > 200 ? str.slice(0, 200) + "…" : str;
}
