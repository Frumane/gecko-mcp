#!/usr/bin/env node
/**
 * floorp-mcp — an MCP server that drives the Floorp browser through its
 * built-in automation API (http://127.0.0.1:58261, gated by
 * `floorp.mcp.enabled` in about:config).
 *
 * MVP tool surface: tab management, page reading, and screenshots, operating on
 * the user's real, logged-in session.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { FloorpClient, type TabInfo } from "./floorp-client.js";
import { realType, realKey, realClear } from "./os-input.js";

const client = new FloorpClient();

const server = new McpServer({
  name: "floorp-mcp",
  version: "0.4.0",
});

// -- helpers ------------------------------------------------------------------

/** Browser-internal pages (about:, chrome:, …) cannot be screenshotted. */
const PRIVILEGED_SCHEME = /^(about|chrome|resource|view-source|moz-extension):/i;

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
}

/** Resolve a browserId (default: active tab) and run `fn` against an attached
 *  instance, always detaching afterwards so the user's tab stays open. */
async function withAttachedTab<T>(
  browserId: string | undefined,
  fn: (instanceId: string, tab: TabInfo) => Promise<T>,
): Promise<T> {
  const tabs = await client.listTabs();
  const tab = browserId
    ? tabs.find((t) => t.browserId === String(browserId))
    : tabs.find((t) => t.selected);

  if (!tab) {
    throw new Error(
      browserId
        ? `No tab with browserId=${browserId}. Run list_tabs to see current tabs.`
        : "No active tab found.",
    );
  }
  if (!tab.browserId || tab.browserId === "0") {
    throw new Error(
      `Tab "${tab.title}" is not loaded yet (Floorp lazy-loads tabs). ` +
        `Click it in the browser to load it, then try again.`,
    );
  }

  const instanceId = await client.attach(tab.browserId);
  if (!instanceId) {
    throw new Error(`Could not attach to tab "${tab.title}" (browserId=${tab.browserId}).`);
  }
  try {
    return await fn(instanceId, tab);
  } finally {
    await client.detach(instanceId).catch(() => {});
  }
}

function formatTabList(tabs: TabInfo[]): string {
  if (tabs.length === 0) return "No open tabs.";
  return tabs
    .map((t, i) => {
      const marks = [t.selected ? "active" : null, t.pinned ? "pinned" : null]
        .filter(Boolean)
        .join(", ");
      const suffix = marks ? `  [${marks}]` : "";
      return `${i + 1}. ${t.title || "(untitled)"}${suffix}\n   ${t.url}\n   browserId: ${t.browserId}`;
    })
    .join("\n");
}

// -- tools --------------------------------------------------------------------

server.tool(
  "list_tabs",
  "List all open tabs in Floorp (title, URL, browserId, and whether each is active or pinned). Use the browserId to target other tools.",
  {},
  async () => {
    try {
      const tabs = await client.listTabs();
      return textResult(formatTabList(tabs));
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
);

server.tool(
  "open_tab",
  "Open a URL in a new Floorp tab.",
  {
    url: z.string().url().describe("The URL to open (must include http:// or https://)."),
    background: z
      .boolean()
      .optional()
      .describe("Open in the background without focusing the new tab. Default: false."),
  },
  async ({ url, background }) => {
    try {
      const instanceId = await client.createTab(url, { background, waitForLoad: true });
      const [title, uri, browserId] = await Promise.all([
        client.getTitle(instanceId),
        client.getUri(instanceId),
        client.getInstanceBrowserId(instanceId),
      ]);
      // Release the handle but leave the tab open for the user.
      await client.detach(instanceId).catch(() => {});
      return textResult(
        `Opened: ${title ?? "(untitled)"}\n${uri ?? url}` +
          (browserId
            ? `\nbrowserId: ${browserId}  — pass this as browserId to target this exact tab (reliable across multiple windows).`
            : ""),
      );
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
);

server.tool(
  "get_active_tab",
  "Return the active tab's title, URL and browserId. Note: with multiple browser windows open, 'active' is ambiguous — prefer the browserId returned by open_tab, or pick from list_tabs.",
  {},
  async () => {
    try {
      const tab = await client.activeTab();
      return textResult(`${tab.title || "(untitled)"}\n${tab.url}\nbrowserId: ${tab.browserId}`);
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
);

server.tool(
  "navigate_tab",
  "Navigate a tab to a new URL. Targets the active tab unless a browserId is given.",
  {
    url: z.string().url().describe("The URL to navigate to."),
    browserId: z
      .string()
      .optional()
      .describe("browserId of the tab to navigate (from list_tabs). Defaults to the active tab."),
  },
  async ({ url, browserId }) => {
    try {
      const result = await withAttachedTab(browserId, async (instanceId) => {
        await client.navigate(instanceId, url);
        return await client.getUri(instanceId);
      });
      return textResult(`Navigated to ${result ?? url}`);
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
);

server.tool(
  "close_tab",
  "Close a tab by its browserId (from list_tabs).",
  {
    browserId: z.string().describe("browserId of the tab to close (from list_tabs)."),
  },
  async ({ browserId }) => {
    try {
      const tabs = await client.listTabs();
      const tab = tabs.find((t) => t.browserId === String(browserId));
      if (!tab) return errorResult(`No tab with browserId=${browserId}.`);
      if (!tab.browserId || tab.browserId === "0") {
        return errorResult(`Tab "${tab.title}" is not loaded; cannot target it reliably.`);
      }
      const instanceId = await client.attach(tab.browserId);
      if (!instanceId) return errorResult(`Could not attach to tab "${tab.title}".`);
      await client.closeTab(instanceId);
      return textResult(`Closed: ${tab.title || tab.url}`);
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
);

server.tool(
  "read_page",
  "Read a tab's content. Returns clean Markdown by default; can also return raw HTML or the accessibility tree. Targets the active tab unless a browserId is given.",
  {
    browserId: z
      .string()
      .optional()
      .describe("browserId of the tab to read (from list_tabs). Defaults to the active tab."),
    format: z
      .enum(["markdown", "html", "accessibility"])
      .optional()
      .describe("Output format. Default: markdown."),
  },
  async ({ browserId, format }) => {
    try {
      const content = await withAttachedTab(browserId, async (instanceId, tab) => {
        const header = `# ${tab.title || "(untitled)"}\n${tab.url}\n\n`;
        if (format === "html") return header + (await client.getHtml(instanceId));
        if (format === "accessibility") {
          return header + JSON.stringify(await client.getAccessibilityTree(instanceId), null, 2);
        }
        return header + (await client.getText(instanceId));
      });
      return textResult(content);
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
);

server.tool(
  "screenshot",
  "Take a screenshot of a tab and return it as a PNG image. Targets the active tab unless a browserId is given.",
  {
    browserId: z
      .string()
      .optional()
      .describe("browserId of the tab to capture (from list_tabs). Defaults to the active tab."),
    fullPage: z
      .boolean()
      .optional()
      .describe("Capture the full scrollable page instead of just the viewport. Default: false."),
  },
  async ({ browserId, fullPage }) => {
    try {
      const image = await withAttachedTab(browserId, (instanceId, tab) => {
        if (PRIVILEGED_SCHEME.test(tab.url)) {
          throw new Error(
            `Cannot screenshot the browser-internal page "${tab.url}". ` +
              `Open a normal web page (http/https) and try again.`,
          );
        }
        return fullPage
          ? client.fullPageScreenshot(instanceId)
          : client.screenshot(instanceId);
      });
      if (!image) return errorResult("Floorp returned no image.");
      return {
        content: [{ type: "image" as const, data: image, mimeType: "image/png" }],
      };
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
);

server.tool(
  "click",
  "Click an element by CSS selector. Targets the active tab unless a browserId is given.",
  {
    selector: z
      .string()
      .describe('CSS selector of the element to click, e.g. "button[type=submit]" or "a.login".'),
    browserId: z.string().optional().describe("Target tab (from list_tabs). Defaults to active."),
    button: z.enum(["left", "right", "middle"]).optional().describe("Mouse button. Default: left."),
  },
  async ({ selector, browserId, button }) => {
    try {
      await withAttachedTab(browserId, (id) => client.click(id, selector, { button }));
      return textResult(`Clicked: ${selector}`);
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
);

server.tool(
  "type_text",
  "Type text into an input or textarea by CSS selector (clears it first by default). Targets the active tab unless a browserId is given.",
  {
    selector: z.string().describe("CSS selector of the input/textarea."),
    text: z.string().describe("The text to type."),
    clear: z.boolean().optional().describe("Clear the field before typing. Default: true."),
    browserId: z.string().optional().describe("Target tab (from list_tabs). Defaults to active."),
  },
  async ({ selector, text, clear, browserId }) => {
    try {
      const method = await withAttachedTab(browserId, async (id) => {
        if (clear !== false) await client.clearInput(id, selector).catch(() => {});
        try {
          await client.input(id, selector, text);
          return "input";
        } catch {
          // Rich / contenteditable editors (Slate, ProseMirror, Lexical…) have no
          // `.value`, so `input` fails. Fall back to a real text-input event.
          await client.dispatchTextInput(id, selector, text);
          return "rich-text";
        }
      });
      return textResult(`Typed into ${selector} (${method}).`);
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
);

server.tool(
  "fill_form",
  "Fill multiple form fields at once. `fields` maps CSS selectors (or field names) to values. Targets the active tab unless a browserId is given.",
  {
    fields: z
      .record(z.string())
      .describe('Map of selector/name to value, e.g. { "#email": "a@b.com", "#password": "secret" }.'),
    browserId: z.string().optional().describe("Target tab (from list_tabs). Defaults to active."),
  },
  async ({ fields, browserId }) => {
    try {
      await withAttachedTab(browserId, (id) => client.fillForm(id, fields));
      return textResult(`Filled ${Object.keys(fields).length} field(s).`);
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
);

server.tool(
  "press_key",
  'Press a keyboard key in the page (e.g. "Enter", "Tab", "Escape", "ArrowDown"). Targets the active tab unless a browserId is given.',
  {
    key: z.string().describe('Key name, e.g. "Enter".'),
    browserId: z.string().optional().describe("Target tab (from list_tabs). Defaults to active."),
  },
  async ({ key, browserId }) => {
    try {
      await withAttachedTab(browserId, (id) => client.pressKey(id, key));
      return textResult(`Pressed: ${key}`);
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
);

server.tool(
  "wait_for_element",
  "Wait for an element to reach a state (attached / visible / hidden / detached). Useful after navigation or actions that load content.",
  {
    selector: z.string().describe("CSS selector to wait for."),
    state: z
      .enum(["attached", "visible", "hidden", "detached"])
      .optional()
      .describe("State to wait for. Default: visible."),
    timeoutMs: z.number().optional().describe("Timeout in milliseconds. Default: 5000."),
    browserId: z.string().optional().describe("Target tab (from list_tabs). Defaults to active."),
  },
  async ({ selector, state, timeoutMs, browserId }) => {
    try {
      const found = await withAttachedTab(browserId, (id) =>
        client.waitForElement(id, selector, state, timeoutMs),
      );
      return found
        ? textResult(`Element "${selector}" is ${state ?? "visible"}.`)
        : errorResult(`Timed out waiting for "${selector}".`);
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
);

server.tool(
  "get_value",
  "Read the current value of an input, textarea, or select by CSS selector. Targets the active tab unless a browserId is given.",
  {
    selector: z.string().describe("CSS selector of the field to read."),
    browserId: z.string().optional().describe("Target tab (from list_tabs). Defaults to active."),
  },
  async ({ selector, browserId }) => {
    try {
      const value = await withAttachedTab(browserId, (id) => client.getValue(id, selector));
      return textResult(value ?? "(no value)");
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
);

// -- OS-level (real) keyboard input (Windows) ---------------------------------
// These send genuine OS key events (isTrusted=true) to Floorp's focused element,
// which fixes React/Slate-controlled editors that ignore synthetic input. They
// bring Floorp to the foreground and ABORT without typing if that fails, so keys
// can never leak into another app. Focus the field first (e.g. with `click`).

server.tool(
  "real_type",
  "Type text into Floorp's currently focused element using REAL OS keyboard events (isTrusted). Use for React/rich editors where `type_text` silently fails. Focus the field first with `click`. Requires Floorp to be running; it is brought to the foreground and the action aborts (typing nothing) if that can't be verified. Windows only.",
  {
    text: z.string().describe("The text to type via the real keyboard."),
  },
  async ({ text }) => {
    try {
      await realType(text);
      return textResult(`Typed (real keyboard): ${text.length} chars.`);
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
);

server.tool(
  "real_key",
  'Press a key or combo via REAL OS keyboard events, e.g. "Enter", "Tab", "Escape", "ctrl+a", "ctrl+shift+k". Use "Enter" to submit React composers that ignore synthetic clicks. Focus the field first. Windows only.',
  {
    key: z.string().describe('Key or combo, e.g. "Enter" or "ctrl+a".'),
  },
  async ({ key }) => {
    try {
      await realKey(key);
      return textResult(`Pressed (real keyboard): ${key}`);
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
);

server.tool(
  "real_clear",
  "Select-all + delete via REAL OS keyboard events — reliably clears a focused rich/contenteditable editor (where synthetic Ctrl+A does not work). Focus the field first with `click`. Windows only.",
  {},
  async () => {
    try {
      await realClear();
      return textResult("Cleared focused field (real keyboard).");
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
);

// -- startup ------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is safe; stdout is reserved for the MCP protocol.
  console.error("floorp-mcp server running on stdio");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
