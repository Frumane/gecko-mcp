/**
 * Interactive setup wizard: `gecko-mcp setup`.
 *
 * Shows an ASCII banner, lets the user pick which AI coding tool(s) to register
 * gecko-mcp with, and whether to install it for the current project or globally
 * (all repos). Writes/merges each tool's MCP config — preserving anything already
 * there and backing up the file first. Tools whose config format we can't safely
 * write are shown as a copy-paste snippet instead.
 *
 * Non-interactive flags (scriptable / testable):
 *   --list                       list supported tool ids
 *   --tool <id[,id...]>          pick tools (skip the menu)
 *   --scope <global|project>     pick scope (skip the menu)
 *   --print                      dry run: show the plan, write nothing
 *   --yes                        assume yes (no confirmation)
 *   --cwd <dir>                  base dir for project scope (default: process.cwd())
 */

import * as readline from "node:readline";
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, platform } from "node:os";

// -- colors -------------------------------------------------------------------
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const sgr = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = sgr("1");
const dim = sgr("2");
const cyan = sgr("38;5;44");
const blue = sgr("38;5;39");
const green = sgr("38;5;42");
const yellow = sgr("38;5;220");
const red = sgr("38;5;203");
const mag = sgr("38;5;177");

// -- banner -------------------------------------------------------------------
const FRUMANE = [
  "███████╗██████╗ ██╗   ██╗███╗   ███╗ █████╗ ███╗   ██╗███████╗",
  "██╔════╝██╔══██╗██║   ██║████╗ ████║██╔══██╗████╗  ██║██╔════╝",
  "█████╗  ██████╔╝██║   ██║██╔████╔██║███████║██╔██╗ ██║█████╗  ",
  "██╔══╝  ██╔══██╗██║   ██║██║╚██╔╝██║██╔══██║██║╚██╗██║██╔══╝  ",
  "██║     ██║  ██║╚██████╔╝██║ ╚═╝ ██║██║  ██║██║ ╚████║███████╗",
  "╚═╝     ╚═╝  ╚═╝ ╚═════╝ ╚═╝     ╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝╚══════╝",
];
const GRADIENT = ["38;5;45", "38;5;44", "38;5;38", "38;5;39", "38;5;33", "38;5;27"];

function banner(version: string): void {
  console.log();
  FRUMANE.forEach((line, i) => {
    console.log("  " + (useColor ? `\x1b[${GRADIENT[i]}m${line}\x1b[0m` : line));
  });
  console.log();
  console.log("  " + bold(cyan("gecko-mcp")) + dim(`  setup wizard · v${version}`));
  console.log("  " + dim("drive the Floorp browser from your AI coding tool"));
  console.log();
}

// -- the server entry every tool gets ----------------------------------------
const CMD = "npx";
const ARGS = ["-y", "gecko-mcp"];
const KEY = "gecko"; // the server key written into each tool's MCP config

type Scope = "global" | "project";
type Kind = "mcpServers" | "vscode" | "zed" | "codex-toml" | "manual";
interface Plan {
  kind: Kind;
  file?: string;
  note?: string;
  fallbackNote?: string; // shown when a requested scope was unavailable
}

// VS Code user dir per-OS (for Cline / VS Code global).
function vscodeUserDir(home: string): string {
  if (platform() === "win32") return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Code", "User");
  if (platform() === "darwin") return join(home, "Library", "Application Support", "Code", "User");
  return join(home, ".config", "Code", "User");
}

// -- tool registry ------------------------------------------------------------
interface ToolDef {
  id: string;
  label: string;
  hint: string;
  plan(scope: Scope, cwd: string, home: string): Plan;
}

const TOOLS: ToolDef[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    hint: "Anthropic CLI",
    plan: (s, cwd, home) =>
      s === "project"
        ? { kind: "mcpServers", file: join(cwd, ".mcp.json"), note: "shareable project config" }
        : { kind: "mcpServers", file: join(home, ".claude.json"), note: "user config (all projects)" },
  },
  {
    id: "cursor",
    label: "Cursor",
    hint: "AI code editor",
    plan: (s, cwd, home) =>
      s === "project"
        ? { kind: "mcpServers", file: join(cwd, ".cursor", "mcp.json") }
        : { kind: "mcpServers", file: join(home, ".cursor", "mcp.json") },
  },
  {
    id: "windsurf",
    label: "Windsurf",
    hint: "Codeium IDE",
    plan: (_s, _cwd, home) => ({
      kind: "mcpServers",
      file: join(home, ".codeium", "windsurf", "mcp_config.json"),
      fallbackNote: "Windsurf only has a global MCP config — installed globally.",
    }),
  },
  {
    id: "vscode",
    label: "VS Code (Copilot)",
    hint: "MCP via Copilot",
    plan: (s, cwd, home) =>
      s === "project"
        ? { kind: "vscode", file: join(cwd, ".vscode", "mcp.json") }
        : { kind: "vscode", file: join(vscodeUserDir(home), "mcp.json"), note: "VS Code user MCP config" },
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    hint: "Google",
    plan: (s, cwd, home) =>
      s === "project"
        ? { kind: "mcpServers", file: join(cwd, ".gemini", "settings.json") }
        : { kind: "mcpServers", file: join(home, ".gemini", "settings.json") },
  },
  {
    id: "codex",
    label: "Codex CLI",
    hint: "OpenAI · TOML",
    plan: (_s, _cwd, home) => ({
      kind: "codex-toml",
      file: join(home, ".codex", "config.toml"),
      fallbackNote: "Codex uses a single global config — installed globally.",
    }),
  },
  {
    id: "zed",
    label: "Zed",
    hint: "editor · context_servers",
    plan: (_s, _cwd, home) => ({
      kind: "zed",
      file: join(home, ".config", "zed", "settings.json"),
      fallbackNote: "Zed context servers are global — installed globally.",
    }),
  },
  {
    id: "cline",
    label: "Cline",
    hint: "VS Code extension",
    plan: (_s, _cwd, home) => ({
      kind: "mcpServers",
      file: join(vscodeUserDir(home), "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json"),
      fallbackNote: "Cline stores MCP config globally — installed globally.",
    }),
  },
  {
    id: "kimi",
    label: "Kimi Code",
    hint: "Moonshot · paste snippet",
    plan: () => ({ kind: "manual", note: "Kimi Code config path varies — paste this into its MCP settings." }),
  },
  {
    id: "antigravity",
    label: "Antigravity",
    hint: "Google IDE · paste snippet",
    plan: () => ({ kind: "manual", note: "Add via Antigravity's MCP settings panel (paste the snippet)." }),
  },
  {
    id: "other",
    label: "Other / manual",
    hint: "show me the snippet",
    plan: () => ({ kind: "manual", note: "Generic MCP server snippet — works with any MCP client." }),
  },
];

// -- config writers (merge, never clobber) -----------------------------------
function readJson(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  const raw = readFileSync(file, "utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

function ensureDir(file: string): void {
  const d = dirname(file);
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

function backup(file: string): string | null {
  if (!existsSync(file)) return null;
  const bak = `${file}.gecko-bak`;
  copyFileSync(file, bak);
  return bak;
}

interface WriteResult { file: string; created: boolean; backup: string | null; already: boolean; }

function writeMerged(plan: Plan, dryRun: boolean): WriteResult {
  const file = plan.file!;
  const created = !existsSync(file);
  let already = false;
  let cfg: Record<string, any>;
  try {
    cfg = readJson(file);
  } catch {
    throw new Error(`existing config at ${file} is not valid JSON — left untouched.`);
  }

  if (plan.kind === "mcpServers") {
    cfg.mcpServers ??= {};
    already = JSON.stringify(cfg.mcpServers[KEY]) === JSON.stringify({ command: CMD, args: ARGS });
    cfg.mcpServers[KEY] = { command: CMD, args: ARGS };
  } else if (plan.kind === "vscode") {
    cfg.servers ??= {};
    const entry = { type: "stdio", command: CMD, args: ARGS };
    already = JSON.stringify(cfg.servers[KEY]) === JSON.stringify(entry);
    cfg.servers[KEY] = entry;
  } else if (plan.kind === "zed") {
    cfg.context_servers ??= {};
    const entry = { command: { path: CMD, args: ARGS }, settings: {} };
    already = JSON.stringify(cfg.context_servers[KEY]) === JSON.stringify(entry);
    cfg.context_servers[KEY] = entry;
  }

  const bak = dryRun ? null : backup(file);
  if (!dryRun) {
    ensureDir(file);
    writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  }
  return { file, created, backup: bak, already };
}

function writeCodexToml(plan: Plan, dryRun: boolean): WriteResult {
  const file = plan.file!;
  const created = !existsSync(file);
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  const already = new RegExp(`\\[mcp_servers\\.${KEY}\\]`).test(existing);
  const head = existing.replace(/\s*$/, "");
  const block = `[mcp_servers.${KEY}]\ncommand = "${CMD}"\nargs = [${ARGS.map((a) => `"${a}"`).join(", ")}]\n`;
  const bak = dryRun ? null : backup(file);
  if (!dryRun && !already) {
    ensureDir(file);
    writeFileSync(file, head + (head.length ? "\n\n" : "") + block, "utf8");
  }
  return { file, created, backup: bak, already };
}

function manualSnippet(): string {
  const json = JSON.stringify({ mcpServers: { [KEY]: { command: CMD, args: ARGS } } }, null, 2);
  const toml = `[mcp_servers.${KEY}]\ncommand = "${CMD}"\nargs = [${ARGS.map((a) => `"${a}"`).join(", ")}]`;
  return dim("  JSON (most tools):\n") + json.split("\n").map((l) => "    " + l).join("\n") +
    dim("\n\n  TOML (Codex-style):\n") + toml.split("\n").map((l) => "    " + l).join("\n");
}

// -- interactive selector (arrow keys; falls back to error if no TTY) ---------
function select(title: string, items: { label: string; hint?: string }[], multi: boolean): Promise<number[]> {
  if (!process.stdin.isTTY) {
    return Promise.reject(new Error("no interactive terminal — use --tool and --scope flags instead (see --list)."));
  }
  return new Promise((resolve) => {
    let cur = 0;
    const sel = new Set<number>();
    const n = items.length;
    const lines = 1 + n + (multi ? 1 : 0);
    let first = true;
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();

    const draw = () => {
      if (!first) process.stdout.write(`\x1b[${lines}A`);
      first = false;
      process.stdout.write(`\x1b[2K${bold(title)}\n`);
      items.forEach((it, i) => {
        const pointer = i === cur ? cyan("❯") : " ";
        const box = multi ? (sel.has(i) ? green("◉ ") : "◯ ") : "";
        const label = i === cur ? cyan(it.label) : it.label;
        const hint = it.hint ? dim("  " + it.hint) : "";
        process.stdout.write(`\x1b[2K ${pointer} ${box}${label}${hint}\n`);
      });
      if (multi) process.stdout.write("\x1b[2K" + dim("   ↑/↓ move · space toggle · a all · enter confirm") + "\n");
    };
    draw();

    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.removeListener("keypress", onKey);
      process.stdin.pause();
    };
    const onKey = (_s: string, k: readline.Key) => {
      if (k.ctrl && k.name === "c") { cleanup(); console.log(); process.exit(130); }
      if (k.name === "up") cur = (cur - 1 + n) % n;
      else if (k.name === "down") cur = (cur + 1) % n;
      else if (multi && k.name === "space") { sel.has(cur) ? sel.delete(cur) : sel.add(cur); }
      else if (multi && k.name === "a") { sel.size === n ? sel.clear() : items.forEach((_, i) => sel.add(i)); }
      else if (k.name === "return") {
        cleanup();
        resolve(multi ? [...sel].sort((a, b) => a - b) : [cur]);
        return;
      } else return;
      draw();
    };
    process.stdin.on("keypress", onKey);
  });
}

// -- argv ---------------------------------------------------------------------
function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) { out[key] = next; i++; }
      else out[key] = true;
    }
  }
  return out;
}

// -- main ---------------------------------------------------------------------
export async function runSetup(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const home = homedir();
  const cwd = typeof args.cwd === "string" ? args.cwd : process.cwd();
  const dryRun = !!args.print;

  let version = "?";
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    version = (JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { version: string }).version;
  } catch { /* ignore */ }

  if (args.list) {
    console.log("Supported tools:");
    for (const t of TOOLS) console.log(`  ${t.id.padEnd(14)} ${t.label} ${dim("· " + t.hint)}`);
    return;
  }

  banner(version);

  // 1) tools
  let toolIds: string[];
  if (typeof args.tool === "string") {
    toolIds = args.tool.split(",").map((s) => s.trim());
    const bad = toolIds.filter((id) => !TOOLS.some((t) => t.id === id));
    if (bad.length) throw new Error(`unknown tool(s): ${bad.join(", ")} — see --list`);
  } else {
    const picks = await select("Which tool(s) should gecko-mcp be added to?", TOOLS, true);
    if (!picks.length) { console.log(yellow("\n  Nothing selected — bye.")); return; }
    toolIds = picks.map((i) => TOOLS[i].id);
  }

  // 2) scope
  let scope: Scope;
  if (args.scope === "global" || args.scope === "project") {
    scope = args.scope;
  } else if (args.global) {
    scope = "global";
  } else if (args.project) {
    scope = "project";
  } else {
    const opts = [
      { label: "This project only", hint: cwd },
      { label: "Globally (all repositories)", hint: "your user config" },
    ];
    const [pick] = await select("Install scope?", opts, false);
    scope = pick === 0 ? "project" : "global";
  }

  console.log();
  console.log("  " + bold("Plan") + dim(`  (${scope}${dryRun ? ", dry-run" : ""})`));
  console.log();

  const manual: ToolDef[] = [];
  const results: string[] = [];
  for (const id of toolIds) {
    const tool = TOOLS.find((t) => t.id === id)!;
    const plan = tool.plan(scope, cwd, home);
    if (plan.kind === "manual") { manual.push(tool); continue; }
    try {
      const r = plan.kind === "codex-toml" ? writeCodexToml(plan, dryRun) : writeMerged(plan, dryRun);
      const verb = dryRun ? "would update" : r.already ? "already set" : r.created ? "created" : "updated";
      const tag = r.already ? dim("✓") : green("✓");
      let line = `  ${tag} ${bold(tool.label)} ${dim("→")} ${r.file}  ${dim("[" + verb + "]")}`;
      if (plan.note) line += "\n      " + dim(plan.note);
      if (plan.fallbackNote && scope === "project") line += "\n      " + yellow(plan.fallbackNote);
      if (r.backup) line += "\n      " + dim("backup: " + r.backup);
      results.push(line);
    } catch (err) {
      results.push(`  ${red("✗")} ${bold(tool.label)} ${dim("→")} ${(err as Error).message}`);
    }
  }

  results.forEach((l) => console.log(l));

  if (manual.length) {
    console.log();
    console.log("  " + bold(mag("Paste-in tools")) + dim("  (" + manual.map((t) => t.label).join(", ") + ")"));
    manual.forEach((t) => {
      if (t.plan("global", cwd, home).note) console.log("  " + dim(t.plan("global", cwd, home).note!));
    });
    console.log();
    console.log(manualSnippet());
  }

  // next steps
  console.log();
  console.log("  " + bold(green("Done.")) + (dryRun ? dim("  (dry-run — nothing was written)") : ""));
  console.log("  " + dim("Next:"));
  console.log("  " + dim("  1. Restart the tool(s) above so they pick up the new server."));
  console.log("  " + dim("  2. In Floorp, set ") + "floorp.mcp.enabled = true" + dim(" in about:config, then restart Floorp."));
  console.log("  " + dim("  3. Ask your assistant to ") + cyan("\"list my Floorp tabs\"") + dim(" to confirm."));
  console.log();
}
