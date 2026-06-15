# Changelog

All notable changes to **floorp-mcp** are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project uses
[Semantic Versioning](https://semver.org/).

## [2.2.0]

### Added
- **`evaluate`** — run JavaScript in the page and get the result back (via
  Marionette `ExecuteScript`; some Floorp builds don't expose it). Powerful, so
  it's **LOCKED by default** like OS input: unlock with the new **`enable_evaluate`**
  tool (the user just asks) or `GECKO_MCP_ENABLE_EVALUATE=1`; **`disable_evaluate`**
  re-locks. Result is stringified and capped (default 25 KB).
- **`launch`** — start any Firefox-based browser (Firefox, LibreWolf, Waterfox,
  Zen, Mullvad, Floorp) with Marionette enabled, using its normal profile, so
  gecko-mcp can drive it. Takes `browser` (known name) or `path`; auto-detects an
  installed one otherwise. (Close the browser first if it's already running without
  Marionette.)
- The new tools are covered by the real-Firefox CI integration test.

## [2.1.1]

### Changed
- First release **published from CI with npm provenance** — the npm page now links
  to the exact source commit and GitHub Actions run that built the package, so the
  published bytes are verifiable against this repo. No code changes.

## [2.1.0]

### Security / trust
- **OS keyboard/mouse is now LOCKED by default (least privilege).** The only tools
  that can act outside the browser (`real_type`, `real_key`, `real_clear`,
  `move_cursor`, `real_click`, `window_bounds`) refuse to run until unlocked —
  per-session via the new **`enable_os_input`** tool (the user just asks), or
  persistently with `GECKO_MCP_ENABLE_OS_INPUT=1`. Added **`disable_os_input`** to
  re-lock. With nothing set, gecko-mcp does browser automation only.
- Added **`SECURITY.md`** (threat model, least-privilege defaults, how to audit
  before installing) and a "cautious about installing?" note + provenance/source
  pointers in the README.
- Added a **provenance release workflow** (`.github/workflows/release.yml`): tagged
  releases publish to npm with `--provenance` so the npm page links to the exact
  source commit + CI run. (Requires an `NPM_TOKEN` repo secret; skips cleanly until
  then.)

## [2.0.1]

### Fixed
- **Marionette navigation no longer hangs on ad/tracker-heavy pages.** Real-world
  testing showed `WebDriver:Navigate` could block until timeout on pages whose
  `load` event never fires (endless ad requests). The Marionette session now uses
  `pageLoadStrategy: "eager"` (returns at DOMContentLoaded) plus a bounded
  `pageLoad` timeout, so navigation completes promptly and the page is usable.

## [2.0.0]

### Changed (breaking — project renamed)
- **Renamed `floorp-mcp` → `gecko-mcp`.** The project now supports the whole
  Firefox/Gecko family, so the name reflects that. Install with `npx gecko-mcp`
  (the old `floorp-mcp` npm package is deprecated and points here). The GitHub
  repo moved to `Frumane/gecko-mcp` (old links redirect).
- Env vars are now prefixed **`GECKO_MCP_*`** (e.g. `GECKO_MCP_PORT`,
  `GECKO_MCP_BACKEND`). The legacy `FLOORP_MCP_*` names still work as fallbacks,
  so existing configs keep running.
- The setup wizard (`gecko-mcp setup`) and its config snippets now use the
  `gecko-mcp` package and a `gecko` server key.
- `floorp.mcp.enabled`, the `:58261` Floorp API, and the `FLOORP_PATH` launch
  override are unchanged — those refer to the Floorp browser itself.

## [1.8.0]

### Added
- **Support for all Firefox-based browsers via Marionette.** floorp-mcp now drives
  LibreWolf, Waterfox, Zen, Mullvad and Firefox (any Gecko browser) — not just
  Floorp — by attaching to Marionette, the automation engine built into every fork.
  Launch the browser with `-marionette` and floorp-mcp controls your live session
  with the same tools. The backend is auto-selected (Floorp's `:58261` API when
  present, else Marionette); force it with `FLOORP_MCP_BACKEND`.
- New `BrowserBackend` interface abstracts the browser; `FloorpClient` and the new
  `MarionetteBackend` both implement it, so all tools work across backends.
- Real OS keyboard/mouse now targets any common Gecko browser window (configurable
  with `FLOORP_MCP_BROWSER_PROCESS`).
- Env: `FLOORP_MCP_BACKEND`, `MARIONETTE_PORT`, `FLOORP_MCP_BROWSER_PROCESS`.

### Notes
- On the Marionette backend, Floorp-only extras (`snapshot` fingerprints,
  workspaces, accessibility tree) report a clear "not supported" message; use
  `find` / `read_page` instead. Everything else works on every fork.

## [1.7.0]

### Added
- **MCP tool annotations** on all 35 tools (`readOnlyHint`, `destructiveHint`,
  `idempotentHint`, `openWorldHint`, `title`). Clients can now gate execution
  sensibly — auto-run read-only tools (`list_tabs`, `read_page`, `find`,
  `screenshot`, …) and ask for confirmation on destructive ones (`close_tab`,
  `navigate_tab`, `submit_form`, `upload_file`). This is the MCP-native way to
  support human-in-the-loop; the client's permission UI uses the hints.
- Annotations live in `src/annotations.ts` and are covered by unit tests.

## [1.6.0]

### Added
- **Interactive setup wizard** — `npx floorp-mcp setup`. ASCII banner, then pick
  which AI coding tool(s) to register floorp-mcp with (Claude Code, Cursor,
  Windsurf, VS Code/Copilot, Gemini CLI, Codex, Zed, Cline — plus copy-paste
  snippets for Kimi Code, Antigravity, or any MCP client) and whether to install
  **per-project** or **globally**. Merges into existing config (preserving other
  servers) and backs the file up first. Scriptable flags: `--list`, `--tool`,
  `--scope`, `--print` (dry run), `--cwd`, `--yes`.
- The `floorp-mcp` binary now routes `setup`/`install`/`init` to the wizard; with
  no subcommand it still runs the MCP server on stdio (unchanged for clients).

## [1.5.0]

### Added
- **Unit tests** that need no live Floorp (`test/unit/`, run with `npm test` via
  the Node test runner) covering the security guards, the `find` HTML search, and
  key mapping.
- **GitHub Actions CI** (`.github/workflows/ci.yml`) — type-check, build and unit
  tests on Ubuntu + Windows for every push and PR.
- `CHANGELOG.md`; `typecheck` npm script; npm package metadata (`repository`,
  `homepage`, `bugs`).

### Changed
- Refactored the pure logic out of `src/index.ts` into `src/guards.ts`
  (URL/upload guards) and `src/html-find.ts` (element locator) so it is testable
  in isolation. No behaviour change.

## [1.4.0]

### Changed
- **OS input is ~5× faster.** Real keyboard/mouse used to spawn a fresh
  `powershell.exe` per call (~1.9 s: ~700 ms spawn + ~600 ms to compile the
  P/Invoke helper). A single **persistent PowerShell host** now compiles once and
  serves commands over a stdin read-eval loop, so each call after the first is
  ~350 ms for a guarded key/click and a few ms for a window-bounds query. The
  foreground + bounds safety guards still run on every command; the host is
  recycled if it hangs or dies.

## [1.3.0]

### Security
- **Blocked SSRF to the local API.** `open_tab`/`navigate_tab` now refuse
  loopback/private hosts (`127.0.0.1`, `localhost`, `10/8`, `172.16/12`,
  `192.168/16`, `169.254/16`, IPv6 ULA/link-local), so a prompt-injected agent
  can't pivot the browser onto Floorp's own automation API and read the response
  back. Added the optional `FLOORP_MCP_ALLOW_DOMAINS` navigation allowlist.
- **Input bounds** on numeric/text tool parameters (coordinates, timeouts,
  `maxChars`, `find` limit, typed text, form fields) to prevent
  resource-exhaustion / crash inputs. Fixes a `maxChars: -1` bypass of the
  output-truncation guard.
- **Upload allowlist hardened**: paths are canonicalised with `realpath` and
  checked with `path.relative`, defeating symlink escapes, `..`, same-prefix
  sibling directories, and UNC paths.
- `find` now skips inline-hidden elements (`display:none`/`visibility:hidden`,
  `hidden`, `type=hidden`, `aria-hidden`).
- Floorp API error bodies are truncated before reaching the model; `get_value`
  is flagged SENSITIVE (it can read password fields); `FLOORP_MCP_PORT` is
  validated; the `withAttachedTab` fast path enforces the `browserId="0"` guard.

## [1.2.0]

### Security
- Real OS input runs PowerShell via `-EncodedCommand` with payloads passed
  through process-private environment variables — no temp `.ps1` on disk, no
  shell interpolation.
- `open_tab`/`navigate_tab` restricted to `http(s)` (and `about:blank`) by
  default (`FLOORP_MCP_ALLOW_PRIVILEGED_URLS=1` to override).
- `get_cookies` redacts cookie values by default (`includeValues: true` for raw).
- Optional `FLOORP_MCP_ALLOW_UPLOAD_DIRS` allowlist for `upload_file`.
- CSS-escape attribute values in generated selectors; `encodeURIComponent` the
  instance id in client requests; `FLOORP_MCP_TOKEN` bearer-auth support.

## [1.1.0]

### Added
- **`find`** — fast server-side element locator: search a page by visible text
  and/or tag and get compact, ready-to-use CSS selectors (~1 KB) instead of the
  whole HTML.

### Changed
- `read_page` output is capped (default 25 KB, `maxChars` to override).
- `withAttachedTab` fast path skips the `listTabs` round-trip when a `browserId`
  is given. (35 tools.)

## [1.0.0]

### Added
- **Real OS mouse**: `window_bounds`, `move_cursor`, `real_click`, with a double
  safety guard (Floorp must be foreground **and** the point inside its window
  rect, else abort). (34 tools.)

## [0.6.0]

### Added
- 13 more tools: `hover`, `double_click`, `right_click`, `select_option`,
  `set_checked`, `submit_form`, `upload_file`, `get_attribute`, `get_article`
  (Readability), `get_cookies`, `wait_for_network_idle`, `list_workspaces`,
  `switch_workspace`. (31 tools.)

## [0.5.0]

### Added
- `snapshot` (structured page map with fingerprint refs + selector map); `click`
  accepts a `ref`; auto-scroll-into-view before clicks; `launch_floorp`. (18 tools.)

## [0.4.0]

### Added
- **Real OS keyboard** (`real_type`, `real_key`, `real_clear`) with a mandatory
  foreground safety guard that aborts without typing if Floorp isn't foreground.

## [0.2.0]

### Added
- Initial release: tab management, page reading, screenshots, and core
  interaction (`click`, `type_text`, `fill_form`, `press_key`,
  `wait_for_element`, `get_value`). (12 tools.)

[2.2.0]: https://github.com/Frumane/gecko-mcp/releases/tag/v2.2.0
[2.1.1]: https://github.com/Frumane/gecko-mcp/releases/tag/v2.1.1
[2.1.0]: https://github.com/Frumane/gecko-mcp/releases/tag/v2.1.0
[2.0.1]: https://github.com/Frumane/gecko-mcp/releases/tag/v2.0.1
[2.0.0]: https://github.com/Frumane/gecko-mcp/releases/tag/v2.0.0
[1.8.0]: https://github.com/Frumane/floorp-mcp/releases/tag/v1.8.0
[1.7.0]: https://github.com/Frumane/floorp-mcp/releases/tag/v1.7.0
[1.6.0]: https://github.com/Frumane/floorp-mcp/releases/tag/v1.6.0
[1.5.0]: https://github.com/Frumane/floorp-mcp/releases/tag/v1.5.0
[1.4.0]: https://github.com/Frumane/floorp-mcp/releases/tag/v1.4.0
[1.3.0]: https://github.com/Frumane/floorp-mcp/releases/tag/v1.3.0
[1.2.0]: https://github.com/Frumane/floorp-mcp/releases/tag/v1.2.0
[1.1.0]: https://github.com/Frumane/floorp-mcp/releases/tag/v1.1.0
[1.0.0]: https://github.com/Frumane/floorp-mcp/releases/tag/v1.0.0
[0.6.0]: https://github.com/Frumane/floorp-mcp/releases/tag/v0.6.0
[0.5.0]: https://github.com/Frumane/floorp-mcp/releases/tag/v0.5.0
[0.4.0]: https://github.com/Frumane/floorp-mcp/releases/tag/v0.4.0
