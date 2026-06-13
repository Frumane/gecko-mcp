#!/usr/bin/env node
/**
 * floorp-mcp — an MCP server that drives the Floorp browser through its
 * built-in automation API (http://127.0.0.1:58261, gated by
 * `floorp.mcp.enabled` in about:config).
 *
 * MVP tool surface: tab management, page reading, and screenshots, operating on
 * the user's real, logged-in session.
 */

import { McpServer, type ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { FloorpClient, type TabInfo } from "./floorp-client.js";
import { realType, realKey, realClear, moveCursor, realClick, floorpWindowBounds } from "./os-input.js";
import { launchFloorp } from "./launch.js";
import { PRIVILEGED_SCHEME, assertNavigableUrl, assertUploadAllowed } from "./guards.js";
import { findInHtml } from "./html-find.js";
import { ANNOTATIONS } from "./annotations.js";

const client = new FloorpClient();

const server = new McpServer({
  name: "floorp-mcp",
  version: "1.7.0",
});

// -- helpers ------------------------------------------------------------------
// URL/upload guards live in ./guards, the `find` HTML search in ./html-find —
// both pure and unit-tested (test/unit/) without a live Floorp.

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
}

/** Register a tool, attaching its MCP annotations from ANNOTATIONS by name. */
function regTool<S extends z.ZodRawShape>(
  name: string,
  description: string,
  schema: S,
  cb: ToolCallback<S>,
): void {
  const annotations = ANNOTATIONS[name];
  if (annotations) server.tool(name, description, schema, annotations, cb);
  else server.tool(name, description, schema, cb);
}

/** Resolve a browserId (default: active tab) and run `fn` against an attached
 *  instance, always detaching afterwards so the user's tab stays open.
 *
 *  Fast path: when a `browserId` is given and the caller doesn't need tab
 *  metadata (`opts.needTab`), we attach directly and skip the `listTabs`
 *  round-trip — most action tools (click/type/find/…) only use the instanceId.
 *  Tools that read `tab.url`/`tab.title` (screenshot, read_page) pass
 *  `needTab: true` to force the full lookup. */
async function withAttachedTab<T>(
  browserId: string | undefined,
  fn: (instanceId: string, tab: TabInfo) => Promise<T>,
  opts: { needTab?: boolean } = {},
): Promise<T> {
  let tab: TabInfo;

  if (browserId && !opts.needTab) {
    // Fast path — no listTabs; attach straight to the requested tab.
    if (String(browserId) === "0") {
      throw new Error(
        `Tab browserId=0 is not loaded yet (Floorp lazy-loads tabs). ` +
          `Click it in the browser to load it, then try again.`,
      );
    }
    tab = { browserId: String(browserId), windowId: "", title: "", url: "", selected: false, pinned: false };
  } else {
    const tabs = await client.listTabs();
    const found = browserId
      ? tabs.find((t) => t.browserId === String(browserId))
      : tabs.find((t) => t.selected);
    if (!found) {
      throw new Error(
        browserId
          ? `No tab with browserId=${browserId}. Run list_tabs to see current tabs.`
          : "No active tab found.",
      );
    }
    if (!found.browserId || found.browserId === "0") {
      throw new Error(
        `Tab "${found.title}" is not loaded yet (Floorp lazy-loads tabs). ` +
          `Click it in the browser to load it, then try again.`,
      );
    }
    tab = found;
  }

  const instanceId = await client.attach(tab.browserId);
  if (!instanceId) {
    throw new Error(
      `Could not attach to tab (browserId=${tab.browserId}). ` +
        `It may not be loaded yet — run list_tabs to check.`,
    );
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

regTool(
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

regTool(
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
      assertNavigableUrl(url);
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

regTool(
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

regTool(
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
      assertNavigableUrl(url);
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

regTool(
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

regTool(
  "read_page",
  "Read a tab's content. Returns clean Markdown by default; can also return raw HTML or the accessibility tree. Output is capped (default 25 KB) to protect the context — to LOCATE a specific element use `find` (cheaper) instead. Targets the active tab unless a browserId is given.",
  {
    browserId: z
      .string()
      .optional()
      .describe("browserId of the tab to read (from list_tabs). Defaults to the active tab."),
    format: z
      .enum(["markdown", "html", "accessibility"])
      .optional()
      .describe("Output format. Default: markdown."),
    maxChars: z
      .number()
      .int()
      .min(0)
      .max(5_000_000)
      .optional()
      .describe("Truncate output to this many characters. Default 25000. Pass 0 for no cap."),
  },
  async ({ browserId, format, maxChars }) => {
    try {
      const content = await withAttachedTab(browserId, async (instanceId, tab) => {
        const header = `# ${tab.title || "(untitled)"}\n${tab.url}\n\n`;
        if (format === "html") return header + (await client.getHtml(instanceId));
        if (format === "accessibility") {
          return header + JSON.stringify(await client.getAccessibilityTree(instanceId), null, 2);
        }
        return header + (await client.getText(instanceId));
      }, { needTab: true });
      const cap = maxChars ?? 25000;
      if (cap > 0 && content.length > cap) {
        return textResult(
          content.slice(0, cap) +
            `\n\n…[truncated ${content.length - cap} of ${content.length} chars. ` +
            `Use 'find' to locate an element, 'snapshot' for a ref map, or raise maxChars.]`,
        );
      }
      return textResult(content);
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
);

regTool(
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
      }, { needTab: true });
      if (!image) return errorResult("Floorp returned no image.");
      return {
        content: [{ type: "image" as const, data: image, mimeType: "image/png" }],
      };
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
);

regTool(
  "find",
  "Locate elements on a tab by visible text and/or tag and get a ready-to-use CSS `selector` for each — one fast call that searches the page server-side and returns ~1 KB instead of the whole HTML. Use this INSTEAD of read_page to find a button, link, or field, then pass the returned selector straight to click/type/etc. Provide `text`, `tag`, or both. Active tab unless browserId given.",
  {
    text: z
      .string()
      .optional()
      .describe("Visible text to match (substring, case-insensitive)."),
    tag: z
      .string()
      .optional()
      .describe('Restrict to a tag, e.g. "button", "a", "input", "select".'),
    limit: z.number().int().min(1).max(1000).optional().describe("Max matches to return. Default 25."),
    browserId: z.string().optional().describe("Target tab (from list_tabs). Defaults to active."),
  },
  async ({ text, tag, limit, browserId }) => {
    try {
      if (!text && !tag) return errorResult("Provide `text` and/or `tag` to search for.");
      const html = await withAttachedTab(browserId, (id) => client.getHtml(id));
      const found = findInHtml(html, { text, tag, limit: limit ?? 25 });
      if (!found.length) return textResult("No matching elements found.");
      return textResult(
        `${found.length} match(es) — selector | tag | text:\n` +
          found
            .map((f) => `${f.selector}  |  ${f.tag}  |  ${JSON.stringify(f.text.slice(0, 60))}`)
            .join("\n"),
      );
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
);

regTool(
  "click",
  "Click an element by CSS selector OR by a `ref` (fingerprint) from `snapshot`. Auto-scrolls the element into view first (fixes off-screen 'not actionable'). Targets the active tab unless a browserId is given.",
  {
    selector: z
      .string()
      .optional()
      .describe('CSS selector, e.g. "button[type=submit]" or "a.login".'),
    ref: z
      .string()
      .optional()
      .describe('A fingerprint ref from `snapshot` (the value after "fp:"), as an alternative to selector.'),
    browserId: z.string().optional().describe("Target tab (from list_tabs). Defaults to active."),
    button: z.enum(["left", "right", "middle"]).optional().describe("Mouse button. Default: left."),
  },
  async ({ selector, ref, browserId, button }) => {
    try {
      if (!selector && !ref) return errorResult("Provide a `selector` or a `ref`.");
      await withAttachedTab(browserId, (id) => client.click(id, selector, { button, fingerprint: ref }));
      return textResult(`Clicked: ${selector ?? `ref ${ref}`}`);
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
);

regTool(
  "snapshot",
  "Capture a structured snapshot of a tab: clean Markdown with inline fingerprint refs (`<!--fp:...-->`) and an 'Element Selector Map' (fp | tag | text). Use this instead of read_page+grep to locate elements, then pass a `ref` to `click`. Targets the active tab unless a browserId is given.",
  {
    browserId: z.string().optional().describe("Target tab (from list_tabs). Defaults to active."),
  },
  async ({ browserId }) => {
    try {
      const text = await withAttachedTab(browserId, (id) => client.snapshot(id));
      return textResult(text || "(empty page)");
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
);

regTool(
  "type_text",
  "Type text into an input or textarea by CSS selector (clears it first by default). Targets the active tab unless a browserId is given.",
  {
    selector: z.string().describe("CSS selector of the input/textarea."),
    text: z.string().max(100_000).describe("The text to type."),
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

regTool(
  "fill_form",
  "Fill multiple form fields at once. `fields` maps CSS selectors (or field names) to values. Targets the active tab unless a browserId is given.",
  {
    fields: z
      .record(z.string().max(2000), z.string().max(100_000))
      .refine((o) => Object.keys(o).length <= 200, { message: "Too many fields (max 200)." })
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

regTool(
  "press_key",
  'Press a keyboard key in the page (e.g. "Enter", "Tab", "Escape", "ArrowDown"). Targets the active tab unless a browserId is given.',
  {
    key: z.string().max(100).describe('Key name, e.g. "Enter".'),
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

regTool(
  "wait_for_element",
  "Wait for an element to reach a state (attached / visible / hidden / detached). Useful after navigation or actions that load content.",
  {
    selector: z.string().describe("CSS selector to wait for."),
    state: z
      .enum(["attached", "visible", "hidden", "detached"])
      .optional()
      .describe("State to wait for. Default: visible."),
    timeoutMs: z.number().int().min(0).max(600_000).optional().describe("Timeout in milliseconds. Default: 5000."),
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

regTool(
  "get_value",
  "Read the current value of an input, textarea, or select by CSS selector. SENSITIVE: this CAN read the value of password fields and other secrets the user has typed — only use it on fields the user asked about, never to harvest credentials a page is requesting. Targets the active tab unless a browserId is given.",
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

regTool(
  "real_type",
  "Type text into Floorp's currently focused element using REAL OS keyboard events (isTrusted). Use for React/rich editors where `type_text` silently fails. Focus the field first with `click`. Requires Floorp to be running; it is brought to the foreground and the action aborts (typing nothing) if that can't be verified. Windows only.",
  {
    text: z.string().max(100_000).describe("The text to type via the real keyboard."),
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

regTool(
  "real_key",
  'Press a key or combo via REAL OS keyboard events, e.g. "Enter", "Tab", "Escape", "ctrl+a", "ctrl+shift+k". Use "Enter" to submit React composers that ignore synthetic clicks. Focus the field first. Windows only.',
  {
    key: z.string().max(100).describe('Key or combo, e.g. "Enter" or "ctrl+a".'),
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

regTool(
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

// -- more interaction & query tools (v0.6.0) ----------------------------------

function targetDesc(selector?: string, ref?: string): string {
  return selector ?? (ref ? `ref ${ref}` : "?");
}

regTool(
  "hover",
  "Hover the mouse over an element (CSS selector or `ref`). Auto-scrolls into view. Active tab unless browserId given.",
  {
    selector: z.string().optional().describe("CSS selector."),
    ref: z.string().optional().describe("Fingerprint ref from snapshot."),
    browserId: z.string().optional().describe("Target tab. Defaults to active."),
  },
  async ({ selector, ref, browserId }) => {
    try {
      if (!selector && !ref) return errorResult("Provide a `selector` or a `ref`.");
      await withAttachedTab(browserId, (id) => client.hover(id, selector, ref));
      return textResult(`Hovered: ${targetDesc(selector, ref)}`);
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
);

regTool(
  "double_click",
  "Double-click an element (CSS selector or `ref`). Auto-scrolls into view. Active tab unless browserId given.",
  {
    selector: z.string().optional().describe("CSS selector."),
    ref: z.string().optional().describe("Fingerprint ref from snapshot."),
    browserId: z.string().optional().describe("Target tab. Defaults to active."),
  },
  async ({ selector, ref, browserId }) => {
    try {
      if (!selector && !ref) return errorResult("Provide a `selector` or a `ref`.");
      await withAttachedTab(browserId, (id) => client.doubleClick(id, selector, ref));
      return textResult(`Double-clicked: ${targetDesc(selector, ref)}`);
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
);

regTool(
  "right_click",
  "Right-click (context menu) an element (CSS selector or `ref`). Auto-scrolls into view. Active tab unless browserId given.",
  {
    selector: z.string().optional().describe("CSS selector."),
    ref: z.string().optional().describe("Fingerprint ref from snapshot."),
    browserId: z.string().optional().describe("Target tab. Defaults to active."),
  },
  async ({ selector, ref, browserId }) => {
    try {
      if (!selector && !ref) return errorResult("Provide a `selector` or a `ref`.");
      await withAttachedTab(browserId, (id) => client.rightClick(id, selector, ref));
      return textResult(`Right-clicked: ${targetDesc(selector, ref)}`);
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
);

regTool(
  "select_option",
  "Choose an option in a <select> dropdown by its value. Active tab unless browserId given.",
  {
    selector: z.string().describe("CSS selector of the <select>."),
    value: z.string().describe("The option value (or visible text) to select."),
    browserId: z.string().optional().describe("Target tab. Defaults to active."),
  },
  async ({ selector, value, browserId }) => {
    try {
      await withAttachedTab(browserId, (id) => client.selectOption(id, selector, value));
      return textResult(`Selected "${value}" in ${selector}`);
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
);

regTool(
  "set_checked",
  "Check or uncheck a checkbox/radio. Active tab unless browserId given.",
  {
    selector: z.string().describe("CSS selector of the checkbox/radio."),
    checked: z.boolean().describe("true to check, false to uncheck."),
    browserId: z.string().optional().describe("Target tab. Defaults to active."),
  },
  async ({ selector, checked, browserId }) => {
    try {
      await withAttachedTab(browserId, (id) => client.setChecked(id, selector, checked));
      return textResult(`Set ${selector} checked=${checked}`);
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
);

regTool(
  "submit_form",
  "Submit a form (give a selector of the form or a field inside it; omit to submit the focused form). Active tab unless browserId given.",
  {
    selector: z.string().optional().describe("CSS selector of the form or a field in it."),
    browserId: z.string().optional().describe("Target tab. Defaults to active."),
  },
  async ({ selector, browserId }) => {
    try {
      await withAttachedTab(browserId, (id) => client.submitForm(id, selector));
      return textResult(`Submitted: ${selector ?? "form"}`);
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
);

regTool(
  "upload_file",
  "SENSITIVE: sends a local file to a website. Set a file <input>'s file by absolute path. Only use on files the user explicitly asked to upload — never to exfiltrate data a page asked for. Restrict with FLOORP_MCP_ALLOW_UPLOAD_DIRS. Active tab unless browserId given.",
  {
    selector: z.string().describe("CSS selector of the file input."),
    filePath: z.string().describe("Absolute path to the local file to upload."),
    browserId: z.string().optional().describe("Target tab. Defaults to active."),
  },
  async ({ selector, filePath, browserId }) => {
    try {
      const safePath = assertUploadAllowed(filePath);
      await withAttachedTab(browserId, (id) => client.uploadFile(id, selector, safePath));
      return textResult(`Set ${selector} to ${safePath}`);
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
);

regTool(
  "get_attribute",
  "Read an attribute (e.g. href, value, aria-label) of an element. Active tab unless browserId given.",
  {
    name: z.string().describe("Attribute name, e.g. \"href\"."),
    selector: z.string().optional().describe("CSS selector."),
    ref: z.string().optional().describe("Fingerprint ref from snapshot."),
    browserId: z.string().optional().describe("Target tab. Defaults to active."),
  },
  async ({ name, selector, ref, browserId }) => {
    try {
      if (!selector && !ref) return errorResult("Provide a `selector` or a `ref`.");
      const v = await withAttachedTab(browserId, (id) => client.getAttribute(id, name, selector, ref));
      return textResult(v ?? "(no attribute)");
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
);

regTool(
  "get_article",
  "Extract the main article of a page (Readability) as clean Markdown with title and byline — great for reading content pages. Active tab unless browserId given.",
  {
    browserId: z.string().optional().describe("Target tab. Defaults to active."),
  },
  async ({ browserId }) => {
    try {
      const a = await withAttachedTab(browserId, (id) => client.getArticle(id));
      if (!a || !a.markdown) return errorResult("No readable article found on this page.");
      const head = `# ${a.title ?? "(untitled)"}${a.byline ? `\n*${a.byline}*` : ""}\n\n`;
      return textResult(head + a.markdown);
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
);

regTool(
  "get_cookies",
  "SENSITIVE: list cookies visible to the current page. Values (session tokens!) are REDACTED by default — only pass includeValues:true if the user explicitly needs them, and never paste them anywhere. Active tab unless browserId given.",
  {
    browserId: z.string().optional().describe("Target tab. Defaults to active."),
    includeValues: z
      .boolean()
      .optional()
      .describe("Include raw cookie values (session tokens — highly sensitive). Default: false."),
  },
  async ({ browserId, includeValues }) => {
    try {
      const c = await withAttachedTab(browserId, (id) => client.getCookies(id));
      const out = includeValues
        ? c
        : (c as unknown[]).map((k) =>
            k && typeof k === "object" && "value" in (k as Record<string, unknown>)
              ? {
                  ...(k as Record<string, unknown>),
                  value: `(redacted ${String((k as Record<string, unknown>).value).length} chars — pass includeValues:true if truly needed)`,
                }
              : k,
          );
      return textResult(JSON.stringify(out, null, 2));
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
);

regTool(
  "wait_for_network_idle",
  "Wait until the page's network activity settles (useful after navigation or SPA actions). Active tab unless browserId given.",
  {
    timeoutMs: z.number().int().min(0).max(600_000).optional().describe("Max wait in ms. Default: 8000."),
    browserId: z.string().optional().describe("Target tab. Defaults to active."),
  },
  async ({ timeoutMs, browserId }) => {
    try {
      const ok = await withAttachedTab(browserId, (id) => client.waitForNetworkIdle(id, timeoutMs));
      return ok ? textResult("Network is idle.") : errorResult("Network did not become idle in time.");
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
);

regTool(
  "list_workspaces",
  "List Floorp workspaces (id and name). Floorp-specific.",
  {},
  async () => {
    try {
      const ws = await client.listWorkspaces();
      if (!ws.length) return textResult("No workspaces.");
      return textResult(ws.map((w) => `${w.id}  ${w.name}`).join("\n"));
    } catch (err) {
      const m = (err as Error).message;
      if (/404|not found/i.test(m)) {
        return errorResult("The Workspaces API isn't available on this Floorp build.");
      }
      return errorResult(m);
    }
  },
);

regTool(
  "switch_workspace",
  "Switch to a Floorp workspace by id (from list_workspaces). Floorp-specific.",
  {
    id: z.string().describe("Workspace id."),
  },
  async ({ id }) => {
    try {
      const ok = await client.switchWorkspace(id);
      return ok ? textResult(`Switched to workspace ${id}`) : errorResult("Switch failed.");
    } catch (err) {
      const m = (err as Error).message;
      if (/404|not found/i.test(m)) {
        return errorResult("The Workspaces API isn't available on this Floorp build.");
      }
      return errorResult(m);
    }
  },
);

// -- OS-level (real) mouse (Windows) (v1.0.0) ---------------------------------
// Coordinates are SCREEN pixels and must fall inside the Floorp window. Call
// window_bounds first to get the valid range. Same foreground guard as the
// keyboard, plus a bounds check, so a click can never land in another app.

regTool(
  "window_bounds",
  "Return Floorp's window rectangle in screen pixels (left, top, right, bottom, width, height). Use this to compute coordinates for move_cursor / real_click. Windows only.",
  {},
  async () => {
    try {
      const b = await floorpWindowBounds();
      return textResult(
        `Floorp window (screen px): left=${b.left} top=${b.top} right=${b.right} bottom=${b.bottom} (${b.width}x${b.height})`,
      );
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
);

regTool(
  "move_cursor",
  "Move the REAL OS cursor to a screen pixel (must be inside the Floorp window). Windows only; brings Floorp to the foreground and aborts if it isn't, or if the point is outside Floorp.",
  {
    x: z.number().int().min(-100_000).max(100_000).describe("Screen X (pixels)."),
    y: z.number().int().min(-100_000).max(100_000).describe("Screen Y (pixels)."),
  },
  async ({ x, y }) => {
    try {
      await moveCursor(x, y);
      return textResult(`Moved cursor to (${x}, ${y}).`);
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
);

regTool(
  "real_click",
  "Click with the REAL OS mouse at a screen pixel inside the Floorp window (genuine, isTrusted click). Use window_bounds to find the range. Refuses to click outside Floorp or if Floorp isn't foreground. Windows only.",
  {
    x: z.number().int().min(-100_000).max(100_000).describe("Screen X (pixels)."),
    y: z.number().int().min(-100_000).max(100_000).describe("Screen Y (pixels)."),
    button: z.enum(["left", "right"]).optional().describe("Mouse button. Default: left."),
    double: z.boolean().optional().describe("Double-click. Default: false."),
  },
  async ({ x, y, button, double }) => {
    try {
      await realClick(x, y, { button, double });
      return textResult(`${double ? "Double-" : ""}${button === "right" ? "Right-" : ""}clicked at (${x}, ${y}).`);
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
);

regTool(
  "launch_floorp",
  "Ensure Floorp is running: if its automation API isn't reachable, launch the Floorp app and wait for it to come up. No-op if already running. Windows only (set FLOORP_PATH to override the exe location).",
  {},
  async () => {
    try {
      return textResult(await launchFloorp(client));
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
);

// -- startup ------------------------------------------------------------------

// `floorp-mcp setup` (also install/init/config/add) opens the interactive setup
// wizard; with no subcommand it runs the MCP server on stdio (what MCP clients use).
const SETUP_CMDS = new Set(["setup", "install", "init", "config", "add"]);

async function main() {
  const sub = process.argv[2];
  if (sub && SETUP_CMDS.has(sub)) {
    const { runSetup } = await import("./setup.js");
    await runSetup(process.argv.slice(3));
    return;
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is safe; stdout is reserved for the MCP protocol.
  console.error("floorp-mcp server running on stdio");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
