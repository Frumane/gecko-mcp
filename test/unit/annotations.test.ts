import { test } from "node:test";
import assert from "node:assert/strict";
import { ANNOTATIONS } from "../../src/annotations.ts";

const READ_ONLY = [
  "list_tabs", "get_active_tab", "read_page", "screenshot", "find", "snapshot",
  "get_value", "wait_for_element", "get_attribute", "get_article", "get_cookies",
  "wait_for_network_idle", "list_workspaces", "window_bounds",
];
const DESTRUCTIVE = ["close_tab", "navigate_tab", "submit_form", "upload_file"];

test("every annotation has a title and a boolean openWorldHint", () => {
  for (const [name, a] of Object.entries(ANNOTATIONS)) {
    assert.equal(typeof a.title, "string", `${name} needs a title`);
    assert.ok((a.title as string).length > 0, `${name} title not empty`);
    assert.equal(typeof a.openWorldHint, "boolean", `${name} openWorldHint`);
  }
});

test("no tool is both read-only and destructive", () => {
  for (const [name, a] of Object.entries(ANNOTATIONS)) {
    assert.ok(!(a.readOnlyHint === true && a.destructiveHint === true), `${name} can't be both`);
  }
});

test("read-only tools are marked readOnlyHint:true (and not destructive)", () => {
  for (const name of READ_ONLY) {
    const a = ANNOTATIONS[name];
    assert.ok(a, `${name} missing from ANNOTATIONS`);
    assert.equal(a.readOnlyHint, true, `${name} should be read-only`);
    assert.notEqual(a.destructiveHint, true, `${name} should not be destructive`);
  }
});

test("destructive tools are marked destructiveHint:true and not read-only", () => {
  for (const name of DESTRUCTIVE) {
    const a = ANNOTATIONS[name];
    assert.ok(a, `${name} missing from ANNOTATIONS`);
    assert.equal(a.readOnlyHint, false, `${name} should not be read-only`);
    assert.equal(a.destructiveHint, true, `${name} should be destructive`);
  }
});
