/**
 * Pure security guards for URL navigation and file uploads. Kept in their own
 * module (no side effects, no server) so they can be unit-tested without a live
 * Floorp or starting the MCP server.
 */

import { resolve, relative, isAbsolute, delimiter } from "node:path";
import { realpathSync } from "node:fs";

/** Browser-internal pages (about:, chrome:, …) cannot be screenshotted. */
export const PRIVILEGED_SCHEME = /^(about|chrome|resource|view-source|moz-extension):/i;

/** True for loopback / link-local / RFC-1918 private hosts. Best-effort literal
 *  check (does not resolve DNS — that rebinding case is documented in README). */
export function isInternalHost(host: string): boolean {
  const h = host.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h === "" || h === "::" || h === "::1") return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    if (a === 0 || a === 127 || a === 10) return true; // this-host, loopback, private
    if (a === 169 && b === 254) return true; // link-local
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
  }
  // IPv6 loopback / unique-local (fc00::/7) / link-local (fe80::/10)
  if (h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe8") || h.startsWith("fe9") ||
      h.startsWith("fea") || h.startsWith("feb")) return true;
  return false;
}

/** Gate URLs before open/navigate. By default: only http(s) (and about:blank),
 *  and NOT loopback/private hosts — so a prompt-injected agent can't pivot the
 *  browser onto Floorp's own automation API (127.0.0.1:58261) or your LAN, then
 *  read the response back. Optional FLOORP_MCP_ALLOW_DOMAINS restricts to a
 *  domain allowlist. FLOORP_MCP_ALLOW_PRIVILEGED_URLS=1 lifts scheme+host gates. */
export function assertNavigableUrl(url: string): void {
  const bypass = process.env.FLOORP_MCP_ALLOW_PRIVILEGED_URLS === "1";
  if (url.trim().toLowerCase() === "about:blank") return;
  const scheme = url.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/)?.[1]?.toLowerCase();
  if (scheme !== "http" && scheme !== "https") {
    if (bypass) return;
    throw new Error(
      `Refusing to open "${url}" — only http(s) URLs are allowed by default ` +
        `(blocks file:// and browser-internal pages). ` +
        `Set FLOORP_MCP_ALLOW_PRIVILEGED_URLS=1 to allow other schemes.`,
    );
  }
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error(`Refusing to open "${url}" — not a valid URL.`);
  }
  if (!bypass && isInternalHost(host)) {
    throw new Error(
      `Refusing to navigate to internal/loopback host "${host}" — this could reach ` +
        `Floorp's own automation API or your private network. ` +
        `Set FLOORP_MCP_ALLOW_PRIVILEGED_URLS=1 to override.`,
    );
  }
  const allow = process.env.FLOORP_MCP_ALLOW_DOMAINS;
  if (allow) {
    const h = host.toLowerCase();
    const ok = allow
      .split(",")
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean)
      .some((d) => h === d || h.endsWith("." + d));
    if (!ok) {
      throw new Error(
        `Refusing to navigate to "${host}" — not in FLOORP_MCP_ALLOW_DOMAINS allowlist.`,
      );
    }
  }
}

/** If FLOORP_MCP_ALLOW_UPLOAD_DIRS is set (';'-separated on Windows), uploads are
 *  restricted to files inside those directories. Paths are canonicalised with
 *  realpath (resolving symlinks) and checked with path.relative so neither a
 *  symlink, a "..", nor a same-prefix sibling dir (C:\\a vs C:\\ab) can escape.
 *  UNC paths are rejected when an allowlist is set. Unset = any path (default). */
export function assertUploadAllowed(filePath: string): string {
  const canon = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  const resolved = canon(filePath);
  const allow = process.env.FLOORP_MCP_ALLOW_UPLOAD_DIRS;
  if (!allow) return resolved;
  if (process.platform === "win32" && /^\\\\/.test(resolved)) {
    throw new Error(`Upload of "${resolved}" blocked — UNC paths are not allowed. Use a local absolute path.`);
  }
  const ok = allow
    .split(delimiter)
    .map((d) => d.trim())
    .filter(Boolean)
    .some((d) => {
      const rel = relative(canon(d), resolved);
      return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    });
  if (!ok) {
    throw new Error(
      `Upload of "${resolved}" blocked — outside FLOORP_MCP_ALLOW_UPLOAD_DIRS. ` +
        `Add its directory to that variable (';'-separated) to allow it.`,
    );
  }
  return resolved;
}
