# floorp-mcp

> An **MCP (Model Context Protocol)** server that lets AI assistants — Claude Code,
> Claude Desktop, Cursor, and any MCP client — **read pages, take screenshots and
> manage tabs** in the [Floorp](https://floorp.app) browser, using your real,
> logged-in browsing session.

Think "Claude in Chrome", but for Floorp (and other Firefox-based browsers on the
roadmap).

## How it works

Floorp ships a **built-in local automation server**. When you set
`floorp.mcp.enabled = true` in `about:config`, Floorp exposes an HTTP API on
`http://127.0.0.1:58261`. This project is a thin, well-documented MCP bridge that
translates MCP tool calls into requests against that API — **no browser extension
required**.

```
  Claude Code / Desktop / Cursor
            │  MCP (stdio)
            ▼
      floorp-mcp  ──HTTP──►  Floorp :58261  ──►  your real tabs
   (this project)            (built-in API)
```

## Requirements

- **Floorp** installed and running.
- In `about:config`, set **`floorp.mcp.enabled`** to `true`, then fully restart Floorp.
- **Node.js** ≥ 18.

## Setup

```bash
git clone https://github.com/Frumane/floorp-mcp
cd floorp-mcp
npm install
npm run build
```

Register it with Claude Code (user-wide):

```bash
claude mcp add floorp -s user -- node /absolute/path/to/floorp-mcp/dist/index.js
```

…or add it to your MCP config manually:

```json
{
  "mcpServers": {
    "floorp": {
      "command": "node",
      "args": ["/absolute/path/to/floorp-mcp/dist/index.js"]
    }
  }
}
```

## Tools

**Tabs & reading**

| Tool | What it does |
|------|--------------|
| `list_tabs` | List all open tabs (title, URL, browserId, active, pinned). |
| `open_tab` | Open a new tab at a URL; **returns the new tab's `browserId`** so you can target it. |
| `get_active_tab` | Return the active tab's title, URL and browserId. |
| `navigate_tab` | Navigate an existing tab to a URL. |
| `close_tab` | Close a tab. |
| `read_page` | Read a tab's content as clean Markdown (or HTML / accessibility tree). Output is capped (default 25 KB) to protect the context. |
| `find` | **Fast element locator** — search a page server-side by visible text and/or tag; returns a compact list of ready-to-use CSS `selector`s (~1 KB) instead of the whole HTML. Use it to find a button/link/field, then act on the selector. |
| `snapshot` | Structured page map: Markdown with inline `fp:` refs + an element selector map — locate elements without grepping HTML, then act via a `ref`. |
| `screenshot` | Capture a screenshot of a tab (viewport or full page). |
| `launch_floorp` | Ensure Floorp is running — launches it if the API isn't reachable (Windows). |

**Interaction**

| Tool | What it does |
|------|--------------|
| `click` | Click an element by CSS selector **or a `ref` from `snapshot`**; auto-scrolls it into view first. |
| `type_text` | Type into an input/textarea — or a rich/contenteditable editor (Slate, ProseMirror…) — by CSS selector. |
| `fill_form` | Fill multiple fields at once. |
| `press_key` | Press a keyboard key (Enter, Tab, …). |
| `wait_for_element` | Wait for an element to attach / become visible / etc. |
| `get_value` | **Sensitive.** Read the current value of an input/textarea/select (can read password fields). |

Most tools target the **active tab** by default; pass a `browserId` (from
`list_tabs`) to target a specific tab.

**Real OS keyboard (Windows)** — for React/rich editors and bot-guarded submits
that ignore synthetic input:

| Tool | What it does |
|------|--------------|
| `real_type` | Type into the focused element via **genuine OS key events** (`isTrusted`). |
| `real_key` | Press a real key/combo, e.g. `"Enter"`, `"ctrl+a"`. |
| `real_clear` | Real Ctrl+A + Delete — reliably clears a rich/contenteditable field. |

These produce input a page can't distinguish from a human's, so they drive
React/Slate editors and submit composers that synthetic clicks/typing can't.
Workflow: `click` the field to focus it → `real_clear` / `real_type` / `real_key "Enter"`.

> **Safety guard:** OS keystrokes go to the foreground window, so before sending
> anything these tools bring Floorp to the foreground and **verify** it — if Floorp
> isn't running or can't be focused, they **abort without typing a single key**, so
> input can never leak into another app.

**Real OS mouse (Windows)** — genuine `isTrusted` clicks at screen coordinates:

| Tool | What it does |
|------|--------------|
| `window_bounds` | Floorp's window rectangle in screen pixels (to compute targets). |
| `move_cursor` | Move the real OS cursor to a screen pixel inside Floorp. |
| `real_click` | Real OS click (left/right, single/double) at a screen pixel inside Floorp. |

> **Double guard:** the click is sent only when Floorp is verified foreground **and**
> the point lies **inside Floorp's window rect** — a stray coordinate is refused, so
> a click can never land in another app/window. Coordinates are screen pixels
> (note display scaling/DPI when mapping from a screenshot).

**More interaction & queries**

| Tool | What it does |
|------|--------------|
| `hover` / `double_click` / `right_click` | Mouse gestures on an element (selector or `ref`). |
| `select_option` | Choose an option in a `<select>`. |
| `set_checked` | Check/uncheck a checkbox or radio. |
| `submit_form` | Submit a form. |
| `upload_file` | **Sensitive.** Set a file `<input>` by absolute path — restrict with `FLOORP_MCP_ALLOW_UPLOAD_DIRS`. |
| `get_attribute` | Read an element attribute (href, value, …). |
| `get_article` | Readability-extracted main article as Markdown. |
| `get_cookies` | **Sensitive.** Cookies visible to the page — values redacted unless `includeValues: true`. |
| `wait_for_network_idle` | Wait for network activity to settle. |
| `list_workspaces` / `switch_workspace` | Floorp workspaces (where supported). |

## Security

Understand the threat model before enabling this. Two risks dominate:

1. **Floorp's automation API has no authentication by default.** While
   `floorp.mcp.enabled` is on, **any local process** can drive your logged-in
   browser via `127.0.0.1:58261` — not just this server. There is also no
   Origin check, so hostile web pages may attempt CSRF/DNS-rebinding tricks
   against it. Mitigations:
   - Turn `floorp.mcp.enabled` **off** when you're not using automation.
   - Set the `FLOORP_MCP_TOKEN` environment variable — this server then sends it
     as a `Bearer` token on every request (effective on Floorp builds that
     enforce a token; harmless otherwise).
2. **Prompt injection ("lethal trifecta").** The assistant reads untrusted page
   content *and* can act on your authenticated sessions (click, type, submit,
   navigate, real OS input). A malicious page could try to instruct the
   assistant to act against you. Treat everything read from a page as untrusted;
   don't run automation unattended on sites you don't trust.

Hardening built into this server:

- **Real OS input is double-guarded:** keys/clicks are sent only after verifying
  Floorp is the foreground window, and mouse clicks must land inside Floorp's
  window rectangle — otherwise it aborts *without* sending anything. PowerShell
  payloads are passed base64-encoded via process-private environment variables
  (no shell interpolation, no temp script files on disk).
- **URL scheme + host allowlist:** `open_tab`/`navigate_tab` accept only `http(s)`
  (and `about:blank`) by default, and **refuse loopback/private hosts**
  (`127.0.0.1`, `localhost`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`,
  IPv6 ULA/link-local). This stops a prompt-injected agent from pivoting the
  browser onto Floorp's own API or your LAN and reading the response back. Lift
  with `FLOORP_MCP_ALLOW_PRIVILEGED_URLS=1`. Optionally pin navigation to a
  domain allowlist with `FLOORP_MCP_ALLOW_DOMAINS`.
- **Cookie values are redacted by default** in `get_cookies`; raw values require
  an explicit `includeValues: true`.
- **`get_value` can read secrets:** browsers let same-origin JS read password
  fields, so this tool *can* return a typed password. It's flagged SENSITIVE —
  use it only on fields the user asked about, never to harvest credentials.
- **Upload allowlist:** set `FLOORP_MCP_ALLOW_UPLOAD_DIRS` (`;`-separated
  directories) to confine `upload_file`. Paths are canonicalised with realpath
  (symlinks resolved) and checked so `..`, a symlink, a same-prefix sibling
  directory, or a UNC path can't escape the allowed folders.
- **`find` skips hidden elements** (inline `display:none`/`visibility:hidden`,
  `hidden`, `type=hidden`, `aria-hidden`) so a page can't lure the agent into
  clicking an invisible button via text search.
- **Input bounds:** numeric/text tool parameters are range- and length-capped
  (coordinates, timeouts, `maxChars`, `find` limit, typed text, form fields) to
  prevent resource-exhaustion / crash inputs.
- **Truncated API errors & validated port:** Floorp error bodies are truncated
  before reaching the model; `FLOORP_MCP_PORT` is validated as 1–65535.
- **No `evaluate` tool:** arbitrary page-JS execution is deliberately not exposed.

What is **not** defended (inherent / Floorp-side): a malicious *local* process can
still read or impersonate the unauthenticated loopback API (plaintext, no TLS), and
prompt injection from a page you choose to automate can still drive legitimate
actions on that page. Disable `floorp.mcp.enabled` when idle and don't automate
untrusted sites unattended.

| Environment variable | Effect |
|---|---|
| `FLOORP_MCP_TOKEN` | Sent as `Authorization: Bearer …` to the Floorp API. |
| `FLOORP_MCP_PORT` | API port (default `58261`, validated 1–65535). |
| `FLOORP_MCP_ALLOW_PRIVILEGED_URLS` | `1` allows non-http(s) URLs **and** loopback/private hosts in open/navigate. |
| `FLOORP_MCP_ALLOW_DOMAINS` | Comma-separated domain allowlist for navigation (subdomains included). Unset = any public host. |
| `FLOORP_MCP_ALLOW_UPLOAD_DIRS` | Restrict `upload_file` to these directories (`;`-separated). |
| `FLOORP_PATH` | Full path to `floorp.exe` for `launch_floorp`. |

## Performance

- **HTTP tool calls are cheap** — a full attach → act → detach round-trip against
  Floorp's local API is ~5–6 ms. `find` searches the page server-side and returns
  ~1 KB of ready-to-use selectors instead of dumping the whole HTML, and
  `read_page` is capped (default 25 KB) so a page read can't flood the context.
- **Real OS input uses a persistent PowerShell host.** Spawning `powershell.exe`
  (~700 ms) and compiling the P/Invoke helper (~600 ms) used to happen on *every*
  `real_*`/`move_cursor`/`window_bounds` call (~1.9 s each). Now one host is
  started lazily, compiles once, and runs a read-eval loop — so the first call
  pays ~1.6 s but every call after is **~350 ms** for a guarded key/click (~5×
  faster) and a few ms for a window-bounds query. The foreground/bounds safety
  guards still run on every command; the host is recycled if it hangs or dies.

## Notes & limitations

Learned from driving real apps (incl. Google Flow):

- **Rich editors:** `type_text` handles plain inputs *and* contenteditable editors
  (Slate, ProseMirror, Lexical) — it falls back to dispatching a real text-input
  event when an element has no `.value`. Reliably *clearing* such editors isn't
  solved yet (no `select-all`/`evaluate`).
- **Submitting React composers:** many chat/prompt composers submit on a real
  **Enter keydown**, not on a synthetic click of the send button. Prefer
  `press_key` `"Enter"` over `click` for those.
- **Trusted events:** you cannot forge `isTrusted=true` from page JavaScript — it
  is a browser security invariant. Floorp injects input at a privileged layer, so
  ordinary clicks/keys behave like real ones; but flows guarded by reCAPTCHA or
  strict bot-detection may still refuse automated submission.
- **`evaluate`:** the page-JS eval endpoint returns HTTP 404 on some Floorp builds,
  so it is not exposed as a tool here.
- **Multiple windows:** when more than one window is open, the "active tab" is
  ambiguous (each window has its own active tab). Prefer the `browserId` returned
  by `open_tab`, or one from `list_tabs`, and pass it explicitly to every tool.

## Roadmap

- [x] Tab management, page reading, screenshots
- [x] Interaction tools: click, type, fill forms, key presses, read field values
- [x] Real OS keyboard (Windows): `real_type` / `real_key` / `real_clear`, with a
      foreground safety guard — drives React/Slate editors & bot-guarded submits
- [x] `snapshot` (fingerprint refs + selector map) + `click` by `ref` + auto-scroll-into-view
- [x] `launch_floorp` — start Floorp if not running (Windows)
- [x] Extra tools: hover, double/right-click, select_option, set_checked, submit,
      upload_file, get_attribute, get_article, get_cookies, wait_for_network_idle, workspaces
- [x] Real OS mouse (Windows): `window_bounds` / `move_cursor` / `real_click`, with a
      foreground + in-window-bounds double guard
- [ ] WebDriver BiDi engine — non-Floorp Firefox forks + JS `evaluate` + element-relative native input
- [ ] macOS / Linux native-input backends
- [ ] JS `evaluate` (available in newer Floorp builds; older ones return HTTP 404)
- [ ] Optional bearer-token auth
- [ ] Support for other Firefox-based browsers (WebDriver BiDi fallback)

## Acknowledgements

Built against the automation API exposed by Floorp. The official
[`Floorp-Projects/floorp-mcp-server`](https://github.com/Floorp-Projects/floorp-mcp-server)
was a useful reference for mapping the endpoint surface. This is an independent,
clean-room MIT-licensed implementation.

## License

[MIT](./LICENSE) © Arda Karaman
