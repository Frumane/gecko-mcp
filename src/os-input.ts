/**
 * OS-level keyboard & mouse input for Floorp (Windows only).
 *
 * Why: synthetic DOM events (Floorp's /input, dispatchTextInput) don't reliably
 * sync React/Slate-controlled editors, so submits silently fail. Real OS key
 * events (isTrusted=true) are processed exactly like a human typing, which fixes
 * rich-editor typing AND form submission — on the user's *live* session.
 *
 * SAFETY (non-negotiable): OS keystrokes/clicks go to whatever window is in the
 * foreground. So before sending ANY input we:
 *   1. require a Floorp window to exist,
 *   2. bring it to the foreground,
 *   3. VERIFY it is actually foreground,
 *   4. abort WITHOUT sending input if verification fails.
 * For the mouse we ALSO require the (x,y) to be inside Floorp's window rect.
 *
 * PERFORMANCE: spawning powershell.exe costs ~700ms and compiling the P/Invoke
 * helper (Add-Type) another ~600ms — so a fresh process per call was ~1.9s. We
 * instead keep ONE persistent PowerShell host: it compiles the helper + loads
 * WinForms once, then runs a read-eval loop over stdin, so each subsequent call
 * is just the foreground guard + SendKeys (~200-400ms). The safety guard still
 * runs on every command. Requests are serialised (OS input is inherently serial).
 * If the host dies or a command times out, it is respawned on the next call.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

// ---------------------------------------------------------------------------
// Persistent PowerShell host
// ---------------------------------------------------------------------------

// The host script: define the P/Invoke helper + WinForms ONCE, then loop reading
// our line protocol from stdin and writing "RESP:<token>:<result>" to stdout.
// Request payloads arrive as base64 (safe charset, no spaces) so they can never
// break the protocol or be interpreted as PowerShell.
const HOST_SCRIPT = `
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
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, IntPtr extra);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
Add-Type -AssemblyName System.Windows.Forms

function Get-FloorpWindow {
  for ($try = 0; $try -lt 6; $try++) {
    $p = Get-Process | Where-Object { $_.ProcessName -match 'floorp' -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if ($p) { return $p.MainWindowHandle }
    [System.Threading.Thread]::Sleep(150)
  }
  return [IntPtr]::Zero
}
function Set-Foreground($h) {
  $fg = [FloorpInput]::GetForegroundWindow()
  $t1 = [FloorpInput]::GetWindowThreadProcessId($fg, [IntPtr]::Zero)
  $t2 = [FloorpInput]::GetCurrentThreadId()
  [void][FloorpInput]::AttachThreadInput($t2, $t1, $true)
  [void][FloorpInput]::ShowWindow($h, 5)
  [void][FloorpInput]::BringWindowToTop($h)
  [void][FloorpInput]::SetForegroundWindow($h)
  [void][FloorpInput]::AttachThreadInput($t2, $t1, $false)
  [System.Threading.Thread]::Sleep(170)
  return ([FloorpInput]::GetForegroundWindow() -eq $h)
}
function Esc([string]$c) {
  switch -CaseSensitive ($c) {
    '{' { return '{{}' } '}' { return '{}}' } '[' { return '{[}' } ']' { return '{]}' }
    '(' { return '{(}' } ')' { return '{)}' } '+' { return '{+}' } '^' { return '{^}' }
    '%' { return '{%}' } '~' { return '{~}' } default { return $c }
  }
}
function Do-Key([string]$mode, [string]$b64) {
  $h = Get-FloorpWindow
  if ($h -eq [IntPtr]::Zero) { return 'ERR:NO_FLOORP' }
  if (-not (Set-Foreground $h)) { return 'ERR:NOT_FOREGROUND' }
  $text = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($b64))
  if ($mode -eq 'type') {
    foreach ($ch in $text.ToCharArray()) {
      $code = [int][char]$ch
      if ($code -eq 13) { continue }
      if ($code -eq 10) { [System.Windows.Forms.SendKeys]::SendWait('{ENTER}') }
      else { [System.Windows.Forms.SendKeys]::SendWait((Esc ([string]$ch))) }
      [System.Threading.Thread]::Sleep(5)
    }
  } else {
    [System.Windows.Forms.SendKeys]::SendWait($text)
  }
  return 'OK'
}
function Do-Mouse([int]$x, [int]$y, [string]$action) {
  $h = Get-FloorpWindow
  if ($h -eq [IntPtr]::Zero) { return 'ERR:NO_FLOORP' }
  $r = New-Object FloorpInput+RECT
  [void][FloorpInput]::GetWindowRect($h, [ref]$r)
  if ($action -eq 'bounds') { return ("BOUNDS:" + $r.Left + "," + $r.Top + "," + $r.Right + "," + $r.Bottom) }
  if (-not (Set-Foreground $h)) { return 'ERR:NOT_FOREGROUND' }
  if ($x -lt $r.Left -or $x -gt $r.Right -or $y -lt $r.Top -or $y -gt $r.Bottom) {
    return ("ERR:OUT_OF_BOUNDS rect=" + $r.Left + "," + $r.Top + "," + $r.Right + "," + $r.Bottom)
  }
  [void][FloorpInput]::SetCursorPos($x, $y)
  [System.Threading.Thread]::Sleep(40)
  if ($action -eq 'click') { [FloorpInput]::mouse_event(2,0,0,0,[IntPtr]::Zero); [FloorpInput]::mouse_event(4,0,0,0,[IntPtr]::Zero) }
  elseif ($action -eq 'double') { for ($i=0; $i -lt 2; $i++) { [FloorpInput]::mouse_event(2,0,0,0,[IntPtr]::Zero); [FloorpInput]::mouse_event(4,0,0,0,[IntPtr]::Zero); [System.Threading.Thread]::Sleep(70) } }
  elseif ($action -eq 'right') { [FloorpInput]::mouse_event(8,0,0,0,[IntPtr]::Zero); [FloorpInput]::mouse_event(16,0,0,0,[IntPtr]::Zero) }
  return 'OK'
}

[Console]::Out.WriteLine('READY::')
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Length -eq 0) { continue }
  $parts = $line.Split(' ')
  $cmd = $parts[0]; $token = $parts[1]
  try {
    if ($cmd -eq 'KEY') { $res = Do-Key $parts[2] $parts[3] }
    elseif ($cmd -eq 'MOUSE') { $res = Do-Mouse ([int]$parts[2]) ([int]$parts[3]) $parts[4] }
    else { $res = 'ERR:BADCMD' }
  } catch {
    $res = 'ERR:EXC ' + $_.Exception.Message
  }
  [Console]::Out.WriteLine("RESP:" + $token + ":" + $res)
  [Console]::Out.Flush()
}
`;

const HOST_SCRIPT_ENC = Buffer.from(HOST_SCRIPT, "utf16le").toString("base64");

let host: ChildProcessWithoutNullStreams | null = null;
let outBuf = "";
let awaiting: { marker: string; resolve: (s: string) => void } | null = null;
let seq = 0;
let chain: Promise<unknown> = Promise.resolve();

function handleData(chunk: Buffer): void {
  outBuf += chunk.toString("utf8");
  let idx: number;
  while ((idx = outBuf.indexOf("\n")) >= 0) {
    const line = outBuf.slice(0, idx).replace(/\r$/, "");
    outBuf = outBuf.slice(idx + 1);
    if (awaiting && line.startsWith(awaiting.marker)) {
      const w = awaiting;
      awaiting = null;
      w.resolve(line.slice(w.marker.length));
    }
  }
}

function killHost(): void {
  const h = host;
  host = null;
  awaiting = null;
  outBuf = "";
  if (h) {
    try { h.stdin.end(); } catch { /* ignore */ }
    try { h.kill(); } catch { /* ignore */ }
  }
}

function ensureHost(): Promise<ChildProcessWithoutNullStreams> {
  if (host && !host.killed) return Promise.resolve(host);
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", HOST_SCRIPT_ENC],
      { windowsHide: true },
    );
    let settled = false;
    const startTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* ignore */ }
      reject(new Error("PowerShell input host did not become ready in time."));
    }, 20_000);

    child.stdout.on("data", handleData);
    child.stderr.on("data", () => { /* swallow PS noise */ });
    child.on("exit", () => { if (host === child) killHost(); });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(startTimer);
      reject(err);
    });

    // Wait for the host's READY:: banner before accepting commands.
    awaiting = {
      marker: "READY::",
      resolve: () => {
        if (settled) return;
        settled = true;
        clearTimeout(startTimer);
        host = child;
        resolve(child);
      },
    };
  });
}

/** Serialise a single request line through the host; returns the raw result
 *  string (e.g. "OK", "ERR:NO_FLOORP", "BOUNDS:.."). */
function send(make: (token: string) => string, timeoutMs: number): Promise<string> {
  const run = (): Promise<string> =>
    ensureHost().then(
      (h) =>
        new Promise<string>((resolve, reject) => {
          const token = "T" + ++seq;
          const marker = `RESP:${token}:`;
          const timer = setTimeout(() => {
            if (awaiting && awaiting.marker === marker) awaiting = null;
            killHost(); // a hung command poisons the host — recycle it
            reject(new Error("OS input timed out (host recycled)."));
          }, timeoutMs);
          awaiting = {
            marker,
            resolve: (s) => {
              clearTimeout(timer);
              resolve(s);
            },
          };
          h.stdin.write(make(token) + "\n");
        }),
    );
  // Mutex: one command at a time.
  const result = chain.then(run, run);
  chain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}

function interpret(result: string, kind: "keyboard" | "mouse"): void {
  if (result.includes("ERR:NO_FLOORP")) {
    throw new Error(
      kind === "keyboard"
        ? "Floorp is not running (no window found). Open Floorp and try again."
        : "Floorp is not running (no window found).",
    );
  }
  if (result.includes("ERR:NOT_FOREGROUND")) {
    throw new Error(
      kind === "keyboard"
        ? "Could not bring Floorp to the foreground — aborted WITHOUT sending any keys " +
          "(safety guard, so keystrokes can't leak to another app). Click the Floorp window, then retry."
        : "Could not bring Floorp to the foreground — aborted WITHOUT clicking (safety guard).",
    );
  }
}

async function runKey(mode: "type" | "keys", payload: string): Promise<void> {
  if (process.platform !== "win32") throw new Error("OS keyboard input is currently Windows-only.");
  // Allow ~6ms/char for typing plus generous headroom.
  const timeout = mode === "type" ? Math.max(60_000, payload.length * 12) : 30_000;
  const out = await send((t) => `KEY ${t} ${mode} ${b64(payload)}`, timeout);
  interpret(out, "keyboard");
  if (!out.includes("OK")) throw new Error(`OS input failed: ${out.trim().slice(0, 300)}`);
}

/** Type text into Floorp's focused element via real OS key events. */
export function realType(text: string): Promise<void> {
  return runKey("type", text);
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
  return runKey("keys", toSendKeys(key));
}

/** Select-all + delete via real OS key events (clears rich/contenteditable fields). */
export function realClear(): Promise<void> {
  return runKey("keys", "^a{DEL}");
}

// -- OS mouse -----------------------------------------------------------------

async function runMouse(
  x: number,
  y: number,
  action: "move" | "click" | "double" | "right" | "bounds",
): Promise<string> {
  if (process.platform !== "win32") throw new Error("OS mouse is currently Windows-only.");
  const out = await send(
    (t) => `MOUSE ${t} ${Math.round(x)} ${Math.round(y)} ${action}`,
    30_000,
  );
  interpret(out, "mouse");
  if (out.includes("ERR:OUT_OF_BOUNDS")) {
    const rect = out.match(/rect=([\-\d,]+)/)?.[1] ?? "";
    throw new Error(
      `(${x},${y}) is outside the Floorp window [${rect}] — refused to click outside Floorp. ` +
        `Call window_bounds for the valid range.`,
    );
  }
  if (!out.includes("OK") && !out.includes("BOUNDS:")) {
    throw new Error(`OS mouse failed: ${out.trim().slice(0, 200)}`);
  }
  return out;
}

/** Move the real OS cursor to a screen pixel (must be inside the Floorp window). */
export function moveCursor(x: number, y: number): Promise<void> {
  return runMouse(x, y, "move").then(() => {});
}

/** Real OS mouse click at a screen pixel inside the Floorp window. */
export function realClick(
  x: number,
  y: number,
  opts: { button?: "left" | "right"; double?: boolean } = {},
): Promise<void> {
  const action = opts.double ? "double" : opts.button === "right" ? "right" : "click";
  return runMouse(x, y, action).then(() => {});
}

/** Floorp window rectangle in screen pixels (so callers can target real_click). */
export async function floorpWindowBounds(): Promise<{
  left: number; top: number; right: number; bottom: number; width: number; height: number;
}> {
  const out = await runMouse(0, 0, "bounds");
  const m = out.match(/BOUNDS:(-?\d+),(-?\d+),(-?\d+),(-?\d+)/);
  if (!m) throw new Error("Could not read Floorp window bounds: " + out.trim().slice(0, 120));
  const [, L, T, R, B] = m.map(Number);
  return { left: L, top: T, right: R, bottom: B, width: R - L, height: B - T };
}

// Best-effort cleanup so we don't leak the host on normal exit.
process.on("exit", killHost);
