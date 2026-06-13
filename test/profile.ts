/** Latency profiler — where does a tool call actually spend time?
 *  Measures the raw HTTP client ops (attach/detach/getHtml/getText) and the
 *  PowerShell OS-input path, against live Floorp. Run: npx tsx test/profile.ts */
import { FloorpClient } from "../src/floorp-client.js";
import { realKey } from "../src/os-input.js";

const hr = () => Number(process.hrtime.bigint() / 1000n) / 1000; // ms
async function time(label: string, n: number, fn: () => Promise<unknown>) {
  // warm-up
  await fn().catch(() => {});
  const samples: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = hr();
    await fn().catch(() => {});
    samples.push(hr() - t0);
  }
  samples.sort((a, b) => a - b);
  const sum = samples.reduce((a, b) => a + b, 0);
  const p50 = samples[Math.floor(n / 2)];
  console.log(`${label.padEnd(34)} n=${n}  avg=${(sum / n).toFixed(1)}ms  p50=${p50.toFixed(1)}ms  min=${samples[0].toFixed(1)}  max=${samples[n - 1].toFixed(1)}`);
}

const c = new FloorpClient();
if (!(await c.health())) { console.error("Floorp not reachable — open it first."); process.exit(1); }

// Open a tab to operate on.
const id0 = await c.createTab("https://example.com", { waitForLoad: true });
const browserId = await c.getInstanceBrowserId(id0);
await c.detach(id0);
console.log(`target browserId=${browserId}\n`);

// 1. attach + detach cycle (the per-call overhead withAttachedTab pays)
await time("attach+detach cycle", 15, async () => {
  const id = await c.attach(browserId!);
  if (id) await c.detach(id);
});

// 2. attach alone
await time("attach only", 15, () => c.attach(browserId!));

// 3. full single op under one attach (attach+getHtml+detach) = what `find` does
await time("attach+getHtml+detach (find)", 15, async () => {
  const id = await c.attach(browserId!);
  if (id) { await c.getHtml(id); await c.detach(id); }
});

// 4. getHtml alone (need a live handle)
{
  const id = await c.attach(browserId!);
  await time("getHtml only", 15, () => c.getHtml(id!));
  await time("getText only", 15, () => c.getText(id!));
  await c.detach(id!);
}

// 5. listTabs (the round-trip the fast-path skips)
await time("listTabs", 15, () => c.listTabs());

// 6. PowerShell OS-input (one real key) — expected to dwarf everything
await time("real_key (PowerShell)", 5, () => realKey("shift").catch(() => {}));

await c.attach(browserId!).then((id) => id && c.closeTab(id));
console.log("\ndone");
process.exit(0);
