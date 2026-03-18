/**
 * Browser automation tools for Pi SDK agent sessions.
 *
 * Connects to headless Chrome sidecar via CDP (Chrome DevTools Protocol).
 * Uses Node.js 22 native fetch + WebSocket — zero external dependencies.
 * Requires BROWSER_ENABLED=true env var (set by operator when spec.capabilities.browser is true).
 */

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

// --- CDP Protocol Layer ---

let cachedWsUrl: string | null = null;
let msgId = 1;

async function getPageWs(): Promise<string> {
  if (cachedWsUrl) return cachedWsUrl;
  const resp = await fetch(`${CDP_URL}/json`);
  const pages = (await resp.json()) as any[];
  const page = pages.find((p) => p.type === "page") || pages[0];
  if (!page?.webSocketDebuggerUrl) throw new Error("No Chrome page found. Is the browser sidecar running?");
  cachedWsUrl = page.webSocketDebuggerUrl;
  return cachedWsUrl!;
}

function cdpCommand(wsUrl: string, method: string, params: Record<string, any> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = msgId++;
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`CDP timeout: ${method}`));
    }, 20000);

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ id, method, params }));
    });

    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.id === id) {
        clearTimeout(timer);
        ws.close();
        if (msg.error) reject(new Error(`CDP error: ${msg.error.message}`));
        else resolve(msg.result);
      }
    });

    ws.addEventListener("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`WebSocket error: ${err}`));
    });
  });
}

// --- Tool Definitions ---

const OpenParams = Type.Object({
  url: Type.String({ description: "URL to navigate to" }),
});

export const browserOpenTool: ToolDefinition = {
  name: "browser_open",
  label: "Browser Open",
  description: "Navigate the browser to a URL. Use for JS-rendered pages, SPAs, or when curl/fetch is insufficient.",
  parameters: OpenParams,
  async execute(_id: string, params: Static<typeof OpenParams>) {
    if (!browserEnabled()) return textResult(BROWSER_DISABLED_MSG);
    try {
      const ws = await getPageWs();
      await cdpCommand(ws, "Page.enable");
      await cdpCommand(ws, "Page.navigate", { url: params.url });
      // Wait for load
      await new Promise((r) => setTimeout(r, 2000));
      return textResult(`Navigated to ${params.url}`);
    } catch (err: any) {
      return textResult(`Error: ${err.message}`);
    }
  },
};

export const browserSnapshotTool: ToolDefinition = {
  name: "browser_snapshot",
  label: "Browser Snapshot",
  description:
    "Get the page content as text. Returns page title, URL, and visible text content. Use to understand what's on the page before interacting.",
  parameters: Type.Object({}),
  async execute() {
    if (!browserEnabled()) return textResult(BROWSER_DISABLED_MSG);
    try {
      const ws = await getPageWs();
      // Get title + URL + text content
      const titleResult = await cdpCommand(ws, "Runtime.evaluate", {
        expression: "document.title",
        returnByValue: true,
      });
      const urlResult = await cdpCommand(ws, "Runtime.evaluate", {
        expression: "window.location.href",
        returnByValue: true,
      });
      const textResult_ = await cdpCommand(ws, "Runtime.evaluate", {
        expression: `(() => {
          const els = document.querySelectorAll('a, button, input, select, textarea, [role="button"], [role="link"], h1, h2, h3, h4, h5, h6');
          const items = [];
          els.forEach((el, i) => {
            const tag = el.tagName.toLowerCase();
            const text = el.textContent?.trim().substring(0, 100) || '';
            const type = el.getAttribute('type') || '';
            const name = el.getAttribute('name') || el.getAttribute('id') || '';
            const placeholder = el.getAttribute('placeholder') || '';
            const href = el.getAttribute('href') || '';
            let desc = tag;
            if (type) desc += '[type=' + type + ']';
            if (name) desc += '#' + name;
            if (placeholder) desc += ' placeholder="' + placeholder + '"';
            if (href) desc += ' href="' + href.substring(0,80) + '"';
            if (text && tag !== 'input') desc += ' "' + text.substring(0,60) + '"';
            items.push('[' + i + '] ' + desc);
          });
          return items.join('\\n');
        })()`,
        returnByValue: true,
      });
      const bodyText = await cdpCommand(ws, "Runtime.evaluate", {
        expression: "document.body?.innerText?.substring(0, 4000) || ''",
        returnByValue: true,
      });

      const title = titleResult?.result?.value || "Untitled";
      const url = urlResult?.result?.value || "unknown";
      const interactive = textResult_?.result?.value || "No interactive elements";
      const text = bodyText?.result?.value || "";

      return textResult(
        `📄 ${title}\n🔗 ${url}\n\n--- Interactive Elements ---\n${interactive}\n\n--- Page Text (excerpt) ---\n${text.substring(0, 3000)}`
      );
    } catch (err: any) {
      return textResult(`Error: ${err.message}`);
    }
  },
};

const SelectorParams = Type.Object({
  selector: Type.String({
    description: "CSS selector (e.g. '#submit', '.btn-primary', 'input[name=email]', 'a[href*=login]')",
  }),
});

export const browserClickTool: ToolDefinition = {
  name: "browser_click",
  label: "Browser Click",
  description: "Click an element by CSS selector.",
  parameters: SelectorParams,
  async execute(_id: string, params: Static<typeof SelectorParams>) {
    if (!browserEnabled()) return textResult(BROWSER_DISABLED_MSG);
    try {
      const ws = await getPageWs();
      const result = await cdpCommand(ws, "Runtime.evaluate", {
        expression: `(() => { const el = document.querySelector('${params.selector.replace(/'/g, "\\'")}'); if(!el) return 'Element not found: ${params.selector}'; el.click(); return 'clicked'; })()`,
        returnByValue: true,
      });
      return textResult(result?.result?.value || "Clicked");
    } catch (err: any) {
      return textResult(`Error: ${err.message}`);
    }
  },
};

const FillParams = Type.Object({
  selector: Type.String({ description: "CSS selector for the input element" }),
  text: Type.String({ description: "Text to fill" }),
});

export const browserFillTool: ToolDefinition = {
  name: "browser_fill",
  label: "Browser Fill",
  description: "Clear and fill an input element with text. Dispatches input events for React/Vue compatibility.",
  parameters: FillParams,
  async execute(_id: string, params: Static<typeof FillParams>) {
    if (!browserEnabled()) return textResult(BROWSER_DISABLED_MSG);
    try {
      const ws = await getPageWs();
      const escapedText = params.text.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      const result = await cdpCommand(ws, "Runtime.evaluate", {
        expression: `(() => {
          const el = document.querySelector('${params.selector.replace(/'/g, "\\'")}');
          if(!el) return 'Element not found';
          const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
            || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
          if(nativeInputValueSetter) nativeInputValueSetter.call(el, '${escapedText}');
          else el.value = '${escapedText}';
          el.dispatchEvent(new Event('input', {bubbles:true}));
          el.dispatchEvent(new Event('change', {bubbles:true}));
          return 'filled';
        })()`,
        returnByValue: true,
      });
      return textResult(result?.result?.value === "filled" ? `Filled ${params.selector}` : (result?.result?.value || "Fill failed"));
    } catch (err: any) {
      return textResult(`Error: ${err.message}`);
    }
  },
};

export const browserGetTextTool: ToolDefinition = {
  name: "browser_get_text",
  label: "Browser Get Text",
  description: "Get text content from a specific element or the full page.",
  parameters: Type.Object({
    selector: Type.Optional(Type.String({ description: "CSS selector (omit for full page)" })),
  }),
  async execute(_id: string, params: { selector?: string }) {
    if (!browserEnabled()) return textResult(BROWSER_DISABLED_MSG);
    try {
      const ws = await getPageWs();
      const expr = params.selector
        ? `document.querySelector('${params.selector.replace(/'/g, "\\'")}')?.innerText ?? 'Element not found'`
        : `document.body?.innerText?.substring(0, 8000) ?? ''`;
      const result = await cdpCommand(ws, "Runtime.evaluate", { expression: expr, returnByValue: true });
      return textResult(result?.result?.value ?? "No text");
    } catch (err: any) {
      return textResult(`Error: ${err.message}`);
    }
  },
};

export const browserScreenshotTool: ToolDefinition = {
  name: "browser_screenshot",
  label: "Browser Screenshot",
  description: "Take a screenshot and save to /tmp. Returns the file path.",
  parameters: Type.Object({
    full: Type.Optional(Type.Boolean({ description: "Capture full page" })),
  }),
  async execute(_id: string, params: { full?: boolean }) {
    if (!browserEnabled()) return textResult(BROWSER_DISABLED_MSG);
    try {
      const ws = await getPageWs();
      const result = await cdpCommand(ws, "Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: params.full ?? false,
      });
      if (result?.data) {
        const path = `/tmp/screenshot-${Date.now()}.png`;
        const fs = await import("fs");
        fs.writeFileSync(path, Buffer.from(result.data, "base64"));
        return textResult(`Screenshot saved: ${path}`);
      }
      return textResult("Screenshot failed — no data returned");
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
  description: "Evaluate JavaScript in the browser. Returns the result value.",
  parameters: EvalParams,
  async execute(_id: string, params: Static<typeof EvalParams>) {
    if (!browserEnabled()) return textResult(BROWSER_DISABLED_MSG);
    try {
      const ws = await getPageWs();
      const result = await cdpCommand(ws, "Runtime.evaluate", {
        expression: params.js,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result?.exceptionDetails) {
        return textResult(`JS Error: ${result.exceptionDetails.text || JSON.stringify(result.exceptionDetails)}`);
      }
      const val = result?.result?.value;
      return textResult(typeof val === "object" ? JSON.stringify(val, null, 2) : String(val ?? "undefined"));
    } catch (err: any) {
      return textResult(`Error: ${err.message}`);
    }
  },
};

export const browserCloseTool: ToolDefinition = {
  name: "browser_close",
  label: "Browser Close",
  description: "Reset browser state. Next operation will reconnect to Chrome sidecar.",
  parameters: Type.Object({}),
  async execute() {
    if (!browserEnabled()) return textResult(BROWSER_DISABLED_MSG);
    cachedWsUrl = null;
    return textResult("Browser state reset.");
  },
};

/**
 * All browser tools — conditionally registered when BROWSER_ENABLED=true.
 * Zero external dependencies — uses Node.js 22 native WebSocket + fetch.
 */
export const browserTools: ToolDefinition[] = [
  browserOpenTool,
  browserSnapshotTool,
  browserClickTool,
  browserFillTool,
  browserGetTextTool,
  browserScreenshotTool,
  browserEvalTool,
  browserCloseTool,
];
