# Security

`gecko-mcp` automates a real, logged-in browser, so it's powerful by design. This
document explains the threat model, the least-privilege defaults, and how to audit
it before you install — because you *should* be cautious about third-party code
that can drive your browser (and, optionally, your keyboard and mouse).

## Reporting a vulnerability

Open a [GitHub Security Advisory](https://github.com/Frumane/gecko-mcp/security/advisories/new)
or a regular [issue](https://github.com/Frumane/gecko-mcp/issues) for anything
non-sensitive. Please don't post working exploits publicly before a fix.

## How to audit before installing

- **It's small and dependency-light.** Two runtime deps (`@modelcontextprotocol/sdk`,
  `zod`); all logic is plain TypeScript under [`src/`](src). Read it in ~20 minutes.
- **Run it from source** instead of `npx` if you prefer: `git clone … && npm install
  && npm run build`, then point your MCP client at `node dist/index.js`.
- **Released with npm provenance** (built on GitHub Actions): the npm page links to
  the exact source commit + CI run that produced the package, so you can verify the
  published bytes match this public repo.
- `npm audit` is clean; CI type-checks, builds and unit-tests on every push.

## Least-privilege defaults

- **OS keyboard/mouse is LOCKED by default.** The `real_type`, `real_key`,
  `real_clear`, `move_cursor`, `real_click` and `window_bounds` tools — the only
  ones that can affect anything *outside* the browser — refuse to run until you
  unlock them, either per-session via the `enable_os_input` tool (the user just
  asks) or persistently with `GECKO_MCP_ENABLE_OS_INPUT=1`. With nothing set,
  gecko-mcp does **browser automation only**.
- **Real OS input is double-guarded** even once unlocked: input is sent only after
  the browser window is verified foreground, and mouse clicks must land inside that
  window — otherwise it aborts without sending anything. Payloads go to PowerShell
  base64-encoded via process-private env vars (no shell interpolation, no temp files).
- **Navigation is host-gated:** only `http(s)` (and `about:blank`), and loopback/
  private hosts are refused, so a prompt-injected agent can't pivot onto the local
  API or your LAN. Optional `GECKO_MCP_ALLOW_DOMAINS` allowlist.
- **Cookie values are redacted** by default; `upload_file` can be confined with
  `GECKO_MCP_ALLOW_UPLOAD_DIRS`; `get_value` is flagged as able to read secrets.
- **MCP tool annotations** mark each tool read-only vs destructive, so your client
  can ask for confirmation on consequential actions.
- **No `evaluate` tool** — arbitrary page-JS execution is deliberately not exposed.

## What is NOT defended (inherent)

- **Prompt injection / "lethal trifecta."** The assistant reads untrusted page
  content *and* can act on your logged-in sessions. Don't run automation unattended
  on sites you don't trust. Disable the browser's automation flag when idle.
- **The browser's automation API is unauthenticated on localhost** (Floorp's
  `:58261`, or Marionette) — any local process can use it while it's enabled. Turn
  it off when you're not automating. Set `GECKO_MCP_TOKEN` if your build enforces it.

See the README's **Security** section for the full list and environment variables.
