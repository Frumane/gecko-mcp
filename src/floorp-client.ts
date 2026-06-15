/**
 * Thin HTTP client for Floorp's built-in automation API.
 *
 * Floorp exposes this API on http://127.0.0.1:58261 once `floorp.mcp.enabled`
 * is set to `true` in about:config. The model is instance-based: to operate on
 * a tab you first obtain an `instanceId` (by attaching to an existing tab or by
 * creating a new one), then issue per-instance commands.
 *
 * Lifecycle (verified against a live Floorp):
 *   - attach(browserId)            -> ephemeral handle to an EXISTING tab
 *   - createTab(url)               -> opens a NEW tab, returns a handle
 *   - detach(instanceId)  [DELETE] -> releases the handle, tab stays open
 *   - closeTab(instanceId) [close] -> actually closes the tab
 */

export interface TabInfo {
  browserId: string;
  windowId: string;
  title: string;
  url: string;
  selected: boolean;
  pinned: boolean;
}

export interface CreateTabOptions {
  background?: boolean;
  waitForLoad?: boolean;
}

export type TextMode = "full" | "scoped" | "visible";

export type ElementState = "attached" | "visible" | "hidden" | "detached";

export interface EvaluateResult {
  success: boolean;
  result?: unknown;
  resultType?: string;
  error?: string;
  errorType?: string;
}

import { envCfg } from "./env.js";

const DATA_URL_PREFIX = /^data:image\/[a-z]+;base64,/;

/**
 * The browser operations the MCP tools rely on. Implemented by `FloorpClient`
 * (Floorp's :58261 API) and `MarionetteBackend` (any Gecko browser over
 * Marionette), so the same tools work across all Firefox-based browsers.
 * The `instanceId` is an opaque per-tab handle whose meaning is backend-specific.
 */
export interface BrowserBackend {
  health(): Promise<boolean>;
  listTabs(): Promise<TabInfo[]>;
  activeTab(): Promise<TabInfo>;
  createTab(url: string, opts?: CreateTabOptions): Promise<string>;
  getInstanceBrowserId(instanceId: string): Promise<string | null>;
  attach(browserId: string): Promise<string | null>;
  detach(instanceId: string): Promise<void>;
  closeTab(instanceId: string): Promise<void>;
  navigate(instanceId: string, url: string): Promise<void>;
  getUri(instanceId: string): Promise<string | null>;
  getTitle(instanceId: string): Promise<string | null>;
  getText(instanceId: string, mode?: TextMode): Promise<string>;
  getHtml(instanceId: string, selector?: string): Promise<string>;
  getAccessibilityTree(instanceId: string): Promise<unknown>;
  screenshot(instanceId: string): Promise<string | null>;
  fullPageScreenshot(instanceId: string): Promise<string | null>;
  snapshot(instanceId: string, mode?: TextMode): Promise<string>;
  click(
    instanceId: string,
    selector?: string,
    opts?: { button?: "left" | "right" | "middle"; clickCount?: number; force?: boolean; fingerprint?: string },
  ): Promise<void>;
  input(
    instanceId: string,
    selector: string,
    value: string,
    opts?: { typingMode?: boolean; typingDelayMs?: number },
  ): Promise<void>;
  clearInput(instanceId: string, selector: string): Promise<void>;
  dispatchTextInput(instanceId: string, selector: string, text: string): Promise<void>;
  fillForm(instanceId: string, formData: Record<string, string>): Promise<void>;
  pressKey(instanceId: string, key: string): Promise<void>;
  waitForElement(instanceId: string, selector: string, state?: ElementState, timeout?: number): Promise<boolean>;
  getValue(instanceId: string, selector: string): Promise<string | null>;
  hover(instanceId: string, selector?: string, fingerprint?: string): Promise<void>;
  doubleClick(instanceId: string, selector?: string, fingerprint?: string): Promise<void>;
  rightClick(instanceId: string, selector?: string, fingerprint?: string): Promise<void>;
  selectOption(instanceId: string, selector: string, value: string): Promise<void>;
  setChecked(instanceId: string, selector: string, checked: boolean): Promise<void>;
  submitForm(instanceId: string, selector?: string): Promise<void>;
  uploadFile(instanceId: string, selector: string, filePath: string): Promise<void>;
  getAttribute(instanceId: string, name: string, selector?: string, fingerprint?: string): Promise<string | null>;
  getArticle(instanceId: string): Promise<{ title?: string; byline?: string; markdown?: string; length?: number } | null>;
  getCookies(instanceId: string): Promise<unknown[]>;
  waitForNetworkIdle(instanceId: string, timeout?: number): Promise<boolean>;
  evaluate(instanceId: string, script: string): Promise<EvaluateResult>;
  listWorkspaces(): Promise<Array<{ id: string; name: string }>>;
  switchWorkspace(id: string): Promise<boolean>;
}

export class FloorpClient implements BrowserBackend {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(
    port: number = Number(envCfg("PORT")) || 58261,
    token: string = envCfg("TOKEN") ?? "",
  ) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(
        `Invalid Floorp API port "${port}" — must be an integer 1–65535 (check GECKO_MCP_PORT).`,
      );
    }
    this.baseUrl = `http://127.0.0.1:${port}`;
    this.token = token;
  }

  // -- low level --------------------------------------------------------------

  private async request<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (this.token) headers["Authorization"] = `Bearer ${this.token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new Error(
        `Cannot reach Floorp at ${this.baseUrl}. Is Floorp running with ` +
          `'floorp.mcp.enabled' set to true in about:config? (${(err as Error).message})`,
      );
    }

    if (!res.ok) {
      const raw = await res.text().catch(() => "");
      // Truncate so a large/unexpected error body can't dump page data into the model.
      const text = raw.length > 500 ? raw.slice(0, 500) + "…[truncated]" : raw;
      throw new Error(`Floorp API ${res.status} on ${path}: ${text}`);
    }
    return (await res.json()) as T;
  }

  private static stripImagePrefix(data: string): string {
    return data.replace(DATA_URL_PREFIX, "");
  }

  // -- browser-level ----------------------------------------------------------

  async health(): Promise<boolean> {
    try {
      const r = await this.request<{ status: string }>("GET", "/health");
      return r.status === "ok";
    } catch {
      return false;
    }
  }

  async listTabs(): Promise<TabInfo[]> {
    return this.request<TabInfo[]>("GET", "/tabs/list");
  }

  /** The currently selected tab. Throws if none is reported. */
  async activeTab(): Promise<TabInfo> {
    const tabs = await this.listTabs();
    const active = tabs.find((t) => t.selected);
    if (!active) throw new Error("No active tab reported by Floorp.");
    return active;
  }

  // -- instance lifecycle -----------------------------------------------------

  /** Open a NEW tab and return its instance handle. */
  async createTab(url: string, opts: CreateTabOptions = {}): Promise<string> {
    const r = await this.request<{ instanceId: string }>(
      "POST",
      "/tabs/instances",
      {
        url,
        inBackground: opts.background ?? false,
        waitForLoad: opts.waitForLoad ?? true,
      },
    );
    return r.instanceId;
  }

  /** Resolve the live browserId behind an instance handle. */
  async getInstanceBrowserId(instanceId: string): Promise<string | null> {
    const r = await this.request<{ browserId?: string }>(
      "GET",
      `/tabs/instances/${encodeURIComponent(instanceId)}`,
    );
    return r.browserId ?? null;
  }

  /** Attach an ephemeral handle to an EXISTING tab. */
  async attach(browserId: string): Promise<string | null> {
    const r = await this.request<{ instanceId: string | null }>(
      "POST",
      "/tabs/attach",
      { browserId: String(browserId) },
    );
    return r.instanceId;
  }

  /** Release a handle WITHOUT closing the tab. */
  async detach(instanceId: string): Promise<void> {
    await this.request<{ ok: boolean }>("DELETE", `/tabs/instances/${encodeURIComponent(instanceId)}`);
  }

  /** Actually close the tab behind a handle. */
  async closeTab(instanceId: string): Promise<void> {
    await this.request<{ ok: boolean }>(
      "POST",
      `/tabs/instances/${encodeURIComponent(instanceId)}/close`,
    );
  }

  // -- per-instance reads / actions ------------------------------------------

  async navigate(instanceId: string, url: string): Promise<void> {
    await this.request<{ ok: boolean }>(
      "POST",
      `/tabs/instances/${encodeURIComponent(instanceId)}/navigate`,
      { url },
    );
  }

  async getUri(instanceId: string): Promise<string | null> {
    const r = await this.request<{ uri: string | null }>(
      "GET",
      `/tabs/instances/${encodeURIComponent(instanceId)}/uri`,
    );
    return r.uri;
  }

  async getTitle(instanceId: string): Promise<string | null> {
    const r = await this.request<{ title?: string }>(
      "GET",
      `/tabs/instances/${encodeURIComponent(instanceId)}/title`,
    );
    return r.title ?? null;
  }

  /** Page content as clean Markdown. */
  async getText(instanceId: string, mode: TextMode = "full"): Promise<string> {
    const r = await this.request<{ text?: string }>(
      "POST",
      `/tabs/instances/${encodeURIComponent(instanceId)}/text`,
      { mode, enableFingerprints: false, includeSelectorMap: false },
    );
    return r.text ?? "";
  }

  async getHtml(instanceId: string, selector?: string): Promise<string> {
    const qs = selector ? `?selector=${encodeURIComponent(selector)}` : "";
    const r = await this.request<{ html?: string }>(
      "GET",
      `/tabs/instances/${encodeURIComponent(instanceId)}/html${qs}`,
    );
    return r.html ?? "";
  }

  async getAccessibilityTree(instanceId: string): Promise<unknown> {
    const r = await this.request<{ tree?: unknown }>(
      "GET",
      `/tabs/instances/${encodeURIComponent(instanceId)}/ax-tree?interestingOnly=true`,
    );
    return r.tree ?? null;
  }

  /** Viewport screenshot as base64 PNG (no data-URL prefix). */
  async screenshot(instanceId: string): Promise<string | null> {
    const r = await this.request<{ image?: string }>(
      "GET",
      `/tabs/instances/${encodeURIComponent(instanceId)}/screenshot`,
    );
    return r.image ? FloorpClient.stripImagePrefix(r.image) : null;
  }

  /** Full-page screenshot as base64 PNG (no data-URL prefix). */
  async fullPageScreenshot(instanceId: string): Promise<string | null> {
    const r = await this.request<{ image?: string }>(
      "GET",
      `/tabs/instances/${encodeURIComponent(instanceId)}/fullPageScreenshot`,
    );
    return r.image ? FloorpClient.stripImagePrefix(r.image) : null;
  }

  // -- interactions -----------------------------------------------------------

  /** POST a per-instance action; treat an explicit `{ ok: false }` as failure. */
  private async action(
    instanceId: string,
    suffix: string,
    body: unknown,
    what: string,
  ): Promise<void> {
    const r = await this.request<{ ok?: boolean }>(
      "POST",
      `/tabs/instances/${encodeURIComponent(instanceId)}${suffix}`,
      body,
    );
    if (r.ok === false) {
      throw new Error(`${what} failed — element not found or not actionable.`);
    }
  }

  /** Scroll an element (by selector or fingerprint) into view. */
  async scrollTo(instanceId: string, selector?: string, fingerprint?: string): Promise<void> {
    await this.request("POST", `/tabs/instances/${encodeURIComponent(instanceId)}/scrollTo`, { selector, fingerprint });
  }

  async click(
    instanceId: string,
    selector?: string,
    opts: {
      button?: "left" | "right" | "middle";
      clickCount?: number;
      force?: boolean;
      fingerprint?: string;
    } = {},
  ): Promise<void> {
    // Auto scroll-into-view first so off-screen elements are actionable.
    await this.scrollTo(instanceId, selector, opts.fingerprint).catch(() => {});
    await this.action(
      instanceId,
      "/click",
      {
        selector,
        fingerprint: opts.fingerprint,
        button: opts.button,
        clickCount: opts.clickCount,
        force: opts.force,
      },
      `Click "${selector ?? opts.fingerprint ?? "?"}"`,
    );
  }

  /**
   * Structured page snapshot: clean Markdown text with inline fingerprint refs
   * (`<!--fp:...-->`) plus an "Element Selector Map" (fp | tag | text). Lets an
   * agent locate elements without grepping raw HTML, then act via a `ref`.
   */
  async snapshot(instanceId: string, mode: TextMode = "full"): Promise<string> {
    const r = await this.request<{ text?: string }>(
      "POST",
      `/tabs/instances/${encodeURIComponent(instanceId)}/text`,
      { mode, enableFingerprints: true, includeSelectorMap: true },
    );
    return r.text ?? "";
  }

  /** Set the value of an input/textarea. */
  async input(
    instanceId: string,
    selector: string,
    value: string,
    opts: { typingMode?: boolean; typingDelayMs?: number } = {},
  ): Promise<void> {
    await this.action(
      instanceId,
      "/input",
      { selector, value, typingMode: opts.typingMode, typingDelayMs: opts.typingDelayMs },
      `Type into "${selector}"`,
    );
  }

  async clearInput(instanceId: string, selector: string): Promise<void> {
    await this.action(instanceId, "/clearInput", { selector }, `Clear "${selector}"`);
  }

  /** Fill several fields at once: keys are CSS selectors, values are strings. */
  async fillForm(instanceId: string, formData: Record<string, string>): Promise<void> {
    await this.action(instanceId, "/fillForm", { formData }, "Fill form");
  }

  async pressKey(instanceId: string, key: string): Promise<void> {
    await this.action(instanceId, "/pressKey", { key }, `Press "${key}"`);
  }

  /**
   * Insert text into a rich / contenteditable editor (Slate, ProseMirror, Lexical…)
   * by dispatching a real text-input event. Use this when `input` fails because the
   * element has no `.value` (i.e. it is not a plain <input>/<textarea>).
   */
  async dispatchTextInput(
    instanceId: string,
    selector: string,
    text: string,
  ): Promise<void> {
    await this.action(
      instanceId,
      "/dispatchTextInput",
      { selector, text },
      `Type into "${selector}"`,
    );
  }

  /** Read the current value of an input/textarea/select. */
  async getValue(instanceId: string, selector: string): Promise<string | null> {
    const r = await this.request<{ value?: string | null }>(
      "GET",
      `/tabs/instances/${encodeURIComponent(instanceId)}/value?selector=${encodeURIComponent(selector)}`,
    );
    return r.value ?? null;
  }

  async waitForElement(
    instanceId: string,
    selector: string,
    state: ElementState = "visible",
    timeout = 5000,
  ): Promise<boolean> {
    const r = await this.request<{ ok?: boolean; found?: boolean }>(
      "POST",
      `/tabs/instances/${encodeURIComponent(instanceId)}/waitForElement`,
      { selector, state, timeout },
    );
    return r.found ?? r.ok ?? false;
  }

  /**
   * Evaluate JavaScript in the page context (supports async/await).
   * NOTE: not exposed in all Floorp builds — older ones return HTTP 404.
   */
  async evaluate(instanceId: string, script: string): Promise<EvaluateResult> {
    return this.request<EvaluateResult>(
      "POST",
      `/tabs/instances/${encodeURIComponent(instanceId)}/evaluate`,
      { script },
    );
  }

  // -- more interactions (v0.6.0) ---------------------------------------------

  async hover(instanceId: string, selector?: string, fingerprint?: string): Promise<void> {
    await this.scrollTo(instanceId, selector, fingerprint).catch(() => {});
    await this.action(instanceId, "/hover", { selector, fingerprint }, `Hover "${selector ?? fingerprint}"`);
  }

  async doubleClick(instanceId: string, selector?: string, fingerprint?: string): Promise<void> {
    await this.scrollTo(instanceId, selector, fingerprint).catch(() => {});
    await this.action(instanceId, "/doubleClick", { selector, fingerprint }, `Double-click "${selector ?? fingerprint}"`);
  }

  async rightClick(instanceId: string, selector?: string, fingerprint?: string): Promise<void> {
    await this.scrollTo(instanceId, selector, fingerprint).catch(() => {});
    await this.action(instanceId, "/rightClick", { selector, fingerprint }, `Right-click "${selector ?? fingerprint}"`);
  }

  /** Choose an option in a <select> by value. */
  async selectOption(instanceId: string, selector: string, value: string): Promise<void> {
    await this.action(instanceId, "/selectOption", { selector, value }, `Select "${value}" in "${selector}"`);
  }

  /** Check/uncheck a checkbox or radio. */
  async setChecked(instanceId: string, selector: string, checked: boolean): Promise<void> {
    await this.action(instanceId, "/setChecked", { selector, checked }, `Set checked=${checked} on "${selector}"`);
  }

  /** Submit a form (by a selector inside/of the form). */
  async submitForm(instanceId: string, selector?: string): Promise<void> {
    await this.action(instanceId, "/submit", { selector }, `Submit "${selector ?? "form"}"`);
  }

  /** Set a file input's file by absolute path. */
  async uploadFile(instanceId: string, selector: string, filePath: string): Promise<void> {
    await this.action(instanceId, "/uploadFile", { selector, filePath }, `Upload to "${selector}"`);
  }

  // -- more reads (v0.6.0) ----------------------------------------------------

  async getAttribute(
    instanceId: string,
    name: string,
    selector?: string,
    fingerprint?: string,
  ): Promise<string | null> {
    const p = new URLSearchParams({ name });
    if (selector) p.set("selector", selector);
    if (fingerprint) p.set("fingerprint", fingerprint);
    const r = await this.request<{ value?: string | null }>(
      "GET",
      `/tabs/instances/${encodeURIComponent(instanceId)}/attribute?${p.toString()}`,
    );
    return r.value ?? null;
  }

  /** Readability-extracted main article (title, byline, markdown). */
  async getArticle(
    instanceId: string,
  ): Promise<{ title?: string; byline?: string; markdown?: string; length?: number } | null> {
    return this.request("GET", `/tabs/instances/${encodeURIComponent(instanceId)}/article`);
  }

  async getCookies(instanceId: string): Promise<unknown[]> {
    const r = await this.request<{ cookies?: unknown[] }>(
      "GET",
      `/tabs/instances/${encodeURIComponent(instanceId)}/cookies`,
    );
    return r.cookies ?? [];
  }

  /** Wait until network activity settles (good after navigation/SPA loads). */
  async waitForNetworkIdle(instanceId: string, timeout = 8000): Promise<boolean> {
    const r = await this.request<{ ok?: boolean }>(
      "POST",
      `/tabs/instances/${encodeURIComponent(instanceId)}/waitForNetworkIdle`,
      { timeout },
    );
    return r.ok ?? false;
  }

  // -- workspaces (Floorp-specific, browser-level) (v0.6.0) -------------------

  async listWorkspaces(): Promise<Array<{ id: string; name: string }>> {
    const r = await this.request<{ workspaces?: Array<{ id: string; name: string }> }>(
      "GET",
      "/workspaces/",
    );
    return r.workspaces ?? [];
  }

  async switchWorkspace(id: string): Promise<boolean> {
    const r = await this.request<{ ok?: boolean }>(
      "POST",
      `/workspaces/${encodeURIComponent(id)}/switch`,
    );
    return r.ok ?? false;
  }
}
