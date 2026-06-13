import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isInternalHost, assertNavigableUrl, assertUploadAllowed } from "../../src/guards.ts";

test("isInternalHost: loopback / private / link-local are internal", () => {
  for (const h of [
    "127.0.0.1", "localhost", "app.localhost", "10.0.0.5", "192.168.1.1",
    "172.16.0.1", "172.31.255.1", "169.254.1.1", "::1", "[::1]", "fc00::1", "fe80::1", "0.0.0.0",
  ]) {
    assert.equal(isInternalHost(h), true, `expected internal: ${h}`);
  }
});

test("isInternalHost: public hosts are external", () => {
  for (const h of ["example.com", "8.8.8.8", "1.1.1.1", "172.32.0.1", "172.15.0.1", "93.184.216.34", "github.com"]) {
    assert.equal(isInternalHost(h), false, `expected external: ${h}`);
  }
});

test("assertNavigableUrl: allows public http(s) and about:blank", () => {
  delete process.env.FLOORP_MCP_ALLOW_PRIVILEGED_URLS;
  delete process.env.FLOORP_MCP_ALLOW_DOMAINS;
  assert.doesNotThrow(() => assertNavigableUrl("https://example.com/x"));
  assert.doesNotThrow(() => assertNavigableUrl("http://example.com"));
  assert.doesNotThrow(() => assertNavigableUrl("about:blank"));
});

test("assertNavigableUrl: blocks file:// and loopback/private hosts", () => {
  delete process.env.FLOORP_MCP_ALLOW_PRIVILEGED_URLS;
  delete process.env.FLOORP_MCP_ALLOW_DOMAINS;
  assert.throws(() => assertNavigableUrl("file:///C:/Windows/win.ini"));
  assert.throws(() => assertNavigableUrl("http://127.0.0.1:58261/tabs/list"));
  assert.throws(() => assertNavigableUrl("http://localhost/x"));
  assert.throws(() => assertNavigableUrl("https://192.168.1.1/admin"));
});

test("assertNavigableUrl: FLOORP_MCP_ALLOW_PRIVILEGED_URLS=1 lifts gates", () => {
  process.env.FLOORP_MCP_ALLOW_PRIVILEGED_URLS = "1";
  assert.doesNotThrow(() => assertNavigableUrl("http://127.0.0.1:58261/x"));
  assert.doesNotThrow(() => assertNavigableUrl("file:///x"));
  delete process.env.FLOORP_MCP_ALLOW_PRIVILEGED_URLS;
});

test("assertNavigableUrl: FLOORP_MCP_ALLOW_DOMAINS allowlist (with subdomains)", () => {
  process.env.FLOORP_MCP_ALLOW_DOMAINS = "example.com, github.com";
  assert.doesNotThrow(() => assertNavigableUrl("https://example.com/a"));
  assert.doesNotThrow(() => assertNavigableUrl("https://sub.example.com/a"));
  assert.throws(() => assertNavigableUrl("https://evil.com/a"));
  delete process.env.FLOORP_MCP_ALLOW_DOMAINS;
});

test("assertUploadAllowed: unset allowlist permits any path", () => {
  delete process.env.FLOORP_MCP_ALLOW_UPLOAD_DIRS;
  const p = assertUploadAllowed(join(tmpdir(), "anything.txt"));
  assert.ok(p.length > 0);
});

test("assertUploadAllowed: confines to allowlist; blocks sibling & traversal", () => {
  const root = mkdtempSync(join(tmpdir(), "fmcp-up-"));
  const allowed = join(root, "ok");
  const sibling = join(root, "ok-secret"); // same-prefix sibling
  mkdirSync(allowed);
  mkdirSync(sibling);
  const inside = join(allowed, "f.txt");
  const outside = join(sibling, "s.txt");
  writeFileSync(inside, "x");
  writeFileSync(outside, "x");
  process.env.FLOORP_MCP_ALLOW_UPLOAD_DIRS = allowed;
  assert.doesNotThrow(() => assertUploadAllowed(inside));
  assert.throws(() => assertUploadAllowed(outside), /blocked/, "same-prefix sibling must be blocked");
  assert.throws(() => assertUploadAllowed(join(allowed, "..", "s.txt")), /blocked/, "traversal must be blocked");
  delete process.env.FLOORP_MCP_ALLOW_UPLOAD_DIRS;
});
