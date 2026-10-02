/**
 * pack.ts - bounded evidence pack.
 *
 * Priority: (1) for each sub-question, the best passage covering it (coverage >= T2), (2) passages with
 * relevance >= T2 by relevance, (3) if fewer than minPassages passed, the next best above minRelevance,
 * (4) optionally (fillBudget) the rest. Greedy under a char budget (tokens * charsPerToken); a passage that
 * does not fit is trimmed to whole lines around its hits (>= minTrimLines) and marked, never cut mid-line.
 * Output groups passages by file (files by best relevance, passages by line).
 */
import type { CodeSearchConfig } from "./config";
import { isChangelogPath, isDocPath, isTestPath } from "./text";
import { renderLines, type RenderOpts } from "./windows";

export interface EvidencePassage {
  id: string;
  path: string;
  start: number;
  end: number;
  fileLines: string[];
  hits: number[];
  label?: { line: number; text: string } | undefined;
  kind: "hit" | "header" | "def";
  rel: number;
  cov: number[];
  /** Lexical passage score (used by pack.lexWeight). */
  lex?: number | undefined;
  lead?: string | undefined;
  /** How lines are rendered (line cap + needles for cutting very long lines around a hit). */
  render?: RenderOpts | undefined;
  /** Mostly import/require lines: ranked with pack.importPrior. */
  importOnly?: boolean | undefined;
  /** A call site of a followed lead (not its definition). */
  caller?: string | undefined;
  /** "Must change together" probability of the declaration this passage holds. */
  ct?: number | undefined;
  /** The declaration judged "must change together". */
  ctName?: string | undefined;
}

export interface PackedPassage {
  id: string;
  path: string;
  start: number;
  end: number;
  origStart: number;
  origEnd: number;
  trimmed: boolean;
  rel: number;
  cov: number[];
  kind: EvidencePassage["kind"];
  lead?: string | undefined;
  label?: { line: number; text: string } | undefined;
  /** rendered block including its `==` header line */
  block: string;
  /** The block shows the whole file. */
  whole?: boolean | undefined;
}

export interface PackOptions {
  subQuestions: string[];
  T2: number;
  /** Chars available for passage blocks (header/footer excluded). */
  bodyChars: number;
  cfg: CodeSearchConfig;
  /** Apply pack.changelogPrior (false when the question is about history / releases). */
  downweightChangelogs?: boolean;
  /** Apply pack.testPrior (false when the question is about tests). */
  downweightTests?: boolean;
  /** Fill the remaining budget with passages at or above this relevance (overrides pack.fillBudget). */
  fillMin?: number | undefined;
}

export interface PackBody {
  included: PackedPassage[];
  excluded: EvidencePassage[];
  body: string;
  priority: string[];
  /** Passages at or above T2 that did not fit the budget (a cap cut). */
  budgetCut: EvidencePassage[];
}

/** A passage whose non-blank code lines are at least 60% import/require/re-export lines (multi-line import lists count). */
export function isImportOnly(lines: string[]): boolean {
  const code = lines.filter((l) => l.trim() && !/^\s*(\/\/|\*|\/\*|#(?!\[))/.test(l));
  if (code.length < 2) return false;
  let inBlock = false;
  let n = 0;
  for (const l of code) {
    const start =
      /^\s*(?:import\b|export\s+(?:\*|\{|type\s+\{)[^;]*\bfrom\b|from\s+\S+\s+import\b|use\s+[\w:{]|(?:const|let|var)\s+[^=]+=\s*require\()/.test(
        l,
      );
    if (inBlock || start) n++;
    if (!inBlock && /^\s*(?:import|export)(?:\s+type)?\s*(?:[\w$]+\s*,\s*)?\{[^}]*$/.test(l))
      inBlock = true;
    else if (inBlock && /\}/.test(l)) inBlock = false;
  }
  return n / code.length >= 0.6;
}

const r2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "?");

/**
 * Greedy file-diverse order: repeatedly take the passage with the highest eff(x) - penalty x (passages already
 * taken from its file). penalty 0 = plain descending eff.
 */
export function diverseOrder(
  xs: EvidencePassage[],
  eff: (x: EvidencePassage) => number,
  penalty: number,
  taken: Map<string, number>,
): EvidencePassage[] {
  const tie = (a: EvidencePassage, b: EvidencePassage) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : a.start - b.start;
  if (penalty <= 0) return [...xs].sort((a, b) => eff(b) - eff(a) || tie(a, b));
  const left = [...xs];
  const out: EvidencePassage[] = [];
  while (left.length) {
    let bi = 0;
    let bv = -Infinity;
    left.forEach((x, i) => {
      const v = eff(x) - penalty * (taken.get(x.path) ?? 0);
      if (v > bv || (v === bv && tie(x, left[bi]!) < 0)) {
        bv = v;
        bi = i;
      }
    });
    const x = left.splice(bi, 1)[0]!;
    taken.set(x.path, (taken.get(x.path) ?? 0) + 1);
    out.push(x);
  }
  return out;
}

/** Path prior for pack ordering (release notes, prose docs, tests); 1 for code. */
export function pathPrior(
  path: string,
  o: Pick<PackOptions, "cfg" | "downweightChangelogs" | "downweightTests">,
): number {
  const p = o.cfg.pack;
  if (isChangelogPath(path)) return o.downweightChangelogs !== false ? p.changelogPrior : 1;
  if (isTestPath(path)) return o.downweightTests !== false ? p.testPrior : 1;
  if (isDocPath(path)) return p.docPrior;
  return 1;
}

/** Pack ordering score: (rel + lexWeight x lex) x path prior. Inclusion floors (T2, minRelevance) still use raw rel. */
export function packScore(
  x: EvidencePassage,
  o: Pick<PackOptions, "cfg" | "downweightChangelogs" | "downweightTests">,
): number {
  return (
    (x.rel + o.cfg.pack.lexWeight * (x.lex ?? 0)) *
    pathPrior(x.path, o) *
    (x.importOnly ? o.cfg.pack.importPrior : 1)
  );
}

/** Relevance used for the inclusion floors: an import-only passage counts at importPrior of its rel. */
export function inclusionRel(x: EvidencePassage, cfg: CodeSearchConfig): number {
  return x.importOnly ? x.rel * cfg.pack.importPrior : x.rel;
}

export function priorityOrder(
  passages: EvidencePassage[],
  o: Pick<
    PackOptions,
    "subQuestions" | "T2" | "cfg" | "downweightChangelogs" | "downweightTests" | "fillMin"
  >,
): EvidencePassage[] {
  const p = o.cfg.pack;
  const effCache = new Map<EvidencePassage, number>();
  const eff = (x: EvidencePassage) => {
    let v = effCache.get(x);
    if (v === undefined) effCache.set(x, (v = packScore(x, o)));
    return v;
  };
  const byRel = [...passages].sort(
    (a, b) => eff(b) - eff(a) || (a.path < b.path ? -1 : a.path > b.path ? 1 : a.start - b.start),
  );
  const out: EvidencePassage[] = [];
  const taken = new Map<string, number>();
  const add = (x: EvidencePassage) => {
    if (!out.includes(x)) {
      out.push(x);
      taken.set(x.path, (taken.get(x.path) ?? 0) + 1);
    }
  };
  const irel = (x: EvidencePassage) => inclusionRel(x, o.cfg);
  // each sub-question's best passage first; a weak sub-question (nothing reaches T2) still gets its best
  // subFallback passages above subFloor, so the reader sees where its answer most likely is
  o.subQuestions.forEach((_, j) => {
    const byCov = [...passages]
      .filter((x) => irel(x) >= p.minRelevance || (x.cov[j] ?? 0) >= p.subFloor)
      .sort((a, b) => (b.cov[j] ?? 0) - (a.cov[j] ?? 0) || b.rel - a.rel);
    const best = byCov[0];
    if (best && (best.cov[j] ?? 0) >= o.T2) add(best);
    else
      for (const x of byCov.filter((y) => (y.cov[j] ?? 0) >= p.subFloor).slice(0, p.subFallback))
        add(x);
  });
  for (const x of diverseOrder(
    byRel.filter((y) => irel(y) >= o.T2 && !out.includes(y)),
    eff,
    p.filePenalty,
    new Map(taken),
  ))
    add(x);
  // declarations a correct change must also touch (sibling mutations, other entry points), best first.
  // They come after the passages that passed T2: they add what a literal relevance check misses, and
  // must never push a verified passage out of the budget (held-out replay, 2026-10-01).
  for (const x of [...passages]
    .filter((y) => (y.ct ?? 0) >= o.cfg.change.threshold)
    .sort((a, b) => (b.ct ?? 0) - (a.ct ?? 0))
    .slice(0, o.cfg.change.maxChosen))
    add(x);
  for (const x of byRel) {
    if (out.length >= p.minPassages) break;
    if (irel(x) >= p.minRelevance) add(x);
  }
  const fillMin = o.fillMin ?? (p.fillBudget ? p.minRelevance : undefined);
  if (fillMin !== undefined)
    for (const x of diverseOrder(
      byRel.filter((y) => irel(y) >= fillMin && !out.includes(y)),
      eff,
      p.filePenalty,
      new Map(taken),
    ))
      add(x);
  return out;
}

function blockHeader(x: EvidencePassage, start: number, end: number, o: PackOptions): string {
  const covTags = o.subQuestions
    .map((_, j) => ((x.cov[j] ?? 0) >= o.T2 ? `s${j + 1}` : ""))
    .filter(Boolean);
  const parts = [`== ${x.path}:${start}-${end}  rel ${r2(x.rel)}`];
  if (covTags.length) parts.push(`[${covTags.join(" ")}]`);
  if (x.kind === "def" && x.lead) parts.push(`(definition of ${x.lead})`);
  if (x.caller) parts.push(`(uses ${x.caller})`);
  if (x.ctName && (x.ct ?? 0) >= o.cfg.change.threshold)
    parts.push(`[change together: ${x.ctName}]`);
  if (start !== x.start || end !== x.end) parts.push(`(trimmed from ${x.start}-${x.end})`);
  let h = parts.join("  ");
  if (x.label && x.label.line < start) h += `\n   in L${x.label.line}: ${x.label.text}`;
  return h;
}

export function renderBlock(
  x: EvidencePassage,
  start: number,
  end: number,
  o: PackOptions,
): string {
  return `${blockHeader(x, start, end, o)}\n${renderLines(x.fileLines, start, end, x.render ?? o.cfg.wave2.maxLineChars)}`;
}

/** Largest contiguous whole-line sub-range around the passage's hits whose block fits in maxChars. */
export function trimToFit(
  x: EvidencePassage,
  maxChars: number,
  o: PackOptions,
): { start: number; end: number } | null {
  const lineLen = (i: number) =>
    renderLines(x.fileLines, i, i, x.render ?? o.cfg.wave2.maxLineChars).length + 1;
  const hdr = blockHeader(x, x.start, x.end, o).length + 40; // + "(trimmed from a-b)"
  const inside = x.hits.filter((h) => h >= x.start && h <= x.end).sort((a, b) => a - b);
  const center = inside.length ? inside[Math.floor((inside.length - 1) / 2)]! : x.start;
  let s = center;
  let e = center;
  let used = hdr + lineLen(center);
  if (used > maxChars) return null;
  // grow 2 lines down per line up (code after a hit usually matters more), until neither side fits
  let stuckUp = false;
  let stuckDown = false;
  let turn = 0;
  while (!(stuckUp && stuckDown)) {
    const goDown = !stuckDown && (stuckUp || turn % 3 !== 2);
    turn++;
    if (goDown) {
      if (e + 1 > x.end) {
        stuckDown = true;
        continue;
      }
      const c = lineLen(e + 1);
      if (used + c > maxChars) stuckDown = true;
      else {
        e++;
        used += c;
      }
    } else {
      if (s - 1 < x.start) {
        stuckUp = true;
        continue;
      }
      const c = lineLen(s - 1);
      if (used + c > maxChars) stuckUp = true;
      else {
        s--;
        used += c;
      }
    }
  }
  if (e - s + 1 < o.cfg.pack.minTrimLines && e - s + 1 < x.end - x.start + 1) return null;
  return { start: s, end: e };
}

export function packBody(passages: EvidencePassage[], o: PackOptions): PackBody {
  const order = priorityOrder(passages, o);
  let remaining = o.bodyChars;
  const included: PackedPassage[] = [];
  const cap = o.cfg.pack.maxPassageChars;
  const irel = (x: EvidencePassage) => inclusionRel(x, o.cfg);
  const wholeFiles = new Set<string>();
  const packed = (
    x: EvidencePassage,
    s: number,
    e: number,
    block: string,
    whole = false,
  ): PackedPassage => ({
    id: x.id,
    path: x.path,
    start: s,
    end: e,
    origStart: x.start,
    origEnd: x.end,
    trimmed: !whole && (s !== x.start || e !== x.end),
    rel: x.rel,
    cov: x.cov,
    kind: x.kind,
    lead: x.lead,
    label: x.label,
    block,
    ...(whole ? { whole: true } : {}),
  });
  for (const x of order) {
    if (remaining < 200) break;
    if (wholeFiles.has(x.path)) continue;
    // a small relevant file is shown whole: its other regions are usually what the next step needs
    const n = x.fileLines.length;
    if (n && irel(x) >= o.T2 && o.cfg.pack.wholeFileMaxChars > 0) {
      const block = renderWhole(x, o);
      const refund = included
        .filter((p) => p.path === x.path)
        .reduce((sum, p) => sum + p.block.length + 2, 0);
      if (block.length <= o.cfg.pack.wholeFileMaxChars && block.length + 2 <= remaining + refund) {
        for (let i = included.length - 1; i >= 0; i--)
          if (included[i]!.path === x.path) included.splice(i, 1);
        remaining += refund - (block.length + 2);
        included.push(packed(x, 1, n, block, true));
        wholeFiles.add(x.path);
        continue;
      }
    }
    let s = x.start;
    let e = x.end;
    let block = renderBlock(x, s, e, o);
    if (cap > 0 && block.length > cap) {
      const t = trimToFit(x, cap, o);
      if (t) {
        s = t.start;
        e = t.end;
        block = renderBlock(x, s, e, o);
      }
    }
    if (block.length + 2 > remaining) {
      const t = trimToFit({ ...x, start: s, end: e }, remaining - 2, o);
      if (!t) continue;
      s = t.start;
      e = t.end;
      block = renderBlock(x, s, e, o);
      if (block.length + 2 > remaining) continue;
    }
    remaining -= block.length + 2;
    included.push(packed(x, s, e, block));
  }
  // join passages of one file separated by a short gap (the gap is usually the glue the reader needs)
  const byId = new Map(passages.map((x) => [x.id, x]));
  const gap = o.cfg.pack.stitchGap;
  if (gap > 0) {
    let changed = true;
    while (changed) {
      changed = false;
      const sorted = [...included].sort((a, b) =>
        a.path < b.path ? -1 : a.path > b.path ? 1 : a.start - b.start,
      );
      for (let i = 0; i + 1 < sorted.length; i++) {
        const a = sorted[i]!;
        const b = sorted[i + 1]!;
        if (a.path !== b.path || a.whole || b.whole) continue;
        const between = b.start - a.end - 1;
        if (between < 0 || between > gap) continue;
        const src = byId.get(a.rel >= b.rel ? a.id : b.id)!;
        const joined: EvidencePassage = {
          ...src,
          start: Math.min(a.origStart, a.start),
          end: Math.max(b.origEnd, b.end),
          hits: [...(byId.get(a.id)?.hits ?? []), ...(byId.get(b.id)?.hits ?? [])],
          rel: Math.max(a.rel, b.rel),
          cov: a.cov.map((c, j) => Math.max(c, b.cov[j] ?? 0)),
          label: byId.get(a.id)?.label,
        };
        const block = renderBlock(joined, a.start, b.end, o);
        const cost = block.length - (a.block.length + b.block.length + 2);
        if (cost > remaining) continue;
        remaining -= cost;
        const merged = { ...packed(joined, a.start, b.end, block), id: `${a.id}+${b.id}` };
        merged.trimmed = a.trimmed || b.trimmed;
        included.splice(included.indexOf(a), 1);
        included.splice(included.indexOf(b), 1, merged);
        byId.set(merged.id, joined);
        changed = true;
        break;
      }
    }
  }
  const shownIds = new Set(included.flatMap((p) => p.id.split("+")));
  const shownAt = (x: EvidencePassage) =>
    included.some((p) => p.path === x.path && x.start >= p.start && x.end <= p.end);
  const excluded = passages
    .filter((x) => !shownIds.has(x.id) && !shownAt(x))
    .sort((a, b) => b.rel - a.rel);
  const budgetCut = excluded.filter((x) => irel(x) >= o.T2);
  // group by file: the best passage's file first, then the file of each sub-question's best passage (so a
  // weak sub-question shows its best hit early), then the rest by best relevance; passages by line
  const effOf = (p: PackedPassage) => {
    const src = byId.get(p.id) ?? byId.get(p.id.split("+")[0]!);
    return src ? packScore({ ...src, rel: p.rel }, o) : p.rel;
  };
  const fileBest = new Map<string, number>();
  for (const p of included) fileBest.set(p.path, Math.max(fileBest.get(p.path) ?? 0, effOf(p)));
  const fileOrder: string[] = [];
  const addFile = (f: string | undefined) => {
    if (f && !fileOrder.includes(f)) fileOrder.push(f);
  };
  addFile([...included].sort((a, b) => effOf(b) - effOf(a))[0]?.path);
  o.subQuestions.forEach((_, j) => {
    const best = [...included]
      .filter((p) => (p.cov[j] ?? 0) >= o.T2)
      .sort((a, b) => (b.cov[j] ?? 0) - (a.cov[j] ?? 0) || b.rel - a.rel)[0];
    addFile(best?.path);
  });
  [...fileBest.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .forEach(([f]) => addFile(f));
  const grouped = [...included].sort(
    (a, b) => fileOrder.indexOf(a.path) - fileOrder.indexOf(b.path) || a.start - b.start,
  );
  return {
    included: grouped,
    excluded,
    body: grouped.map((p) => p.block).join("\n\n"),
    priority: order.map((x) => x.id),
    budgetCut,
  };
}

/** The whole file as one block (`== path:1-N  rel ...  (whole file)`). */
export function renderWhole(x: EvidencePassage, o: PackOptions): string {
  const n = x.fileLines.length;
  const y: EvidencePassage = { ...x, start: 1, end: n, label: undefined };
  const [head, ...rest] = renderBlock(y, 1, n, o).split("\n");
  return [`${head}  (whole file)`, ...rest].join("\n");
}

/** Line ranges as `a-b, c, d-e`. */
export function fmtRanges(ranges: Array<[number, number]>): string {
  return ranges.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(", ");
}

/** Merged, sorted ranges. */
export function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const [a, b] of [...ranges].sort((x, y) => x[0] - y[0] || x[1] - y[1])) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** 1..n minus the shown ranges. */
export function complementRanges(
  n: number,
  shown: Array<[number, number]>,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let next = 1;
  for (const [a, b] of mergeRanges(shown)) {
    if (a > next) out.push([next, Math.min(a - 1, n)]);
    next = Math.max(next, b + 1);
  }
  if (next <= n) out.push([next, n]);
  return out;
}

/** One relevant file of the coverage map. */
export interface CoverageFile {
  path: string;
  /** File length in lines (0 when the file was never read). */
  lines: number;
  shown: Array<[number, number]>;
  /** Verified passages not shown, best first. */
  checked: Array<{ start: number; end: number; rel: number }>;
  /** Why the file counts as relevant when nothing of it is shown (for example `file triage 0.83`). */
  note?: string | undefined;
  /** Declarations in the not-shown ranges (name and line), outermost first. */
  outline?: Array<{ name: string; line: number }> | undefined;
}

export interface KeywordNote {
  raw: string;
  /** Fragments that matched instead of the keyword. */
  fragments: string[];
  /** Real identifiers of this workspace that resemble the keyword. */
  suggestions: string[];
  /** zero = no hits; irrelevant = hits only in files the search judged irrelevant. */
  status: "zero" | "fragments" | "irrelevant";
  files?: number | undefined;
}

export interface FooterInput {
  coverage: CoverageFile[];
  /** Pre-rendered lines naming what each cap cut. */
  cuts: string[];
  excluded: EvidencePassage[];
  otherFiles: Array<{ path: string; score: number }>;
  leadsNotFollowed: Array<{ name: string; score: number; seenAt: string; note?: string }>;
  keywords: KeywordNote[];
  widenedNote?: string;
  cfg: CodeSearchConfig;
  maxChars: number;
}

function coverageLine(f: CoverageFile, checkedMax: number): string {
  const len = f.lines ? `${f.lines} lines` : "not read";
  const head = `  ${f.path} (${len}${f.note ? `, ${f.note}` : ""}):`;
  const parts: string[] = [];
  if (f.shown.length) parts.push(`shown ${fmtRanges(mergeRanges(f.shown))}`);
  const missing = f.lines ? complementRanges(f.lines, f.shown) : [];
  const outline = f.outline?.length
    ? ` (declares ${f.outline.map((d) => `${d.name} ${d.line}`).join(", ")})`
    : "";
  if (!f.shown.length) parts.push(`not shown${outline}`);
  else if (missing.length) parts.push(`not shown ${fmtRanges(missing)}${outline}`);
  else parts.push("whole file shown");
  const checked = f.checked.slice(0, checkedMax);
  if (checked.length)
    parts.push(
      `checked, below the bar: ${checked.map((c) => `${c.start}-${c.end} (${r2(c.rel)})`).join(", ")}`,
    );
  return `${head} ${parts.join("; ")}`;
}

/** Footer lines, dropping list entries from the end until it fits maxChars (coverage of the top files stays). */
export function renderFooter(f: FooterInput): string {
  const p = f.cfg.pack;
  const coverageFiles = new Set(f.coverage.map((c) => c.path));
  const more: string[] = f.excluded
    .filter((x) => !coverageFiles.has(x.path))
    .slice(0, p.moreCandidates)
    .map((x) => `${x.path}:${x.start}-${x.end} (${r2(x.rel)})`);
  const moreFiles = f.otherFiles
    .filter((x) => !coverageFiles.has(x.path))
    .slice(0, Math.max(0, p.moreCandidates - more.length))
    .map((x) => `${x.path} (${r2(x.score)})`);
  const leads = f.leadsNotFollowed
    .slice(0, p.leadsNotFollowed)
    .map((l) => `${l.name} (${r2(l.score)}${l.note ? `, ${l.note}` : ""}) @${l.seenAt}`);
  const moreLeads = f.leadsNotFollowed.length - leads.length;
  const moreExcluded = f.excluded.filter((x) => !coverageFiles.has(x.path)).length - more.length;
  const kw = (st: KeywordNote["status"]) =>
    f.keywords
      .filter((k) => k.status === st)
      .map((k) => {
        const extra: string[] = [];
        if (k.fragments.length) extra.push(`matched fragments: ${k.fragments.join(", ")}`);
        if (k.files) extra.push(`${k.files} file${k.files === 1 ? "" : "s"}`);
        if (k.suggestions.length) extra.push(`identifiers here: ${k.suggestions.join(", ")}`);
        return extra.length ? `${k.raw} (${extra.join("; ")})` : k.raw;
      });
  const zero = [...kw("zero"), ...kw("fragments")];
  const irrelevant = kw("irrelevant");
  const build = (
    cov: number,
    checkedMax: number,
    m: string[],
    mf: string[],
    l: string[],
    cuts: string[],
  ) => {
    const lines: string[] = [];
    if (cov > 0) {
      lines.push(
        "Relevant files and what this pack did not show (read the not-shown ranges in full before changing code there):",
      );
      for (const c of f.coverage.slice(0, cov)) lines.push(coverageLine(c, checkedMax));
      if (f.coverage.length > cov)
        lines.push(`  (${f.coverage.length - cov} more relevant files not listed)`);
    }
    if (cuts.length) lines.push("Cut by limits:", ...cuts.map((c) => `  ${c}`));
    if (m.length || mf.length) {
      lines.push("More candidates (not included; read if needed):");
      const restM = moreExcluded + (more.length - m.length);
      if (m.length)
        lines.push(`  ${m.join(", ")}${restM > 0 ? ` (+${restM} weaker passages)` : ""}`);
      if (mf.length) lines.push(`  files: ${mf.join(", ")}`);
    }
    const restL = moreLeads + (leads.length - l.length);
    if (l.length)
      lines.push(`Leads not followed: ${l.join(", ")}${restL > 0 ? ` (+${restL} weaker)` : ""}`);
    if (zero.length) lines.push(`Keywords with zero hits: ${zero.join(", ")}`);
    if (irrelevant.length)
      lines.push(`Keywords that matched only files judged irrelevant: ${irrelevant.join(", ")}`);
    if (f.widenedNote) lines.push(f.widenedNote);
    return lines.join("\n");
  };
  let cov = Math.min(f.coverage.length, p.coverageFiles);
  let checkedMax = 4;
  let m = more;
  let mf = moreFiles;
  let l = leads;
  let cuts = f.cuts;
  let out = build(cov, checkedMax, m, mf, l, cuts);
  while (out.length > f.maxChars) {
    if (mf.length) mf = mf.slice(0, -1);
    else if (l.length > 2) l = l.slice(0, -1);
    else if (m.length) m = m.slice(0, -1);
    else if (checkedMax > 1) checkedMax--;
    else if (cov > 6) cov--;
    else if (cuts.some((c) => c.length > 160))
      cuts = cuts.map((c) => (c.length > 160 ? `${c.slice(0, 157)}...` : c));
    else if (l.length) l = l.slice(0, -1);
    else if (cov > 1) cov--;
    else break;
    out = build(cov, checkedMax, m, mf, l, cuts);
  }
  return out;
}
