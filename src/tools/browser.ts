/**
 * Browser automation tools for Pi SDK agent sessions.
 *
 * Uses agent-browser CLI for token-efficient browser interaction.
 * agent-browser returns structured accessibility trees with refs (@e1, @e2)
 * that are 90% more token-efficient than raw CDP/DOM dumps.
 *
 * Connects to headless Chrome sidecar via BROWSER_CDP_URL.
 * Requires BROWSER_ENABLED=true (set by operator when spec.capabilities.browser is true).
 */

import { execSync } from "child_process";
import { Type, type Static } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";

const BROWSER_DISABLED_MSG =
  "Browser capability not enabled. Set spec.capabilities.browser: true in Knight CR.";

const CDP_URL = process.env.BROWSER_CDP_URL || "http://localhost:9222";

function browserEnabled(): boolean {
  return process.env.BROWSER_ENABLED === "true";
}

function textResult(text: string): AgentToolResult<void> {
  return { content: [{ type: "text", text }], details: undefined };
}

let connected = false;

function ensureConnected(): void {
  if (connected) return;
  try {
    execSync(`agent-browser connect ${CDP_URL}`, {
      timeout: 10000,
      encoding: "utf-8",
    });
    connected = true;
  } catch (err: any) {
    throw new Error(`Failed to connect to Chrome sidecar at ${CDP_URL}: ${err.message}`);
  }
}

function runBrowser(args: string, timeoutMs = 30000): string {
  ensureConnected();
  try {
    const result = execSync(`agent-browser ${args}`, {
      timeout: timeoutMs,
      encoding: "utf-8",
    });
    return result.trim();
  } catch (err: any) {
    const stderr = err.stderr?.toString() || "";
    const stdout = err.stdout?.toString() || "";
    // If connection lost, reset and retry once
    if (stderr.includes("not connected") || stderr.includes("No browser")) {
      connected = false;
      ensureConnected();
      const retry = execSync(`agent-browser ${args}`, { timeout: timeoutMs, encoding: "utf-8" });
      return retry.trim();
    }
    throw new Error(stderr || stdout || err.message);
  }
}

// --- Tool Definitions ---

const OpenParams = Type.Object({
  url: Type.String({ description: "URL to navigate to" }),
});

export const browserOpenTool: ToolDefinition = {
  name: "browser_open",
  label: "Browser Open",
  description: "Navigate the browser to a URL. Use for JS-rendered pages, SPAs, form interaction, or when curl is insufficient.",
  parameters: OpenParams,
  async execute(_id: string, params: Static<typeof OpenParams>) {
    if (!browserEnabled()) return textResult(BROWSER_DISABLED_MSG);
    try {
      return textResult(runBrowser(`open "${params.url}"`) || `Navigated to ${params.url}`);
    } catch (err: any) {
      return textResult(`Error: ${err.message}`);
    }
  },
};

export const browserSnapshotTool: ToolDefinition = {
  name: "browser_snapshot",
  label: "Browser Snapshot",
  description:
    "Get the accessibility tree of the current page with element refs (@e1, @e2, etc). Use refs to interact via browser_click, browser_fill. Token-efficient alternative to reading raw HTML.",
  parameters: Type.Object({}),
  async execute() {
    if (!browserEnabled()) return textResult(BROWSER_DISABLED_MSG);
    try {
      return textResult(runBrowser("snapshot", 15000));
    } catch (err: any) {
      return textResult(`Error: ${err.message}`);
    }
  },
};

const RefParams = Type.Object({
  ref: Type.String({ description: "Element ref from snapshot (e.g. @e2) or CSS selector" }),
});

export const browserClickTool: ToolDefinition = {
  name: "browser_click",
  label: "Browser Click",
  description: "Click an element by ref (from snapshot, e.g. @e5) or CSS selector.",
  parameters: RefParams,
  async execute(_id: string, params: Static<typeof RefParams>) {
    if (!browserEnabled()) return textResult(BROWSER_DISABLED_MSG);
    try {
      return textResult(runBrowser(`click "${params.ref}"`) || `Clicked ${params.ref}`);
    } catch (err: any) {
      return textResult(`Error: ${err.message}`);
    }
  },
};

const FillParams = Type.Object({
  ref: Type.String({ description: "Element ref from snapshot or CSS selector" }),
  text: Type.String({ description: "Text to fill" }),
});

export const browserFillTool: ToolDefinition = {
  name: "browser_fill",
  label: "Browser Fill",
  description: "Clear and fill an input element with text. Uses ref from snapshot.",
  parameters: FillParams,
  async execute(_id: string, params: Static<typeof FillParams>) {
    if (!browserEnabled()) return textResult(BROWSER_DISABLED_MSG);
    try {
      return textResult(runBrowser(`fill "${params.ref}" "${params.text}"`) || `Filled ${params.ref}`);
    } catch (err: any) {
      return textResult(`Error: ${err.message}`);
    }
  },
};

export const browserGetTextTool: ToolDefinition = {
  name: "browser_get_text",
  label: "Browser Get Text",
  description: "Get text content from a specific element.",
  parameters: RefParams,
  async execute(_id: string, params: Static<typeof RefParams>) {
    if (!browserEnabled()) return textResult(BROWSER_DISABLED_MSG);
    try {
      return textResult(runBrowser(`get text "${params.ref}"`));
    } catch (err: any) {
      return textResult(`Error: ${err.message}`);
    }
  },
};

export const browserScreenshotTool: ToolDefinition = {
  name: "browser_screenshot",
  label: "Browser Screenshot",
  description: "Take a screenshot of the current page.",
  parameters: Type.Object({
    path: Type.Optional(Type.String({ description: "File path to save screenshot" })),
    full: Type.Optional(Type.Boolean({ description: "Full page capture" })),
  }),
  async execute(_id: string, params: { path?: string; full?: boolean }) {
    if (!browserEnabled()) return textResult(BROWSER_DISABLED_MSG);
    try {
      let args = "screenshot";
      if (params.full) args += " --full";
      if (params.path) args += ` "${params.path}"`;
      return textResult(runBrowser(args) || "Screenshot captured");
    } catch (err: any) {
      return textResult(`Error: ${err.message}`);
    }
  },
};

const EvalParams = Type.Object({
  js: Type.String({ description: "JavaScript to evaluate in page context" }),
});

export const browserEvalTool: ToolDefinition = {
  name: "browser_eval",
  label: "Browser Eval",
  description: "Evaluate JavaScript in the browser page context.",
  parameters: EvalParams,
  async execute(_id: string, params: Static<typeof EvalParams>) {
    if (!browserEnabled()) return textResult(BROWSER_DISABLED_MSG);
    try {
      const b64 = Buffer.from(params.js).toString("base64");
      return textResult(runBrowser(`eval -b "${b64}"`, 30000));
    } catch (err: any) {
      return textResult(`Error: ${err.message}`);
    }
  },
};

export const browserCloseTool: ToolDefinition = {
  name: "browser_close",
  label: "Browser Close",
  description: "Close the browser page and free resources.",
  parameters: Type.Object({}),
  async execute() {
    if (!browserEnabled()) return textResult(BROWSER_DISABLED_MSG);
    try {
      return textResult(runBrowser("close") || "Browser closed");
    } catch (err: any) {
      return textResult(`Error: ${err.message}`);
    }
  },
};

/**
 * All browser tools — conditionally registered when BROWSER_ENABLED=true.
 * Uses agent-browser CLI for token-efficient accessibility tree interaction.
 */
export const browserTools: ToolDefinition[] = [
  browserOpenTool, browserSnapshotTool, browserClickTool, browserFillTool,
  browserGetTextTool, browserScreenshotTool, browserEvalTool, browserCloseTool,
];
