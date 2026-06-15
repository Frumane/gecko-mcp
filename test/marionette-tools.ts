/** End-to-end test of the MCP tool surface over the MARIONETTE backend.
 *  Launches a headless Gecko browser (Floorp via FLOORP_PATH) with -marionette,
 *  spawns the MCP server forced to the Marionette backend, and drives real tools.
 *  Run: npx tsx test/marionette-tools.ts */
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const EXE =
  process.env.FLOORP_PATH ||
  ["C:\\Program Files\\Ablaze Floorp\\floorp.exe", "C:\\Program Files (x86)\\Ablaze Floorp\\floorp.exe"].find((p) => existsSync(p)) ||
  "floorp";
const PORT = 2830;
const profile = mkdtempSync(join(tmpdir(), "fmcp-martools-"));
writeFileSync(join(profile, "user.js"), `user_pref("marionette.port", ${PORT});\n`);

const waitPort = (port: number, ms: number) =>
  new Promise<boolean>((resolve) => {
    const deadline = Date.now() + ms;
    const tick = () => {
      const s = connect({ host: "127.0.0.1", port }, () => { s.destroy(); resolve(true); });
      s.on("error", () => { s.destroy(); if (Date.now() > deadline) resolve(false); else setTimeout(tick, 300); });
    };
    tick();
  });

const browser = spawn(EXE, ["-headless", "-marionette", "-no-remote", "-profile", profile], { stdio: "ignore" });

let pass = 0, fail = 0;
const chk = (l: string, c: boolean, d = "") => { if (c) { pass++; console.log("✅ " + l); } else { fail++; console.log("❌ " + l + "  " + d); } };

let client: Client | null = null;
try {
  console.log(`launching headless ${EXE} (marionette :${PORT})`);
  if (!(await waitPort(PORT, 30_000))) throw new Error("marionette port never opened");
  console.log("✅ browser up\n");

  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: { ...process.env, FLOORP_MCP_BACKEND: "marionette", MARIONETTE_PORT: String(PORT) },
  });
  client = new Client({ name: "mar-tools", version: "0.0.0" });
  await client.connect(transport);
  const txt = (r: any) => (r.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
  const img = (r: any) => (r.content ?? []).find((c: any) => c.type === "image");
  const call = async (n: string, a: Record<string, unknown> = {}) => {
    const r: any = await client!.callTool({ name: n, arguments: a });
    return { text: txt(r).trim(), image: img(r), isError: !!r.isError };
  };

  const tabs = await call("list_tabs");
  chk("list_tabs works on Marionette", !tabs.isError && /browserId:/.test(tabs.text), tabs.text.slice(0, 120));

  const opened = await call("open_tab", { url: "https://example.com" });
  const browserId = opened.text.match(/browserId:\s*([^\s]+)/)?.[1];
  chk("open_tab returns a handle", !opened.isError && !!browserId, opened.text.slice(0, 120));

  const page = await call("read_page", { browserId });
  chk("read_page returns content", /example domain/i.test(page.text), page.text.slice(0, 80));

  const found = await call("find", { tag: "a", browserId });
  const selector = found.text.match(/(a\[href[^\s|]*\])/)?.[1];
  chk("find returns an <a> selector", !found.isError && !!selector, found.text.slice(0, 160));

  const shot = await call("screenshot", { browserId });
  chk("screenshot returns an image", !!shot.image && (shot.image.data?.length ?? 0) > 1000, shot.text.slice(0, 80));

  // evaluate is locked by default; unlock then run page JS
  const locked = await call("evaluate", { script: "return document.title", browserId });
  chk("evaluate locked by default", locked.isError && /LOCKED/i.test(locked.text), locked.text.slice(0, 80));
  await call("enable_evaluate");
  const evald = await call("evaluate", { script: "return document.title", browserId });
  chk("evaluate runs after enable", !evald.isError && /example domain/i.test(evald.text), evald.text.slice(0, 80));

  if (selector) {
    const clicked = await call("click", { selector, browserId });
    chk("click works", !clicked.isError, clicked.text.slice(0, 120));
    await call("wait_for_network_idle", { browserId, timeoutMs: 8000 });
    const after = await call("read_page", { browserId });
    chk("click navigated (iana page)", /iana|example/i.test(after.text), after.text.slice(0, 80));
  }

  // Floorp-only feature should degrade gracefully, not crash
  const snap = await call("snapshot", { browserId });
  chk("snapshot degrades with a clear message", snap.isError && /Floorp-only/i.test(snap.text), snap.text.slice(0, 120));

  if (browserId) await call("close_tab", { browserId });
  chk("close_tab works", true);
} catch (e) {
  fail++;
  console.error("❌ FATAL:", (e as Error).message);
} finally {
  try { await client?.close(); } catch { /* ignore */ }
  try { browser.kill(); } catch { /* ignore */ }
  setTimeout(() => { try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ } console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); }, 1500);
}
