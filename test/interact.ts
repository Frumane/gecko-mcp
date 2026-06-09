/**
 * Interaction smoke test: launches the freshly built server and exercises the
 * interaction tools (wait_for_element, type_text, get_value, fill_form, click,
 * press_key) against live Floorp using Wikipedia's search box — a stable,
 * automation-friendly real page.
 *
 * Run with: npx tsx test/interact.ts   (after `npm run build`)
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SEARCH = "input[name=search]";

const transport = new StdioClientTransport({ command: "node", args: ["dist/index.js"] });
const client = new Client({ name: "interact-test", version: "0.0.0" });
await client.connect(transport);

function txt(r: any): string {
  return (r.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
}
async function call(name: string, args: Record<string, unknown> = {}) {
  const r: any = await client.callTool({ name, arguments: args });
  return { text: txt(r).trim(), isError: !!r.isError };
}

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`✅ ${label}`);
  } else {
    fail++;
    console.log(`❌ ${label}  ${detail}`);
  }
}

const opened = await call("open_tab", { url: "https://en.wikipedia.org/" });
check("open_tab", !opened.isError, opened.text);

const w = await call("wait_for_element", { selector: SEARCH, state: "visible", timeoutMs: 8000 });
check("wait_for_element", !w.isError, w.text);

await call("type_text", { selector: SEARCH, text: "Floorp browser" });
const v1 = await call("get_value", { selector: SEARCH });
check("type_text + get_value", v1.text === "Floorp browser", `got: ${v1.text}`);

await call("fill_form", { fields: { [SEARCH]: "Mozilla Firefox" } });
const v2 = await call("get_value", { selector: SEARCH });
check("fill_form", v2.text === "Mozilla Firefox", `got: ${v2.text}`);

const clicked = await call("click", { selector: SEARCH });
check("click (no error)", !clicked.isError, clicked.text);

const pressed = await call("press_key", { key: "Escape" });
check("press_key (no error)", !pressed.isError, pressed.text);

// failure surfacing: a bogus selector must now report an error, not silently pass
const bogus = await call("click", { selector: "#definitely-not-here-12345" });
check("click bogus selector reports error", bogus.isError, `got: ${bogus.text}`);

const read = await call("read_page", {});
check("read_page", read.text.toLowerCase().includes("wikipedia"), read.text.slice(0, 80));

// cleanup
const list = await call("list_tabs");
const m = list.text.match(/en\.wikipedia\.org[\s\S]*?browserId:\s*(\d+)/);
if (m) {
  await call("close_tab", { browserId: m[1] });
  console.log(`(closed test tab ${m[1]})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
await client.close();
process.exit(fail ? 1 : 0);
