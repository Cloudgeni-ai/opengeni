/** Short or unreadable files, ripgrep exit 2 without output, and patterns over the adapter's length cap. */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  CODE_SEARCH_MAX_PATTERN_CHARS,
  CodeSearchWorkspaceError,
  codeSearchConfig,
  runCodeSearch,
  type CodeSearchWorkspace,
} from "../src";
import { definitionPattern, definitionPatterns, locateDefinitions } from "../src/code-search/leads";
import {
  excludeArgs,
  packAlternatives,
  recall,
  ripgrepPatternCompiles,
  searchAlternatives,
  searchPattern,
  splitAlternation,
} from "../src/code-search/recall";
import { WorkspaceSession } from "../src/code-search/session";
import {
  blockEnd,
  buildFileWindows,
  definitionWindow,
  enclosingWindow,
  nearestEnclosingLabel,
} from "../src/code-search/windows";
import { FIXTURE_FILES, fakeJevClient, makeFixtureRepo, packPassages } from "./helpers/fixture";
import { LocalCodeSearchWorkspace } from "./helpers/local-workspace";

// These run the real ripgrep binary; skip them where it is not installed.
const describeWithRipgrep = Bun.which("rg") ? describe : describe.skip;

const cfg = codeSearchConfig();
const roots: string[] = [];
function repo(files: Record<string, string | Uint8Array>): string {
  const root = makeFixtureRepo(files);
  roots.push(root);
  return root;
}
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function session(ws: CodeSearchWorkspace): WorkspaceSession {
  return new WorkspaceSession(ws, new AbortController().signal, 30_000);
}

/** The `-e` patterns the engine sent to ripgrep. */
function patternsSent(ws: LocalCodeSearchWorkspace): string[] {
  return ws.calls.flatMap((c) => {
    const i = c.args.indexOf("-e");
    return c.kind === "ripgrep" && i >= 0 ? [c.args[i + 1]!] : [];
  });
}

/** A workspace whose readText cuts the named files to their first N lines. */
function shortReads(inner: CodeSearchWorkspace, cut: Record<string, number>): CodeSearchWorkspace {
  return {
    ripgrep: (args, o) => inner.ripgrep(args, o),
    pathKinds: (paths, o) => inner.pathKinds(paths, o),
    readText: async (path, o) => {
      const r = await inner.readText(path, o);
      const n = cut[path];
      return r && n !== undefined ? { ...r, text: r.text.split("\n").slice(0, n).join("\n") } : r;
    },
  };
}

const LIMIT_FILES: Record<string, string> = {
  "src/limit.ts": [
    "// Limit computation.",
    "export function computeLimit(x: number): number {",
    "  return helperThresholdValue(x) * 2;",
    "}",
    "",
  ].join("\n"),
  "src/helpers.ts": [
    "// Helpers.",
    'import { base } from "./base";',
    "",
    "export function helperThresholdValue(x: number): number {",
    "  return base(x) + 1;",
    "}",
    "",
  ].join("\n"),
  "src/other.ts": [
    "// Callers.",
    'import { computeLimit } from "./limit";',
    "",
    "export function doubled(x: number): number {",
    "  return computeLimit(x) * 2;",
    "}",
    "",
  ].join("\n"),
};

describeWithRipgrep("lines past the end of the file as read", () => {
  test("the window helpers treat out-of-range lines as blank instead of throwing", () => {
    expect(() => definitionWindow([], 4, "sql", cfg)).not.toThrow();
    expect(() => definitionWindow(["-- a", "x"], 9, "brace", cfg)).not.toThrow();
    expect(() => enclosingWindow(["const a = 1;"], 5, "brace", cfg)).not.toThrow();
    expect(nearestEnclosingLabel(["def f():", "  x"], 7, "indent")).toEqual({
      line: 1,
      text: "def f():",
    });
    for (const lang of ["brace", "indent", "markdown", "sql"] as const) {
      expect(blockEnd(["x"], 3, lang)).toBeNull();
    }
  });

  test("buildFileWindows drops hits past the end and keeps the in-range ones", () => {
    const lines = ["export function f() {", "  return target;", "}"];
    const kws = [
      {
        index: 0,
        raw: "target",
        variants: ["target"],
        mode: "phrase" as const,
        pattern: "target",
        rgPattern: "target",
        df: 1,
        pathDf: 0,
        hitLines: 2,
        idf: 1,
        fragments: [],
      },
    ];
    const ws = buildFileWindows(
      lines,
      [
        { line: 2, text: "  return target;", kws: [0] },
        { line: 40, text: "target", kws: [0] },
      ],
      kws,
      "brace",
      cfg,
    );
    expect(ws.map((w) => [w.start, w.end, w.hits])).toEqual([[1, 3, [2]]]);
    expect(
      buildFileWindows(lines, [{ line: 40, text: "target", kws: [0] }], kws, "brace", cfg),
    ).toEqual([]);
  });

  test("a lead defined in a file that reads as null (UTF-16) is skipped, not a crash", async () => {
    const sql = [
      "-- SQL helpers.",
      "",
      "-- Doubles the input.",
      "CREATE FUNCTION helper_threshold_value(x int) RETURNS int AS $$",
      "  SELECT x * 2;",
      "$$ LANGUAGE sql;",
      "",
    ].join("\n");
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(sql, "utf16le")]);
    const root = repo({
      "src/limit.ts": [
        "// Limit computation.",
        "export async function computeLimit(db: Db, x: number): Promise<number> {",
        '  const row = await db.query("SELECT helper_threshold_value($1) AS v", [x]);',
        "  return row.v;",
        "}",
        "",
      ].join("\n"),
      "db/functions.sql": new Uint8Array(utf16),
    });
    const events: Array<[string, Record<string, unknown>]> = [];
    const r = await runCodeSearch({
      question: "How is the limit computed?",
      keywords: ["computeLimit"],
      workspace: new LocalCodeSearchWorkspace(root),
      jev: fakeJevClient({ good: ["computeLimit", "helper_threshold_value"] }),
      onStage: (stage, data) => events.push([stage, data]),
    });
    // ripgrep transcodes UTF-16 and finds the definition; readText sees NUL bytes and returns null
    const leads = events.find(([stage]) => stage === "leads")![1];
    expect(leads.followed).toEqual([
      {
        name: "helper_threshold_value",
        score: 0.9,
        def: "db/functions.sql:4 (not in the file as read)",
      },
    ]);
    expect(packPassages(r.text).map((p) => p.path)).toEqual(["src/limit.ts"]);
  });

  test("files read shorter than ripgrep saw them: hits and lead definitions past the end are skipped", async () => {
    const root = repo(LIMIT_FILES);
    const events: Array<[string, Record<string, unknown>]> = [];
    const r = await runCodeSearch({
      question: "How is the limit computed?",
      keywords: ["computeLimit"],
      // the lead definition is at src/helpers.ts:4 and the hits at src/other.ts:2 and :5
      workspace: shortReads(new LocalCodeSearchWorkspace(root), {
        "src/helpers.ts": 2,
        "src/other.ts": 1,
      }),
      jev: fakeJevClient({ good: ["computeLimit", "helperThresholdValue"] }),
      onStage: (stage, data) => events.push([stage, data]),
    });
    const leads = events.find(([stage]) => stage === "leads")![1];
    expect(leads.followed).toEqual([
      {
        name: "helperThresholdValue",
        score: 0.9,
        def: "src/helpers.ts:4 (not in the file as read)",
      },
    ]);
    expect(packPassages(r.text).map((p) => p.path)).toEqual(["src/limit.ts"]);
    // read in full, the same search follows the lead and windows both files
    const full = await runCodeSearch({
      question: "How is the limit computed?",
      keywords: ["computeLimit"],
      workspace: new LocalCodeSearchWorkspace(root),
      jev: fakeJevClient({ good: ["computeLimit", "helperThresholdValue"] }),
    });
    expect(
      packPassages(full.text)
        .map((p) => p.path)
        .sort(),
    ).toEqual(["src/helpers.ts", "src/limit.ts", "src/other.ts"]);
  });
});

describeWithRipgrep("ripgrep exit 2 without output", () => {
  test("a search with no match in a workspace with an unreadable directory finds nothing", async () => {
    const root = repo(FIXTURE_FILES);
    const locked = join(root, "locked");
    mkdirSync(locked);
    chmodSync(locked, 0o000);
    try {
      const r = await runCodeSearch({
        question: "How is Kafka configured?",
        keywords: ["kafkaBroker", "KAFKA_URL"],
        workspace: new LocalCodeSearchWorkspace(root),
        jev: fakeJevClient(),
      });
      expect(r.status.label).toBe("insufficient");
      expect(r.text).toContain("Keywords with zero hits: kafkaBroker, KAFKA_URL");
      const found = await runCodeSearch({
        question: "How is the compaction threshold computed?",
        keywords: ["compactionThresholdTokens"],
        workspace: new LocalCodeSearchWorkspace(root),
        jev: fakeJevClient(),
      });
      expect(packPassages(found.text).map((p) => p.path)).toContain("src/compaction.ts");
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  test("exit 2 without output from every listing and search is no match, not a workspace error", async () => {
    const ws: CodeSearchWorkspace = {
      ripgrep: async () => ({ stdout: "", exitCode: 2, truncated: false, timedOut: false }),
      readText: async () => null,
      pathKinds: async () => ({}),
    };
    const r = await runCodeSearch({
      question: "How is the compaction threshold computed?",
      keywords: ["compactionThresholdTokens", "clampRatio"],
      workspace: ws,
      jev: fakeJevClient(),
    });
    expect(r.status.label).toBe("insufficient");
    expect(r.stats.candidates).toBe(0);
  });

  test("an invalid pattern still fails", async () => {
    expect(ripgrepPatternCompiles("(?-u:\\b)turn|compaction\\s+threshold")).toBe(true);
    expect(ripgrepPatternCompiles(definitionPattern(["clampRatio", "MIN_RATIO"]))).toBe(true);
    expect(ripgrepPatternCompiles("(?:a|b")).toBe(false);
    const root = repo(FIXTURE_FILES);
    const s = session(new LocalCodeSearchWorkspace(root));
    await expect(searchPattern(s, "(?:a|b", ["."], cfg)).rejects.toBeInstanceOf(
      CodeSearchWorkspaceError,
    );
  });
});

describeWithRipgrep("patterns over the adapter's length cap", () => {
  test("splitAlternation splits only at top-level bars", () => {
    expect(splitAlternation("a|b")).toEqual(["a", "b"]);
    expect(splitAlternation("(?:a|b)|c")).toEqual(["(?:a|b)", "c"]);
    expect(splitAlternation("a\\|b|c")).toEqual(["a\\|b", "c"]);
    expect(splitAlternation("[|(]x|d")).toEqual(["[|(]x", "d"]);
    expect(splitAlternation("a\\\\|x")).toEqual(["a\\\\", "x"]);
    expect(splitAlternation("single")).toEqual(["single"]);
  });

  test("packAlternatives fills patterns in order up to the cap", () => {
    expect(packAlternatives(["aa", "bb", "cc"], 7)).toEqual(["aa|bb", "cc"]);
    expect(packAlternatives(["aa", "bb", "cc"], 8)).toEqual(["aa|bb|cc"]);
    expect(packAlternatives(["aa", "b".repeat(20), "cc"], 8)).toEqual(["aa", "b".repeat(20), "cc"]);
    expect(packAlternatives(["aa", "bb"], 100)).toEqual(["aa|bb"]);
    expect(packAlternatives([], 100)).toEqual([]);
  });

  test("a split search returns exactly what one search over the union returns", async () => {
    const root = repo(FIXTURE_FILES);
    const alternatives = [
      "compactionThresholdTokens|compaction_threshold_tokens",
      "contextWindow|context_window",
      "(?-u:\\b)ratio",
      "clampRatio|MIN_RATIO|compactNow",
      "noSuchIdentifier",
    ];
    const one = new LocalCodeSearchWorkspace(root);
    const union = alternatives.map((p) => `(?:${p})`).join("|");
    const expected = await searchPattern(session(one), union, ["."], cfg);
    expect(new Set(expected.map((m) => m.path)).size).toBeGreaterThan(2);

    const split = new LocalCodeSearchWorkspace(root);
    const got = await searchAlternatives(session(split), alternatives, ["."], cfg, 32);
    expect(got).toEqual(expected);
    // packed in order up to 32 chars; the alternatives over 32 chars were split at their own bars
    expect(patternsSent(split).sort()).toEqual(
      [
        "(?:compactionThresholdTokens)",
        "(?:compaction_threshold_tokens)",
        "(?:contextWindow|context_window)",
        "(?:(?-u:\\b)ratio)|(?:clampRatio)",
        "(?:MIN_RATIO)|(?:compactNow)",
        "(?:noSuchIdentifier)",
      ].sort(),
    );

    // a part too long for any pattern is not searched
    const tooLong = new LocalCodeSearchWorkspace(root);
    const only = await searchAlternatives(
      session(tooLong),
      ["x".repeat(40), "clampRatio"],
      ["."],
      cfg,
      32,
    );
    expect(patternsSent(tooLong)).toEqual(["(?:clampRatio)"]);
    expect(only.map((m) => `${m.path}:${m.line}`)).toEqual([
      "src/compaction.ts:6",
      "src/compaction.ts:10",
    ]);

    // under the cap: the single union pattern, unchanged
    const unsplit = new LocalCodeSearchWorkspace(root);
    await searchAlternatives(session(unsplit), alternatives, ["."], cfg);
    expect(patternsSent(unsplit)).toEqual([union]);
  });

  test("recall with 20 keywords of 120 characters", async () => {
    const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"];
    const keyword = (i: number) => {
      const n = String(i).padStart(2, "0");
      let k = "";
      for (let j = 0; k.length < 120; j++) k += `${words[j % words.length]}${n}${j} `;
      return k.slice(0, 119) + "z";
    };
    const keywords = Array.from({ length: 20 }, (_, i) => keyword(i));
    for (const k of keywords) expect(k.length).toBe(120);
    const snake = (k: string) => k.split(" ").join("_");
    const root = repo({
      ...FIXTURE_FILES,
      "src/errors.ts": [
        "// Error texts.",
        `export const A = "${keywords[3]}";`,
        `export const ${snake(keywords[11]!)} = 1;`,
        "",
      ].join("\n"),
      "docs/errors.md": ["# Errors", "", keywords[17], ""].join("\n"),
    });
    const ws = new LocalCodeSearchWorkspace(root);
    const r = await recall({
      session: session(ws),
      question: "Which error is raised?",
      keywords,
      pathPrefixes: [],
      config: cfg,
    });
    // the union did not fit one pattern (the local workspace rejects a pattern over the cap)
    expect(patternsSent(ws).length).toBeGreaterThan(1);
    for (const p of patternsSent(ws))
      expect(p.length).toBeLessThanOrEqual(CODE_SEARCH_MAX_PATTERN_CHARS);
    expect(r.keywords.filter((k) => k.df > 0).map((k) => k.index)).toEqual([3, 11, 17]);
    expect(r.candidates.map((c) => c.path).sort()).toEqual(["docs/errors.md", "src/errors.ts"]);
    const errors = r.candidates.find((c) => c.path === "src/errors.ts")!;
    expect([...errors.hitLines.keys()].sort()).toEqual([2, 3]);

    const search = await runCodeSearch({
      question: "Which error is raised?",
      keywords,
      workspace: new LocalCodeSearchWorkspace(root),
      jev: fakeJevClient({ good: [keywords[3]!] }),
    });
    expect(packPassages(search.text).map((p) => p.path)).toContain("src/errors.ts");
  });

  test("definition search over many long lead names", async () => {
    const names = Array.from(
      { length: 90 },
      (_, i) => `leadName${String(i).padStart(2, "0")}_${"abcdefghij".repeat(4)}`,
    );
    expect(definitionPattern(names).length).toBeGreaterThan(CODE_SEARCH_MAX_PATTERN_CHARS);
    const patterns = definitionPatterns(names);
    expect(patterns.length).toBe(2);
    for (const p of patterns) expect(p.length).toBeLessThanOrEqual(CODE_SEARCH_MAX_PATTERN_CHARS);
    const root = repo({
      // the first and last names fall in different patterns but share one line
      "src/leads.ts": [
        `export function ${names[0]}() { function ${names[89]}() {} }`,
        `export const ${names[45]} = 1;`,
        "",
      ].join("\n"),
    });
    const ws = new LocalCodeSearchWorkspace(root);
    const d = await locateDefinitions(session(ws), names, cfg, excludeArgs(cfg));
    expect(patternsSent(ws)).toEqual(patterns);
    expect(d.hits.map((h) => [h.name, h.line, h.kind])).toEqual([
      [names[0]!, 1, "decl"],
      [names[89]!, 1, "decl"],
      [names[45]!, 2, "decl"],
    ]);
    expect(d.fileCounts.get(names[0]!)).toBe(1);
    expect(d.fileCounts.get(names[1]!)).toBe(0);
  });

  test("a name too long for a pattern of its own gets no definition", async () => {
    const huge = `huge${"x".repeat(5000)}`;
    expect(definitionPatterns([huge])).toEqual([]);
    const root = repo({
      "src/a.ts": `export const ${huge} = 1;\nexport function clampRatio() {}\n`,
    });
    const ws = new LocalCodeSearchWorkspace(root);
    const d = await locateDefinitions(session(ws), [huge, "clampRatio"], cfg, excludeArgs(cfg));
    expect(d.hits.map((h) => h.name)).toEqual(["clampRatio"]);
    expect(d.fileCounts.get(huge)).toBe(0);
    expect(patternsSent(ws)).toEqual([definitionPattern(["clampRatio"])]);
  });
});
