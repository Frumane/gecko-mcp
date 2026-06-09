/**
 * Safety test for the OS keyboard guard. With Floorp NOT in the foreground
 * (e.g. closed), real input MUST abort without sending any keystroke, so text
 * can never leak into another app. Run: npx tsx test/os-input-guard.ts
 */

import { realType, toSendKeys } from "../src/os-input.js";

// Pure mapping checks (no side effects)
const cases: Array<[string, string]> = [
  ["Enter", "{ENTER}"],
  ["ctrl+a", "^a"],
  ["ctrl+shift+k", "^+k"],
  ["Escape", "{ESC}"],
  ["a", "a"],
];
for (const [input, expected] of cases) {
  const got = toSendKeys(input);
  console.log(`${got === expected ? "✅" : "❌"} toSendKeys(${input}) = ${got} (want ${expected})`);
}

console.log("\n— guard test: real_type with Floorp not foreground —");
try {
  await realType("THIS_TEXT_MUST_NEVER_BE_TYPED_ANYWHERE");
  console.log("❌ UNSAFE: realType returned without throwing — it may have typed somewhere!");
  process.exit(1);
} catch (e) {
  const msg = (e as Error).message;
  console.log("aborted with:", msg);
  if (msg.includes("not running") || msg.includes("foreground")) {
    console.log("✅ SAFE: aborted WITHOUT sending keys.");
    process.exit(0);
  }
  console.log("⚠️ threw for an unexpected reason.");
  process.exit(2);
}
