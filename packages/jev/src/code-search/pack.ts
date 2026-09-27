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
}

export interface PackBody {
  included: PackedPassage[];
  excluded: EvidencePassage[];
  body: string;
  priority: string[];
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
  return (x.rel + o.cfg.pack.lexWeight * (x.lex ?? 0)) * pathPrior(x.path, o);
}

export function priorityOrder(
  passages: EvidencePassage[],
  o: Pick<PackOptions, "subQuestions" | "T2" | "cfg" | "downweightChangelogs" | "downweightTests">,
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
  o.subQuestions.forEach((_, j) => {
    const best = [...passages]
      .filter((x) => (x.cov[j] ?? 0) >= o.T2 && x.rel >= p.minRelevance)
      .sort((a, b) => (b.cov[j] ?? 0) - (a.cov[j] ?? 0) || b.rel - a.rel)[0];
    if (best) add(best);
  });
  for (const x of diverseOrder(
    byRel.filter((y) => y.rel >= o.T2 && !out.includes(y)),
    eff,
    p.filePenalty,
    new Map(taken),
  ))
    add(x);
  for (const x of byRel) {
    if (out.length >= p.minPassages) break;
    if (x.rel >= p.minRelevance) add(x);
  }
  if (p.fillBudget)
    for (const x of diverseOrder(
      byRel.filter((y) => y.rel >= p.minRelevance && !out.includes(y)),
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
  for (const x of order) {
    if (remaining < 200) break;
    let s = x.start;
    let e = x.end;
    let block = renderBlock(x, s, e, o);
    const cap = o.cfg.pack.maxPassageChars;
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
    included.push({
      id: x.id,
      path: x.path,
      start: s,
      end: e,
      origStart: x.start,
      origEnd: x.end,
      trimmed: s !== x.start || e !== x.end,
      rel: x.rel,
      cov: x.cov,
      kind: x.kind,
      lead: x.lead,
      label: x.label,
      block,
    });
  }
  const inc = new Set(included.map((p) => p.id));
  const excluded = passages.filter((x) => !inc.has(x.id)).sort((a, b) => b.rel - a.rel);
  // group by file: files by best relevance, passages by line
  const fileBest = new Map<string, number>();
  for (const p of included) fileBest.set(p.path, Math.max(fileBest.get(p.path) ?? 0, p.rel));
  const grouped = [...included].sort(
    (a, b) =>
      fileBest.get(b.path)! - fileBest.get(a.path)! ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : a.start - b.start),
  );
  return {
    included: grouped,
    excluded,
    body: grouped.map((p) => p.block).join("\n\n"),
    priority: order.map((x) => x.id),
  };
}

export interface FooterInput {
  excluded: EvidencePassage[];
  otherFiles: Array<{ path: string; score: number }>;
  leadsNotFollowed: Array<{ name: string; score: number; seenAt: string; note?: string }>;
  zeroHitKeywords: Array<{ raw: string; fragments: string[] }>;
  widenedNote?: string;
  cfg: CodeSearchConfig;
  maxChars: number;
}

/** Footer lines, dropping list entries from the end until it fits maxChars. */
export function renderFooter(f: FooterInput): string {
  const p = f.cfg.pack;
  const more: string[] = f.excluded
    .slice(0, p.moreCandidates)
    .map((x) => `${x.path}:${x.start}-${x.end} (${r2(x.rel)})`);
  const moreFiles = f.otherFiles
    .slice(0, Math.max(0, p.moreCandidates - more.length))
    .map((x) => `${x.path} (${r2(x.score)})`);
  const leads = f.leadsNotFollowed
    .slice(0, p.leadsNotFollowed)
    .map((l) => `${l.name} (${r2(l.score)}${l.note ? `, ${l.note}` : ""}) @${l.seenAt}`);
  const zero = f.zeroHitKeywords.map((k) =>
    k.fragments.length ? `${k.raw} (matched fragments: ${k.fragments.join(", ")})` : k.raw,
  );
  const build = (m: string[], mf: string[], l: string[]) => {
    const lines: string[] = [];
    if (m.length || mf.length) {
      lines.push("More candidates (not included; read if needed):");
      if (m.length) lines.push(`  ${m.join(", ")}`);
      if (mf.length) lines.push(`  files: ${mf.join(", ")}`);
    }
    if (l.length) lines.push(`Leads not followed: ${l.join(", ")}`);
    if (zero.length) lines.push(`Keywords with zero hits: ${zero.join(", ")}`);
    if (f.widenedNote) lines.push(f.widenedNote);
    return lines.join("\n");
  };
  let m = more;
  let mf = moreFiles;
  let l = leads;
  let out = build(m, mf, l);
  while (out.length > f.maxChars && (m.length || mf.length || l.length)) {
    if (mf.length) mf = mf.slice(0, -1);
    else if (l.length > 2) l = l.slice(0, -1);
    else if (m.length) m = m.slice(0, -1);
    else l = l.slice(0, -1);
    out = build(m, mf, l);
  }
  return out;
}
