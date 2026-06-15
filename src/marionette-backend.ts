/**
 * BrowserBackend over Marionette — works on ANY Gecko/Firefox-based browser
 * (Firefox, LibreWolf, Waterfox, Zen, Mullvad, Floorp...) launched with
 * `-marionette`. Mirrors FloorpClient's surface so the MCP tools are unchanged.
 *
 * Model mapping: a tab is a Marionette "window handle"; the opaque `instanceId`
 * the tools pass around IS that handle. We switch to it before each operation.
 * Floorp-only niceties (fingerprint snapshots, workspaces, accessibility tree)
 * aren't available here and throw a clear message; everything else is implemented
 * with standard WebDriver commands or injected JS.
 */

import { MarionetteClient } from "./marionette.js";
import type { BrowserBackend, TabInfo, CreateTabOptions } from "./floorp-client.js";

const WD_KEY = "element-6066-11e4-a52e-4f735466cecf";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// WebDriver special keys live in the U+E0xx Private Use range. Built from code
// points (not literal chars) to keep this source pure ASCII.
const C = (code: number): string => String.fromCharCode(code);
const WD_KEYS: Record<string, string> = {
  enter: C(0xe007), return: C(0xe006), tab: C(0xe004), escape: C(0xe00c), esc: C(0xe00c),
  backspace: C(0xe003), delete: C(0xe017), del: C(0xe017), space: " ",
  up: C(0xe013), down: C(0xe015), left: C(0xe012), right: C(0xe014),
  home: C(0xe011), end: C(0xe010), pageup: C(0xe00e), pagedown: C(0xe00f),
};
const WD_MODS: Record<string, string> = {
  ctrl: C(0xe009), control: C(0xe009), alt: C(0xe00a), shift: C(0xe008), meta: C(0xe03d), cmd: C(0xe03d),
};

/** Unwrap `{ value: X }` (WebDriver) or return the raw result. */
function unwrap<T = unknown>(r: unknown): T {
  if (r && typeof r === "object" && "value" in (r as Record<string, unknown>)) {
    return (r as { value: T }).value;
  }
  return r as T;
}

export class MarionetteBackend implements BrowserBackend {
  private m: MarionetteClient | null = null;
  private current: string | null = null;
  private readonly port: number;

  constructor(port?: number) {
    this.port = port ?? (Number(process.env.MARIONETTE_PORT) || 2828);
  }

  // -- connection -------------------------------------------------------------

  private async ensure(): Promise<MarionetteClient> {
    if (this.m) return this.m;
    const m = new MarionetteClient({ port: this.port });
    await m.connect();
    await m.newSession();
    this.m = m;
    return m;
  }

  async health(): Promise<boolean> {
    try {
      await this.ensure();
      return true;
    } catch {
      return false;
    }
  }

  private async switchTo(handle: string): Promise<MarionetteClient> {
    const m = await this.ensure();
    if (this.current !== handle) {
      await m.send("WebDriver:SwitchToWindow", { name: handle, handle });
      this.current = handle;
    }
    return m;
  }

  private async exec<T = unknown>(m: MarionetteClient, script: string, args: unknown[] = []): Promise<T> {
    return unwrap<T>(await m.send("WebDriver:ExecuteScript", { script, args }));
  }

  /** Resolve a CSS selector to a WebDriver element id (throws if not found). */
  private async findId(m: MarionetteClient, selector: string): Promise<string> {
    let r: unknown;
    try {
      r = await m.send("WebDriver:FindElement", { using: "css selector", value: selector });
    } catch {
      throw new Error(`Element not found - selector "${selector}".`);
    }
    const v = unwrap<Record<string, string>>(r);
    const id = v?.[WD_KEY] ?? (v ? Object.values(v)[0] : undefined);
    if (!id) throw new Error(`Element not found - selector "${selector}".`);
    return id;
  }

  private noFingerprint(fingerprint?: string): void {
    if (fingerprint) {
      throw new Error("`ref`/snapshot fingerprints are Floorp-only. Pass a CSS `selector` on this browser.");
    }
  }

  // -- tabs -------------------------------------------------------------------

  async listTabs(): Promise<TabInfo[]> {
    const m = await this.ensure();
    const handles = (await m.send<string[]>("WebDriver:GetWindowHandles")) ?? [];
    const cur = unwrap<string>(await m.send("WebDriver:GetWindowHandle"));
    const tabs: TabInfo[] = [];
    for (const h of handles) {
      await m.send("WebDriver:SwitchToWindow", { name: h, handle: h });
      const title = unwrap<string>(await m.send("WebDriver:GetTitle")) ?? "";
      const url = unwrap<string>(await m.send("WebDriver:GetCurrentURL")) ?? "";
      tabs.push({ browserId: h, windowId: "", title, url, selected: h === cur, pinned: false });
    }
    if (cur) {
      await m.send("WebDriver:SwitchToWindow", { name: cur, handle: cur });
      this.current = cur;
    }
    return tabs;
  }

  async activeTab(): Promise<TabInfo> {
    const m = await this.ensure();
    const h = unwrap<string>(await m.send("WebDriver:GetWindowHandle"));
    this.current = h;
    const title = unwrap<string>(await m.send("WebDriver:GetTitle")) ?? "";
    const url = unwrap<string>(await m.send("WebDriver:GetCurrentURL")) ?? "";
    return { browserId: h, windowId: "", title, url, selected: true, pinned: false };
  }

  async createTab(url: string, opts: CreateTabOptions = {}): Promise<string> {
    const m = await this.ensure();
    const r = await m.send<{ handle?: string; value?: { handle?: string } }>("WebDriver:NewWindow", {
      type: "tab",
      focus: !opts.background,
    });
    const handle = r.handle ?? r.value?.handle;
    if (!handle) throw new Error("Could not open a new tab via Marionette.");
    await this.switchTo(handle);
    await m.send("WebDriver:Navigate", { url });
    return handle;
  }

  async getInstanceBrowserId(instanceId: string): Promise<string | null> {
    return instanceId; // the handle IS the browserId for Marionette
  }

  async attach(browserId: string): Promise<string | null> {
    await this.switchTo(browserId);
    return browserId;
  }

  async detach(): Promise<void> {
    /* no-op: Marionette has a single session, nothing to release */
  }

  async closeTab(instanceId: string): Promise<void> {
    const m = await this.switchTo(instanceId);
    await m.send("WebDriver:CloseWindow");
    this.current = null;
  }

  async navigate(instanceId: string, url: string): Promise<void> {
    const m = await this.switchTo(instanceId);
    await m.send("WebDriver:Navigate", { url });
  }

  async getUri(instanceId: string): Promise<string | null> {
    const m = await this.switchTo(instanceId);
    return unwrap<string>(await m.send("WebDriver:GetCurrentURL")) ?? null;
  }

  async getTitle(instanceId: string): Promise<string | null> {
    const m = await this.switchTo(instanceId);
    return unwrap<string>(await m.send("WebDriver:GetTitle")) ?? null;
  }

  // -- reads ------------------------------------------------------------------

  async getText(instanceId: string): Promise<string> {
    const m = await this.switchTo(instanceId);
    return (await this.exec<string>(m, "return document.body ? document.body.innerText : '';")) ?? "";
  }

  async getHtml(instanceId: string, selector?: string): Promise<string> {
    const m = await this.switchTo(instanceId);
    if (selector) {
      return (
        (await this.exec<string>(m, "var e=document.querySelector(arguments[0]);return e?e.outerHTML:'';", [selector])) ?? ""
      );
    }
    return unwrap<string>(await m.send("WebDriver:GetPageSource")) ?? "";
  }

  async getAccessibilityTree(): Promise<unknown> {
    throw new Error("Accessibility tree isn't available on this browser (Marionette). Use read_page or find.");
  }

  async screenshot(instanceId: string): Promise<string | null> {
    const m = await this.switchTo(instanceId);
    return unwrap<string>(await m.send("WebDriver:TakeScreenshot", { full: false })) ?? null;
  }

  async fullPageScreenshot(instanceId: string): Promise<string | null> {
    const m = await this.switchTo(instanceId);
    return unwrap<string>(await m.send("WebDriver:TakeScreenshot", { full: true })) ?? null;
  }

  async snapshot(): Promise<string> {
    throw new Error("snapshot (fingerprint map) is Floorp-only. Use `find` or `read_page` on this browser.");
  }

  // -- interactions -----------------------------------------------------------

  async click(
    instanceId: string,
    selector?: string,
    opts: { button?: "left" | "right" | "middle"; fingerprint?: string } = {},
  ): Promise<void> {
    this.noFingerprint(opts.fingerprint);
    if (!selector) throw new Error("A CSS selector is required on this browser.");
    const m = await this.switchTo(instanceId);
    const id = await this.findId(m, selector);
    await m
      .send("WebDriver:ExecuteScript", {
        script: "arguments[0].scrollIntoView({block:'center',inline:'center'});",
        args: [{ [WD_KEY]: id }],
      })
      .catch(() => {});
    if (opts.button === "right") {
      await this.pointer(m, id, 2);
    } else {
      await m.send("WebDriver:ElementClick", { id });
    }
  }

  /** Low-level pointer gesture on an element (button: 0 left, 2 right; double = two clicks). */
  private async pointer(m: MarionetteClient, id: string, button: number, double = false): Promise<void> {
    const press = [
      { type: "pointerDown", button },
      { type: "pointerUp", button },
    ];
    const actions = [{ type: "pointerMove", origin: { [WD_KEY]: id }, x: 0, y: 0 }, ...press, ...(double ? press : [])];
    await m.send("WebDriver:PerformActions", {
      actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions }],
    });
  }

  async input(instanceId: string, selector: string, value: string): Promise<void> {
    const m = await this.switchTo(instanceId);
    const id = await this.findId(m, selector);
    await m.send("WebDriver:ElementClear", { id }).catch(() => {});
    await m.send("WebDriver:ElementSendKeys", { id, text: value });
  }

  async clearInput(instanceId: string, selector: string): Promise<void> {
    const m = await this.switchTo(instanceId);
    const id = await this.findId(m, selector);
    await m.send("WebDriver:ElementClear", { id });
  }

  async dispatchTextInput(instanceId: string, selector: string, text: string): Promise<void> {
    const m = await this.switchTo(instanceId);
    const id = await this.findId(m, selector);
    await m.send("WebDriver:ElementSendKeys", { id, text });
  }

  async fillForm(instanceId: string, formData: Record<string, string>): Promise<void> {
    const m = await this.switchTo(instanceId);
    for (const [selector, value] of Object.entries(formData)) {
      const id = await this.findId(m, selector);
      await m.send("WebDriver:ElementClear", { id }).catch(() => {});
      await m.send("WebDriver:ElementSendKeys", { id, text: value });
    }
  }

  async pressKey(instanceId: string, key: string): Promise<void> {
    const m = await this.switchTo(instanceId);
    const parts = key.split("+").map((p) => p.trim().toLowerCase());
    const main = parts.pop() ?? "";
    const k = WD_KEYS[main] ?? main;
    const mods = parts.map((p) => WD_MODS[p]).filter(Boolean);
    const down = mods.map((v) => ({ type: "keyDown", value: v }));
    const up = [...mods].reverse().map((v) => ({ type: "keyUp", value: v }));
    await m.send("WebDriver:PerformActions", {
      actions: [
        {
          type: "key",
          id: "kb",
          actions: [...down, { type: "keyDown", value: k }, { type: "keyUp", value: k }, ...up],
        },
      ],
    });
  }

  async waitForElement(instanceId: string, selector: string, state = "visible", timeout = 5000): Promise<boolean> {
    const m = await this.switchTo(instanceId);
    const deadline = Date.now() + timeout;
    for (;;) {
      const els =
        (await m.send<Array<Record<string, string>>>("WebDriver:FindElements", { using: "css selector", value: selector })) ??
        [];
      if (els.length) {
        if (state !== "visible") return true;
        const id = els[0][WD_KEY] ?? Object.values(els[0])[0];
        const shown = unwrap<boolean>(await m.send("WebDriver:IsElementDisplayed", { id }).catch(() => ({ value: true })));
        if (shown) return true;
      }
      if (Date.now() >= deadline) return false;
      await sleep(200);
    }
  }

  async getValue(instanceId: string, selector: string): Promise<string | null> {
    const m = await this.switchTo(instanceId);
    const id = await this.findId(m, selector);
    return unwrap<string>(await m.send("WebDriver:GetElementProperty", { id, name: "value" })) ?? null;
  }

  async hover(instanceId: string, selector?: string, fingerprint?: string): Promise<void> {
    this.noFingerprint(fingerprint);
    if (!selector) throw new Error("A CSS selector is required on this browser.");
    const m = await this.switchTo(instanceId);
    const id = await this.findId(m, selector);
    await m.send("WebDriver:PerformActions", {
      actions: [
        {
          type: "pointer",
          id: "mouse",
          parameters: { pointerType: "mouse" },
          actions: [{ type: "pointerMove", origin: { [WD_KEY]: id }, x: 0, y: 0 }],
        },
      ],
    });
  }

  async doubleClick(instanceId: string, selector?: string, fingerprint?: string): Promise<void> {
    this.noFingerprint(fingerprint);
    if (!selector) throw new Error("A CSS selector is required on this browser.");
    const m = await this.switchTo(instanceId);
    const id = await this.findId(m, selector);
    await this.pointer(m, id, 0, true);
  }

  async rightClick(instanceId: string, selector?: string, fingerprint?: string): Promise<void> {
    this.noFingerprint(fingerprint);
    if (!selector) throw new Error("A CSS selector is required on this browser.");
    const m = await this.switchTo(instanceId);
    const id = await this.findId(m, selector);
    await this.pointer(m, id, 2);
  }

  async selectOption(instanceId: string, selector: string, value: string): Promise<void> {
    const m = await this.switchTo(instanceId);
    const ok = await this.exec<boolean>(
      m,
      "var s=document.querySelector(arguments[0]); if(!s) return false; s.value=arguments[1]; s.dispatchEvent(new Event('input',{bubbles:true})); s.dispatchEvent(new Event('change',{bubbles:true})); return true;",
      [selector, value],
    );
    if (!ok) throw new Error(`Select not found - selector "${selector}".`);
  }

  async setChecked(instanceId: string, selector: string, checked: boolean): Promise<void> {
    const m = await this.switchTo(instanceId);
    const id = await this.findId(m, selector);
    const cur = unwrap<boolean>(await m.send("WebDriver:GetElementProperty", { id, name: "checked" }));
    if (cur !== checked) await m.send("WebDriver:ElementClick", { id });
  }

  async submitForm(instanceId: string, selector?: string): Promise<void> {
    const m = await this.switchTo(instanceId);
    const ok = await this.exec<boolean>(
      m,
      "var e=arguments[0]?document.querySelector(arguments[0]):document.forms[0]; if(!e) return false; var f=e.form||e; if(f.requestSubmit) f.requestSubmit(); else f.submit(); return true;",
      [selector ?? null],
    );
    if (!ok) throw new Error("No form found to submit.");
  }

  async uploadFile(instanceId: string, selector: string, filePath: string): Promise<void> {
    const m = await this.switchTo(instanceId);
    const id = await this.findId(m, selector);
    await m.send("WebDriver:ElementSendKeys", { id, text: filePath });
  }

  async getAttribute(instanceId: string, name: string, selector?: string, fingerprint?: string): Promise<string | null> {
    this.noFingerprint(fingerprint);
    if (!selector) throw new Error("A CSS selector is required on this browser.");
    const m = await this.switchTo(instanceId);
    const id = await this.findId(m, selector);
    return unwrap<string>(await m.send("WebDriver:GetElementAttribute", { id, name })) ?? null;
  }

  async getArticle(
    instanceId: string,
  ): Promise<{ title?: string; byline?: string; markdown?: string; length?: number } | null> {
    const m = await this.switchTo(instanceId);
    const r = await this.exec<{ title: string; text: string }>(
      m,
      "var a=document.querySelector('article')||document.querySelector('main')||document.body; var t=(a&&a.innerText)||''; return {title:document.title, text:t};",
    );
    if (!r || !r.text) return null;
    return { title: r.title, markdown: r.text, length: r.text.length };
  }

  async getCookies(instanceId: string): Promise<unknown[]> {
    const m = await this.switchTo(instanceId);
    const r = unwrap<unknown[]>(await m.send("WebDriver:GetCookies"));
    return Array.isArray(r) ? r : [];
  }

  async waitForNetworkIdle(instanceId: string, timeout = 8000): Promise<boolean> {
    const m = await this.switchTo(instanceId);
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const ready = await this.exec<string>(m, "return document.readyState;");
      if (ready === "complete") {
        await sleep(300);
        return true;
      }
      await sleep(200);
    }
    return false;
  }

  async evaluate(
    instanceId: string,
    script: string,
  ): Promise<{ success: boolean; result?: unknown; error?: string }> {
    const m = await this.switchTo(instanceId);
    try {
      const result = await this.exec(m, script);
      return { success: true, result };
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  }

  async listWorkspaces(): Promise<Array<{ id: string; name: string }>> {
    throw new Error("Workspaces are a Floorp-only feature.");
  }

  async switchWorkspace(): Promise<boolean> {
    throw new Error("Workspaces are a Floorp-only feature.");
  }
}
