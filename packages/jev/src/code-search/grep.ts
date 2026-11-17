/**
 * grep.ts - `code_grep`: the caller's own ripgrep patterns, run in parallel, widened into excerpts
 * around the hits, and (with a decision model) judged excerpt by excerpt in parallel waves that stop
 * once the relevant excerpts answer the question. The caller chooses every pattern; nothing is derived
 * from the question. Without a decision model, or when it fails, the excerpts come back in their
 * lexical order, cut to the same size.
 */
import {
  DecisionRequestError,
  DecisionUnavailableError,
  predicate,
  type DecisionModel,
  type DecisionUsage,
} from "@opengeni/decisions";
import { codeSearchConfig, type CodeSearchConfig } from "./config";
import {
  excludeArgs,
  hiddenArgs,
  parseRgOutput,
  ripgrepPatternCompiles,
  type HitLine,
  type KeywordInfo,
} from "./recall";
import { definitionPattern as leadDefinitionPattern } from "./leads";
import { mapLimit, WorkspaceSession } from "./session";
import { escapeRegex } from "./text";
import {
  enclosingWindow,
  langOf,
  rankFileWindows,
  renderLines,
  splitLines,
  type Lang,
  type Window,
} from "./windows";
import type { CodeSearchWorkspace } from "./workspace";

export interface CodeGrepInput {
  question: string;
  /** ripgrep regular expressions (or literals), chosen by the caller. */
  patterns: string[];
  /** Workspace-relative files or directories to search; default the whole workspace. */
  paths?: string[] | undefined;
  /** ripgrep globs such as `*.ts` or `!**\/test/**`. */
  globs?: string[] | undefined;
  /** Default: smart case (case-insensitive unless the pattern has an upper-case letter). */
  ignoreCase?: boolean | undefined;
  /** Paths the caller gave that were set aside (absolute); reported, not searched. */
  ignoredPaths?: readonly string[] | undefined;
  workspace: CodeSearchWorkspace;
  /** Judges excerpts; without one the excerpts are returned in lexical order. */
  decisionModel?: DecisionModel | null | undefined;
  signal?: AbortSignal | undefined;
  /** Characters of excerpt text shown in full (default 14000); later excerpts are listed by location. */
  budgetChars?: number | undefined;
  limits?: Partial<CodeGrepLimits> | undefined;
  onStage?: ((stage: string, data: Record<string, unknown>) => void) | undefined;
  onDecisionUsage?: ((usage: DecisionUsage) => void | Promise<void>) | undefined;
}

export interface CodeGrepLimits {
  /** Files whose excerpts are built (best lexical files first); the rest are listed by path. */
  maxExcerptFiles: number;
  windowsPerFile: number;
  /** Excerpts judged per wave and waves at most. */
  waveSize: number;
  maxWaves: number;
  /** Excerpts per decision request; lowered to the provider's question cap. */
  excerptsPerRequest: number;
  requestConcurrency: number;
  /** Excerpt text sent to the judge. */
  judgeExcerptChars: number;
  /** Excerpt text shown in the result. */
  shownExcerptChars: number;
  /**
   * The first excerpts shown (each from a different file) are widened to the size of a read: their
   * enclosing block, or a fixed span around the hit, so the caller need not read around them.
   */
  widenTop: number;
  widenedMaxLines: number;
  widenedChars: number;
  relevantFloor: number;
  /**
   * Judge in waves and ask after each whether the relevant excerpts already answer the question. Off by
   * default: every excerpt (up to waveSize x maxWaves) is judged in one parallel pass, which costs one
   * judge round trip instead of a sequential wave-plus-stop chain.
   */
  earlyStop: boolean;
  stopFloor: number;
  judgeDeadlineMs: number;
  otherFilesListed: number;
  /** Excerpts past the text budget, listed as location plus their first matching line. */
  moreExcerptsListed: number;
  matchesPerFile: number;
  /**
   * One follow-up hop: symbols the top relevant excerpts use but do not define are looked up by their
   * definitions, judged like the other excerpts, and the relevant ones shown under "Related definitions"
   * within the same text budget. Needs the judge.
   */
  relatedDefinitions: boolean;
  /** Relevant excerpts whose symbols are followed, symbols looked up, files per symbol, lines and text shown. */
  hopFromExcerpts: number;
  hopSymbols: number;
  hopFilesPerSymbol: number;
  hopExcerptLines: number;
  hopBudgetChars: number;
}

export const CODE_GREP_DEFAULT_LIMITS: Readonly<CodeGrepLimits> = Object.freeze({
  maxExcerptFiles: 40,
  windowsPerFile: 3,
  waveSize: 24,
  maxWaves: 4,
  excerptsPerRequest: 24,
  requestConcurrency: 8,
  judgeExcerptChars: 2400,
  shownExcerptChars: 4500,
  widenTop: 3,
  widenedMaxLines: 120,
  widenedChars: 6000,
  relevantFloor: 0.5,
  earlyStop: false,
  stopFloor: 0.8,
  judgeDeadlineMs: 20_000,
  otherFilesListed: 40,
  moreExcerptsListed: 20,
  matchesPerFile: 50,
  relatedDefinitions: true,
  hopFromExcerpts: 6,
  hopSymbols: 8,
  hopFilesPerSymbol: 2,
  hopExcerptLines: 60,
  hopBudgetChars: 4000,
});

/**
 * Windows sized like the reads that follow a search (about 100 lines around a hit), so a shown excerpt
 * replaces the read instead of preceding it.
 */
const GREP_CONFIG: CodeSearchConfig = codeSearchConfig({
  wave2: {
    maxUp: 45,
    maxDown: 60,
    maxWindowLines: 100,
    maxWindowChars: 4500,
    maxProseLineChars: 800,
    maxProseWindowChars: 2000,
    seedHitsPerFile: 12,
    fallbackBefore: 6,
    fallbackAfter: 14,
  },
});

/** Read-sized windows for the top excerpts: the enclosing block further up, or 25 lines above and 50 below. */
const READ_CONFIG: CodeSearchConfig = codeSearchConfig({
  wave2: {
    maxUp: 150,
    maxDown: 120,
    maxWindowLines: 120,
    maxWindowChars: 6000,
    minWindowLines: 40,
    fallbackBefore: 25,
    fallbackAfter: 50,
  },
});

/**
 * Widen an excerpt (1-based start..end, with its hit lines) to its enclosing block or a read-sized span
 * around its first hit, at most maxLines long and always containing that hit.
 */
export function widenForRead(
  lines: readonly string[],
  hits: readonly number[],
  start: number,
  end: number,
  lang: Lang,
  maxLines: number,
): { start: number; end: number } {
  const n = lines.length;
  const anchor = hits.find((h) => h >= 1 && h <= n) ?? start;
  const w = enclosingWindow(lines as string[], anchor, lang, READ_CONFIG);
  let s = Math.max(1, Math.min(w.start, start));
  let e = Math.min(n, Math.max(w.end, end));
  if (e - s + 1 > maxLines) {
    // Too long: keep the hit in the upper third.
    s = Math.max(s, anchor - Math.floor(maxLines / 3));
    e = Math.min(e, s + maxLines - 1);
  }
  return { start: s, end: e };
}

export interface CodeGrepExcerpt {
  id: string;
  path: string;
  start: number;
  end: number;
  text: string;
  patterns: number[];
  p: number | null;
  /** Shown in the result. */
  shown: boolean;
  /** Hit lines inside the excerpt (1-based). */
  hits?: number[] | undefined;
  /** Widened to a read-sized span for the result. */
  widened?: boolean | undefined;
  /** For a related definition: the symbol it defines. */
  defines?: string | undefined;
}

export interface CodeGrepStats {
  wallMs: number;
  /** Time in ripgrep, in reading files and building excerpts, and waiting on the judge. */
  grepMs: number;
  excerptMs: number;
  judgeMs: number;
  patternFiles: number[];
  patternHits: number[];
  invalidPatterns: number[];
  filesMatched: number;
  excerpts: number;
  judged: number;
  relevant: number;
  shown: number;
  /** Shown excerpts widened to a read-sized span. */
  widened: number;
  /** The related-definitions hop: symbols looked up, definition excerpts judged and shown, time taken. */
  hop: { symbols: string[]; excerpts: number; relevant: number; shown: number; ms: number };
  waves: number;
  stoppedEarly: boolean;
  judge: "on" | "off" | "failed";
  ripgrepPartial: boolean;
  decision: { requests: number; inputTokens: number | null; costUsd: number | null };
}

export interface CodeGrepResult {
  text: string;
  excerpts: CodeGrepExcerpt[];
  stats: CodeGrepStats;
  /** The decision-model failure the result fell back from, for the caller's health tracking. */
  judgeError: DecisionUnavailableError | DecisionRequestError | null;
}

interface FileHits {
  path: string;
  patterns: Set<number>;
  lines: Map<number, HitLine>;
  count: number;
}

const JUDGE_TASK =
  "A developer is searching a code base. For each excerpt, judge whether it bears on the developer's question.";
const excerptQuestion = (id: string) =>
  `Does excerpt ${id} contain code or text that someone answering the question would need to read or change?`;
const STOP_QUESTION =
  "Do the excerpts found so far already answer the question, so that the remaining matches need not be examined?";

/** Each file's first excerpt (in the given order), then the rest, both keeping the given order. */
export function byFileBreadth<T extends { path: string }>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  const first: T[] = [];
  const rest: T[] = [];
  for (const e of items) {
    if (seen.has(e.path)) rest.push(e);
    else {
      seen.add(e.path);
      first.push(e);
    }
  }
  return [...first, ...rest];
}

/** The excerpt's first line matching one of its patterns (numbered as in the excerpt), shortened. */
export function firstMatchingLine(
  e: Pick<CodeGrepExcerpt, "text" | "patterns">,
  patterns: readonly string[],
  ignoreCase?: boolean,
): string {
  const regexes = e.patterns.flatMap((i) => {
    const p = patterns[i];
    if (p === undefined) return [];
    const flags = (ignoreCase ?? !/[A-Z]/.test(p)) ? "i" : "";
    try {
      return [new RegExp(p, flags)];
    } catch {
      return [new RegExp(escapeRegex(p), flags)];
    }
  });
  const lines = e.text.split("\n");
  const hit =
    lines.find((l) => regexes.some((r) => r.test(l.replace(/^\s*\d+\| ?/, "")))) ??
    lines.find((l) => l.replace(/^\s*\d+\| ?/, "").trim()) ??
    "";
  const line = hit.trim();
  return line.length > 140 ? `${line.slice(0, 140)}...` : line;
}

const KEYWORDS = new Set(
  (
    "abstract async await break case catch class const constructor continue default defer delete do " +
    "else enum export extends false final finally for from func function go if impl implements import " +
    "in instanceof interface lambda let loop match module mut namespace new nil none null override " +
    "package private protected pub public raise return self static struct super switch this throw " +
    "throws trait true try type typeof undefined unsafe use var void while with yield elif except " +
    "pass print len str int bool float dict list tuple object string number boolean console require " +
    "assert expect describe test println printf sprintf malloc free sizeof"
  ).split(" "),
);

/** Declaration keywords before a name, in the languages ripgrep sees most. */
const DECL = String.raw`(?:def|class|func|function|fn|struct|interface|type|enum|trait|module|record|object|const|let|var|val|macro|typedef|alias)`;

/**
 * A ripgrep pattern for lines that define `symbol`: the code-search lead definitions (declarations,
 * methods, keys), plus Go receiver methods, C-family definitions with a return type and #define.
 */
export function symbolDefinitionPattern(symbol: string): string {
  const s = escapeRegex(symbol);
  return [
    leadDefinitionPattern([symbol]),
    String.raw`(?-u:\bfunc\s+\([^)]*\)\s*${s}\b)`,
    String.raw`(?-u:^\s*(?:[\w:<>,*&\[\]]+\s+)+[*&]*${s}\s*\([^;]*$)`,
    String.raw`(?-u:#\s*define\s+${s}\b)`,
  ].join("|");
}

const DECL_LINE = new RegExp(String.raw`\b${DECL}\s`);

/**
 * Symbols an excerpt uses but does not define, most promising first: identifiers that look like code
 * symbols (snake_case, camelCase, CapitalCase or CONSTANT) or that are called, minus keywords, names the
 * excerpt itself declares, and names the caller's patterns already match.
 */
export function referencedSymbols(text: string, patterns: readonly RegExp[]): string[] {
  const code = text
    .split("\n")
    .map((l) => l.replace(/^\s*\d+\| ?/, ""))
    .join("\n")
    .replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""')
    .replace(/\/\/.*$|#(?!\s*define).*$/gm, "");
  const declared = new Set<string>();
  for (const m of code.matchAll(new RegExp(String.raw`\b${DECL}\s+\*?([A-Za-z_]\w*)`, "g")))
    declared.add(m[1]!);
  const score = new Map<string, number>();
  for (const m of code.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\b(\s*\()?/g)) {
    const name = m[1]!;
    if (name.length < 4 || KEYWORDS.has(name.toLowerCase()) || declared.has(name)) continue;
    const called = Boolean(m[2]);
    const shaped =
      /[a-z][A-Z]/.test(name) ||
      /^_?[a-z0-9]+(?:_[a-z0-9]+)+$/i.test(name) ||
      (/^[A-Z]/.test(name) && name.length >= 5);
    if (!called && !shaped) continue;
    score.set(name, (score.get(name) ?? 0) + (called ? 2 : 1));
  }
  return [...score.entries()]
    .filter(([name]) => !patterns.some((r) => r.test(name)))
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([name]) => name);
}

export async function runCodeGrep(input: CodeGrepInput): Promise<CodeGrepResult> {
  const t0 = performance.now();
  const L: CodeGrepLimits = { ...CODE_GREP_DEFAULT_LIMITS, ...input.limits };
  const cfg = GREP_CONFIG;
  const signal = input.signal ?? new AbortController().signal;
  const emit = (stage: string, data: Record<string, unknown>) => {
    try {
      input.onStage?.(stage, data);
    } catch {
      // tracing never breaks a search
    }
  };
  const session = new WorkspaceSession(input.workspace, signal, cfg.recall.ripgrepTimeoutMs);
  const budget = input.budgetChars ?? 14_000;

  // ---- 1. the caller's patterns, in parallel
  let searchPaths = ["."];
  const missingPaths: string[] = [];
  if (input.paths?.length) {
    const kinds = await session.pathKinds(input.paths);
    const found = input.paths.filter((p) => kinds[p] && kinds[p] !== "missing");
    missingPaths.push(...input.paths.filter((p) => !found.includes(p)));
    if (found.length) searchPaths = found;
  }
  const invalid: number[] = [];
  const perPattern = await mapLimit(input.patterns, 8, async (pattern) => {
    const literal = !ripgrepPatternCompiles(pattern);
    // Smart case by default: case-insensitive unless the pattern has an upper-case letter.
    const insensitive = input.ignoreCase ?? !/[A-Z]/.test(pattern);
    const out = await session.ripgrep(
      [
        "--null",
        "--line-number",
        "--with-filename",
        "--no-heading",
        "--color",
        "never",
        ...(insensitive ? ["-i"] : []),
        "--no-require-git",
        ...hiddenArgs(cfg),
        "-m",
        String(L.matchesPerFile),
        "--max-columns",
        String(cfg.recall.maxLineColumns),
        "--max-filesize",
        String(cfg.recall.maxFileBytes),
        ...excludeArgs(cfg),
        ...(input.globs ?? []).flatMap((g) => ["-g", g]),
        "-e",
        literal ? escapeRegex(pattern) : pattern,
        "--",
        ...searchPaths,
      ],
      { allowFailure: true },
    );
    return { literal, matches: parseRgOutput(out) };
  });
  const files = new Map<string, FileHits>();
  perPattern.forEach(({ literal, matches }, i) => {
    if (literal) invalid.push(i);
    for (const m of matches) {
      let f = files.get(m.path);
      if (!f)
        files.set(m.path, (f = { path: m.path, patterns: new Set(), lines: new Map(), count: 0 }));
      f.patterns.add(i);
      f.count++;
      const hit = f.lines.get(m.line);
      if (hit) {
        if (!hit.kws.includes(i)) hit.kws.push(i);
      } else f.lines.set(m.line, { line: m.line, text: m.text, kws: [i] });
    }
  });
  const patternFiles = input.patterns.map(
    (_, i) => [...files.values()].filter((f) => f.patterns.has(i)).length,
  );
  const patternHits = perPattern.map((r) => r.matches.length);
  // A pattern that matches few files says more about a file than one that matches many.
  const total = Math.max(1, files.size);
  const keywords: KeywordInfo[] = input.patterns.map((pattern, index) => ({
    index,
    raw: pattern,
    variants: [pattern],
    mode: "phrase",
    pattern: invalid.includes(index) ? escapeRegex(pattern) : pattern,
    rgPattern: pattern,
    df: patternFiles[index]!,
    pathDf: 0,
    hitLines: patternHits[index]!,
    idf: Math.log(1 + total / Math.max(1, patternFiles[index]!)),
    fragments: [],
  }));
  const weight = (f: FileHits) =>
    [...f.patterns].reduce((s, i) => s + keywords[i]!.idf, 0) + 0.1 * Math.log(1 + f.count);
  const ranked = [...files.values()].sort(
    (a, b) => weight(b) - weight(a) || a.path.length - b.path.length || (a.path < b.path ? -1 : 1),
  );
  const grepMs = Math.round(performance.now() - t0);
  emit("grep", { patternFiles, patternHits, invalid, files: files.size, missingPaths });

  // ---- 2. excerpts around the hits (best files first, one window per file per round)
  const excerptFiles = ranked.slice(0, L.maxExcerptFiles);
  const windowsByFile = await mapLimit(excerptFiles, 8, async (f) => {
    const text = await session.readText(f.path, cfg.recall.maxFileBytes).catch(() => null);
    if (text === null) return { f, lines: [] as string[], windows: [] as Window[] };
    const lines = splitLines(text);
    const windows = rankFileWindows(
      lines,
      [...f.lines.values()],
      keywords,
      langOf(f.path),
      cfg,
    ).slice(0, L.windowsPerFile);
    return { f, lines, windows };
  });
  const excerpts: CodeGrepExcerpt[] = [];
  for (let round = 0; round < L.windowsPerFile; round++)
    for (const { f, lines, windows } of windowsByFile) {
      const w = windows[round];
      if (!w) continue;
      const body = renderLines(lines, w.start, w.end, { maxLineChars: cfg.wave2.maxLineChars });
      excerpts.push({
        id: `e${excerpts.length + 1}`,
        path: f.path,
        start: w.start,
        end: w.end,
        text: body,
        patterns: [...f.patterns].filter((i) =>
          w.hits.some((h) => f.lines.get(h)?.kws.includes(i)),
        ),
        p: null,
        shown: false,
        hits: [...w.hits].sort((a, b) => a - b),
      });
    }
  const excerptMs = Math.round(performance.now() - t0) - grepMs;
  emit("excerpts", { files: windowsByFile.length, excerpts: excerpts.length });

  // ---- 3. judge in parallel waves; stop once the relevant excerpts answer the question
  let judge: CodeGrepStats["judge"] = input.decisionModel ? "on" : "off";
  let waves = 0;
  let stoppedEarly = false;
  let judgeError: DecisionUnavailableError | DecisionRequestError | null = null;
  const usage = { requests: 0, inputTokens: 0 as number | null, costUsd: 0 as number | null };
  const onUsage = async (u: DecisionUsage) => {
    usage.requests += u.requests;
    usage.inputTokens =
      usage.inputTokens === null || u.inputTokens === null
        ? null
        : usage.inputTokens + u.inputTokens;
    usage.costUsd = usage.costUsd === null || u.costUsd === null ? null : usage.costUsd + u.costUsd;
    await input.onDecisionUsage?.(u);
  };
  const model = input.decisionModel;
  const judgeStart = performance.now();
  if (model && excerpts.length) {
    const perRequest = Math.max(
      1,
      Math.min(L.excerptsPerRequest, model.maxQuestionsPerRequest ?? L.excerptsPerRequest),
    );
    const deadline = performance.now() + L.judgeDeadlineMs;
    try {
      const waveSize = L.earlyStop ? L.waveSize : L.waveSize * L.maxWaves;
      const maxWaves = L.earlyStop ? L.maxWaves : 1;
      for (let start = 0; start < excerpts.length && waves < maxWaves; start += waveSize) {
        if (performance.now() > deadline) break;
        const wave = excerpts.slice(start, start + waveSize);
        const batches: CodeGrepExcerpt[][] = [];
        for (let i = 0; i < wave.length; i += perRequest)
          batches.push(wave.slice(i, i + perRequest));
        await mapLimit(batches, L.requestConcurrency, async (batch) => {
          const state = {
            task: JUDGE_TASK,
            question: input.question,
            excerpts: Object.fromEntries(
              batch.map((e) => [
                e.id,
                {
                  path: e.path,
                  lines: `${e.start}-${e.end}`,
                  text: e.text.slice(0, L.judgeExcerptChars),
                },
              ]),
            ),
          };
          const questions = Object.fromEntries(
            batch.map((e) => [e.id, predicate(excerptQuestion(e.id))]),
          );
          const r = await model.decide(state, questions, { signal, tag: "code_grep", onUsage });
          for (const e of batch) {
            const a = r.answers[e.id];
            e.p = a?.type === "predicate" ? a.probability : null;
          }
        });
        waves++;
        emit("wave", {
          wave: waves,
          judged: wave.length,
          relevant: wave.filter((e) => (e.p ?? 0) >= L.relevantFloor).length,
        });
        const relevant = excerpts.filter((e) => (e.p ?? 0) >= L.relevantFloor);
        const more = start + waveSize < excerpts.length && waves < maxWaves;
        if (!L.earlyStop || !relevant.length || !more) continue;
        const best = [...relevant].sort((a, b) => b.p! - a.p!).slice(0, 8);
        const r = await model.decide(
          {
            task: "A developer is searching a code base. Decide whether the excerpts found so far answer the question.",
            question: input.question,
            found: best.map((e) => ({
              path: e.path,
              lines: `${e.start}-${e.end}`,
              text: e.text.slice(0, 600),
            })),
            unexamined: excerpts.length - (start + wave.length),
          },
          { stop: predicate(STOP_QUESTION) },
          { signal, tag: "code_grep", onUsage },
        );
        const stop = r.answers.stop;
        if (stop?.type === "predicate" && stop.probability >= L.stopFloor) {
          stoppedEarly = true;
          break;
        }
      }
    } catch (error) {
      if (signal.aborted) throw error;
      if (!(error instanceof DecisionUnavailableError || error instanceof DecisionRequestError))
        throw error;
      // The search itself succeeded: fall back to the lexical order instead of failing the call.
      judge = "failed";
      judgeError = error;
      for (const e of excerpts) e.p = null;
    }
  }

  const judgeMs = model && excerpts.length ? Math.round(performance.now() - judgeStart) : 0;

  // ---- 3b. one hop: the definitions of symbols the top relevant excerpts use but do not define
  const hopStart = performance.now();
  const hop: CodeGrepStats["hop"] = { symbols: [], excerpts: 0, relevant: 0, shown: 0, ms: 0 };
  const related: CodeGrepExcerpt[] = [];
  if (model && judge === "on" && L.relatedDefinitions && L.hopSymbols > 0) {
    const relevantNow = excerpts.filter((e) => (e.p ?? 0) >= L.relevantFloor);
    const top = byFileBreadth([...relevantNow].sort((a, b) => b.p! - a.p!)).slice(
      0,
      L.hopFromExcerpts,
    );
    const callerRegexes = input.patterns.flatMap((p) => {
      const flags = (input.ignoreCase ?? !/[A-Z]/.test(p)) ? "i" : "";
      try {
        return [new RegExp(p, flags)];
      } catch {
        return [new RegExp(escapeRegex(p), flags)];
      }
    });
    // Round robin over the top excerpts, so each contributes its most promising symbols.
    const perExcerpt = top.map((e) => referencedSymbols(e.text, callerRegexes).slice(0, 4));
    const symbols: string[] = [];
    for (let rank = 0; rank < 4 && symbols.length < L.hopSymbols; rank++)
      for (const list of perExcerpt) {
        const s = list[rank];
        if (s && !symbols.includes(s) && symbols.length < L.hopSymbols) symbols.push(s);
      }
    hop.symbols = symbols;
    const definitionHits = await mapLimit(symbols, 8, async (symbol) => {
      const out = await session.ripgrep(
        [
          "--null",
          "--line-number",
          "--with-filename",
          "--no-heading",
          "--color",
          "never",
          "--no-require-git",
          ...hiddenArgs(cfg),
          "-m",
          "2",
          "--max-columns",
          String(cfg.recall.maxLineColumns),
          "--max-filesize",
          String(cfg.recall.maxFileBytes),
          ...excludeArgs(cfg),
          "-e",
          symbolDefinitionPattern(symbol),
          "--",
          ".",
        ],
        { allowFailure: true },
      );
      const byPath = new Map<string, number>();
      for (const m of parseRgOutput(out)) {
        // A line that ends a statement is a call, not a definition, unless it declares something.
        const line = m.text.trim();
        if (/[;)]$/.test(line) && !DECL_LINE.test(line)) continue;
        if (!byPath.has(m.path)) byPath.set(m.path, m.line);
      }
      return { symbol, hits: [...byPath.entries()] };
    });
    // A name defined in many files is too ambiguous to follow; prefer files near the excerpts.
    const near = (path: string) =>
      Math.max(
        0,
        ...top.map((e) => {
          const a = e.path.split("/");
          const b = path.split("/");
          let i = 0;
          while (i < a.length - 1 && i < b.length - 1 && a[i] === b[i]) i++;
          return i;
        }),
      );
    const targets: { symbol: string; path: string; line: number }[] = [];
    for (const { symbol, hits } of definitionHits) {
      if (!hits.length || hits.length > 6) continue;
      const inside = (path: string, line: number) =>
        relevantNow.some((e) => e.path === path && line >= e.start && line <= e.end);
      hits
        .filter(([path, line]) => !inside(path, line))
        .sort((x, y) => near(y[0]) - near(x[0]) || (x[0] < y[0] ? -1 : 1))
        .slice(0, L.hopFilesPerSymbol)
        .forEach(([path, line]) => targets.push({ symbol, path, line }));
    }
    const fileText = new Map<string, string[]>();
    for (const t of targets) {
      if (fileText.has(t.path)) continue;
      const text = await session.readText(t.path, cfg.recall.maxFileBytes).catch(() => null);
      fileText.set(t.path, text === null ? [] : splitLines(text));
    }
    for (const t of targets) {
      const lines = fileText.get(t.path) ?? [];
      if (!lines.length) continue;
      const w = enclosingWindow(lines, t.line, langOf(t.path), cfg);
      let s = Math.min(w.start, t.line);
      let e = Math.max(w.end, t.line);
      if (e - s + 1 > L.hopExcerptLines) {
        s = Math.max(s, t.line - 3);
        e = Math.min(e, s + L.hopExcerptLines - 1);
      }
      if (related.some((r) => r.path === t.path && s <= r.end && e >= r.start)) continue;
      related.push({
        id: `d${related.length + 1}`,
        path: t.path,
        start: s,
        end: e,
        text: renderLines(lines, s, e, { maxLineChars: cfg.wave2.maxLineChars }),
        patterns: [],
        p: null,
        shown: false,
        hits: [t.line],
        defines: t.symbol,
      });
    }
    hop.excerpts = related.length;
    if (related.length) {
      const perRequest = Math.max(
        1,
        Math.min(L.excerptsPerRequest, model.maxQuestionsPerRequest ?? L.excerptsPerRequest),
      );
      const batches: CodeGrepExcerpt[][] = [];
      for (let i = 0; i < related.length; i += perRequest)
        batches.push(related.slice(i, i + perRequest));
      try {
        await mapLimit(batches, L.requestConcurrency, async (batch) => {
          const r = await model.decide(
            {
              task: JUDGE_TASK,
              question: input.question,
              excerpts: Object.fromEntries(
                batch.map((e) => [
                  e.id,
                  {
                    path: e.path,
                    lines: `${e.start}-${e.end}`,
                    text: e.text.slice(0, L.judgeExcerptChars),
                  },
                ]),
              ),
            },
            Object.fromEntries(batch.map((e) => [e.id, predicate(excerptQuestion(e.id))])),
            { signal, tag: "code_grep", onUsage },
          );
          for (const e of batch) {
            const a = r.answers[e.id];
            e.p = a?.type === "predicate" ? a.probability : null;
          }
        });
      } catch (error) {
        if (signal.aborted) throw error;
        if (!(error instanceof DecisionUnavailableError || error instanceof DecisionRequestError))
          throw error;
        // The main result stands; the hop is only an addition.
        for (const e of related) e.p = null;
      }
    }
    hop.relevant = related.filter((e) => (e.p ?? 0) >= L.relevantFloor).length;
    hop.ms = Math.round(performance.now() - hopStart);
    emit("hop", { ...hop });
  }
  const relatedBlock = (e: CodeGrepExcerpt) =>
    `--- ${e.path}:${e.start}-${e.end} (defines ${e.defines}; relevance ${e.p!.toFixed(2)})\n${
      e.text.length > L.shownExcerptChars
        ? `${e.text.slice(0, L.shownExcerptChars)}\n...[excerpt cut]`
        : e.text
    }`;
  const relatedShown: CodeGrepExcerpt[] = [];
  let hopUsed = 0;
  for (const e of related
    .filter((r) => (r.p ?? 0) >= L.relevantFloor)
    .sort((a, b) => b.p! - a.p!)) {
    const size = relatedBlock(e).length + 1;
    if (hopUsed + size > L.hopBudgetChars) continue;
    relatedShown.push(e);
    e.shown = true;
    hopUsed += size;
  }
  hop.shown = relatedShown.length;

  // ---- 4. the result: relevant excerpts (or lexical order), then the files not shown
  const judged = excerpts.filter((e) => e.p !== null);
  // Breadth first: each file's best excerpt before any file's second, so more files are shown in full.
  const ranked2 = byFileBreadth(
    judge === "on"
      ? judged.filter((e) => e.p! >= L.relevantFloor).sort((a, b) => b.p! - a.p!)
      : excerpts,
  );
  // The top excerpts become read-sized, so the usual read around a search result is already done;
  // excerpts of the same file that the widened span mostly covers are folded into it.
  const linesByPath = new Map(windowsByFile.map((w) => [w.f.path, w.lines]));
  const absorbed = new Set<CodeGrepExcerpt>();
  let widened = 0;
  for (const e of ranked2) {
    if (widened >= L.widenTop) break;
    if (absorbed.has(e)) continue;
    const lines = linesByPath.get(e.path);
    if (!lines?.length) continue;
    const r = widenForRead(lines, e.hits ?? [], e.start, e.end, langOf(e.path), L.widenedMaxLines);
    e.start = r.start;
    e.end = r.end;
    e.text = renderLines(lines, r.start, r.end, { maxLineChars: cfg.wave2.maxLineChars });
    e.widened = true;
    widened++;
    for (const o of ranked2) {
      if (o === e || o.path !== e.path || absorbed.has(o)) continue;
      const overlap = Math.min(o.end, r.end) - Math.max(o.start, r.start) + 1;
      if (overlap >= (o.end - o.start + 1) / 2) absorbed.add(o);
    }
  }
  const order = ranked2.filter((e) => !absorbed.has(e));
  const shownText = (e: CodeGrepExcerpt) => {
    const cap = e.widened ? L.widenedChars : L.shownExcerptChars;
    return e.text.length > cap ? `${e.text.slice(0, cap)}\n...[excerpt cut]` : e.text;
  };
  const shown: CodeGrepExcerpt[] = [];
  let used = 0;
  for (const e of order) {
    const block = `--- ${e.path}:${e.start}-${e.end}${e.p === null ? "" : ` (relevance ${e.p.toFixed(2)})`}\n${shownText(e)}\n`;
    if (used + block.length > budget - hopUsed && shown.length) break;
    shown.push(e);
    e.shown = true;
    used += block.length;
  }
  // Excerpts past the budget stay findable: their location and first matching line, not their text.
  const more = order.filter((e) => !e.shown).slice(0, L.moreExcerptsListed);
  const shownPaths = new Set(shown.map((e) => e.path));
  const pointedPaths = new Set([
    ...shownPaths,
    ...more.map((e) => e.path),
    ...relatedShown.map((e) => e.path),
  ]);
  const others = ranked.filter((f) => !pointedPaths.has(f.path));
  const head: string[] = [];
  const filesTotal = files.size;
  head.push(
    filesTotal
      ? `code_grep: ${filesTotal} file${filesTotal === 1 ? "" : "s"} matched; showing ${shown.length} excerpt${shown.length === 1 ? "" : "s"} from ${shownPaths.size} file${shownPaths.size === 1 ? "" : "s"}.`
      : "code_grep: no matches.",
  );
  input.patterns.forEach((p, i) =>
    head.push(
      `pattern ${i + 1} ${JSON.stringify(p)}: ${patternFiles[i]} files, ${patternHits[i]} lines${invalid.includes(i) ? " (not a valid regex; searched literally)" : ""}`,
    ),
  );
  if (missingPaths.length) head.push(`paths not found (ignored): ${missingPaths.join(", ")}`);
  if (input.ignoredPaths?.length)
    head.push(
      `absolute paths ignored (give paths relative to the working directory): ${input.ignoredPaths.join(", ")}`,
    );
  if (judge === "on")
    head.push(
      `Relevance-judged ${judged.length} of ${excerpts.length} excerpts${stoppedEarly ? " (stopped early: the excerpts shown answer the question)" : ""}; ${judged.filter((e) => e.p! >= L.relevantFloor).length} judged relevant.`,
    );
  else if (judge === "failed")
    head.push(
      `Relevance judging failed (${judgeError?.message ?? "unknown error"}); excerpts are in match order.`,
    );
  else if (excerpts.length)
    head.push("Excerpts are in match order (files matching more patterns first).");
  if (session.partial) head.push("Some searches returned partial output (size or time limit).");
  const body = shown.map(
    (e) =>
      `--- ${e.path}:${e.start}-${e.end}${e.p === null ? "" : ` (relevance ${e.p.toFixed(2)})`}\n${shownText(e)}`,
  );
  const moreText = more.length
    ? [
        judge === "on"
          ? "Also judged relevant, not shown in full (read these lines if needed):"
          : "More excerpts, not shown in full (read these lines if needed):",
        ...more.map(
          (e) =>
            `${e.path}:${e.start}-${e.end}${e.p === null ? "" : ` (relevance ${e.p.toFixed(2)})`}: ${firstMatchingLine(e, input.patterns, input.ignoreCase)}`,
        ),
      ].join("\n")
    : "";
  const tail: string[] = [];
  if (others.length) {
    tail.push(
      `Other matching files (not shown${judge === "on" ? " or judged not relevant" : ""}):`,
    );
    for (const f of others.slice(0, L.otherFilesListed))
      tail.push(
        `${f.path} (${f.count} line${f.count === 1 ? "" : "s"}; pattern${f.patterns.size === 1 ? "" : "s"} ${[...f.patterns].map((i) => i + 1).join(",")})`,
      );
    if (others.length > L.otherFilesListed)
      tail.push(`...and ${others.length - L.otherFilesListed} more`);
  }
  const relatedText = relatedShown.length
    ? [
        "Related definitions (of symbols the excerpts above use):",
        ...relatedShown.map(relatedBlock),
      ].join("\n")
    : "";
  const text = [head.join("\n"), ...body, relatedText, moreText, tail.join("\n")]
    .filter(Boolean)
    .join("\n\n");
  const stats: CodeGrepStats = {
    wallMs: Math.round(performance.now() - t0),
    grepMs,
    excerptMs,
    judgeMs,
    patternFiles,
    patternHits,
    invalidPatterns: invalid,
    filesMatched: filesTotal,
    excerpts: excerpts.length,
    judged: judged.length,
    relevant: judged.filter((e) => e.p! >= L.relevantFloor).length,
    shown: shown.length,
    widened: shown.filter((e) => e.widened).length,
    hop,
    waves,
    stoppedEarly,
    judge,
    ripgrepPartial: session.partial,
    decision: usage,
  };
  emit("summary", { ...stats });
  return { text, excerpts: [...excerpts, ...related], stats, judgeError };
}
