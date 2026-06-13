import { test } from "node:test";
import assert from "node:assert/strict";
import { toSendKeys } from "../../src/os-input.ts";

test("toSendKeys maps named keys", () => {
  assert.equal(toSendKeys("Enter"), "{ENTER}");
  assert.equal(toSendKeys("Escape"), "{ESC}");
  assert.equal(toSendKeys("Tab"), "{TAB}");
  assert.equal(toSendKeys("Backspace"), "{BS}");
  assert.equal(toSendKeys("PageDown"), "{PGDN}");
});

test("toSendKeys maps modifier combos", () => {
  assert.equal(toSendKeys("ctrl+a"), "^a");
  assert.equal(toSendKeys("ctrl+shift+k"), "^+k");
  assert.equal(toSendKeys("alt+F4"), "%{F4}");
});

test("toSendKeys passes single characters through", () => {
  assert.equal(toSendKeys("a"), "a");
  assert.equal(toSendKeys("Z"), "z"); // lowercased; SendKeys is case-insensitive for letters
});
