/**
 * Server-side element locator. Searches a page's raw HTML by visible text and/or
 * tag and returns compact, clickable CSS selectors — so the full page never has
 * to reach the model. Pure (no I/O) so it can be unit-tested directly.
 */

/** Escape a raw attribute value for use inside a double-quoted CSS string. */
export function cssString(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Build a clickable CSS selector from an element's opening tag, preferring the
 *  most stable identifier available. */
export function suggestSelector(openTag: string, tag: string): string {
  const id = openTag.match(/\sid="([^"]+)"/)?.[1];
  if (id && /^[A-Za-z_][\w-]*$/.test(id)) return `#${id}`;
  const name = openTag.match(/\sname="([^"]+)"/)?.[1];
  if (name) return `${tag}[name="${cssString(name)}"]`;
  const href = openTag.match(/\shref="([^"]+)"/)?.[1];
  if (href && href !== "#" && !href.startsWith("javascript:")) return `${tag}[href="${cssString(href)}"]`;
  const cls = openTag
    .match(/\sclass="([^"]+)"/)?.[1]
    ?.split(/\s+/)
    .find((c) => /^[A-Za-z_][\w-]{1,}$/.test(c));
  if (cls) return `${tag}.${cls}`;
  const type = openTag.match(/\stype="([^"]+)"/)?.[1];
  if (type) return `${tag}[type="${cssString(type)}"]`;
  return tag;
}

export interface FoundEl {
  tag: string;
  selector: string;
  text: string;
}

/** Locate elements in raw HTML by visible text and/or tag — runs server-side so
 *  the full page never reaches the model. Returns compact, clickable matches. */
export function findInHtml(html: string, opts: { text?: string; tag?: string; limit: number }): FoundEl[] {
  // Strip Floorp's injected automation overlay so it can't pollute matches.
  html = html
    .replace(/<style id="nr-webscraper[\s\S]*?<\/style>/gi, " ")
    .replace(/<div[^>]*nr-webscraper[\s\S]*?<\/div>/gi, " ");
  const out: FoundEl[] = [];
  const tagFilter = opts.tag?.toLowerCase();
  const strip = (s: string) => s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  // Text nodes never live in these — skip them so a text search returns visible elements.
  const INVISIBLE = new Set(["title", "meta", "script", "style", "head", "link", "noscript", "html"]);
  // Skip elements an attacker can hide to lure the agent into clicking them. Best
  // effort over raw HTML: catches inline hiding, the hidden attr, type=hidden,
  // aria-hidden (not CSS-class-based hiding, which needs computed styles).
  const isHidden = (openTag: string): boolean =>
    /\stype\s*=\s*["']?hidden/i.test(openTag) ||
    /\shidden(\s|>|=|\/)/i.test(openTag) ||
    /\saria-hidden\s*=\s*["']?true/i.test(openTag) ||
    /\sstyle\s*=\s*["'][^"']*(display\s*:\s*none|visibility\s*:\s*hidden)/i.test(openTag);

  if (opts.text) {
    const lc = html.toLowerCase();
    const q = opts.text.toLowerCase();
    const seen = new Set<number>();
    let from = 0;
    while (out.length < opts.limit) {
      const idx = lc.indexOf(q, from);
      if (idx < 0) break;
      from = idx + q.length;
      const open = html.lastIndexOf("<", idx);
      if (open < 0 || seen.has(open)) continue;
      seen.add(open);
      const tm = html.slice(open).match(/^<([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/);
      if (!tm) continue;
      const tg = tm[1].toLowerCase();
      if (INVISIBLE.has(tg)) continue;
      if (isHidden(tm[0])) continue;
      if (tagFilter && tg !== tagFilter) continue;
      // Preview = the matched text node only; cut at the next tag so it can't bleed.
      const seg = html.slice(idx, idx + 120);
      const cut = seg.indexOf("<");
      const text = (cut >= 0 ? seg.slice(0, cut) : seg).replace(/\s+/g, " ").trim();
      out.push({ tag: tg, selector: suggestSelector(tm[0], tg), text });
    }
  } else if (tagFilter) {
    const re = new RegExp(`<${tagFilter}\\b[^>]*>`, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) && out.length < opts.limit) {
      if (isHidden(m[0])) continue;
      const after = html.slice(m.index + m[0].length, m.index + m[0].length + 90);
      out.push({ tag: tagFilter, selector: suggestSelector(m[0], tagFilter), text: strip(after) });
    }
  }
  return out;
}
