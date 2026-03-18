/**
 * Browser automation tools for Pi SDK agent sessions.
 *
 * Provides native tool-loop integration for headless Chrome via agent-browser CLI.
 * Requires BROWSER_ENABLED=true env var (set by operator when spec.capabilities.browser is true).
 */

import { execSync } from "child_process";
import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@anthropic-ai/sdk/resources/beta";

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
  return { type: "tool_result", content: [{ type: "text", text }] } as any;
}

// --- Tool parameter schemas ---

const OpenParams = Type.Object({
  url: Type.String({ description: "URL to navigate to" }),
});

const ClickParams = Type.Object({
  ref: Type.String({ description: "Element ref from snapshot (e.g. @e2) or CSS selector" }),
});

const FillParams = Type.Object({
  ref: Type.String({ description: "Element ref from snapshot (e.g. @e3) or CSS selector" }),
  text: Type.String({ description: "Text to fill into the element" }),
});

const GetTextParams = Type.Object({
  ref: Type.String({ description: "Element ref from snapshot or CSS selector" }),
});

const EvalParams = Type.Object({
  js: Type.String({ description: "JavaScript code to evaluate in the page" }),
});

const ScreenshotParams = Type.Object({
  path: Type.Optional(Type.String({ description: "File path to save screenshot (optional)" })),
  full: Type.Optional(Type.Boolean({ description: "Capture full page screenshot" })),
});

// --- Tool definitions ---

const browserOpen: AgentTool = {
  name: "browser_open",
  description:
    "Navigate the browser to a URL. Use for web pages that need JS rendering, form interaction, or when curl is insufficient.",
  input_schema: OpenParams as any,
  async execute(_toolCallId: string, params: Static<typeof OpenParams>) {
    if (!browserEnabled()) return textResult(BROWSER_DISABLED_MSG);
    const result = runBrowser(`open "${params.url}"`);
    return textResult(result || `Navigated to ${params.url}`);
  },
} as any;

const browserSnapshot: AgentTool = {
  name: "browser_snapshot",
  description:
    "Get the accessibility tree of the current page with element refs (@e1, @e2, etc.). Use refs to interact with elements via browser_click, browser_fill, etc.",
  input_schema: Type.Object({}) as any,
  async execute() {
    if (!browserEnabled()) return textResult(BROWSER_DISABLED_MSG);
    const result = runBrowser("snapshot", 15000);
    return textResult(result);
  },
} as any;

const browserClick: AgentTool = {
  name: "browser_click",
  description: "Click an element by ref (from snapshot) or CSS selector.",
  input_schema: ClickParams as any,
  async execute(_toolCallId: string, params: Static<typeof ClickParams>) {
    if (!browserEnabled()) return textResult(BROWSER_DISABLED_MSG);
    const result = runBrowser(`click "${params.ref}"`);
    return textResult(result || `Clicked ${params.ref}`);
  },
} as any;

const browserFill: AgentTool = {
  name: "browser_fill",
  description: "Clear and fill an input element with text.",
  input_schema: FillParams as any,
  async execute(_toolCallId: string, params: Static<typeof FillParams>) {
    if (!browserEnabled()) return textResult(BROWSER_DISABLED_MSG);
    const result = runBrowser(`fill "${params.ref}" "${params.text}"`);
    return textResult(result || `Filled ${params.ref} with "${params.text}"`);
  },
} as any;

const browserGetText: AgentTool = {
  name: "browser_get_text",
  description: "Get the text content of an element.",
  input_schema: GetTextParams as any,
  async execute(_toolCallId: string, params: Static<typeof GetTextParams>) {
    if (!browserEnabled()) return textResult(BROWSER_DISABLED_MSG);
    const result = runBrowser(`get text "${params.ref}"`);
    return textResult(result);
  },
} as any;

const browserScreenshot: AgentTool = {
  name: "browser_screenshot",
  description: "Take a screenshot of the current page.",
  input_schema: ScreenshotParams as any,
  async execute(_toolCallId: string, params: Static<typeof ScreenshotParams>) {
    if (!browserEnabled()) return textResult(BROWSER_DISABLED_MSG);
    let args = "screenshot";
    if (params.full) args += " --full";
    if (params.path) args += ` "${params.path}"`;
    const result = runBrowser(args);
    return textResult(result || "Screenshot captured");
  },
} as any;

const browserEval: AgentTool = {
  name: "browser_eval",
  description: "Evaluate JavaScript in the browser page context.",
  input_schema: EvalParams as any,
  async execute(_toolCallId: string, params: Static<typeof EvalParams>) {
    if (!browserEnabled()) return textResult(BROWSER_DISABLED_MSG);
    // Base64 encode to avoid shell escaping issues
    const b64 = Buffer.from(params.js).toString("base64");
    const result = runBrowser(`eval -b "${b64}"`, 30000);
    return textResult(result);
  },
} as any;

const browserClose: AgentTool = {
  name: "browser_close",
  description: "Close the browser and free resources.",
  input_schema: Type.Object({}) as any,
  async execute() {
    if (!browserEnabled()) return textResult(BROWSER_DISABLED_MSG);
    const result = runBrowser("close");
    return textResult(result || "Browser closed");
  },
} as any;

/**
 * All browser tools for registration with Pi SDK.
 * Only active when BROWSER_ENABLED=true.
 */
export const browserTools: AgentTool[] = [
  browserOpen,
  browserSnapshot,
  browserClick,
  browserFill,
  browserGetText,
  browserScreenshot,
  browserEval,
  browserClose,
];
