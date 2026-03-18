/**
 * Browser automation tools for Pi SDK agent sessions.
 *
 * Provides native tool-loop integration for headless Chrome via agent-browser CLI.
 * Requires BROWSER_ENABLED=true env var (set by operator when spec.capabilities.browser is true).
 */

import { execSync } from "child_process";
import { Type, type Static } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";

const BROWSER_DISABLED_MSG =
  "Browser capability not enabled for this knight. Set spec.capabilities.browser: true in your Knight CR.";

function browserEnabled(): boolean {
  return process.env.BROWSER_ENABLED === "true";
}

function runBrowser(args: string, timeoutMs = 30000): string {
  try {
    const result = execSync(`agent-browser ${args}`, {
      timeout: timeoutMs,
      encoding: "utf-8",
      env: { ...process.env, DISPLAY: ":99" },
    });
    return result.trim();
  } catch (err: any) {
    const stderr = err.stderr?.toString() || "";
    const stdout = err.stdout?.toString() || "";
    throw new Error(`agent-browser error: ${stderr || stdout || err.message}`);
  }
}

function textResult(text: string): AgentToolResult<void> {
  return { type: "tool_result", content: [{ type: "text", text }] } as AgentToolResult<void>;
}

const OpenParams = Type.Object({
  url: Type.String({ description: "URL to navigate to" }),
});

export const browserOpenTool: ToolDefinition = {
  name: "browser_open",
  label: "Browser Open",
  description: "Navigate the browser to a URL. Use for JS-rendered pages, SPAs, or when curl is insufficient.",
  parameters: OpenParams,
  async execute(_toolCallId: string, params: Static<typeof OpenParams>) {
    if (!browserEnabled()) return textResult(BROWSER_DISABLED_MSG);
    const result = runBrowser(`open "${params.url}"`);
    return textResult(result || `Navigated to ${params.url}`);
  },
};

export const browserSnapshotTool: ToolDefinition = {
  name: "browser_snapshot",
  label: "Browser Snapshot",
  description: "Get the accessibility tree of the current page with element refs (@e1, @e2). Use refs to interact via browser_click, browser_fill, etc.",
  parameters: Type.Object({}),
  async execute() {
    if (!browserEnabled()) return textResult(BROWSER_DISABLED_MSG);
    return textResult(runBrowser("snapshot", 15000));
  },
};

const RefParams = Type.Object({
  ref: Type.String({ description: "Element ref from snapshot (e.g. @e2) or CSS selector" }),
});

export const browserClickTool: ToolDefinition = {
  name: "browser_click",
  label: "Browser Click",
  description: "Click an element by ref (from snapshot) or CSS selector.",
  parameters: RefParams,
  async execute(_toolCallId: string, params: Static<typeof RefParams>) {
    if (!browserEnabled()) return textResult(BROWSER_DISABLED_MSG);
    return textResult(runBrowser(`click "${params.ref}"`) || `Clicked ${params.ref}`);
  },
};

const FillParams = Type.Object({
  ref: Type.String({ description: "Element ref from snapshot or CSS selector" }),
  text: Type.String({ description: "Text to fill" }),
});

export const browserFillTool: ToolDefinition = {
  name: "browser_fill",
  label: "Browser Fill",
  description: "Clear and fill an input element with text.",
  parameters: FillParams,
  async execute(_toolCallId: string, params: Static<typeof FillParams>) {
    if (!browserEnabled()) return textResult(BROWSER_DISABLED_MSG);
    return textResult(runBrowser(`fill "${params.ref}" "${params.text}"`) || `Filled ${params.ref}`);
  },
};

export const browserGetTextTool: ToolDefinition = {
  name: "browser_get_text",
  label: "Browser Get Text",
  description: "Get the text content of an element.",
  parameters: RefParams,
  async execute(_toolCallId: string, params: Static<typeof RefParams>) {
    if (!browserEnabled()) return textResult(BROWSER_DISABLED_MSG);
    return textResult(runBrowser(`get text "${params.ref}"`));
  },
};

const ScreenshotParams = Type.Object({
  path: Type.Optional(Type.String({ description: "File path to save screenshot" })),
  full: Type.Optional(Type.Boolean({ description: "Capture full page" })),
});

export const browserScreenshotTool: ToolDefinition = {
  name: "browser_screenshot",
  label: "Browser Screenshot",
  description: "Take a screenshot of the current page.",
  parameters: ScreenshotParams,
  async execute(_toolCallId: string, params: Static<typeof ScreenshotParams>) {
    if (!browserEnabled()) return textResult(BROWSER_DISABLED_MSG);
    let args = "screenshot";
    if (params.full) args += " --full";
    if (params.path) args += ` "${params.path}"`;
    return textResult(runBrowser(args) || "Screenshot captured");
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
  async execute(_toolCallId: string, params: Static<typeof EvalParams>) {
    if (!browserEnabled()) return textResult(BROWSER_DISABLED_MSG);
    const b64 = Buffer.from(params.js).toString("base64");
    return textResult(runBrowser(`eval -b "${b64}"`, 30000));
  },
};

export const browserCloseTool: ToolDefinition = {
  name: "browser_close",
  label: "Browser Close",
  description: "Close the browser and free resources.",
  parameters: Type.Object({}),
  async execute() {
    if (!browserEnabled()) return textResult(BROWSER_DISABLED_MSG);
    return textResult(runBrowser("close") || "Browser closed");
  },
};

export const browserTools: ToolDefinition[] = [
  browserOpenTool, browserSnapshotTool, browserClickTool, browserFillTool,
  browserGetTextTool, browserScreenshotTool, browserEvalTool, browserCloseTool,
];
