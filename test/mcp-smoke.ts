/**
 * End-to-end smoke test: launches the built MCP server over stdio with a real
 * MCP client, lists tools, and exercises the read-only ones against live Floorp.
 * Run with: npx tsx test/mcp-smoke.ts  (after `npm run build`)
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function main() {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
  });
  const client = new Client({ name: "smoke-test", version: "0.0.0" });
  await client.connect(transport);

  const { tools } = await client.listTools();
  console.log(`Tools (${tools.length}): ${tools.map((t) => t.name).join(", ")}\n`);

  console.log("── open_tab (example.com) ──");
  const opened = await client.callTool({
    name: "open_tab",
    arguments: { url: "https://example.com" },
  });
  const openedText = textOf(opened);
  console.log(openedText, "\n");

  // Target the exact tab we just opened (reliable across multiple windows).
  const browserId = openedText.match(/browserId:\s*(\d+)/)?.[1];
  console.log(`(using browserId: ${browserId ?? "?"})\n`);
  const target = browserId ? { browserId } : {};

  console.log("── read_page (markdown) ──");
  const read = await client.callTool({ name: "read_page", arguments: target });
  console.log(truncate(textOf(read), 400), "\n");

  console.log("── screenshot ──");
  const shot = await client.callTool({ name: "screenshot", arguments: target });
  console.log(describeContent(shot), "\n");

  if (browserId) {
    console.log("── close_tab ──");
    const closed = await client.callTool({ name: "close_tab", arguments: { browserId } });
    console.log(textOf(closed), "\n");
  }

  await client.close();
  console.log("✅ smoke test complete");
}

function textOf(result: any): string {
  return (result.content ?? [])
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .join("\n");
}

function describeContent(result: any): string {
  return (result.content ?? [])
    .map((c: any) =>
      c.type === "image"
        ? `[image ${c.mimeType}, ${c.data.length} base64 chars]`
        : `[text] ${truncate(c.text, 120)}`,
    )
    .join("\n");
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + " …" : s;
}

main().catch((err) => {
  console.error("Smoke test failed:", err);
  process.exit(1);
});
