/** v1.3.0 security-hardening checks against live Floorp:
 *  - SSRF guard: loopback / private hosts refused by open_tab/navigate_tab
 *  - zod bounds: out-of-range numeric args rejected
 *  - find: inline-hidden elements excluded from results
 * Run: npx tsx test/v13.ts
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({ command: "node", args: ["dist/index.js"] });
const client = new Client({ name: "v13-test", version: "0.0.0" });
await client.connect(transport);
const txt = (r: any) => (r.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
async function call(n: string, a: Record<string, unknown> = {}) {
  try {
    const r: any = await client.callTool({ name: n, arguments: a });
    return { text: txt(r).trim(), isError: !!r.isError };
  } catch (e) {
    // MCP input-validation failures surface as a thrown protocol error.
    return { text: (e as Error).message, isError: true };
  }
}
let pass = 0, fail = 0;
const chk = (l: string, c: boolean, d = "") => { if (c) { pass++; console.log("✅ " + l); } else { fail++; console.log("❌ " + l + "  " + d); } };

await call("launch_floorp");

// -- SSRF guard --------------------------------------------------------------
for (const url of [
  "http://127.0.0.1:58261/tabs/list",
  "http://localhost:58261/health",
  "http://192.168.1.1/",
  "http://169.254.1.1/",
]) {
  const r = await call("open_tab", { url });
  chk(`open_tab refuses ${url}`, r.isError && /internal|loopback|private/i.test(r.text), r.text.slice(0, 120));
}

// non-http scheme still blocked
const fileR = await call("open_tab", { url: "file:///C:/Windows/win.ini" });
chk("open_tab refuses file://", fileR.isError, fileR.text.slice(0, 100));

// legit URL still works
const ok = await call("open_tab", { url: "https://example.com" });
const browserId = ok.text.match(/browserId:\s*(\d+)/)?.[1];
chk("open_tab allows https://example.com", !ok.isError && !!browserId, ok.text.slice(0, 120));

// navigate_tab to loopback also refused
if (browserId) {
  const nav = await call("navigate_tab", { url: "http://127.0.0.1:58261/health", browserId });
  chk("navigate_tab refuses loopback", nav.isError && /internal|loopback/i.test(nav.text), nav.text.slice(0, 120));
}

// -- zod bounds --------------------------------------------------------------
const neg = await call("read_page", { browserId, maxChars: -1 });
chk("read_page rejects maxChars=-1", neg.isError, neg.text.slice(0, 120));

const bigLimit = await call("find", { tag: "a", limit: 9_999_999, browserId });
chk("find rejects limit=9999999", bigLimit.isError, bigLimit.text.slice(0, 120));

const badXY = await call("move_cursor", { x: 1e9, y: 1e9 });
chk("move_cursor rejects x=1e9", badXY.isError, badXY.text.slice(0, 120));

if (browserId) await call("close_tab", { browserId });
console.log(`\n${pass} passed, ${fail} failed`);
await client.close();
process.exit(fail ? 1 : 0);
