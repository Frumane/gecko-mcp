/** v1.1.0: `find` (server-side element locator) smoke test against live Floorp. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({ command: "node", args: ["dist/index.js"] });
const client = new Client({ name: "v11-test", version: "0.0.0" });
await client.connect(transport);
const txt = (r: any) => (r.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
async function call(n: string, a: Record<string, unknown> = {}) {
  const r: any = await client.callTool({ name: n, arguments: a });
  return { text: txt(r).trim(), isError: !!r.isError };
}
let pass = 0, fail = 0;
const chk = (l: string, c: boolean, d = "") => { if (c) { pass++; console.log("✅ " + l); } else { fail++; console.log("❌ " + l + "  " + d); } };

const tools = (await client.listTools()).tools.map((t) => t.name);
chk("find tool present", tools.includes("find"), `tools=${tools.length}`);

await call("launch_floorp");
const opened = await call("open_tab", { url: "https://example.com" });
const browserId = opened.text.match(/browserId:\s*(\d+)/)?.[1];
chk("open_tab", !!browserId, opened.text);

const byTag = await call("find", { tag: "a", browserId });
chk("find tag=a returns a selector", !byTag.isError && /\|\s*a\s*\|/.test(byTag.text), byTag.text.slice(0, 160));
console.log("  find tag=a:\n  " + byTag.text.replace(/\n/g, "\n  ") + "\n");

const byText = await call("find", { text: "Example Domain", browserId });
chk("find text='Example Domain'", !byText.isError && /example domain/i.test(byText.text), byText.text.slice(0, 160));
console.log("  find text:\n  " + byText.text.replace(/\n/g, "\n  ") + "\n");

if (browserId) await call("close_tab", { browserId });
console.log(`\n${pass} passed, ${fail} failed`);
await client.close();
process.exit(fail ? 1 : 0);
