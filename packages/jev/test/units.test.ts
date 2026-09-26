import { describe, expect, test } from "bun:test";
import { DEFAULT_CODE_SEARCH_CONFIG, codeSearchConfig } from "../src";
import {
  buildFileRequest,
  buildPassageRequest,
  chunkPassages,
  PROMPTS,
  type PassageItem,
} from "../src/code-search/judge";
import {
  chooseDefinitions,
  definedNames,
  definitionKinds,
  extractLeads,
  identifiersInLine,
  type DefinitionHit,
} from "../src/code-search/leads";
import {
  packBody,
  priorityOrder,
  renderFooter,
  trimToFit,
  type EvidencePassage,
} from "../src/code-search/pack";
import { buildPattern, idfOf, pathMatches } from "../src/code-search/recall";
import { capPassages, selectFiles, statusLabel } from "../src/code-search/search";
import {
  compoundFragments,
  contentTerms,
  isShortPlainWord,
  isTestPath,
  keywordVariants,
  splitWords,
  trimAround,
} from "../src/code-search/text";
import {
  blockEnd,
  buildFileWindows,
  definitionWindow,
  enclosingWindow,
  isDeclLine,
  mergeWindows,
  padWindow,
  renderLines,
  splitWindow,
  type Window,
} from "../src/code-search/windows";

const cfg = codeSearchConfig();

// ---------------------------------------------------------------------------
describe("text / variants", () => {
  test("splitWords handles camel, Pascal, acronyms, snake, kebab", () => {
    expect(splitWords("compactionThresholdTokens")).toEqual(["compaction", "threshold", "tokens"]);
    expect(splitWords("HTTPServerError")).toEqual(["http", "server", "error"]);
    expect(splitWords("MAX_AUTO_CONTINUATIONS")).toEqual(["max", "auto", "continuations"]);
    expect(splitWords("wait-for-input v2")).toEqual(["wait", "for", "input", "v2"]);
  });
  test("keywordVariants covers camel/snake/kebab/phrase, deduped case-insensitively", () => {
    const v = keywordVariants("compactionThreshold");
    expect(v).toEqual([
      "compactionThreshold",
      "compaction_threshold",
      "compaction-threshold",
      "compaction threshold",
    ]);
    expect(keywordVariants("wait_for_input")).toContain("waitForInput");
    expect(keywordVariants("MAX_AUTO_CONTINUATIONS").map((x) => x.toLowerCase())).toContain(
      "maxautocontinuations",
    );
    expect(keywordVariants("turn")).toEqual(["turn"]);
    expect(keywordVariants("x")).toEqual([]);
  });
  test("compoundFragments only for >= 3 words and skips tiny pairs", () => {
    expect(compoundFragments("shouldCompactContext")).toEqual(["shouldCompact", "compactContext"]);
    expect(compoundFragments("compactContext")).toEqual([]);
  });
  test("short plain words get a word boundary; identifiers do not", () => {
    expect(isShortPlainWord("turn", 5)).toBe(true);
    expect(isShortPlainWord("turnId", 5)).toBe(false);
    expect(buildPattern("turn", cfg)).toMatchObject({ mode: "word-prefix", pattern: "\\bturn" });
    const p = buildPattern("compactionThreshold", cfg);
    expect(p.mode).toBe("phrase");
    expect(p.pattern).toContain("compaction_threshold");
    expect(p.pattern).toContain("compaction\\s+threshold");
  });
  test("contentTerms drops stopwords and stems", () => {
    const t = contentTerms("How does the worker retry failing turns?");
    expect(t).toContain("work"); // "worker" stemmed
    expect(t).toContain("retry");
    expect(t).toContain("turn");
    expect(t).not.toContain("does");
  });
  test("trimAround keeps the needle visible", () => {
    const line = "x".repeat(300) + " compactionThresholdTokens(window) " + "y".repeat(300);
    const t = trimAround(line, ["compactionThresholdTokens"], 120);
    expect(t).toContain("compactionThresholdTokens");
    expect(t.length).toBeLessThanOrEqual(120);
  });
  test("isTestPath", () => {
    expect(isTestPath("apps/worker/test/x.test.ts")).toBe(true);
    expect(isTestPath("packages/a/src/foo.spec.ts")).toBe(true);
    expect(isTestPath("packages/a/src/testing.ts")).toBe(false);
  });
  test("idf decreases with df and pathMatches ignores separators", () => {
    expect(idfOf(1, 6000)).toBeGreaterThan(idfOf(3000, 6000));
    expect(pathMatches("apps/worker/src/context-compaction.ts", ["contextCompaction"])).toBe(true);
    expect(pathMatches("apps/worker/src/turn.ts", ["contextCompaction"])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("config", () => {
  test("defaults are scout-0.3.1's Jev configuration", () => {
    expect(DEFAULT_CODE_SEARCH_CONFIG.thresholds).toEqual({ T1: 0.6, T2: 0.5, T3: 0.5 });
    expect(DEFAULT_CODE_SEARCH_CONFIG.recall).toMatchObject({
      maxCandidates: 240,
      maxMatchesPerFile: 25,
      maxFileBytes: 4_000_000,
      maxLineColumns: 8000,
      testWeight: 0.6,
      pathBonus: 0.5,
      hitCountWeight: 0.1,
      shortWordMaxLen: 5,
      fragmentFallback: true,
      minCandidatesBeforeWiden: 5,
      extraExcludes: [],
      searchHidden: true,
      changelogWeight: 0.6,
    });
    expect(DEFAULT_CODE_SEARCH_CONFIG.wave1).toEqual({
      filesPerRequest: 60,
      hitLinesPerFile: 3,
      hitLineChars: 160,
      maxFiles: 16,
      minFiles: 8,
      lexicalGuard: 5,
    });
    expect(DEFAULT_CODE_SEARCH_CONFIG.wave2).toEqual({
      windowsPerFile: 5,
      seedHitsPerFile: 24,
      maxUp: 40,
      maxDown: 120,
      maxWindowLines: 150,
      fallbackBefore: 10,
      fallbackAfter: 30,
      mergeGap: 2,
      minWindowLines: 12,
      passagesPerRequest: 4,
      maxRequestChars: 24_000,
      maxPassages: 80,
      maxLineChars: 400,
      maxProseLineChars: 1600,
      maxWindowChars: 8000,
      maxProseWindowChars: 4000,
    });
    expect(DEFAULT_CODE_SEARCH_CONFIG.wave3).toEqual({
      enabled: true,
      maxLeadCandidates: 60,
      maxLeadsFollowed: 6,
      seedPassages: 12,
      defsPerLead: 1,
    });
    expect(DEFAULT_CODE_SEARCH_CONFIG.status).toEqual({
      enabled: true,
      maxEvidenceChars: 60_000,
      hi: 0.7,
      lo: 0.4,
    });
    expect(DEFAULT_CODE_SEARCH_CONFIG.pack).toEqual({
      charsPerToken: 3.2,
      minPassages: 4,
      minRelevance: 0.1,
      fillBudget: false,
      moreCandidates: 10,
      leadsNotFollowed: 8,
      minTrimLines: 15,
      filePenalty: 0.1,
      maxPassageChars: 3200,
      changelogPrior: 0.5,
      docPrior: 0.85,
      testPrior: 1,
      lexWeight: 0,
    });
    expect(DEFAULT_CODE_SEARCH_CONFIG.jev).toEqual({
      inlineQuestionMaxChars: 600,
      fileCriteriaPerQuestion: false,
      warmConnections: 12,
    });
    expect(Object.isFrozen(DEFAULT_CODE_SEARCH_CONFIG.recall)).toBe(true);
  });
  test("partial override merges per section", () => {
    const c = codeSearchConfig({ wave1: { maxFiles: 10 }, thresholds: { T2: 0.4 } });
    expect(c.wave1.maxFiles).toBe(10);
    expect(c.wave1.minFiles).toBe(DEFAULT_CODE_SEARCH_CONFIG.wave1.minFiles);
    expect(c.thresholds.T2).toBe(0.4);
    expect(c.thresholds.T1).toBe(DEFAULT_CODE_SEARCH_CONFIG.thresholds.T1);
    expect(DEFAULT_CODE_SEARCH_CONFIG.wave1.maxFiles).toBe(16);
  });
  test("unknown keys, wrong types and bad values are rejected", () => {
    expect(() => codeSearchConfig({ wave1: { maxFilez: 3 } as never })).toThrow(
      /unknown code_search config key/,
    );
    expect(() => codeSearchConfig({ wave1: { maxFiles: "3" } as never })).toThrow(
      /expected number/,
    );
    expect(() => codeSearchConfig({ thresholds: { T1: 1.5 } })).toThrow(/must be in \[0,1\]/);
    expect(() => codeSearchConfig({ wave1: { minFiles: 30 } })).toThrow(/minFiles/);
  });
});

// ---------------------------------------------------------------------------
describe("windows", () => {
  const ts = [
    "import { a } from './a';", // 1
    "", // 2
    "/** Doc comment. */", // 3
    "export function outer(x: number): number {", // 4
    "  const y = a(x);", // 5
    "  if (y > 3) {", // 6
    "    return y * 2;", // 7
    "  }", // 8
    "  return y;", // 9
    "}", // 10
    "", // 11
    "export const LIMIT = 5;", // 12
    "", // 13
    "export class Box {", // 14
    "  open(): void {", // 15
    "    this.count += 1;", // 16
    "  }", // 17
    "}", // 18
  ];
  test("isDeclLine recognizes declarations but not control flow or plain calls", () => {
    expect(isDeclLine("export function outer(x: number): number {", "brace")).toBe(true);
    expect(isDeclLine("export const LIMIT = 5;", "brace")).toBe(true);
    expect(isDeclLine("  open(): void {", "brace")).toBe(true);
    expect(isDeclLine('describe("x", () => {', "brace")).toBe(true);
    expect(isDeclLine('app.post("/v1/x", async (c) => {', "brace")).toBe(true);
    expect(isDeclLine("  if (y > 3) {", "brace")).toBe(false);
    expect(isDeclLine("  doThing(a, b);", "brace")).toBe(false);
    expect(isDeclLine("## Heading", "markdown")).toBe(true);
    expect(isDeclLine("CREATE OR REPLACE FUNCTION f() RETURNS void AS $$", "sql")).toBe(true);
    expect(isDeclLine("def foo(x):", "indent")).toBe(true);
  });
  test("blockEnd for brace, markdown, sql, indent", () => {
    expect(blockEnd(ts, 3, "brace")).toBe(9); // outer: 0-based 3..9
    expect(blockEnd(ts, 11, "brace")).toBe(11); // one-liner
    const md = ["# A", "text", "## B", "b text", "## C", "c"];
    expect(blockEnd(md, 2, "markdown")).toBe(3);
    expect(blockEnd(md, 0, "markdown")).toBe(5);
    const sql = [
      "CREATE FUNCTION f() RETURNS int AS $$",
      "BEGIN",
      "  RETURN 1;",
      "END;",
      "$$ LANGUAGE plpgsql;",
      "SELECT 1;",
    ];
    expect(blockEnd(sql, 0, "sql")).toBe(4);
    const py = ["def f(x):", "    y = x", "    return y", "", "def g():", "    pass"];
    expect(blockEnd(py, 0, "indent")).toBe(2);
  });
  test("enclosingWindow walks up to the enclosing function and includes its doc comment", () => {
    const w = enclosingWindow(ts, 7, "brace", cfg);
    expect(w.start).toBeLessThanOrEqual(3); // doc comment included (+ padding to minWindowLines)
    expect(w.end).toBeGreaterThanOrEqual(10);
    expect(w.label?.line).toBe(4);
    expect(w.hits).toEqual([7]);
  });
  test("a one-line statement on the hit line is not an enclosing block", () => {
    const lines = [
      "export function f() {",
      ...Array.from({ length: 5 }, (_, i) => `  step${i}();`),
      "  const x = compute(1);",
      "  return x;",
      "}",
    ];
    const w = enclosingWindow(lines, 7, "brace", cfg);
    expect(w.start).toBe(1);
    expect(w.end).toBe(9);
  });
  test("fallback window when no declaration is within maxUp, labelled with the far declaration", () => {
    const lines = [
      "export function huge() {",
      ...Array.from({ length: 200 }, (_, i) => `  work(${i});`),
      "}",
    ];
    const w = enclosingWindow(lines, 80, "brace", cfg);
    expect(w.start).toBe(80 - cfg.wave2.fallbackBefore);
    expect(w.end).toBe(80 + cfg.wave2.fallbackAfter);
    expect(w.label?.line).toBe(1);
  });
  test("padWindow grows short windows, mergeWindows merges overlaps and near-adjacent windows", () => {
    const p = padWindow({ start: 50, end: 52, hits: [51], kind: "hit", score: 0 }, 100, cfg);
    expect(p.end - p.start + 1).toBe(cfg.wave2.minWindowLines);
    expect(p.start).toBeLessThanOrEqual(50);
    const ws: Window[] = [
      { start: 10, end: 20, hits: [12], kind: "hit", score: 0 },
      { start: 22, end: 30, hits: [25], kind: "hit", score: 0 },
      { start: 50, end: 60, hits: [55], kind: "hit", score: 0 },
    ];
    const m = mergeWindows(ws, 2);
    expect(m.map((x) => [x.start, x.end])).toEqual([
      [10, 30],
      [50, 60],
    ]);
    expect(m[0]!.hits).toEqual([12, 25]);
  });
  test("splitWindow splits long windows around hit clusters and drops chunks without hits", () => {
    const w: Window = { start: 1, end: 500, hits: [10, 20, 300, 480], kind: "hit", score: 0 };
    const parts = splitWindow(w, 150);
    expect(parts.length).toBe(3);
    for (const p of parts) {
      expect(p.end - p.start + 1).toBeLessThanOrEqual(150);
      expect(p.hits.length).toBeGreaterThan(0);
      for (const h of p.hits) expect(h >= p.start && h <= p.end).toBe(true);
    }
  });
  test("buildFileWindows keeps at most windowsPerFile windows in line order", () => {
    const lines = Array.from({ length: 2000 }, (_, i) =>
      i % 100 === 0 ? `export function f${i}() {` : i % 100 === 99 ? "}" : `  line${i}();`,
    );
    const hits = Array.from({ length: 12 }, (_, i) => ({ line: i * 150 + 5, text: "x", kws: [0] }));
    const kws = [
      {
        index: 0,
        raw: "line",
        variants: ["line"],
        mode: "phrase" as const,
        pattern: "line",
        rgPattern: "line",
        df: 1,
        pathDf: 0,
        hitLines: 12,
        idf: 2,
        fragments: [],
      },
    ];
    const ws = buildFileWindows(lines, hits, kws, "brace", cfg);
    expect(ws.length).toBeLessThanOrEqual(cfg.wave2.windowsPerFile);
    for (let i = 1; i < ws.length; i++) expect(ws[i]!.start).toBeGreaterThan(ws[i - 1]!.end);
  });
  test("definitionWindow starts at the definition (with doc comment) and ends at its block", () => {
    const w = definitionWindow(ts, 4, "brace", cfg);
    expect(w.start).toBe(3);
    expect(w.end).toBe(10);
    expect(w.kind).toBe("def");
  });
  test("renderLines prefixes original line numbers and cuts very long lines with a marker", () => {
    const out = renderLines(["a", "b".repeat(1000)], 1, 2, 400);
    expect(out.split("\n")[0]).toBe("1| a");
    expect(out).toContain("[line cut, 1000 chars]");
  });
});

// ---------------------------------------------------------------------------
describe("leads", () => {
  test("identifiersInLine finds calls, imports, types, constants and members", () => {
    const ids = identifiersInLine(
      'import { compactNow, type TurnInput } from "./x"; const l = compactionThresholdTokens(cfg.maxInputTokens, MAX_RATIO_VALUE) as ContextWindow;',
    );
    const names = ids.map((x) => x.name);
    expect(names).toContain("compactNow");
    expect(names).toContain("TurnInput");
    expect(names).toContain("compactionThresholdTokens");
    expect(names).toContain("MAX_RATIO_VALUE");
    expect(names).toContain("ContextWindow");
    expect(names).toContain("maxInputTokens");
  });
  test("definedNames collects declarations inside passages", () => {
    const d = definedNames(
      "export function a() {}\nconst { b, c: d } = x;\nclass E {}\n  method(x: number): void {\nCREATE OR REPLACE FUNCTION public.do_thing(a int)",
    );
    for (const n of ["a", "b", "d", "E", "method", "do_thing"]) expect(d.has(n)).toBe(true);
  });
  test("extractLeads excludes searched keywords, defined names and stoplist; ranks by weighted frequency", () => {
    const seeds = [
      {
        path: "src/turn.ts",
        start: 10,
        rel: 0.9,
        lines: [
          "  const limit = compactionThresholdTokens(input.contextWindow);",
          "  await compactNow(input);",
          "  const s = JSON.stringify(input);",
          "  retryPolicyFor(input);",
        ],
      },
      {
        path: "src/b.ts",
        start: 1,
        rel: 0.6,
        lines: ["function compactNow() {}", "  retryPolicyFor(x);"],
      },
    ];
    const leads = extractLeads(
      seeds,
      new Set(["compactionthresholdtokens"]),
      new Set(["retry"]),
      10,
    );
    const names = leads.map((l) => l.name);
    expect(names).not.toContain("compactionThresholdTokens"); // searched
    expect(names).not.toContain("compactNow"); // defined in a seed
    expect(names).not.toContain("stringify"); // stoplist
    expect(names[0]).toBe("retryPolicyFor");
    expect(leads[0]!.seenAt).toEqual({ path: "src/turn.ts", line: 13 });
  });
  test("markdown seeds only contribute backticked identifiers", () => {
    const leads = extractLeads(
      [
        {
          path: "docs/a.md",
          start: 1,
          rel: 0.9,
          lines: ["OpenGeni uses `resolveThreshold()` and `MAX_TOKENS_LIMIT`."],
        },
      ],
      new Set(),
      new Set(),
      10,
    );
    expect(leads.map((l) => l.name).sort()).toEqual(["MAX_TOKENS_LIMIT", "resolveThreshold"]);
  });
  test("definitionKinds classify declarations, SQL functions, methods and keys", () => {
    const k = (line: string) => definitionKinds("doThing").find((x) => x.re.test(line))?.kind;
    expect(k("export async function doThing(a: number) {")).toBe("decl");
    expect(k("CREATE OR REPLACE FUNCTION public.doThing(a int)")).toBe("sqlfn");
    expect(k("  async doThing(a: number): Promise<void> {")).toBe("method");
    expect(k("  doThing: z.number(),")).toBe("key");
    expect(k("  doThing?: number;")).toBe("key");
    expect(k("  doThing(a);")).toBeUndefined();
  });
  test("chooseDefinitions prefers declarations in non-test files and drops test-only definitions", () => {
    const hits: DefinitionHit[] = [
      { name: "x", path: "test/a.test.ts", line: 1, kind: "decl", text: "" },
      { name: "x", path: "src/config.ts", line: 5, kind: "key", text: "" },
      { name: "x", path: "src/impl.ts", line: 9, kind: "decl", text: "" },
      { name: "y", path: "test/b.test.ts", line: 2, kind: "decl", text: "" },
    ];
    const d = chooseDefinitions(hits, new Set(), 1);
    expect(d.get("x")![0]!.path).toBe("src/impl.ts");
    expect(d.has("y")).toBe(false);
    expect(chooseDefinitions(hits, new Set(), 1, true).get("y")![0]!.path).toBe("test/b.test.ts");
  });
});

// ---------------------------------------------------------------------------
const lines100 = Array.from(
  { length: 400 },
  (_, i) => `const v${i + 1} = ${i + 1}; // filler text for line ${i + 1}`,
);
const ev = (
  id: string,
  start: number,
  end: number,
  rel: number,
  cov: number[] = [],
  path = "src/a.ts",
): EvidencePassage => ({
  id,
  path,
  start,
  end,
  fileLines: lines100,
  hits: [Math.floor((start + end) / 2)],
  kind: "hit",
  rel,
  cov,
});

describe("pack", () => {
  test("priorityOrder guarantees the best passage per covered sub-question, then relevance", () => {
    const ps = [
      ev("a", 1, 10, 0.95, [0.1, 0.2]),
      ev("b", 20, 30, 0.3, [0.2, 0.9]),
      ev("c", 40, 50, 0.6, [0.8, 0.1]),
      ev("d", 60, 70, 0.05, [0.1, 0.1]),
    ];
    const order = priorityOrder(ps, { subQuestions: ["s1", "s2"], T2: 0.5, cfg });
    expect(order.map((x) => x.id).slice(0, 2)).toEqual(["c", "b"]); // s1 best, s2 best
    expect(order.map((x) => x.id)).toContain("a");
    expect(order.map((x) => x.id)).not.toContain("d"); // below minRelevance
  });
  test("passages below T2 are only used to reach minPassages", () => {
    const ps = [
      ev("a", 1, 10, 0.9),
      ev("b", 20, 30, 0.3),
      ev("c", 40, 50, 0.2),
      ev("d", 60, 70, 0.15),
      ev("e", 80, 90, 0.12),
    ];
    const order = priorityOrder(ps, {
      subQuestions: [],
      T2: 0.5,
      cfg: codeSearchConfig({ pack: { minPassages: 3 } }),
    });
    expect(order.map((x) => x.id)).toEqual(["a", "b", "c"]);
  });
  test("packBody respects the char budget and trims whole lines with a marker", () => {
    const ps = [ev("a", 1, 150, 0.9), ev("b", 200, 350, 0.8)];
    const bodyChars = 9000;
    const body = packBody(ps, { subQuestions: [], T2: 0.5, bodyChars, cfg });
    expect(body.body.length).toBeLessThanOrEqual(bodyChars);
    const trimmed = body.included.filter((p) => p.trimmed);
    expect(trimmed.length).toBeGreaterThan(0);
    for (const p of trimmed) {
      expect(p.block).toContain("(trimmed from");
      const nums = p.block
        .split("\n")
        .filter((l) => /^\d+\| /.test(l))
        .map((l) => Number(l.split("|")[0]));
      expect(nums[0]).toBe(p.start);
      expect(nums[nums.length - 1]).toBe(p.end);
      // every rendered line is a complete source line
      for (const l of p.block.split("\n").filter((x) => /^\d+\| /.test(x))) {
        const n = Number(l.split("|")[0]);
        expect(l).toBe(`${n}| ${lines100[n - 1]}`);
      }
    }
  });
  test("trimToFit refuses to keep fewer than minTrimLines lines", () => {
    expect(
      trimToFit(ev("a", 1, 150, 0.9), 400, { subQuestions: [], T2: 0.5, bodyChars: 400, cfg }),
    ).toBeNull();
  });
  test("output groups by file, best file first, passages by line", () => {
    const ps = [
      ev("a", 100, 110, 0.7, [], "src/x.ts"),
      ev("b", 1, 10, 0.95, [], "src/y.ts"),
      ev("c", 5, 15, 0.6, [], "src/x.ts"),
    ];
    const body = packBody(ps, { subQuestions: [], T2: 0.5, bodyChars: 50_000, cfg });
    expect(body.included.map((p) => p.id)).toEqual(["b", "c", "a"]);
  });
  test("renderFooter drops entries until it fits", () => {
    const excluded = Array.from({ length: 20 }, (_, i) =>
      ev(`p${i}`, i * 10 + 1, i * 10 + 5, 0.4, [], `src/very/long/path/number/${i}/file.ts`),
    );
    const out = renderFooter({
      excluded,
      otherFiles: [],
      leadsNotFollowed: [],
      zeroHitKeywords: [{ raw: "nope", fragments: [] }],
      cfg,
      maxChars: 300,
    });
    expect(out.length).toBeLessThanOrEqual(300);
    expect(out).toContain("Keywords with zero hits: nope");
  });
});

// ---------------------------------------------------------------------------
describe("selection helpers", () => {
  test("selectFiles keeps the lexical guard, takes >= T1 and at least minFiles, caps at maxFiles", () => {
    const cands = Array.from(
      { length: 30 },
      (_, i) => ({ path: `f${i}`, lexScore: 30 - i }) as any,
    );
    const ids = cands.map((_, i) => `f${i}`);
    const scores = new Map(ids.map((id, i) => [id, i >= 20 && i < 25 ? 0.9 : 0.05]));
    const c = codeSearchConfig({ wave1: { maxFiles: 10, minFiles: 4, lexicalGuard: 3 } });
    const { selected } = selectFiles(cands, scores, ids, 0.3, c);
    expect(selected.length).toBe(8); // 3 guard + 5 above T1
    for (const g of [0, 1, 2]) expect(selected).toContain(g);
    for (const j of [20, 21, 22, 23, 24]) expect(selected).toContain(j);
    expect(selected.slice(0, 5)).toEqual([20, 21, 22, 23, 24]); // judge order first
    // everything below T1: guard + top minFiles by judge score (ties by lexical)
    const low = new Map(ids.map((id) => [id, 0.05]));
    expect(selectFiles(cands, low, ids, 0.3, c).selected.sort((a, b) => a - b)).toEqual([
      0, 1, 2, 3,
    ]);
    // cap
    const high = new Map(ids.map((id) => [id, 0.9]));
    expect(selectFiles(cands, high, ids, 0.3, c).selected.length).toBe(10);
  });
  test("capPassages round-robins across files", () => {
    const per = [
      [{ score: 3 }, { score: 2 }, { score: 1 }],
      [{ score: 5 }],
      [{ score: 4 }, { score: 4 }],
    ];
    const out = capPassages(per, 4);
    expect(out.map((x) => x.length)).toEqual([2, 1, 1]);
  });
  test("statusLabel bands", () => {
    expect(statusLabel({ overall: 0.9, subs: [0.8, 0.75] }, cfg).label).toBe("sufficient");
    expect(statusLabel({ overall: 0.9, subs: [0.8, 0.2] }, cfg).label).toBe("partial");
    expect(statusLabel({ overall: 0.2, subs: [0.1] }, cfg).label).toBe("insufficient");
    expect(statusLabel(null, cfg).label).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
describe("judge request shapes", () => {
  const ctx = {
    question: "How is the threshold computed?",
    subQuestions: ["Where is it checked?"],
  };
  test("file request: one Noul per file, criteria stated once in the state, question inlined", () => {
    const { state, questions } = buildFileRequest(
      [
        { id: "f000", path: "src/a.ts", descriptor: "src/a.ts\n  3: x", lex: 1 },
        { id: "f001", path: "src/b.ts", descriptor: "src/b.ts", lex: 0.5 },
      ],
      ctx,
      cfg,
    );
    expect(Object.keys(questions)).toEqual(["f000", "f001"]);
    expect((state as any).criteria).toEqual(PROMPTS.fileCriteria);
    expect(questions.f000!.instructions as string).toContain('"How is the threshold computed?"');
    expect(questions.f000!.instructions as string).toContain("src/a.ts");
  });
  test("passage request: relevance + coverage Nouls with explicit criteria", () => {
    const p: PassageItem = {
      id: "p001",
      path: "src/a.ts",
      start: 3,
      end: 9,
      text: "3| x",
      lex: 0.5,
      lexCov: [0.2],
    };
    const { questions } = buildPassageRequest([p], ctx, cfg);
    expect(Object.keys(questions).sort()).toEqual(["cov::p001::0", "rel::p001"]);
    expect(questions["rel::p001"]!.criteria).toEqual(PROMPTS.passageCriteria);
    expect(questions["cov::p001::0"]!.instructions as string).toContain("Where is it checked?");
  });
  test("chunkPassages respects count and char caps", () => {
    const mk = (id: string, n: number): PassageItem => ({
      id,
      path: "a",
      start: 1,
      end: 2,
      text: "x".repeat(n),
      lex: 0,
      lexCov: [],
    });
    const chunks = chunkPassages(
      [
        mk("a", 10),
        mk("b", 10),
        mk("c", 10),
        mk("d", 10),
        mk("e", 10),
        mk("f", 20000),
        mk("g", 20000),
      ],
      4,
      24000,
    );
    expect(chunks.map((c) => c.map((p) => p.id).join(""))).toEqual(["abcd", "ef", "g"]);
  });
});
