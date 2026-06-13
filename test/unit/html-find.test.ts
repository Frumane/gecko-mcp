import { test } from "node:test";
import assert from "node:assert/strict";
import { findInHtml, suggestSelector, cssString } from "../../src/html-find.ts";

test("cssString escapes backslashes and double quotes", () => {
  assert.equal(cssString('a"b\\c'), 'a\\"b\\\\c');
});

test("suggestSelector prefers id > name > href > class > type", () => {
  assert.equal(suggestSelector('<input id="email" name="e">', "input"), "#email");
  assert.equal(suggestSelector('<input name="user">', "input"), 'input[name="user"]');
  assert.equal(suggestSelector('<a href="https://x.com/p">', "a"), 'a[href="https://x.com/p"]');
  assert.equal(suggestSelector('<button class="btn primary">', "button"), "button.btn");
  assert.equal(suggestSelector('<input type="submit">', "input"), 'input[type="submit"]');
  assert.equal(suggestSelector("<div>", "div"), "div");
});

test("suggestSelector ignores javascript: hrefs (falls through to class)", () => {
  // a javascript: href is rejected; class names must be >= 2 chars to be used.
  assert.equal(suggestSelector('<a href="javascript:void(0)" class="login">', "a"), "a.login");
  assert.equal(suggestSelector('<a href="javascript:void(0)">', "a"), "a");
});

test("findInHtml by tag returns one selector per match", () => {
  const html = `<a href="https://iana.org/x">Learn</a><a href="#">skip</a>`;
  const r = findInHtml(html, { tag: "a", limit: 10 });
  assert.equal(r.length, 2);
  assert.equal(r[0].selector, 'a[href="https://iana.org/x"]');
});

test("findInHtml by text skips invisible tags and hidden elements", () => {
  const html =
    `<title>Widget</title>` +
    `<h1>Widget store</h1>` +
    `<button style="display:none">Widget buy</button>` +
    `<input type="hidden" value="Widget">` +
    `<span aria-hidden="true">Widget ghost</span>`;
  const r = findInHtml(html, { text: "Widget", limit: 10 });
  assert.equal(r.length, 1, JSON.stringify(r));
  assert.equal(r[0].tag, "h1");
  assert.equal(r[0].text, "Widget store");
});

test("findInHtml respects the limit", () => {
  const html = "<a>x</a>".repeat(50);
  assert.equal(findInHtml(html, { tag: "a", limit: 5 }).length, 5);
});

test("findInHtml strips Floorp's injected automation overlay", () => {
  const html = `<div class="nr-webscraper-overlay">Target</div><h2>Target</h2>`;
  const r = findInHtml(html, { text: "Target", limit: 10 });
  assert.equal(r.length, 1);
  assert.equal(r[0].tag, "h2");
});
