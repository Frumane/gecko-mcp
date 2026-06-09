/**
 * OS-level keyboard input for Floorp (Windows only).
 *
 * Why: synthetic DOM events (Floorp's /input, dispatchTextInput) don't reliably
 * sync React/Slate-controlled editors, so submits silently fail. Real OS key
 * events (isTrusted=true) are processed exactly like a human typing, which fixes
 * rich-editor typing AND form submission — on the user's *live* session.
 *
 * SAFETY (non-negotiable): OS keystrokes go to whatever window is in the
 * foreground. So before sending ANY key we:
 *   1. require a Floorp window to exist,
 *   2. bring it to the foreground,
 *   3. VERIFY it is actually foreground,
 *   4. abort WITHOUT sending keys if verification fails.
 * This prevents leaking keystrokes into the wrong app.
 *
 * Usage: focus the target field first (e.g. with the `click` tool), then call
 * realType / realKeys. The element keeps DOM focus while Floorp is foregrounded.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const pexec = promisify(execFile);

// PowerShell script: foreground-guard + send keys. param-based, no backticks so
// it survives being stored in a JS template literal.
const PS_SCRIPT = `param([string]$Mode, [string]$Payload)
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class FloorpInput {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
}
"@
$proc = Get-Process | Where-Object { $_.ProcessName -match 'floorp' -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) { Write-Output 'ERR:NO_FLOORP'; exit 3 }
$h = $proc.MainWindowHandle
$fg = [FloorpInput]::GetForegroundWindow()
$t1 = [FloorpInput]::GetWindowThreadProcessId($fg, [IntPtr]::Zero)
$t2 = [FloorpInput]::GetCurrentThreadId()
[void][FloorpInput]::AttachThreadInput($t2, $t1, $true)
[void][FloorpInput]::ShowWindow($h, 5)
[void][FloorpInput]::BringWindowToTop($h)
[void][FloorpInput]::SetForegroundWindow($h)
[void][FloorpInput]::AttachThreadInput($t2, $t1, $false)
[System.Threading.Thread]::Sleep(180)
if ([FloorpInput]::GetForegroundWindow() -ne $h) { Write-Output 'ERR:NOT_FOREGROUND'; exit 4 }
Add-Type -AssemblyName System.Windows.Forms
$text = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($Payload))
function Esc([string]$c) {
  switch -CaseSensitive ($c) {
    '{' { return '{{}' }
    '}' { return '{}}' }
    '[' { return '{[}' }
    ']' { return '{]}' }
    '(' { return '{(}' }
    ')' { return '{)}' }
    '+' { return '{+}' }
    '^' { return '{^}' }
    '%' { return '{%}' }
    '~' { return '{~}' }
    default { return $c }
  }
}
if ($Mode -eq 'type') {
  foreach ($ch in $text.ToCharArray()) {
    $code = [int][char]$ch
    if ($code -eq 13) { continue }
    if ($code -eq 10) { [System.Windows.Forms.SendKeys]::SendWait('{ENTER}') }
    else { [System.Windows.Forms.SendKeys]::SendWait((Esc ([string]$ch))) }
    [System.Threading.Thread]::Sleep(6)
  }
} else {
  [System.Windows.Forms.SendKeys]::SendWait($text)
}
Write-Output 'OK'
`;

let scriptPath: string | null = null;
function ensureScript(): string {
  if (!scriptPath) {
    scriptPath = join(tmpdir(), "floorp-mcp-osinput.ps1");
    writeFileSync(scriptPath, PS_SCRIPT, "utf8");
  }
  return scriptPath;
}

function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}

async function runPs(mode: "type" | "keys", payload: string): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("OS keyboard input is currently Windows-only.");
  }
  const file = ensureScript();
  let stdout = "";
  try {
    const res = await pexec(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file, "-Mode", mode, "-Payload", b64(payload)],
      { windowsHide: true, timeout: 60_000 },
    );
    stdout = res.stdout;
  } catch (err: any) {
    stdout = (err.stdout ?? "") + (err.stderr ?? err.message ?? "");
  }
  if (stdout.includes("ERR:NO_FLOORP")) {
    throw new Error("Floorp is not running (no window found). Open Floorp and try again.");
  }
  if (stdout.includes("ERR:NOT_FOREGROUND")) {
    throw new Error(
      "Could not bring Floorp to the foreground — aborted WITHOUT sending any keys " +
        "(safety guard, so keystrokes can't leak to another app). Click the Floorp window, then retry.",
    );
  }
  if (!stdout.includes("OK")) {
    throw new Error(`OS input failed: ${stdout.trim().slice(0, 300)}`);
  }
}

/** Type text into Floorp's focused element via real OS key events. */
export function realType(text: string): Promise<void> {
  return runPs("type", text);
}

/** Map a friendly key/combo name to SendKeys notation. */
const KEY_MAP: Record<string, string> = {
  enter: "{ENTER}",
  tab: "{TAB}",
  escape: "{ESC}",
  esc: "{ESC}",
  backspace: "{BS}",
  delete: "{DEL}",
  del: "{DEL}",
  up: "{UP}",
  down: "{DOWN}",
  left: "{LEFT}",
  right: "{RIGHT}",
  home: "{HOME}",
  end: "{END}",
  pageup: "{PGUP}",
  pagedown: "{PGDN}",
};

const MODIFIERS: Record<string, string> = { ctrl: "^", control: "^", alt: "%", shift: "+" };

/** Translate "Enter", "Tab", "ctrl+a", "ctrl+shift+k" → SendKeys notation. */
export function toSendKeys(key: string): string {
  const parts = key.split("+").map((p) => p.trim().toLowerCase());
  const main = parts.pop()!;
  const mods = parts.map((m) => MODIFIERS[m] ?? "").join("");
  const mapped = KEY_MAP[main] ?? (main.length === 1 ? main : `{${main.toUpperCase()}}`);
  return mods + mapped;
}

/** Press a single key or combo via real OS key events. */
export function realKey(key: string): Promise<void> {
  return runPs("keys", toSendKeys(key));
}

/** Select-all + delete via real OS key events (clears rich/contenteditable fields). */
export function realClear(): Promise<void> {
  return runPs("keys", "^a{DEL}");
}
