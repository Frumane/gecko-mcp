/**
 * Standalone diagnostic: verifies that Floorp's automation API is reachable and
 * lists the currently open tabs. Run with `npm run probe`.
 */

import { FloorpClient } from "./floorp-client.js";

async function main() {
  const client = new FloorpClient();

  const ok = await client.health();
  if (!ok) {
    console.error(
      "❌ Could not reach Floorp's automation API.\n" +
        "   - Is Floorp running?\n" +
        "   - Is 'floorp.mcp.enabled' set to true in about:config?\n" +
        "   - Did you fully restart Floorp after enabling it?",
    );
    process.exit(1);
  }
  console.log("✅ Floorp automation API is reachable.\n");

  const tabs = await client.listTabs();
  console.log(`Open tabs (${tabs.length}):`);
  for (const t of tabs) {
    const flags = [t.selected ? "active" : "", t.pinned ? "pinned" : ""]
      .filter(Boolean)
      .join(",");
    console.log(`  [${t.browserId}] ${t.title}${flags ? ` (${flags})` : ""}`);
    console.log(`        ${t.url}`);
  }
}

main().catch((err) => {
  console.error("Probe failed:", err);
  process.exit(1);
});
