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
import {
  chooseDefinitions,
  extractLeads,
  locateDefinitions,
  type DefinitionHit,
  type LeadCandidate,
} from "./leads";
import {
  complementRanges,
  fmtRanges,
  inclusionRel,
  isImportOnly,
  mergeRanges,
  packBody,
  renderFooter,
  type CoverageFile,
  type EvidencePassage,
  type PackBody,
} from "./pack";
import {
  bestHitLines,
  cleanPrefix,
  excludeArgs,
  idfOf,
  recall,
  type FileCandidate,
  type KeywordInfo,
  type RecallResult,
} from "./recall";
import { mapLimit, READ_CONCURRENCY, WorkspaceSession } from "./session";
import { nameIndex } from "./nameindex";
import { locateUsages, specificName, symbolCandidates } from "./symbols";
import { keywordNotes } from "./vocab";
import {
  contentTerms,
  escapeRegex,
  estTokens,
  fmtK,
  isChangelogPath,
  isDocPath,
  isTestPath,
  keywordVariants,
  overlap,
  questionMentionsHistory,
  questionMentionsTests,
  splitWords,
  STOPWORDS,
  trimAround,
} from "./text";
import {
  definitionWindow,
  enclosingWindow,
  keywordRegex,
  keywordsInRange,
  langOf,
  outlineRanges,
  rankFileWindows,
  renderLines,
  scoreWindow,
  splitLines,
  tileFile,
  type RenderOpts,
  type Window,
} from "./windows";
import type { CodeSearchWorkspace } from "./workspace";

/** Engine version: scout-0.3.1 (the validated research port) plus symbol discovery, tiling, callers and the adaptive, gap-reporting pack. */
export const CODE_SEARCH_ENGINE_VERSION = "scout-0.4.0";
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
    stageMs[stage] = (stageMs[stage] ?? 0) + Math.round(performance.now() - since);
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
  const allowTests = questionMentionsTests(ctx.question);
  const exArgs = excludeArgs(cfg);
  /** What each cap cut, one pre-rendered line per cap, for the footer. */
  const cuts: string[] = [];
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
  const scopePaths = (o.paths ?? []).map(cleanPrefix).filter((p): p is string => p !== null && p !== ".");
  const [rec, ni] = await Promise.all([
    recall({
      session,
      question: ctx.question + " " + subQuestions.join(" "),
      keywords: o.keywords,
      pathPrefixes: o.paths ?? [],
      config: cfg,
    }),
    cfg.recall.nameIndex
      ? nameIndex({
          session,
          question: ctx.question + " " + subQuestions.join(" "),
          files: [],
          paths: scopePaths,
          cfg,
          excludeArgs: exArgs,
          allowTests,
          maxFiles: cfg.recall.nameIndexFiles * 3,
        }).catch(() => null)
      : Promise.resolve(null),
  ]);
  mark("recall", ts);
  const kws = [...rec.keywords];
  const userKeywords = rec.keywords.length;
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
  if (rec.scoredFiles > rec.candidates.length) {
    cuts.push(
      `recall: ${rec.scoredFiles} files matched the keywords; only the best ${rec.candidates.length} by keyword score were triaged (the other ${rec.scoredFiles - rec.candidates.length} match fewer or more common keywords; the strongest of them: ${rec.cutTop
        .map((c) => c.path)
        .join(", ")}).`,
    );
  }

  // ---- 2. wave 1: file triage
  ts = performance.now();
  const cands: FileCandidate[] = [...rec.candidates];
  const byPath = new Map(cands.map((c, i) => [c.path, i]));
  // files whose declared names carry the question's own words join triage (no Jev spent to find them)
  const nameIndexAdded: string[] = [];
  if (ni && ni.files.length) {
    const qk = kws.length;
    kws.push({
      index: qk,
      raw: "(question words)",
      variants: [],
      mode: "phrase",
      pattern: ni.stems.map(escapeRegex).join("|") || "(?!)",
      rgPattern: "",
      df: ni.files.length,
      pathDf: 0,
      hitLines: 0,
      idf: 1,
      fragments: [],
      symbol: true,
    });
    for (const f of ni.files) {
      if (nameIndexAdded.length >= cfg.recall.nameIndexFiles) break;
      if (byPath.has(f.path) || (!allowTests && isTestPath(f.path))) continue;
      byPath.set(f.path, cands.length);
      cands.push({
        path: f.path,
        lexScore: f.score / 10,
        kwHits: { [qk]: f.hits.length },
        pathKws: [],
        hitLines: new Map(f.hits.map((h) => [h.line, { line: h.line, text: h.text, kws: [qk] }])),
        isTest: isTestPath(f.path),
        isDoc: isDocPath(f.path),
      });
      nameIndexAdded.push(f.path);
    }
  }
  const fileIds = cands.map((_, i) => `f${String(i).padStart(3, "0")}`);
  const maxLex = cands[0]?.lexScore || 1;
  const fileItem = (i: number): FileItem => {
    const c = cands[i]!;
    const hits = bestHitLines(c, kws, cfg.wave1.hitLinesPerFile);
    const needles = Object.keys(c.kwHits).flatMap((k) => kws[Number(k)]!.variants);
    const lines = hits.map(
      (h) => `  ${h.line}: ${trimAround(h.text, needles, cfg.wave1.hitLineChars)}`,
    );
    return {
      id: fileIds[i]!,
      path: c.path,
      descriptor: [c.path, ...lines].join("\n"),
      lex: Math.min(1, c.lexScore / maxLex),
    };
  };
  const fileScores = await judge.scoreFiles(
    cands.map((_, i) => fileItem(i)),
    ctx,
  );
  const pOf = (i: number) => fileScores.get(fileIds[i]!) ?? 0;
  const first = selectFiles(cands, fileScores, fileIds, thr.T1, cfg);
  const selected = [...first.selected];
  const ranked = [...first.ranked];
  mark("wave1", ts);
  emit("wave1", {
    T1: thr.T1,
    scores: cands.map((c, i) => ({
      path: c.path,
      p: round(fileScores.get(fileIds[i]!) ?? Number.NaN),
      lex: round(c.lexScore / maxLex),
    })),
    selected: selected.map((i) => cands[i]!.path),
  });
  const triageCut = ranked.filter((i) => !selected.includes(i) && pOf(i) >= thr.T1);
  if (triageCut.length) {
    cuts.push(
      `file triage: ${triageCut.length} more file${triageCut.length === 1 ? "" : "s"} passed (limit ${cfg.wave1.maxFiles}): ${triageCut
        .map((i) => `${cands[i]!.path} (${r2(pOf(i))})`)
        .join(", ")}`,
    );
  }

  // file contents are read in parallel as needed; windowing is synchronous
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
  await loadLines(selected.map((i) => cands[i]!.path));

  // words already searched (keywords, variants, fragments) and the question's words
  const searched = new Set<string>();
  for (const k of rec.keywords) {
    for (const v of [...k.variants, ...k.fragments.flatMap((f) => keywordVariants(f))]) {
      searched.add(v.toLowerCase());
      searched.add(splitWords(v).join(" "));
    }
  }
  const qWords = new Set(
    [
      ...splitWords(ctx.question + " " + subQuestions.join(" ")),
      ...rec.keywords.flatMap((k) => splitWords(k.raw)),
    ].filter((w) => w.length >= 3 && !STOPWORDS.has(w)),
  );
  const nFiles = Math.max(rec.totalFiles, 1);

  const symbolRounds: Array<Record<string, unknown>> = [];
  const symbolAdded: Array<{ path: string; p: number; via: string[] }> = [];
  const followedSymbols: string[] = [];
  /**
   * Follow named identifiers: their definitions and usages across the workspace become candidate files, the
   * files they lead to are triaged, and the passing ones join the selection. Returns the files added.
   */
  const followNames = async (
    round_: number | string,
    chosen: Array<{ it: { name: string }; p: number }>,
    roundTrace: Record<string, unknown>,
  ): Promise<number[]> => {
    const usage = await locateUsages(
      session,
      chosen.map((x) => x.it.name),
      cfg,
      exArgs,
      allowTests,
    );
    if (usage.cappedFiles)
      cuts.push(
        `symbols round ${round_}: usage search kept at most 30 matching lines per file (${usage.cappedFiles} file${usage.cappedFiles === 1 ? "" : "s"} had more).`,
      );
    const fileGain = new Map<number, { score: number; via: Set<string> }>();
    const generic: string[] = [];
    for (const x of chosen) {
      const name = x.it.name;
      followedSymbols.push(name);
      const files = usage.files.get(name) ?? new Set<string>();
      const isGeneric = files.size > cfg.symbols.maxRefFiles;
      if (isGeneric) generic.push(`${name} (${files.size} files)`);
      const hits = usage.hits.filter((h) => h.name === name && (!isGeneric || h.kind === "def"));
      if (!hits.length) continue;
      const kwIndex = kws.length;
      const esc = escapeRegex(name);
      kws.push({
        index: kwIndex,
        raw: name,
        variants: [name],
        mode: "phrase",
        pattern: `\\b${esc}\\b`,
        rgPattern: `(?-u:\\b)${esc}(?-u:\\b)`,
        df: files.size,
        pathDf: 0,
        hitLines: hits.length,
        idf: idfOf(files.size, nFiles),
        fragments: [],
        symbol: true,
      });
      for (const h of hits) {
        let ci = byPath.get(h.path);
        if (ci === undefined) {
          ci = cands.length;
          cands.push({
            path: h.path,
            lexScore: 0,
            kwHits: {},
            pathKws: [],
            hitLines: new Map(),
            isTest: isTestPath(h.path),
            isDoc: isDocPath(h.path),
          });
          byPath.set(h.path, ci);
          fileIds.push(`s${round_}${String(ci).padStart(4, "0")}`);
        }
        const c = cands[ci]!;
        c.kwHits[kwIndex] = (c.kwHits[kwIndex] ?? 0) + 1;
        let hl = c.hitLines.get(h.line);
        if (!hl) c.hitLines.set(h.line, (hl = { line: h.line, text: h.text, kws: [] }));
        if (!hl.kws.includes(kwIndex)) hl.kws.push(kwIndex);
        if (!selected.includes(ci)) {
          const g = fileGain.get(ci) ?? { score: 0, via: new Set<string>() };
          if (!g.via.has(name)) g.score += x.p * (h.kind === "def" ? 1.5 : 1);
          g.via.add(name);
          fileGain.set(ci, g);
        }
      }
    }
    if (generic.length)
      cuts.push(
        `symbols round ${round_}: used in too many files to follow every usage (definitions only): ${generic.join(", ")}`,
      );
    // triage the files the identifiers lead to (new files, and candidates that gained symbol hits)
    const gains = [...fileGain.entries()]
      .filter(([ci]) => !cands[ci]!.isTest || allowTests)
      .sort((a, b) => b[1].score - a[1].score || (cands[a[0]]!.path < cands[b[0]]!.path ? -1 : 1));
    const toTriage = gains.slice(0, cfg.symbols.maxNewFilesTriaged);
    if (gains.length > toTriage.length) {
      cuts.push(
        `symbols round ${round_}: triaged ${toTriage.length} of ${gains.length} files that use the followed identifiers; not triaged: ${gains
          .slice(toTriage.length, toTriage.length + 12)
          .map(([ci]) => cands[ci]!.path)
          .join(", ")}${gains.length - toTriage.length > 12 ? ", ..." : ""}`,
      );
    }
    for (const [ci, g] of toTriage) cands[ci]!.lexScore += g.score;
    const newScores = await judge.scoreFiles(
      toTriage.map(([ci]) => fileItem(ci)),
      ctx,
    );
    for (const [id, p] of newScores) fileScores.set(id, p);
    const passed = toTriage
      .map(([ci, g]) => ({ ci, g, p: pOf(ci) }))
      .filter((x) => x.p >= thr.T1)
      .sort((a, b) => b.p - a.p || b.g.score - a.g.score);
    const take = passed.slice(0, cfg.symbols.maxNewFilesSelected);
    if (passed.length > take.length) {
      cuts.push(
        `symbols round ${round_}: selected ${take.length} of ${passed.length} relevant files the identifiers lead to; not selected: ${passed
          .slice(take.length)
          .map((x) => `${cands[x.ci]!.path} (${r2(x.p)})`)
          .join(", ")}`,
      );
    }
    for (const x of take) {
      selected.push(x.ci);
      symbolAdded.push({ path: cands[x.ci]!.path, p: round(x.p), via: [...x.g.via] });
    }
    roundTrace.triaged = toTriage.map(([ci, g]) => ({
      path: cands[ci]!.path,
      p: round(pOf(ci)),
      via: [...g.via],
    }));
    roundTrace.added = take.map((x) => cands[x.ci]!.path);
    await loadLines(take.map((x) => cands[x.ci]!.path));
    return take.map((x) => x.ci);
  };

  // ---- 2a. second recall round: most keywords matched nothing relevant, so recall again with real names
  // that carry the question's own words
  let recall2: { bad: string[]; names: string[]; added: string[] } | null = null;
  if (ni && ni.names.length && cfg.recall.secondRoundNames > 0) {
    const bad = rec.keywords.filter((k) => {
      if (k.df === 0 && k.pathDf === 0) return true;
      const hit = cands.filter((c) => c.kwHits[k.index] || c.pathKws.includes(k.index));
      return !hit.some((c) => pOf(byPath.get(c.path)!) >= thr.T1);
    });
    if (rec.keywords.length && bad.length >= Math.max(1, Math.ceil(cfg.recall.secondRoundBadShare * rec.keywords.length))) {
      const names = ni.names
        .map((n) => n.name)
        .filter((n) => specificName(n) && !searched.has(n.toLowerCase()))
        .slice(0, cfg.recall.secondRoundNames);
      if (names.length) {
        const t2 = performance.now();
        const trace2: Record<string, unknown> = { round: "recall 2", bad: bad.map((k) => k.raw), chosen: names };
        const added = await followNames(
          "recall 2",
          names.map((name) => ({ it: { name }, p: 1 })),
          trace2,
        );
        symbolRounds.push(trace2);
        recall2 = { bad: bad.map((k) => k.raw), names, added: added.map((i) => cands[i]!.path) };
        mark("recall2", t2);
      }
    }
  }

  // ---- 2b. symbol discovery: identifiers of the selected files, judged, then their definitions and usages
  ts = performance.now();
  if (cfg.symbols.enabled) {
    const judged = new Set<string>();
    // identifiers come from relevant code files (not docs, release notes or unrelated tests)
    const codeFile = (i: number) =>
      !isDocPath(cands[i]!.path) &&
      !isChangelogPath(cands[i]!.path) &&
      (allowTests || !cands[i]!.isTest);
    let sources = selected.filter((i) => pOf(i) >= thr.T1 && codeFile(i));
    if (!sources.length) sources = selected.filter(codeFile).slice(0, 3);
    for (let round_ = 1; round_ <= cfg.symbols.maxRounds && sources.length; round_++) {
      const srcFiles = sources.map((i) => ({
        path: cands[i]!.path,
        lines: readLines(cands[i]!.path),
        p: pOf(i),
        hitLines: [...cands[i]!.hitLines.keys()],
      }));
      const exclude = new Set([...searched, ...judged]);
      const all = symbolCandidates(srcFiles, exclude, qWords);
      const judgedNow = all.slice(0, cfg.symbols.maxJudged);
      judgedNow.forEach((c) => judged.add(c.name));
      if (all.length > judgedNow.length) {
        cuts.push(
          `symbols round ${round_}: judged the ${judgedNow.length} strongest of ${all.length} identifiers in ${srcFiles.length} files; not judged: ${all
            .slice(judgedNow.length, judgedNow.length + 12)
            .map((c) => c.name)
            .join(", ")}${all.length - judgedNow.length > 12 ? ", ..." : ""}`,
        );
      }
      const maxW = Math.max(...judgedNow.map((c) => c.weight), 1e-9);
      const items: LeadItem[] = judgedNow.map((c, j) => ({
        id: `y${round_}${String(j).padStart(3, "0")}`,
        name: c.name,
        seenAt: `${c.seenAt.path}:${c.seenAt.line}`,
        context: c.context,
        lex: c.weight / maxW,
      }));
      const symScores = await judge.scoreSymbols(items, ctx);
      const passing = items
        .map((it) => ({ it, p: symScores.get(it.id) ?? 0 }))
        .filter((x) => x.p >= cfg.symbols.threshold)
        .sort((a, b) => b.p - a.p || (a.it.id < b.it.id ? -1 : 1));
      const chosen = passing.slice(0, cfg.symbols.maxFollowed);
      if (passing.length > chosen.length) {
        cuts.push(
          `symbols round ${round_}: followed ${chosen.length} of ${passing.length} relevant identifiers; not followed: ${passing
            .slice(chosen.length)
            .map((x) => `${x.it.name} (${r2(x.p)})`)
            .join(", ")}`,
        );
      }
      const roundTrace: Record<string, unknown> = {
        round: round_,
        sources: srcFiles.map((f) => f.path),
        candidates: all.length,
        judged: items.map((it) => ({ name: it.name, p: round(symScores.get(it.id) ?? Number.NaN), ctx: it.context })),
        chosen: chosen.map((x) => x.it.name),
      };
      symbolRounds.push(roundTrace);
      if (!chosen.length) break;
      sources = (await followNames(round_, chosen, roundTrace)).filter(codeFile);

    }
    // ranked (for "more candidates") includes the newly triaged files by score
    for (let i = 0; i < cands.length; i++) if (!ranked.includes(i) && fileScores.has(fileIds[i]!)) ranked.push(i);
    ranked.sort((a, b) => pOf(b) - pOf(a) || cands[b]!.lexScore - cands[a]!.lexScore || a - b);
  }
  mark("symbols", ts);
  emit("symbols", {
    nameIndex: ni ? { stems: ni.stems, ms: ni.ms, declarations: ni.declarations, added: nameIndexAdded, names: ni.names.slice(0, 20).map((n) => n.name) } : null,
    recall2,
    rounds: symbolRounds,
    added: symbolAdded,
    selected: selected.map((i) => cands[i]!.path),
  });

  // ---- 3. wave 2: windows + verification
  ts = performance.now();
  const kwNeedles = () =>
    kws
      .filter((k) => k.idf > 0)
      .map((k) => keywordRegex(k))
      .filter((re): re is RegExp => re !== null);
  const needlesNow = kwNeedles();
  const renderFor = (path: string, needles: RegExp[] = needlesNow): RenderOpts => ({
    maxLineChars: isDocPath(path) ? cfg.wave2.maxProseLineChars : cfg.wave2.maxLineChars,
    needles,
  });
  // the top relevant small files are tiled whole: every declaration is judged, not only keyword windows
  const tiled = new Set(
    selected
      .filter((i) => pOf(i) >= thr.T1 && readLines(cands[i]!.path).length <= cfg.wave2.tileMaxLines)
      .sort((a, b) => pOf(b) - pOf(a))
      .slice(0, cfg.wave2.tileMaxFiles),
  );
  /** Ranges as text, grouping lines within `gap` of each other, at most `max` ranges plus a count of the rest. */
  const rangesText = (rs: Array<[number, number]>, gap = 0, max = 10) => {
    const merged: Array<[number, number]> = [];
    for (const [a, b] of mergeRanges(rs)) {
      const last = merged[merged.length - 1];
      if (last && a - last[1] - 1 <= gap) last[1] = Math.max(last[1], b);
      else merged.push([a, b]);
    }
    return (
      fmtRanges(merged.slice(0, max)) + (merged.length > max ? ` (+${merged.length - max} more ranges)` : "")
    );
  };
  const windowCuts: string[] = [];
  let otherWindowCuts = 0;
  const otherWindowFiles = new Set<string>();
  const perFileWindows: Window[][] = selected.map((i) => {
    const c = cands[i]!;
    const lines = readLines(c.path);
    const hits = [...c.hitLines.values()];
    const relevant = pOf(i) >= thr.T1;
    const note = (rest: Window[]) => {
      if (!rest.length) return;
      if (relevant) windowCuts.push(`${c.path}: ${rangesText(rest.map((w) => [w.start, w.end]))}`);
      else {
        otherWindowCuts += rest.length;
        otherWindowFiles.add(c.path);
      }
    };
    if (tiled.has(i)) {
      const tiles = tileFile(lines, hits.map((h) => h.line), langOf(c.path), cfg, renderFor(c.path));
      for (const t of tiles) t.score = scoreWindow(lines, t, kws, cfg.recall.hitCountWeight);
      const keep = [...tiles]
        .sort((a, b) => b.score - a.score || a.start - b.start)
        .slice(0, cfg.wave2.tileMaxWindows);
      note(tiles.filter((t) => !keep.includes(t)));
      return keep;
    }
    const all = rankFileWindows(lines, hits, kws, langOf(c.path), cfg, renderFor(c.path));
    const keep = all.slice(0, relevant ? cfg.wave2.windowsPerRelevantFile : cfg.wave2.windowsPerFile);
    note(all.slice(keep.length));
    return keep;
  });
  if (windowCuts.length || otherWindowCuts)
    cuts.push(
      `regions per file (limit ${cfg.wave2.windowsPerFile}, ${cfg.wave2.windowsPerRelevantFile} in relevant files, ${cfg.wave2.tileMaxWindows} in small relevant files read whole): not checked ${[
        ...windowCuts,
        ...(otherWindowCuts
          ? [`${otherWindowCuts} more keyword regions in ${otherWindowFiles.size} less relevant files (${[...otherWindowFiles].slice(0, 6).join(", ")}${otherWindowFiles.size > 6 ? ", ..." : ""})`]
          : []),
      ].join("; ")}`,
    );
  const capped = capPassages(perFileWindows, cfg.wave2.maxPassages);
  // keyword and symbol hit lines no checked window covers in relevant files (seed-hit, window and passage caps)
  const uncovered: string[] = [];
  selected.forEach((ci, f) => {
    const c = cands[ci]!;
    if (pOf(ci) < thr.T1 || tiled.has(ci)) return;
    const n = readLines(c.path).length;
    const lines = [...c.hitLines.keys()].filter(
      (l) => l <= n && !capped[f]!.some((w) => l >= w.start && l <= w.end),
    );
    const stored = Object.entries(c.kwHits).some(
      ([k, cnt]) => cnt > cfg.recall.maxMatchesPerFile && !kws[Number(k)]?.symbol,
    );
    if (lines.length || stored)
      uncovered.push(
        `${c.path}: ${lines.length ? `lines ${rangesText(lines.map((l) => [l, l]), 15)}` : ""}${stored ? `${lines.length ? "; " : ""}more matches past the first ${cfg.recall.maxMatchesPerFile} per keyword not examined` : ""}`,
      );
  });
  if (uncovered.length) cuts.push(`keyword hits outside every checked region: ${uncovered.join("; ")}`);
  const passageCut = perFileWindows.flatMap((ws, f) =>
    ws.filter((w) => !capped[f]!.includes(w)).map((w) => `${cands[selected[f]!]!.path}:${w.start}-${w.end}`),
  );
  if (passageCut.length)
    cuts.push(`passages checked (limit ${cfg.wave2.maxPassages}): not checked ${passageCut.join(", ")}`);
  const qTerms = contentTerms(ctx.question);
  const subTerms = subQuestions.map((s) => contentTerms(s));
  const evidence: EvidencePassage[] = [];
  const passageItems: PassageItem[] = [];
  let pid = 0;
  const makePassage = (
    path: string,
    w: Window,
    fileNorm: number,
    extra: { lead?: string; caller?: string } = {},
  ) => {
    const lines = readLines(path);
    const focus = extra.lead ?? extra.caller;
    const render = renderFor(path, focus ? [new RegExp(`\\b${escapeRegex(focus)}\\b`)] : needlesNow);
    const text = renderLines(lines, w.start, w.end, render);
    const rawLines = lines.slice(w.start - 1, w.end);
    const raw = rawLines.join("\n");
    const present = keywordsInRange(lines, w.start, w.end, kws.slice(0, userKeywords));
    const rawTerms = new Set(contentTerms(raw));
    const id = `p${String(pid++).padStart(3, "0")}`;
    const lex = lexicalPassageScore(raw, present, kws.slice(0, userKeywords), qTerms, fileNorm);
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
      lead: extra.lead,
      caller: extra.caller,
      render,
      importOnly: isImportOnly(rawLines),
    });
  };
  selected.forEach((ci, f) => {
    const c = cands[ci]!;
    for (const w of [...capped[f]!].sort((a, b) => a.start - b.start))
      makePassage(c.path, w, Math.min(1, c.lexScore / maxLex));
  });
  const applyScores = (scores: Map<string, { rel: number; cov: number[] }>) => {
    for (const e of evidence) {
      const s = scores.get(e.id);
      if (s) {
        e.rel = s.rel;
        e.cov = s.cov;
      }
    }
  };
  applyScores(await judge.scorePassages(passageItems, ctx, "wave2"));
  mark("wave2", ts);
  emit("wave2", {
    T2: thr.T2,
    tiled: [...tiled].map((i) => cands[i]!.path),
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
      importOnly: e.importOnly || undefined,
    })),
  });

  // ---- 4. wave 3: leads (definitions and call sites)
  ts = performance.now();
  let leadCands: LeadCandidate[] = [];
  let leadScores = new Map<string, number>();
  const chosenNames = new Set<string>();
  const leadIdByName = new Map<string, string>();
  const leadsFollowed: Array<{ name: string; score: number; def: string | null }> = [];
  const inEvidence = (path: string, line: number) =>
    evidence.some((e) => e.path === path && line >= e.start && line <= e.end);
  const overlapsEvidence = (path: string, w: { start: number; end: number }) =>
    evidence.some((e) => e.path === path && !(w.end < e.start || w.start > e.end));
  /** Windows the definitions and call sites of the named leads; returns the passages added. */
  const followLeads = async (
    chosen: Array<{ name: string; p: number }>,
    defs: Map<string, DefinitionHit[]>,
  ): Promise<number> => {
    const before = passageItems.length;
    for (const x of chosen) chosenNames.add(x.name);
    await loadLines(chosen.flatMap((x) => (defs.get(x.name) ?? []).map((d) => d.path)));
    for (const x of chosen) {
      for (const d of defs.get(x.name) ?? []) {
        const lines = readLines(d.path);
        // the file could not be read as text (missing, binary, UTF-16) or changed after ripgrep saw it
        if (d.line > lines.length) {
          leadsFollowed.push({ name: x.name, score: x.p, def: `${d.path}:${d.line} (not in the file as read)` });
          continue;
        }
        const w = definitionWindow(
          lines,
          d.line,
          langOf(d.path),
          cfg,
          renderFor(d.path, [new RegExp(`\\b${escapeRegex(x.name)}\\b`)]),
        );
        const ov = overlapsEvidence(d.path, w);
        leadsFollowed.push({ name: x.name, score: x.p, def: `${d.path}:${d.line}${ov ? " (overlaps evidence)" : ""}` });
        if (!ov) makePassage(d.path, w, 0, { lead: x.name });
      }
    }
    // call sites: other places that use the lead (sibling code paths that must change together)
    const callerLeads = chosen.filter((x) => specificName(x.name));
    if (cfg.wave3.callersPerLead > 0 && callerLeads.length) {
      const usage = await locateUsages(session, callerLeads.map((x) => x.name), cfg, exArgs, allowTests, 12);
      const refs = usage.hits.filter((h) => h.kind === "ref" && !inEvidence(h.path, h.line));
      const picks: typeof refs = [];
      for (const x of callerLeads) {
        if ((usage.files.get(x.name)?.size ?? 0) > cfg.symbols.maxRefFiles) {
          cuts.push(`call sites of ${x.name}: used in ${usage.files.get(x.name)!.size} files, too many to check (definition only).`);
          continue;
        }
        const mine = refs
          .filter((h) => h.name === x.name && (!isTestPath(h.path) || allowTests))
          .sort(
            (a, b) =>
              Number(evidence.some((e) => e.path === b.path)) - Number(evidence.some((e) => e.path === a.path)) ||
              (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line),
          );
        const perFile = new Set<string>();
        for (const h of mine) {
          if (picks.filter((p) => p.name === x.name).length >= cfg.wave3.callersPerLead) break;
          if (perFile.has(h.path)) continue;
          perFile.add(h.path);
          picks.push(h);
        }
        const total = new Set(mine.map((h) => h.path)).size;
        if (total > perFile.size)
          cuts.push(
            `call sites of ${x.name}: checked ${perFile.size} of ${total} files; not checked: ${[...new Set(mine.map((h) => h.path))]
              .filter((p) => !perFile.has(p))
              .slice(0, 10)
              .join(", ")}${total - perFile.size > 10 ? ", ..." : ""}`,
          );
      }
      await loadLines(picks.map((h) => h.path));
      for (const h of picks) {
        const lines = readLines(h.path);
        if (h.line > lines.length || inEvidence(h.path, h.line)) continue;
        const w = enclosingWindow(lines, h.line, langOf(h.path), cfg);
        if (overlapsEvidence(h.path, w)) continue;
        makePassage(h.path, w, 0, { caller: h.name });
      }
    }
    const added = passageItems.slice(before);
    if (added.length) applyScores(await judge.scorePassages(added, ctx, "lead_defs"));
    return added.length;
  };
  let defsForLeads = new Map<string, DefinitionHit[]>();
  if (cfg.wave3.enabled) {
    const strong = evidence
      .filter((e) => inclusionRel(e, cfg) >= thr.T2)
      .sort((a, b) => b.rel - a.rel)
      .slice(0, cfg.wave3.seedPassages);
    // few passages passed: the best ones below the bar still name the code to follow
    const weak =
      strong.length < cfg.wave3.seedPassages
        ? evidence
            .filter((e) => !strong.includes(e) && !e.importOnly && e.rel >= cfg.wave3.seedFloor)
            .sort((a, b) => b.rel - a.rel)
            .slice(0, cfg.wave3.seedPassages - strong.length)
        : [];
    const seeds = [...strong, ...weak].map((e) => ({
      path: e.path,
      start: e.start,
      lines: e.fileLines.slice(e.start - 1, e.end),
      rel: e.rel,
    }));
    const leadSearched = new Set([...searched, ...followedSymbols.map((n) => n.toLowerCase())]);
    const extracted = extractLeads(seeds, leadSearched, qWords, Math.ceil(cfg.wave3.maxLeadCandidates * 1.5));
    const selectedPaths = new Set(selected.map((i) => cands[i]!.path));
    const defSearch = await locateDefinitions(
      session,
      extracted.map((l) => l.name),
      cfg,
      exArgs,
      12,
      allowTests,
    );
    const seenAt = new Map(extracted.map((l) => [l.name, l.seenAt.path]));
    defsForLeads = chooseDefinitions(defSearch.hits, selectedPaths, cfg.wave3.defsPerLead, allowTests, seenAt);
    const leadDrops: Record<string, string> = {};
    // genericity penalty: a name defined/used as a key in many files (sessionId, workspaceId, isRecord) is rarely
    // what the answer hinges on
    const genericity = (name: string) =>
      idfOf(defSearch.fileCounts.get(name) ?? 0, nFiles) / idfOf(0, nFiles);
    leadCands = extracted
      .filter((l) => {
        const ds = defsForLeads.get(l.name) ?? [];
        if (!ds.length) leadDrops[l.name] = "no definition found";
        else if (ds.every((d) => inEvidence(d.path, d.line)))
          leadDrops[l.name] = "definition already in evidence";
        return ds.length > 0 && !ds.every((d) => inEvidence(d.path, d.line));
      })
      .map((l) => ({ ...l, weight: Math.round(l.weight * genericity(l.name) * 1000) / 1000 }))
      .sort((a, b) => b.weight - a.weight || (a.name < b.name ? -1 : 1));
    if (leadCands.length > cfg.wave3.maxLeadCandidates) {
      const rest = leadCands.slice(cfg.wave3.maxLeadCandidates);
      cuts.push(
        `leads: judged ${cfg.wave3.maxLeadCandidates} of ${leadCands.length} identifiers the evidence names; not judged: ${rest
          .slice(0, 12)
          .map((l) => l.name)
          .join(", ")}${rest.length > 12 ? ", ..." : ""}`,
      );
      leadCands = leadCands.slice(0, cfg.wave3.maxLeadCandidates);
    }
    const maxW = Math.max(...leadCands.map((l) => l.weight), 1e-9);
    const leadItems: LeadItem[] = leadCands.map((l, i) => ({
      id: `l${String(i).padStart(3, "0")}`,
      name: l.name,
      seenAt: `${l.seenAt.path}:${l.seenAt.line}`,
      context: l.context,
      lex: l.weight / maxW,
    }));
    leadItems.forEach((l) => leadIdByName.set(l.name, l.id));
    leadScores = await judge.scoreLeads(leadItems, ctx);
    const chosen = leadItems
      .map((l) => ({ name: l.name, id: l.id, p: leadScores.get(l.id) ?? 0 }))
      .filter((x) => x.p >= thr.T3)
      .sort((a, b) => b.p - a.p || (a.id < b.id ? -1 : 1))
      .slice(0, cfg.wave3.maxLeadsFollowed);
    await followLeads(chosen, defsForLeads);
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
        .filter((e) => e.kind === "def" || e.caller)
        .map((e) => ({
          id: e.id,
          path: e.path,
          start: e.start,
          end: e.end,
          lead: e.lead ?? e.caller,
          caller: Boolean(e.caller),
          rel: round(e.rel),
        })),
    });
  }
  mark("wave3", ts);

  // ---- 5. pack + status (adaptive: a low rating follows more leads once and refills the budget)
  ts = performance.now();
  const cpt = cfg.pack.charsPerToken;
  const totalChars = Math.floor(budgetTokens * cpt);
  const headerReserve = 520 + subQuestions.reduce((s, q) => s + q.length + 8, 0);
  const footerReserve = Math.floor(totalChars * cfg.pack.footerShare);
  const packOpts = (fillMin?: number) => ({
    subQuestions,
    T2: thr.T2,
    bodyChars: Math.max(0, totalChars - headerReserve - footerReserve),
    cfg,
    downweightChangelogs: !questionMentionsHistory(ctx.question + " " + subQuestions.join(" ")),
    downweightTests: !questionMentionsTests(ctx.question),
    ...(fillMin !== undefined ? { fillMin } : {}),
  });
  let status: CodeSearchStatus = { label: "unknown", overall: null, subs: [] };
  let statusCheckError: JevUnavailableError | JevRequestError | undefined;
  let statusEvidenceChars = 0;
  const check = async (b: PackBody): Promise<void> => {
    if (!cfg.status.enabled || !b.included.length) {
      status = b.included.length ? status : { label: "insufficient", overall: null, subs: [] };
      return;
    }
    const ev = statusEvidence(b.included, cfg.status.maxEvidenceChars);
    statusEvidenceChars = ev.length;
    const tStatus = performance.now();
    try {
      status = statusLabel(await judge.status(ev, ctx), cfg);
      mark("status", tStatus);
    } catch (error) {
      mark("status", tStatus);
      if (signal.aborted || !(error instanceof JevUnavailableError || error instanceof JevRequestError))
        throw error;
      statusCheckError = error;
      status = { label: "unknown", overall: null, subs: [], error: error.message.slice(0, 200) };
    }
  };
  let body = packBody(evidence, packOpts());
  await check(body);
  const adaptive: string[] = [];
  const ratingOf = () => (status.overall === null ? null : status.overall);
  const firstRating = ratingOf();
  if (!statusCheckError && firstRating !== null && firstRating < cfg.pack.followBelowRating && cfg.wave3.enabled) {
    // follow the next leads (a lower bar) and the next triaged files once
    const nextLeads = leadCands
      .filter((l) => !chosenNames.has(l.name))
      .map((l) => ({ name: l.name, p: leadScores.get(leadIdByName.get(l.name)!) ?? 0 }))
      .filter((x) => x.p >= Math.min(thr.T3, 0.35))
      .sort((a, b) => b.p - a.p)
      .slice(0, cfg.wave3.maxLeadsFollowed);
    const added = await followLeads(nextLeads, defsForLeads);
    adaptive.push(`rating ${r2(firstRating)}: followed ${nextLeads.length} more leads (${added} passages)`);
    body = packBody(evidence, packOpts(cfg.pack.fillMinRelevance));
    await check(body);
  } else if (!statusCheckError && firstRating !== null && firstRating < cfg.pack.fillBelowRating) {
    const before = body.included.length;
    body = packBody(evidence, packOpts(cfg.pack.fillMinRelevance));
    if (body.included.length !== before) {
      adaptive.push(`rating ${r2(firstRating)}: filled the budget with passages rel >= ${cfg.pack.fillMinRelevance}`);
      await check(body);
    }
  }
  mark("pack", ts);

  // ---- footer: coverage of relevant files, caps, leads, keywords
  const includedFiles = new Set(body.included.map((p) => p.path));
  const windowedFiles = new Set(evidence.map((e) => e.path));
  const relevantFiles = new Set<string>([
    ...includedFiles,
    ...selected.filter((i) => pOf(i) >= thr.T1).map((i) => cands[i]!.path),
    ...evidence.filter((e) => inclusionRel(e, cfg) >= thr.T2).map((e) => e.path),
  ]);
  const shownBy = new Map<string, Array<[number, number]>>();
  for (const p of body.included) {
    const arr = shownBy.get(p.path) ?? [];
    arr.push([p.start, p.end]);
    shownBy.set(p.path, arr);
  }
  const pByPath = new Map(cands.map((c, i) => [c.path, fileScores.get(fileIds[i]!)]));
  const fileRank = (path: string) => {
    const order = body.included.findIndex((p) => p.path === path);
    return order >= 0 ? order : 1000 - (pByPath.get(path) ?? 0);
  };
  const coverage: CoverageFile[] = [...relevantFiles]
    .sort((a, b) => fileRank(a) - fileRank(b) || (a < b ? -1 : 1))
    .map((path) => {
      const shown = shownBy.get(path) ?? [];
      const checked = body.excluded
        .filter((x) => x.path === path && !shown.some(([s, e]) => x.start >= s && x.end <= e))
        .map((x) => ({ start: x.start, end: x.end, rel: x.rel }));
      const p = pByPath.get(path);
      const lines = fileLines.get(path) ?? [];
      const hidden = complementRanges(lines.length, shown);
      return {
        path,
        lines: lines.length,
        shown,
        checked,
        outline: outlineRanges(lines, langOf(path), hidden, cfg.pack.outlineNames),
        ...(!shown.length && p !== undefined ? { note: `file triage ${r2(p)}` } : {}),
      };
    });
  if (body.budgetCut.length)
    cuts.push(
      `token budget (${fmtK(budgetTokens)}): passages that passed but did not fit: ${body.budgetCut
        .map((x) => `${x.path}:${x.start}-${x.end} (${r2(x.rel)})`)
        .join(", ")}`,
    );
  const otherFiles = ranked
    .filter((i) => !windowedFiles.has(cands[i]!.path))
    .map((i) => ({ path: cands[i]!.path, score: pOf(i) }))
    .filter((x) => x.score > 0);
  const notFollowed = leadCands
    .filter((l) => !chosenNames.has(l.name))
    .map((l) => ({
      name: l.name,
      score: leadScores.get(leadIdByName.get(l.name)!) ?? 0,
      seenAt: `${l.seenAt.path}:${l.seenAt.line}`,
    }))
    .sort((a, b) => b.score - a.score);
  ts = performance.now();
  const keywords = await keywordNotes({
    session,
    keywords: rec.keywords,
    candidates: cands,
    relevantFiles,
    suggestFrom: [
      ...new Set([
        ...selected.map((i) => cands[i]!.path),
        ...ranked.slice(0, 60).map((i) => cands[i]!.path),
      ]),
    ],
    cfg,
    excludeArgs: exArgs,
  });
  mark("vocab", ts);
  const recall2Note = recall2
    ? `Second recall round: ${recall2.bad.length} keywords matched nothing relevant (${recall2.bad.join(", ")}), so the search also looked up real names that carry the question's words: ${recall2.names.join(", ")}${recall2.added.length ? `; files added: ${recall2.added.join(", ")}` : "; no file passed triage"}.`
    : undefined;
  const widenedNote = [prefixNote(rec), recall2Note].filter(Boolean).join(" ") || undefined;
  const footer = renderFooter({
    coverage,
    cuts,
    excluded: body.excluded,
    otherFiles,
    leadsNotFollowed: notFollowed,
    keywords,
    ...(widenedNote ? { widenedNote } : {}),
    cfg,
    maxChars: footerReserve,
  });
  emit("pack", {
    T2: thr.T2,
    budgetTokens,
    totalChars,
    priority: body.priority,
    adaptive,
    firstRating,
    included: body.included.map((p) => ({
      id: p.id,
      path: p.path,
      start: p.start,
      end: p.end,
      trimmed: p.trimmed,
      whole: p.whole || undefined,
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
    coverage: coverage.map((c) => ({ path: c.path, lines: c.lines, shown: c.shown })),
    cuts,
    keywords,
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
  // A number, not a verdict: "sufficient" read as permission to stop, but the
  // check only sees the passages the search returned.
  const statusText =
    status.label === "unknown" || status.overall === null
      ? status.error
        ? "evidence rating unknown (check failed)"
        : "evidence rating unknown (no check)"
      : `evidence rating ${r2(status.overall)}` +
        (status.subs.length
          ? ` (${status.subs.map((x, j) => `s${j + 1} ${r2(x)}`).join(", ")})`
          : "");
  const buildText = (packTok: number) => {
    const head = [
      `code_search${label ? " " + label : ""}: ${statusText} | ${body.included.length} passages from ${includedFiles.size} files, ~${fmtK(packTok)} tokens | ${(wallMs / 1000).toFixed(1)}s`,
    ];
    if (subQuestions.length) head.push(subQuestions.map((s, j) => `s${j + 1}: ${s}`).join("\n"));
    head.push(
      body.included.length
        ? "Passages are verbatim with original line numbers (N| text), grouped by file, best first; rel = relevance, [sN] = covers sub-question N. The rating covers only these passages; it cannot see other entry points, defaults, flags or exceptions the search did not return. This shows where to look: before changing code, read the relevant regions in full, including the not-shown ranges listed at the end."
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
