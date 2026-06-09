/**
 * Launch Floorp if it isn't already running (Windows).
 *
 * "Ensure running" semantics: if the automation API is already reachable we do
 * nothing; otherwise we spawn the Floorp executable and poll until the API on
 * 127.0.0.1:58261 responds (or time out). Set FLOORP_PATH to override the exe.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { FloorpClient } from "./floorp-client.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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

export async function launchFloorp(client: FloorpClient): Promise<string> {
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
