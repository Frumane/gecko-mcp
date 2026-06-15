/**
 * Launch Floorp if it isn't already running (Windows).
 *
 * "Ensure running" semantics: if the automation API is already reachable we do
 * nothing; otherwise we spawn the Floorp executable and poll until the API on
 * 127.0.0.1:58261 responds (or time out). Set FLOORP_PATH to override the exe.
 */

import { spawn } from "node:child_process";
import { connect } from "node:net";
import { existsSync } from "node:fs";
import type { BrowserBackend } from "./floorp-client.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const portOpen = (port: number, host = "127.0.0.1"): Promise<boolean> =>
  new Promise((res) => {
    const s = connect({ host, port }, () => { s.destroy(); res(true); });
    s.on("error", () => { s.destroy(); res(false); });
  });

// Known Gecko browser executables on Windows (other OSes resolve by name on PATH).
const WIN_BROWSERS: Record<string, string[]> = {
  firefox: ["C:\\Program Files\\Mozilla Firefox\\firefox.exe", "C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe"],
  librewolf: ["C:\\Program Files\\LibreWolf\\librewolf.exe"],
  waterfox: ["C:\\Program Files\\Waterfox\\waterfox.exe"],
  zen: ["C:\\Program Files\\Zen Browser\\zen.exe", `${process.env.LOCALAPPDATA ?? ""}\\Zen Browser\\zen.exe`],
  mullvad: ["C:\\Program Files\\Mullvad Browser\\mullvadbrowser.exe"],
  floorp: ["C:\\Program Files\\Ablaze Floorp\\floorp.exe", "C:\\Program Files (x86)\\Ablaze Floorp\\floorp.exe"],
};

function resolveBrowserExe(opts: { path?: string; browser?: string }): string | null {
  if (opts.path) return existsSync(opts.path) ? opts.path : null;
  if (process.platform === "win32") {
    const names = opts.browser ? [opts.browser.toLowerCase()] : Object.keys(WIN_BROWSERS);
    for (const n of names) {
      for (const p of (WIN_BROWSERS[n] ?? []).filter(Boolean)) {
        if (existsSync(p)) return p;
      }
    }
    return null;
  }
  return opts.browser || "firefox"; // PATH lookup at spawn time
}

/** Launch a Gecko browser with Marionette enabled and wait for the port. Uses the
 *  browser's normal profile (your logged-in session). If the browser is already
 *  running WITHOUT Marionette, close it first — a second launch can't enable it. */
export async function launchBrowser(
  opts: { path?: string; browser?: string; port?: number } = {},
): Promise<string> {
  const port = opts.port ?? (Number(process.env.MARIONETTE_PORT) || 2828);
  if (await portOpen(port)) return `A browser with Marionette is already listening on 127.0.0.1:${port}.`;
  const exe = resolveBrowserExe(opts);
  if (!exe) {
    throw new Error(
      opts.browser
        ? `Could not find "${opts.browser}". Pass a full exe path, or install it.`
        : "No Gecko browser found. Pass `path` (full exe) or `browser` (firefox/librewolf/waterfox/zen/mullvad/floorp).",
    );
  }
  spawn(exe, ["-marionette"], { detached: true, stdio: "ignore" }).unref();
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    if (await portOpen(port)) return `Launched ${exe} with Marionette; listening on :${port} after ~${i + 1}s.`;
  }
  throw new Error(
    `Launched ${exe} but Marionette didn't open on :${port} within 30s. If the browser was already ` +
      "running, close it fully and try again (a second launch can't enable Marionette)." +
      (port !== 2828 ? ` Also set the profile's marionette.port pref to ${port}.` : ""),
  );
}

function findFloorpExe(): string | null {
  const candidates = [
    process.env.FLOORP_PATH,
    "C:\\Program Files\\Ablaze Floorp\\floorp.exe",
    "C:\\Program Files (x86)\\Ablaze Floorp\\floorp.exe",
    process.env.LOCALAPPDATA
      ? `${process.env.LOCALAPPDATA}\\Ablaze Floorp\\floorp.exe`
      : undefined,
  ].filter((p): p is string => typeof p === "string" && p.length > 0);
  return candidates.find((p) => existsSync(p)) ?? null;
}

export async function launchFloorp(client: BrowserBackend): Promise<string> {
  if (await client.health()) {
    return "Floorp is already running and its automation API is reachable.";
  }
  if (process.platform !== "win32") {
    throw new Error("launch_floorp is currently Windows-only.");
  }
  const exe = findFloorpExe();
  if (!exe) {
    throw new Error(
      "Could not find floorp.exe. Set the FLOORP_PATH environment variable to its full path.",
    );
  }
  spawn(exe, [], { detached: true, stdio: "ignore" }).unref();

  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    if (await client.health()) {
      return `Launched Floorp (${exe}); automation API is up after ~${i + 1}s.`;
    }
  }
  throw new Error(
    "Launched Floorp, but its automation API (127.0.0.1:58261) didn't come up within 30s. " +
      "Make sure 'floorp.mcp.enabled' is set to true in about:config.",
  );
}
