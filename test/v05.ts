/**
 * v0.5.0 smoke test: launch_floorp, snapshot (fingerprints + selector map),
 * and click-by-ref, against live Floorp. Run: npx tsx test/v05.ts (after build).
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({ command: "node", args: ["dist/index.js"] });
const client = new Client({ name: "v05-test", version: "0.0.0" });
await client.connect(transport);

function txt(r: any): string {
  return (r.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
}
async function call(n: string, a: Record<string, unknown> = {}) {
  const r: any = await client.callTool({ name: n, arguments: a });
  return { text: txt(r).trim(), isError: !!r.isError };
}
let pass = 0, fail = 0;
function chk(label: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log("✅ " + label); }
  else { fail++; console.log("❌ " + label + "  " + detail); }
}

const tools = (await client.listTools()).tools.map((t) => t.name);
console.log(`tools (${tools.length}): ${tools.join(", ")}\n`);
chk("snapshot tool present", tools.includes("snapshot"));
chk("launch_floorp tool present", tools.includes("launch_floorp"));

const lf = await call("launch_floorp");
chk("launch_floorp (already running)", !lf.isError && /already running|API is up/.test(lf.text), lf.text);

const opened = await call("open_tab", { url: "https://example.com" });
const browserId = opened.text.match(/browserId:\s*(\d+)/)?.[1];
chk("open_tab returns browserId", !!browserId, opened.text);

const snap = await call("snapshot", { browserId });
chk("snapshot has fingerprints + selector map",
  snap.text.includes("fp:") && /Selector Map/i.test(snap.text),
  snap.text.slice(0, 120));
console.log("snapshot head:\n" + snap.text.slice(0, 280) + "\n…\n");

const ref = snap.text.match(/fp:([0-9a-z]{8,})\s*\|/i)?.[1];
console.log("picked ref:", ref);
if (ref) {
  const c = await call("click", { browserId, ref });
  chk("click by ref (no error)", !c.isError, c.text);
}

if (browserId) await call("close_tab", { browserId });
console.log(`\n${pass} passed, ${fail} failed`);
await client.close();
process.exit(fail ? 1 : 0);
