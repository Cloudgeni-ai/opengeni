/**
 * windows.ts - turn hit lines into readable passages.
 *
 * For each hit: walk up (<= maxUp lines) to the nearest declaration line at lower-or-equal indentation
 * whose block encloses the hit (function/class/const/export/interface/type/enum/describe/route handler,
 * markdown heading, SQL statement, python def/class), then walk down to where that block closes
 * (<= maxDown lines below the hit). No enclosing declaration -> fixed context around the hit, labelled
 * with the nearest enclosing declaration further up. Overlapping windows merge; windows longer than
 * maxWindowLines split around hit clusters; each file keeps its best windowsPerFile windows.
 * All line numbers in this module's public API are 1-based. A line past the end of the file as read (it
 * changed after ripgrep saw it, or could not be read) is skipped by the callers and treated as blank here.
 */
import type { CodeSearchConfig } from "./config";
import type { HitLine, KeywordInfo } from "./recall";

export type Lang = "brace" | "indent" | "markdown" | "sql" | "other";

export interface Window {
  start: number;
  end: number;
  /** Hit lines inside the window (1-based). */
  hits: number[];
  /** Enclosing declaration when it is above the window start (or the window starts at it). */
  label?: { line: number; text: string } | undefined;
  kind: "hit" | "header" | "def";
  score: number;
}

export function langOf(path: string): Lang {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  if (
    [
      "ts",
      "tsx",
      "js",
      "jsx",
      "mjs",
      "cjs",
      "mts",
      "cts",
      "rs",
      "go",
      "java",
      "c",
      "h",
      "cc",
      "cpp",
      "hpp",
      "cs",
      "swift",
      "kt",
      "scala",
      "css",
      "scss",
      "json",
      "jsonc",
      "proto",
      "tf",
      "hcl",
    ].includes(ext)
  ) {
    return "brace";
  }
  if (["py", "yaml", "yml"].includes(ext)) return "indent";
  if (["md", "mdx"].includes(ext)) return "markdown";
  if (ext === "sql") return "sql";
  return "other";
}

export function indentOf(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === " ") n += 1;
    else if (ch === "\t") n += 4;
    else break;
  }
  return n;
}

const CONTROL = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "else",
  "do",
  "try",
  "with",
  "await",
  "new",
  "typeof",
  "function",
  "throw",
  "yield",
  "delete",
  "void",
  "in",
  "of",
  "case",
  "super",
  "this",
  "import",
  "export",
]);

const TS_DECL =
  /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\b|class\s|interface\s|type\s+[A-Za-z_$][\w$]*\s*(?:<[^>]*>)?\s*=|enum\s|const\s+[A-Za-z_$[{]|let\s+[A-Za-z_$[{]|var\s+[A-Za-z_$]|namespace\s|module\s)/;
const EXPORT_DEFAULT = /^\s*export\s+default\b/;
const RUST_DECL =
  /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:const\s+)?(?:fn|struct|enum|trait|impl|mod|macro_rules!)[\s<]/;
const GO_DECL = /^\s*func\s/;
const TEST_DECL = /^\s*(?:describe|it|test)(?:\.\w+)?\s*\(/;
const METHOD =
  /^\s*(?:(?:public|private|protected|static|readonly|async|override|get|set)\s+)*\*?\s*([A-Za-z_$][\w$]*)\s*(?:<[^>()]*>)?\s*\([^;]*$/;
const PROP_FN =
  /^\s*(?:(?:public|private|protected|static|readonly)\s+)*[A-Za-z_$][\w$]*\s*[:=]\s*(?:async\s*)?(?:function\b|\([^)]*\)?[^;]*=>|[A-Za-z_$][\w$]*\s*=>)/;
const OBJ_KEY_OPEN = /^\s*["']?[A-Za-z_$][\w$-]*["']?\s*:\s*(?:[\w$.]+\()?[{[]\s*$/;
const CALLBACK_OPEN = /^\s*(?:await\s+)?[\w$]+(?:\.[\w$]+)+\s*\(.*(?:=>|function\b).*\{\s*$/;
const MD_HEADING = /^(#{1,6})\s/;
const SQL_STMT =
  /^(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|WITH|SELECT|DO|COMMENT|GRANT|REVOKE|BEGIN|SET|LOCK|TRUNCATE)\b/i;
const PY_DECL = /^\s*(?:async\s+)?(?:def|class)\s/;
const YAML_KEY = /^\s*(?:- )?["']?[A-Za-z_$][\w$ .-]*["']?\s*:(?:\s|$)/;

export function isDeclLine(line: string, lang: Lang): boolean {
  if (!line.trim()) return false;
  switch (lang) {
    case "markdown":
      return MD_HEADING.test(line);
    case "sql":
      return indentOf(line) === 0 && SQL_STMT.test(line);
    case "indent":
      return PY_DECL.test(line) || YAML_KEY.test(line);
    case "brace": {
      if (
        TS_DECL.test(line) ||
        EXPORT_DEFAULT.test(line) ||
        RUST_DECL.test(line) ||
        GO_DECL.test(line) ||
        TEST_DECL.test(line)
      )
        return true;
      if (PROP_FN.test(line) || OBJ_KEY_OPEN.test(line) || CALLBACK_OPEN.test(line)) return true;
      const m = METHOD.exec(line);
      if (
        m &&
        !CONTROL.has(m[1]!) &&
        /(\{|\(|,)\s*$/.test(line.trimEnd()) &&
        !/^\s*[\w$]+\s*\(.*\)\s*;?\s*$/.test(line)
      ) {
        return true;
      }
      return false;
    }
    default:
      return false;
  }
}

/** Remove string literals and comments so bracket counting is roughly right. */
export function stripForBrackets(line: string): string {
  const t = line.trim();
  if (t.startsWith("*") || t.startsWith("/*") || t.startsWith("//")) return "";
  return line
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``")
    .replace(/\/\*.*?\*\//g, "")
    .replace(/\/\/.*$/, "");
}

const blockEndCache = new WeakMap<string[], Map<number, number | null>>();

/**
 * 0-based index of the last line of the block starting at 0-based line d, or null if unknown
 * (no structure, or longer than maxScan lines).
 */
export function blockEnd(lines: string[], d: number, lang: Lang, maxScan = 3000): number | null {
  let cache = blockEndCache.get(lines);
  if (!cache) {
    cache = new Map();
    blockEndCache.set(lines, cache);
  }
  const key = d * 8 + ["brace", "indent", "markdown", "sql", "other"].indexOf(lang);
  if (cache.has(key)) return cache.get(key)!;
  const r = computeBlockEnd(lines, d, lang, maxScan);
  cache.set(key, r);
  return r;
}

function computeBlockEnd(lines: string[], d: number, lang: Lang, maxScan: number): number | null {
  const n = lines.length;
  if (d < 0 || d >= n) return null;
  const last = Math.min(n - 1, d + maxScan);
  if (lang === "brace") {
    let depth = 0;
    let maxDepth = 0;
    for (let i = d; i <= last; i++) {
      const s = stripForBrackets(lines[i]!);
      for (const ch of s) {
        if (ch === "{" || ch === "(" || ch === "[") {
          depth++;
          if (depth > maxDepth) maxDepth = depth;
        } else if (ch === "}" || ch === ")" || ch === "]") depth--;
      }
      if (maxDepth > 0 && depth <= 0) return i;
      if (maxDepth === 0 && /;\s*$/.test(s)) return i;
    }
    return null;
  }
  if (lang === "indent") {
    const ind = indentOf(lines[d]!);
    let lastNonEmpty = d;
    for (let i = d + 1; i <= last; i++) {
      const l = lines[i]!;
      if (!l.trim()) continue;
      if (indentOf(l) <= ind) return lastNonEmpty;
      lastNonEmpty = i;
    }
    return last === n - 1 ? lastNonEmpty : null;
  }
  if (lang === "markdown") {
    const m = MD_HEADING.exec(lines[d]!);
    if (!m) return null;
    const level = m[1]!.length;
    let inFence = false;
    for (let i = d + 1; i <= last; i++) {
      const l = lines[i]!;
      if (/^\s*(```|~~~)/.test(l)) inFence = !inFence;
      if (inFence) continue;
      const h = MD_HEADING.exec(l);
      if (h && h[1]!.length <= level) return i - 1;
    }
    return last === n - 1 ? n - 1 : null;
  }
  if (lang === "sql") {
    let inDollar = false;
    for (let i = d; i <= last; i++) {
      const l = lines[i]!.replace(/--.*$/, "");
      const toggles = (l.match(/\$[A-Za-z_]*\$/g) ?? []).length;
      if (toggles % 2 === 1) inDollar = !inDollar;
      if (!inDollar && /;\s*$/.test(l)) return i;
    }
    return null;
  }
  return null;
}

function isCommentOrDecorator(line: string): boolean {
  return /^(\/\/|\/\*\*?|\*|#\[|@[A-Za-z]|--)/.test(line.trim());
}

/** Include up to maxLines of doc comments / decorators directly above a declaration (0-based). */
function leadingComments(lines: string[], d: number, lang: Lang, maxLines = 6): number {
  if (lang === "markdown" || lang === "other") return d;
  let s = d;
  while (s > 0 && d - s < maxLines && isCommentOrDecorator(lines[s - 1] ?? "")) s--;
  return s;
}

/** Nearest declaration above (0-based idx) with indentation below the given one; cheap, for labels only. */
export function nearestEnclosingLabel(
  lines: string[],
  idx: number,
  lang: Lang,
  maxScan = 2000,
): { line: number; text: string } | undefined {
  const ind = indentOf(lines[idx] ?? "");
  for (let i = idx; i >= Math.max(0, idx - maxScan); i--) {
    const l = lines[i] ?? "";
    if (!isDeclLine(l, lang)) continue;
    if (
      lang === "markdown" ||
      lang === "sql" ||
      i === idx ||
      indentOf(l) < ind ||
      (ind === 0 && indentOf(l) === 0)
    ) {
      return { line: i + 1, text: l.trim().slice(0, 140) };
    }
  }
  return undefined;
}

/** The window around one hit line (1-based in, 1-based out). */
export function enclosingWindow(
  lines: string[],
  hitLine: number,
  lang: Lang,
  cfg: CodeSearchConfig,
): Window {
  const w = cfg.wave2;
  const hi = hitLine - 1;
  const n = lines.length;
  const hitIndent = indentOf(lines[hi] ?? "");
  if (lang !== "other") {
    for (let i = hi; i >= Math.max(0, hi - w.maxUp); i--) {
      const l = lines[i] ?? "";
      if (!isDeclLine(l, lang)) continue;
      if ((lang === "brace" || lang === "indent") && i !== hi && indentOf(l) > hitIndent) continue;
      const e = blockEnd(lines, i, lang);
      if (e === null || e < hi) continue;
      // a short statement starting on the hit line (`const x = f(...);`) does not enclose anything
      if (i === hi && e - hi < 2) continue;
      const start = leadingComments(lines, i, lang);
      const end = Math.min(e, hi + w.maxDown, n - 1);
      return padWindow(
        {
          start: start + 1,
          end: end + 1,
          hits: [hitLine],
          label: { line: i + 1, text: l.trim().slice(0, 140) },
          kind: "hit",
          score: 0,
        },
        n,
        cfg,
      );
    }
  }
  const start = Math.max(0, hi - w.fallbackBefore);
  const end = Math.min(n - 1, hi + w.fallbackAfter);
  const label = lang === "other" ? undefined : nearestEnclosingLabel(lines, hi, lang);
  return { start: start + 1, end: end + 1, hits: [hitLine], label, kind: "hit", score: 0 };
}

/** Grow windows shorter than minWindowLines with surrounding context (1/3 above, 2/3 below). */
export function padWindow(win: Window, nLines: number, cfg: CodeSearchConfig): Window {
  const min = cfg.wave2.minWindowLines;
  const len = win.end - win.start + 1;
  if (len >= min) return win;
  const need = min - len;
  const up = Math.floor(need / 3);
  let start = Math.max(1, win.start - up);
  let end = Math.min(nLines, win.end + (need - (win.start - start)));
  if (end - start + 1 < min) start = Math.max(1, end - min + 1);
  return { ...win, start, end };
}

/** Merge overlapping windows or windows separated by <= gap lines. Input any order; output by start. */
export function mergeWindows(ws: Window[], gap: number): Window[] {
  const sorted = [...ws].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Window[] = [];
  for (const w of sorted) {
    const prev = out[out.length - 1];
    if (prev && w.start <= prev.end + gap + 1) {
      prev.end = Math.max(prev.end, w.end);
      prev.hits = [...new Set([...prev.hits, ...w.hits])].sort((a, b) => a - b);
      // keep the outermost label (earliest declaration)
      if (w.label && (!prev.label || w.label.line < prev.label.line)) prev.label = w.label;
      if (prev.kind !== w.kind && w.kind === "def") prev.kind = "def";
    } else {
      out.push({ ...w, hits: [...w.hits] });
    }
  }
  return out;
}

/** Split a window longer than maxLines into chunks around its hit clusters (chunks without hits are dropped). */
export function splitWindow(w: Window, maxLines: number, before = 20): Window[] {
  if (w.end - w.start + 1 <= maxLines) return [w];
  const hits = [...w.hits].sort((a, b) => a - b);
  if (!hits.length) return [{ ...w, end: w.start + maxLines - 1 }];
  const out: Window[] = [];
  let i = 0;
  while (i < hits.length) {
    let start = Math.max(w.start, hits[i]! - before);
    // keep the declaration line if it is close
    if (w.start >= hits[i]! - 2 * before) start = w.start;
    const end = Math.min(w.end, start + maxLines - 1);
    const chunkHits: number[] = [];
    while (i < hits.length && hits[i]! <= end) chunkHits.push(hits[i++]!);
    if (!chunkHits.length) {
      // hit before start cannot happen; guard against infinite loops
      i++;
      continue;
    }
    out.push({
      ...w,
      start,
      end,
      hits: chunkHits,
      label: w.label && w.label.line < start ? w.label : w.label,
    });
  }
  return out;
}

/** Keywords (indices) whose pattern occurs anywhere in lines[start..end] (1-based inclusive). */
const kwRegexCache = new WeakMap<KeywordInfo, RegExp | null>();
export function keywordRegex(k: KeywordInfo): RegExp | null {
  if (!kwRegexCache.has(k)) {
    let re: RegExp | null = null;
    try {
      re = new RegExp(k.pattern, "i");
    } catch {
      re = null;
    }
    kwRegexCache.set(k, re);
  }
  return kwRegexCache.get(k)!;
}

export function textHasKeyword(text: string, k: KeywordInfo): boolean {
  const re = keywordRegex(k);
  if (re) return re.test(text);
  const lower = text.toLowerCase();
  return k.variants.some((v) => lower.includes(v.toLowerCase()));
}

export function keywordsInRange(
  lines: string[],
  start: number,
  end: number,
  keywords: KeywordInfo[],
): number[] {
  const text = lines.slice(start - 1, end).join("\n");
  return keywords.filter((k) => k.idf > 0 && textHasKeyword(text, k)).map((k) => k.index);
}

export function scoreWindow(
  lines: string[],
  w: Window,
  keywords: KeywordInfo[],
  hitWeight = 0.1,
): number {
  const kws = keywordsInRange(lines, w.start, w.end, keywords);
  return kws.reduce((s, k) => s + keywords[k]!.idf, 0) + hitWeight * Math.log(1 + w.hits.length);
}

/**
 * Windows for one file: window the strongest hit lines (skipping hits already covered), merge,
 * split long ones, score, keep the best windowsPerFile, return in line order.
 */
export function buildFileWindows(
  lines: string[],
  hitLines: HitLine[],
  keywords: KeywordInfo[],
  lang: Lang,
  cfg: CodeSearchConfig,
  render?: RenderOpts,
): Window[] {
  const w = cfg.wave2;
  const ro: RenderOpts = render ?? { maxLineChars: w.maxLineChars };
  // prose sections are long and their paragraphs independent: smaller sub-windows around each hit
  const maxChars = lang === "markdown" ? w.maxProseWindowChars : w.maxWindowChars;
  if (!lines.length) return [];
  if (!hitLines.length) {
    // path-only match: the top of the file (or its first section)
    const e = lang === "markdown" ? Math.min(lines.length, 80) : Math.min(lines.length, 60);
    return splitByChars(
      lines,
      { start: 1, end: e, hits: [], kind: "header", score: 0 },
      maxChars,
      ro,
    ).slice(0, 1);
  }
  // hits past the end of the file as read (it changed after ripgrep saw it) are dropped
  const inRange = hitLines.filter((h) => h.line >= 1 && h.line <= lines.length);
  const weight = (h: HitLine) => h.kws.reduce((s, k) => s + (keywords[k]?.idf ?? 0), 0);
  const ranked = [...inRange].sort((a, b) => weight(b) - weight(a) || a.line - b.line);
  const budgetHits = w.seedHitsPerFile;
  const raw: Window[] = [];
  let used = 0;
  for (const h of ranked) {
    if (used >= budgetHits) break;
    const inside = raw.find((r) => h.line >= r.start && h.line <= r.end);
    if (inside) {
      inside.hits.push(h.line);
      continue;
    }
    raw.push(enclosingWindow(lines, h.line, lang, cfg));
    used++;
  }
  // hits that fall inside kept windows but were not windowed themselves still count
  for (const h of inRange) {
    for (const r of raw)
      if (h.line >= r.start && h.line <= r.end && !r.hits.includes(h.line)) r.hits.push(h.line);
  }
  const merged = mergeWindows(raw, w.mergeGap)
    .flatMap((x) => splitWindow(x, w.maxWindowLines))
    .flatMap((x) => splitByChars(lines, x, maxChars, ro));
  for (const x of merged) x.score = scoreWindow(lines, x, keywords, cfg.recall.hitCountWeight);
  return merged
    .sort((a, b) => b.score - a.score || a.start - b.start)
    .slice(0, w.windowsPerFile)
    .sort((a, b) => a.start - b.start);
}

/** Window for a definition found at 1-based defLine (lead following). */
export function definitionWindow(
  lines: string[],
  defLine: number,
  lang: Lang,
  cfg: CodeSearchConfig,
  render?: RenderOpts,
): Window {
  const w = cfg.wave2;
  const d = defLine - 1;
  const start = leadingComments(lines, d, lang);
  const e = lang === "other" ? null : blockEnd(lines, d, lang);
  let end =
    e === null ? Math.min(lines.length - 1, d + w.fallbackAfter) : Math.min(e, d + w.maxDown);
  end = Math.min(end, start + w.maxWindowLines - 1, lines.length - 1);
  const win: Window = {
    start: start + 1,
    end: end + 1,
    hits: [defLine],
    label: { line: defLine, text: (lines[d] ?? "").trim().slice(0, 140) },
    kind: "def",
    score: 0,
  };
  // over the char cap: keep the part starting at the definition (the first sub-window)
  const maxChars = lang === "markdown" ? w.maxProseWindowChars : w.maxWindowChars;
  return splitByChars(
    lines,
    win,
    maxChars,
    render ?? { maxLineChars: w.maxLineChars },
    defLine - win.start,
  )[0]!;
}

export interface RenderOpts {
  /** Lines longer than this are cut (with an explicit marker). */
  maxLineChars: number;
  /** When a cut line has a match beyond the head, the cut keeps the region around the first match. */
  needles?: RegExp[];
}

/**
 * Cut one over-long line to about maxChars, marked explicitly. If a needle matches beyond the first ~60% of
 * the budget, keep a short head plus the region around the match (prose docs such as AGENTS.md have
 * single-line paragraphs of 1-6k chars whose key sentence is often far from the start).
 */
export function cutLine(t: string, maxChars: number, needles: RegExp[] = []): string {
  if (t.length <= maxChars) return t;
  let at = -1;
  for (const re of needles) {
    const m = re.exec(t);
    if (m && (at < 0 || m.index < at)) at = m.index;
  }
  if (at < 0 || at < maxChars * 0.6)
    return `${t.slice(0, maxChars)} ...[line cut, ${t.length} chars]`;
  const head = Math.floor(maxChars * 0.25);
  const before = Math.floor(maxChars * 0.3);
  const s = Math.max(head, at - before);
  const e = Math.min(t.length, s + (maxChars - head));
  return `${t.slice(0, head)} ...[cut]... ${t.slice(s, e)}${e < t.length ? ` ...[line cut, ${t.length} chars]` : ""}`;
}

/** Render lines[start..end] (1-based inclusive) as `N| text`, cutting very long lines with an explicit marker. */
export function renderLines(
  lines: string[],
  start: number,
  end: number,
  opts: number | RenderOpts,
): string {
  const o: RenderOpts = typeof opts === "number" ? { maxLineChars: opts } : opts;
  const out: string[] = [];
  for (let i = start; i <= end && i <= lines.length; i++) {
    out.push(`${i}| ${cutLine(lines[i - 1]!.replace(/\t/g, "  "), o.maxLineChars, o.needles)}`);
  }
  return out.join("\n");
}

/** Rendered length of one line (as renderLines would produce it, plus the newline). */
export function renderedLineLength(lines: string[], i: number, o: RenderOpts): number {
  return renderLines(lines, i, i, o).length + 1;
}

/**
 * Split a window whose rendered text exceeds maxChars into whole-line sub-windows around its hits:
 * each sub-window starts a few lines above the first uncovered hit (up to a quarter of the budget) and
 * extends down until the budget is used. Windows without hits (headers, definitions) keep their top.
 */
export function splitByChars(
  lines: string[],
  w: Window,
  maxChars: number,
  o: RenderOpts,
  ctxUp = 3,
): Window[] {
  const len = (i: number) => renderedLineLength(lines, i, o);
  let total = 0;
  for (let i = w.start; i <= w.end; i++) total += len(i);
  if (total <= maxChars) return [w];
  const hits = [...w.hits].filter((h) => h >= w.start && h <= w.end).sort((a, b) => a - b);
  const anchors = hits.length ? hits : [w.start];
  const out: Window[] = [];
  let covered = w.start - 1;
  for (const h of anchors) {
    if (h <= covered) continue;
    let s = h;
    let used = len(h);
    while (
      s - 1 >= w.start &&
      s - 1 > covered &&
      h - (s - 1) <= ctxUp &&
      used + len(s - 1) <= maxChars / 4
    )
      used += len(--s);
    let e = h;
    while (e + 1 <= w.end && used + len(e + 1) <= maxChars) used += len(++e);
    out.push({ ...w, start: s, end: e, hits: hits.filter((x) => x >= s && x <= e) });
    covered = e;
  }
  return out;
}

export function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}
