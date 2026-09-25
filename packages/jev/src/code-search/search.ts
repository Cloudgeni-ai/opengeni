/**
 * search.ts - the code_search pipeline (scout-0.3.1 with the Jev judge):
 *
 *  1. recall   (ripgrep)                        -> top maxCandidates files by distinct-keyword IDF
 *  2. wave 1   (file triage, 1 Noul per file)   -> up to maxFiles files (+ lexical guard)
 *  3. wave 2   (passage verification)           -> relevance + per-sub-question coverage per passage
 *  4. wave 3   (leads, exactly one round)       -> <= maxLeadsFollowed definitions, verified like wave 2
 *  5. pack     (bounded, verbatim, line-numbered) + status (1 request over the packed evidence)
 *
 * Every file and process access goes through the injected CodeSearchWorkspace. A Jev failure fails the
 * search (JevUnavailableError / JevRequestError propagate); only a failed final status check keeps the
 * fully Jev-scored pack and reports the status as unknown.
 */
import { JevRequestError, JevUnavailableError, type JevClient } from "../client";
import { DEFAULT_CODE_SEARCH_CONFIG, type CodeSearchConfig } from "./config";
import {
  JevJudge,
  type FileItem,
  type JudgeContext,
  type LeadItem,
  type PassageItem,
} from "./judge";
import { chooseDefinitions, extractLeads, locateDefinitions, type LeadCandidate } from "./leads";
import { packBody, renderFooter, type EvidencePassage } from "./pack";
import {
  bestHitLines,
  excludeArgs,
  idfOf,
  recall,
  type FileCandidate,
  type KeywordInfo,
  type RecallResult,
} from "./recall";
import { mapLimit, READ_CONCURRENCY, WorkspaceSession } from "./session";
import {
  contentTerms,
  escapeRegex,
  estTokens,
  fmtK,
  isDocPath,
  keywordVariants,
  overlap,
  questionMentionsHistory,
  questionMentionsTests,
  splitWords,
  STOPWORDS,
  trimAround,
} from "./text";
import {
  buildFileWindows,
  definitionWindow,
  keywordRegex,
  keywordsInRange,
  langOf,
  renderLines,
  splitLines,
  type RenderOpts,
  type Window,
} from "./windows";
import type { CodeSearchWorkspace } from "./workspace";

/** The validated research version this engine ports (ranking, thresholds and defaults are unchanged). */
export const CODE_SEARCH_ENGINE_VERSION = "scout-0.3.1";
export const CODE_SEARCH_DEFAULT_BUDGET_TOKENS = 12_000;

export interface CodeSearchInput {
  question: string;
  keywords: string[];
  subQuestions?: string[] | undefined;
  /** Workspace-relative path prefixes to search; default the whole workspace. */
  paths?: string[] | undefined;
  workspace: CodeSearchWorkspace;
  jev: JevClient;
  signal?: AbortSignal | undefined;
  /** Max pack size in tokens (default 12000). */
  budgetTokens?: number | undefined;
  /** Tuning and tests only; defaults to DEFAULT_CODE_SEARCH_CONFIG. */
  config?: CodeSearchConfig | undefined;
  /** In-memory stage trace (recall, wave1, wave2, leads, pack, summary, and one "jev" event per Jev request). */
  onStage?: ((stage: string, data: Record<string, unknown>) => void) | undefined;
}

export interface CodeSearchStatus {
  label: "sufficient" | "partial" | "insufficient" | "unknown";
  overall: number | null;
  subs: Array<number | null>;
  /** Set when the final Jev sufficiency check failed (the pack itself is fully Jev-scored). */
  error?: string;
}

export interface CodeSearchStats {
  wallMs: number;
  stageMs: Record<string, number>;
  candidates: number;
  filesSelected: number;
  passagesVerified: number;
  passagesIncluded: number;
  packChars: number;
  packTokensEst: number;
  workspaceCalls: number;
  /** A ripgrep call returned partial output (byte cap or time limit); the pack header says so. */
  ripgrepTruncated: boolean;
  jev: { requests: number; inputTokens: number; costUsd: number; model: string | null };
}

export interface CodeSearchResult {
  version: string;
  /** The rendered pack: a status header line, verbatim line-numbered passages, then the footer. */
  text: string;
  status: CodeSearchStatus;
  stats: CodeSearchStats;
  /** The error of a failed final status check, for a circuit breaker (the search itself succeeded). */
  statusCheckError?: JevUnavailableError | JevRequestError;
}

const r2 = (x: number | null | undefined) =>
  x === null || x === undefined || !Number.isFinite(x) ? "?" : x.toFixed(2);

/** Lexical passage relevance in [0,1]: keyword IDF mass present, question-term overlap, file prior. */
export function lexicalPassageScore(
  text: string,
  kwPresent: number[],
  keywords: KeywordInfo[],
  qTerms: string[],
  fileNorm: number,
): number {
  const total = keywords.reduce((s, k) => s + k.idf, 0) || 1;
  const mass = kwPresent.reduce((s, k) => s + keywords[k]!.idf, 0) / total;
  const qov = overlap(qTerms, new Set(contentTerms(text)));
  return Math.max(0, Math.min(1, 0.55 * mass + 0.3 * qov + 0.15 * fileNorm));
}

export function selectFiles(
  cands: FileCandidate[],
  scores: Map<string, number>,
  ids: string[],
  T1: number,
  cfg: CodeSearchConfig,
): { selected: number[]; ranked: number[] } {
  // cands are in lexical order; ids[i] is the judge id of cands[i]
  const ranked = cands
    .map((_, i) => i)
    .sort(
      (a, b) =>
        (scores.get(ids[b]!) ?? 0) - (scores.get(ids[a]!) ?? 0) ||
        cands[b]!.lexScore - cands[a]!.lexScore ||
        a - b,
    );
  const selected: number[] = [];
  for (let i = 0; i < Math.min(cfg.wave1.lexicalGuard, cands.length); i++) selected.push(i);
  ranked.forEach((i, rank) => {
    if (selected.length >= cfg.wave1.maxFiles || selected.includes(i)) return;
    if ((scores.get(ids[i]!) ?? 0) >= T1 || rank < cfg.wave1.minFiles) selected.push(i);
  });
  // priority order for windowing = judge rank order
  selected.sort((a, b) => ranked.indexOf(a) - ranked.indexOf(b));
  return { selected, ranked };
}

/** Round-robin across files (priority order), each file's windows by score, up to max. */
export function capPassages<T extends { score: number }>(perFile: T[][], max: number): T[][] {
  const sorted = perFile.map((ws) => [...ws].sort((a, b) => b.score - a.score));
  const out: T[][] = perFile.map(() => []);
  let taken = 0;
  for (let pass = 0; taken < max; pass++) {
    let any = false;
    for (let f = 0; f < sorted.length && taken < max; f++) {
      const w = sorted[f]![pass];
      if (w) {
        out[f]!.push(w);
        taken++;
        any = true;
      }
    }
    if (!any) break;
  }
  return out;
}

/** Evidence text for the status check: included passages, best first, up to maxChars (whole blocks only). */
export function statusEvidence(
  included: Array<{ block: string; rel: number }>,
  maxChars: number,
): string {
  const out: string[] = [];
  let used = 0;
  for (const p of [...included].sort((a, b) => b.rel - a.rel)) {
    if (used + p.block.length + 2 > maxChars) continue;
    out.push(p.block);
    used += p.block.length + 2;
  }
  return out.join("\n\n");
}

export function statusLabel(
  s: { overall: number; subs: number[] } | null,
  cfg: CodeSearchConfig,
): CodeSearchStatus {
  if (!s || !Number.isFinite(s.overall)) return { label: "unknown", overall: null, subs: [] };
  const { hi, lo } = cfg.status;
  const subsOk = s.subs.every((x) => x >= hi);
  const anySub = s.subs.some((x) => x >= hi);
  const label =
    s.overall >= hi && subsOk
      ? "sufficient"
      : s.overall >= lo || anySub
        ? "partial"
        : "insufficient";
  return { label, overall: s.overall, subs: s.subs };
}

/** Footer note about paths that were missing, or a search that had to widen to the whole workspace. */
export function prefixNote(
  rec: Pick<RecallResult, "missingPrefixes" | "widened" | "validPrefixes">,
): string | undefined {
  const notes: string[] = [];
  if (rec.missingPrefixes.length) {
    notes.push(
      `Note: paths not found in the workspace (ignored): ${rec.missingPrefixes.join(", ")}.`,
    );
  }
  if (rec.widened) {
    notes.push(
      !rec.validPrefixes.length
        ? "Note: the whole workspace was searched."
        : "Note: nothing matched under the given paths; the whole workspace was searched.",
    );
  }
  return notes.length ? notes.join(" ") : undefined;
}

/** Header label for partial ripgrep output, in the same position scout used for its other partial states. */
function partialLabel(session: WorkspaceSession): string {
  if (!session.partial) return "";
  const why = session.timedOut
    ? "a ripgrep search hit its time limit"
    : "ripgrep output was cut at its size limit";
  return `(partial search: ${why}; some matches may be missing)`;
}

export async function runCodeSearch(input: CodeSearchInput): Promise<CodeSearchResult> {
  const outer = input.signal;
  outer?.throwIfAborted();
  // One controller per search: an error in one parallel branch cancels the others.
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort(outer?.reason);
  outer?.addEventListener("abort", onOuterAbort, { once: true });
  try {
    return await pipeline(input, controller.signal);
  } catch (error) {
    controller.abort(error);
    if (outer?.aborted) throw outer.reason;
    throw error;
  } finally {
    outer?.removeEventListener("abort", onOuterAbort);
  }
}

async function pipeline(o: CodeSearchInput, signal: AbortSignal): Promise<CodeSearchResult> {
  const cfg = o.config ?? DEFAULT_CODE_SEARCH_CONFIG;
  const t0 = performance.now();
  const stageMs: Record<string, number> = {};
  const mark = (stage: string, since: number) => {
    stageMs[stage] = Math.round(performance.now() - since);
  };
  const emit = (stage: string, data: Record<string, unknown>) => {
    try {
      o.onStage?.(stage, data);
    } catch {
      // tracing never breaks a search
    }
  };
  const session = new WorkspaceSession(o.workspace, signal, cfg.recall.ripgrepTimeoutMs);
  const judge = new JevJudge({ client: o.jev, config: cfg, signal, onEvent: emit });
  const subQuestions = (o.subQuestions ?? [])
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 4);
  const ctx: JudgeContext = { question: o.question.trim(), subQuestions };
  const budgetTokens = o.budgetTokens ?? CODE_SEARCH_DEFAULT_BUDGET_TOKENS;
  const thr = cfg.thresholds;
  emit("start", {
    version: CODE_SEARCH_ENGINE_VERSION,
    question: ctx.question,
    subQuestions,
    keywords: o.keywords,
    paths: o.paths ?? [],
    budgetTokens,
  });
  // open keep-alive connections while recall runs
  o.jev.warmUp(cfg.jev.warmConnections);

  // ---- 1. recall
  let ts = performance.now();
  const rec: RecallResult = await recall({
    session,
    question: ctx.question + " " + subQuestions.join(" "),
    keywords: o.keywords,
    pathPrefixes: o.paths ?? [],
    config: cfg,
  });
  mark("recall", ts);
  const kws = rec.keywords;
  emit("recall", {
    ms: rec.ms,
    totalFiles: rec.totalFiles,
    scoredFiles: rec.scoredFiles,
    searchPaths: rec.searchPaths,
    widened: rec.widened,
    missingPrefixes: rec.missingPrefixes,
    binaryDropped: rec.binaryDropped,
    partial: session.partial,
    keywords: kws.map((k) => ({
      raw: k.raw,
      mode: k.mode,
      pattern: k.pattern,
      df: k.df,
      pathDf: k.pathDf,
      hitLines: k.hitLines,
      idf: round(k.idf),
      fragments: k.fragments,
    })),
    candidates: rec.candidates.map((c) => ({
      path: c.path,
      lex: round(c.lexScore),
      kws: Object.keys(c.kwHits).map(Number),
      pathKws: c.pathKws,
      lines: c.hitLines.size,
      test: c.isTest,
    })),
  });

  // ---- 2. wave 1: file triage
  ts = performance.now();
  const maxLex = rec.candidates[0]?.lexScore || 1;
  const fileIds = rec.candidates.map((_, i) => `f${String(i).padStart(3, "0")}`);
  const fileItems: FileItem[] = rec.candidates.map((c, i) => {
    const hits = bestHitLines(c, kws, cfg.wave1.hitLinesPerFile);
    const needles = Object.keys(c.kwHits).flatMap((k) => kws[Number(k)]!.variants);
    const lines = hits.map(
      (h) => `  ${h.line}: ${trimAround(h.text, needles, cfg.wave1.hitLineChars)}`,
    );
    return {
      id: fileIds[i]!,
      path: c.path,
      descriptor: [c.path, ...lines].join("\n"),
      lex: c.lexScore / maxLex,
    };
  });
  const fileScores = await judge.scoreFiles(fileItems, ctx);
  const { selected, ranked } = selectFiles(rec.candidates, fileScores, fileIds, thr.T1, cfg);
  mark("wave1", ts);
  emit("wave1", {
    T1: thr.T1,
    scores: rec.candidates.map((c, i) => ({
      path: c.path,
      p: round(fileScores.get(fileIds[i]!) ?? Number.NaN),
      lex: round(fileItems[i]!.lex),
    })),
    selected: selected.map((i) => rec.candidates[i]!.path),
  });

  // ---- 3. wave 2: windows + verification
  ts = performance.now();
  // file contents are read in parallel up front; the windowing below is synchronous
  const fileLines = new Map<string, string[]>();
  const loadLines = async (paths: string[]) => {
    const missing = [...new Set(paths)].filter((p) => !fileLines.has(p));
    const texts = await mapLimit(missing, READ_CONCURRENCY, (p) =>
      session.readText(p, cfg.recall.maxFileBytes),
    );
    missing.forEach((p, i) => {
      const text = texts[i];
      // binary content (NUL bytes) is never rendered as a passage
      fileLines.set(p, text === null || text === undefined ? [] : splitLines(text));
    });
  };
  const readLines = (path: string): string[] => fileLines.get(path) ?? [];
  await loadLines(selected.map((i) => rec.candidates[i]!.path));
  const kwNeedles = kws
    .filter((k) => k.idf > 0)
    .map((k) => keywordRegex(k))
    .filter((re): re is RegExp => re !== null);
  const renderFor = (path: string, needles: RegExp[] = kwNeedles): RenderOpts => ({
    maxLineChars: isDocPath(path) ? cfg.wave2.maxProseLineChars : cfg.wave2.maxLineChars,
    needles,
  });
  const perFileWindows: Window[][] = selected.map((i) => {
    const c = rec.candidates[i]!;
    const lines = readLines(c.path);
    const hits = [...c.hitLines.values()];
    return buildFileWindows(lines, hits, kws, langOf(c.path), cfg, renderFor(c.path));
  });
  const capped = capPassages(perFileWindows, cfg.wave2.maxPassages);
  const qTerms = contentTerms(ctx.question);
  const subTerms = subQuestions.map((s) => contentTerms(s));
  const evidence: EvidencePassage[] = [];
  const passageItems: PassageItem[] = [];
  let pid = 0;
  const makePassage = (path: string, w: Window, fileNorm: number, lead?: string) => {
    const lines = readLines(path);
    const render = renderFor(path, lead ? [new RegExp(`\\b${escapeRegex(lead)}\\b`)] : kwNeedles);
    const text = renderLines(lines, w.start, w.end, render);
    const raw = lines.slice(w.start - 1, w.end).join("\n");
    const present = keywordsInRange(lines, w.start, w.end, kws);
    const rawTerms = new Set(contentTerms(raw));
    const id = `p${String(pid++).padStart(3, "0")}`;
    const lex = lexicalPassageScore(raw, present, kws, qTerms, fileNorm);
    const lexCov = subTerms.map((t) => overlap(t, rawTerms));
    const label =
      w.label && w.label.line < w.start ? `L${w.label.line}: ${w.label.text}` : undefined;
    passageItems.push({ id, path, start: w.start, end: w.end, text, label, lex, lexCov });
    evidence.push({
      id,
      path,
      start: w.start,
      end: w.end,
      fileLines: lines,
      hits: w.hits,
      label: w.label,
      kind: w.kind,
      rel: lex,
      cov: lexCov,
      lex,
      lead,
      render,
    });
  };
  selected.forEach((ci, f) => {
    const c = rec.candidates[ci]!;
    for (const w of [...capped[f]!].sort((a, b) => a.start - b.start))
      makePassage(c.path, w, c.lexScore / maxLex);
  });
  const wave2Scores = await judge.scorePassages(passageItems, ctx, "wave2");
  for (const e of evidence) {
    const s = wave2Scores.get(e.id);
    if (s) {
      e.rel = s.rel;
      e.cov = s.cov;
    }
  }
  mark("wave2", ts);
  emit("wave2", {
    T2: thr.T2,
    passages: evidence.map((e) => ({
      id: e.id,
      path: e.path,
      start: e.start,
      end: e.end,
      kind: e.kind,
      hits: e.hits.length,
      rel: round(e.rel),
      cov: e.cov.map(round),
      lex: round(e.lex ?? Number.NaN),
    })),
  });

  // ---- 4. wave 3: leads (exactly one round)
  ts = performance.now();
  let leadCands: LeadCandidate[] = [];
  let leadScores = new Map<string, number>();
  const chosenNames = new Set<string>();
  if (cfg.wave3.enabled) {
    const leadsFollowed: Array<{ name: string; score: number; def: string | null }> = [];
    const seeds = evidence
      .filter((e) => e.rel >= thr.T2)
      .sort((a, b) => b.rel - a.rel)
      .slice(0, cfg.wave3.seedPassages)
      .map((e) => ({
        path: e.path,
        start: e.start,
        lines: e.fileLines.slice(e.start - 1, e.end),
        rel: e.rel,
      }));
    const searched = new Set<string>();
    for (const k of kws) {
      for (const v of [...k.variants, ...k.fragments.flatMap((f) => keywordVariants(f))]) {
        searched.add(v.toLowerCase());
        searched.add(splitWords(v).join(" "));
      }
    }
    const qWords = new Set(
      [
        ...splitWords(ctx.question + " " + subQuestions.join(" ")),
        ...kws.flatMap((k) => splitWords(k.raw)),
      ].filter((w) => w.length >= 3 && !STOPWORDS.has(w)),
    );
    // extract generously, keep only leads whose definition exists and is not already in the evidence
    const extracted = extractLeads(
      seeds,
      searched,
      qWords,
      Math.ceil(cfg.wave3.maxLeadCandidates * 1.5),
    );
    const selectedPaths = new Set(selected.map((i) => rec.candidates[i]!.path));
    const allowTests = questionMentionsTests(ctx.question);
    const defSearch = await locateDefinitions(
      session,
      extracted.map((l) => l.name),
      cfg,
      excludeArgs(cfg),
      12,
      allowTests,
    );
    const seenAt = new Map(extracted.map((l) => [l.name, l.seenAt.path]));
    const defs = chooseDefinitions(
      defSearch.hits,
      selectedPaths,
      cfg.wave3.defsPerLead,
      allowTests,
      seenAt,
    );
    const inEvidence = (path: string, line: number) =>
      evidence.some((e) => e.path === path && line >= e.start && line <= e.end);
    const leadDrops: Record<string, string> = {};
    // genericity penalty: a name defined/used as a key in many files (sessionId, workspaceId, isRecord) is rarely
    // what the answer hinges on
    const nFiles = Math.max(rec.totalFiles, 1);
    const genericity = (name: string) =>
      idfOf(defSearch.fileCounts.get(name) ?? 0, nFiles) / idfOf(0, nFiles);
    leadCands = extracted
      .filter((l) => {
        const ds = defs.get(l.name) ?? [];
        if (!ds.length) leadDrops[l.name] = "no definition found";
        else if (ds.every((d) => inEvidence(d.path, d.line)))
          leadDrops[l.name] = "definition already in evidence";
        return ds.length > 0 && !ds.every((d) => inEvidence(d.path, d.line));
      })
      .map((l) => ({ ...l, weight: Math.round(l.weight * genericity(l.name) * 1000) / 1000 }))
      .sort((a, b) => b.weight - a.weight || (a.name < b.name ? -1 : 1))
      .slice(0, cfg.wave3.maxLeadCandidates);
    const maxW = Math.max(...leadCands.map((l) => l.weight), 1e-9);
    const leadItems: LeadItem[] = leadCands.map((l, i) => ({
      id: `l${String(i).padStart(3, "0")}`,
      name: l.name,
      seenAt: `${l.seenAt.path}:${l.seenAt.line}`,
      context: l.context,
      lex: l.weight / maxW,
    }));
    leadScores = await judge.scoreLeads(leadItems, ctx);
    const chosen = leadItems
      .map((l) => ({ l, p: leadScores.get(l.id) ?? 0 }))
      .filter((x) => x.p >= thr.T3)
      .sort((a, b) => b.p - a.p || (a.l.id < b.l.id ? -1 : 1))
      .slice(0, cfg.wave3.maxLeadsFollowed);
    for (const x of chosen) chosenNames.add(x.l.name);
    await loadLines(chosen.flatMap((x) => (defs.get(x.l.name) ?? []).map((d) => d.path)));
    const defItemsStart = passageItems.length;
    for (const x of chosen) {
      for (const d of defs.get(x.l.name) ?? []) {
        const lines = readLines(d.path);
        // the file could not be read as text (missing, binary, UTF-16) or changed after ripgrep saw it
        if (d.line > lines.length) {
          leadsFollowed.push({
            name: x.l.name,
            score: x.p,
            def: `${d.path}:${d.line} (not in the file as read)`,
          });
          continue;
        }
        const w = definitionWindow(
          lines,
          d.line,
          langOf(d.path),
          cfg,
          renderFor(d.path, [new RegExp(`\\b${escapeRegex(x.l.name)}\\b`)]),
        );
        const overlapsExisting = evidence.some(
          (e) => e.path === d.path && !(w.end < e.start || w.start > e.end),
        );
        leadsFollowed.push({
          name: x.l.name,
          score: x.p,
          def: `${d.path}:${d.line}${overlapsExisting ? " (overlaps evidence)" : ""}`,
        });
        if (overlapsExisting) continue;
        makePassage(d.path, w, 0, x.l.name);
      }
    }
    const defItems = passageItems.slice(defItemsStart);
    if (defItems.length) {
      const defScores = await judge.scorePassages(defItems, ctx, "lead_defs");
      for (const e of evidence) {
        const s = defScores.get(e.id);
        if (s) {
          e.rel = s.rel;
          e.cov = s.cov;
        }
      }
    }
    emit("leads", {
      T3: thr.T3,
      seeds: seeds.map((s) => `${s.path}:${s.start}`),
      candidates: leadItems.map((l) => ({
        id: l.id,
        name: l.name,
        seenAt: l.seenAt,
        lex: round(l.lex),
        p: round(leadScores.get(l.id) ?? Number.NaN),
      })),
      followed: leadsFollowed,
      defsFound: defSearch.hits.length,
      defSearchMs: defSearch.ms,
      extracted: extracted.length,
      dropped: leadDrops,
      defPassages: evidence
        .filter((e) => e.kind === "def")
        .map((e) => ({
          id: e.id,
          path: e.path,
          start: e.start,
          end: e.end,
          lead: e.lead,
          rel: round(e.rel),
        })),
    });
  }
  mark("wave3", ts);

  // ---- 5. pack + status
  ts = performance.now();
  const cpt = cfg.pack.charsPerToken;
  const totalChars = Math.floor(budgetTokens * cpt);
  const headerReserve = 420 + subQuestions.reduce((s, q) => s + q.length + 8, 0);
  const footerReserve = Math.min(1800, Math.floor(totalChars * 0.12));
  const body = packBody(evidence, {
    subQuestions,
    T2: thr.T2,
    bodyChars: Math.max(0, totalChars - headerReserve - footerReserve),
    cfg,
    downweightChangelogs: !questionMentionsHistory(ctx.question + " " + subQuestions.join(" ")),
    downweightTests: !questionMentionsTests(ctx.question),
  });
  const includedFiles = new Set(body.included.map((p) => p.path));
  const windowedFiles = new Set(evidence.map((e) => e.path));
  const otherFiles = ranked
    .filter((i) => !windowedFiles.has(rec.candidates[i]!.path))
    .map((i) => ({ path: rec.candidates[i]!.path, score: fileScores.get(fileIds[i]!) ?? 0 }))
    .filter((x) => x.score > 0);
  const leadIdByName = new Map(leadCands.map((l, i) => [l.name, `l${String(i).padStart(3, "0")}`]));
  const notFollowed = leadCands
    .filter((l) => !chosenNames.has(l.name))
    .map((l) => ({
      name: l.name,
      score: leadScores.get(leadIdByName.get(l.name)!) ?? 0,
      seenAt: `${l.seenAt.path}:${l.seenAt.line}`,
    }))
    .sort((a, b) => b.score - a.score);
  const zero = kws.filter((k) => k.df === 0 && k.pathDf === 0);
  const fragmentOnly = kws.filter((k) => k.fragments.length > 0 && (k.df > 0 || k.pathDf > 0));
  const zeroHitKeywords = [
    ...zero.map((k) => ({ raw: k.raw, fragments: [] as string[] })),
    ...fragmentOnly.map((k) => ({ raw: k.raw, fragments: k.fragments })),
  ];
  const widenedNote = prefixNote(rec);
  const footer = renderFooter({
    excluded: body.excluded,
    otherFiles,
    leadsNotFollowed: notFollowed,
    zeroHitKeywords,
    ...(widenedNote ? { widenedNote } : {}),
    cfg,
    maxChars: footerReserve,
  });
  mark("pack", ts);

  // A failure of the status request alone (after the pack) keeps the Jev pack with status unknown.
  ts = performance.now();
  let status: CodeSearchStatus = { label: "unknown", overall: null, subs: [] };
  let statusCheckError: JevUnavailableError | JevRequestError | undefined;
  let statusEvidenceChars = 0;
  if (cfg.status.enabled && body.included.length) {
    const ev = statusEvidence(body.included, cfg.status.maxEvidenceChars);
    statusEvidenceChars = ev.length;
    try {
      status = statusLabel(await judge.status(ev, ctx), cfg);
    } catch (error) {
      if (
        signal.aborted ||
        !(error instanceof JevUnavailableError || error instanceof JevRequestError)
      )
        throw error;
      statusCheckError = error;
      status = { label: "unknown", overall: null, subs: [], error: error.message.slice(0, 200) };
    }
  } else if (!body.included.length) {
    status = { label: "insufficient", overall: null, subs: [] };
  }
  mark("status", ts);
  emit("pack", {
    T2: thr.T2,
    budgetTokens,
    totalChars,
    priority: body.priority,
    included: body.included.map((p) => ({
      id: p.id,
      path: p.path,
      start: p.start,
      end: p.end,
      trimmed: p.trimmed,
      rel: round(p.rel),
      cov: p.cov.map(round),
      chars: p.block.length,
    })),
    excluded: body.excluded.map((e) => ({
      id: e.id,
      path: e.path,
      start: e.start,
      end: e.end,
      rel: round(e.rel),
    })),
    status,
    statusEvidenceChars,
  });

  // ---- render
  const jevTotals = Object.values(judge.stats()).reduce(
    (a, s) => ({
      requests: a.requests + s.requests,
      inputTokens: a.inputTokens + s.inputTokens,
      costUsd: a.costUsd + s.costUsd,
    }),
    { requests: 0, inputTokens: 0, costUsd: 0 },
  );
  const wallMs = Math.round(performance.now() - t0);
  const label = partialLabel(session);
  const statusText =
    status.label === "unknown"
      ? status.error
        ? "status=unknown (sufficiency check failed)"
        : "status=unknown (no sufficiency check)"
      : `status=${status.label}` +
        (status.overall !== null
          ? ` (overall ${r2(status.overall)}${status.subs.length ? "; " + status.subs.map((x, j) => `s${j + 1} ${r2(x)}`).join(", ") : ""})`
          : "");
  const buildText = (packTok: number) => {
    const head = [
      `code_search${label ? " " + label : ""}: ${statusText} | ${body.included.length} passages from ${includedFiles.size} files, ~${fmtK(packTok)} tokens | ${(wallMs / 1000).toFixed(1)}s`,
    ];
    if (subQuestions.length) head.push(subQuestions.map((s, j) => `s${j + 1}: ${s}`).join("\n"));
    head.push(
      body.included.length
        ? "Passages are verbatim with original line numbers (N| text), grouped by file, best first; rel = relevance, [sN] = covers sub-question N."
        : "No passage passed verification. Try other keywords (exact identifiers, config keys, error strings) or read the candidates below.",
    );
    return [head.join("\n"), body.body, footer].filter(Boolean).join("\n\n") + "\n";
  };
  let text = buildText(0);
  text = buildText(estTokens(text.length, cpt));
  const stats: CodeSearchStats = {
    wallMs,
    stageMs,
    candidates: rec.candidates.length,
    filesSelected: selected.length,
    passagesVerified: evidence.length,
    passagesIncluded: body.included.length,
    packChars: text.length,
    packTokensEst: estTokens(text.length, cpt),
    workspaceCalls: session.calls,
    ripgrepTruncated: session.partial,
    jev: { ...jevTotals, model: judge.model() },
  };
  emit("summary", { wallMs, stageMs, stats, status, jevByStage: judge.stats() });
  const result: CodeSearchResult = { version: CODE_SEARCH_ENGINE_VERSION, text, status, stats };
  if (statusCheckError) result.statusCheckError = statusCheckError;
  return result;
}

function round(x: number): number {
  return Number.isFinite(x) ? Math.round(x * 1000) / 1000 : x;
}
