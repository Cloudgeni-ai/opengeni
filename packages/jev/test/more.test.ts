import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { codeSearchConfig } from "../src";
import { chunkEven } from "../src/code-search/judge";
import {
  chooseDefinitions,
  extractLeads,
  locateDefinitions,
  packageOf,
} from "../src/code-search/leads";
import {
  diverseOrder,
  packBody,
  pathPrior,
  priorityOrder,
  type EvidencePassage,
} from "../src/code-search/pack";
import { attribute, excludeArgs, jsRegex, parseRgOutput } from "../src/code-search/recall";
import { statusEvidence } from "../src/code-search/search";
import { WorkspaceSession } from "../src/code-search/session";
import { isChangelogPath, questionMentionsHistory } from "../src/code-search/text";
import {
  buildFileWindows,
  cutLine,
  definitionWindow,
  renderLines,
  splitByChars,
  type Window,
} from "../src/code-search/windows";
import { makeFixtureRepo } from "./helpers/fixture";
import { LocalCodeSearchWorkspace } from "./helpers/local-workspace";

// These run the real ripgrep binary; skip them where it is not installed.
const describeWithRipgrep = Bun.which("rg") ? describe : describe.skip;

const cfg = codeSearchConfig();

function ev(
  id: string,
  path: string,
  rel: number,
  lines = 10,
  lineText = "const x = 1;",
): EvidencePassage {
  const fileLines = Array.from({ length: 400 }, (_, i) => `${lineText} // ${i + 1}`);
  return {
    id,
    path,
    start: 1,
    end: lines,
    fileLines,
    hits: [1],
    kind: "hit",
    rel,
    cov: [],
    lex: 0.5,
  };
}

describe("long lines and char caps", () => {
  test("cutLine keeps short lines, marks cuts, and keeps the region around a far match", () => {
    expect(cutLine("short", 100)).toBe("short");
    const head = cutLine("a".repeat(500), 100);
    expect(head).toBe(`${"a".repeat(100)} ...[line cut, 500 chars]`);
    const far = "x".repeat(3000) + " the NEEDLE sentence " + "y".repeat(3000);
    const c = cutLine(far, 400, [/needle/i]);
    expect(c).toContain("NEEDLE sentence");
    expect(c).toContain("...[cut]...");
    expect(c).toContain("[line cut, 6021 chars]");
    expect(c.length).toBeLessThan(500);
    // a match inside the head is served by the plain head cut
    expect(cutLine("NEEDLE" + "z".repeat(500), 100, [/needle/i]).startsWith("NEEDLE")).toBe(true);
  });
  test("splitByChars splits around hits into whole-line sub-windows under the cap", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1} ` + "p".repeat(90));
    const w: Window = {
      start: 1,
      end: 40,
      hits: [5, 30],
      kind: "hit",
      score: 0,
      label: { line: 1, text: "## H" },
    };
    const parts = splitByChars(lines, w, 1200, { maxLineChars: 400 });
    expect(parts.length).toBe(2);
    for (const p of parts) {
      expect(renderLines(lines, p.start, p.end, 400).length).toBeLessThanOrEqual(1200);
      expect(p.hits.length).toBe(1);
      expect(p.label?.text).toBe("## H");
    }
    expect(parts[0]!.start).toBeLessThanOrEqual(5);
    expect(parts[0]!.start).toBeGreaterThanOrEqual(2); // at most ctxUp=3 lines of context above
    expect(parts[1]!.start).toBeLessThanOrEqual(30);
    // under the cap: unchanged
    expect(splitByChars(lines, { ...w, end: 5 }, 100_000, { maxLineChars: 400 })).toEqual([
      { ...w, end: 5 },
    ]);
  });
  test("markdown windows over long single-line paragraphs stay under the prose cap", () => {
    const md = [
      "# Title",
      "",
      "## Section",
      ...Array.from(
        { length: 30 },
        (_, i) => `- bullet ${i} ` + "w".repeat(3000) + (i === 12 ? " KEYWORDX" : ""),
      ),
    ];
    const kws = [
      {
        index: 0,
        raw: "KEYWORDX",
        variants: ["KEYWORDX"],
        mode: "phrase" as const,
        pattern: "KEYWORDX",
        rgPattern: "KEYWORDX",
        df: 1,
        pathDf: 0,
        hitLines: 1,
        idf: 2,
        fragments: [],
      },
    ];
    const ro = { maxLineChars: cfg.wave2.maxProseLineChars, needles: [/KEYWORDX/i] };
    const ws = buildFileWindows(
      md,
      [{ line: 16, text: md[15]!, kws: [0] }],
      kws,
      "markdown",
      cfg,
      ro,
    );
    expect(ws.length).toBe(1);
    const text = renderLines(md, ws[0]!.start, ws[0]!.end, ro);
    expect(text.length).toBeLessThanOrEqual(cfg.wave2.maxProseWindowChars);
    expect(text).toContain("KEYWORDX");
    const dw = definitionWindow(md, 3, "markdown", cfg, ro);
    expect(renderLines(md, dw.start, dw.end, ro).length).toBeLessThanOrEqual(
      cfg.wave2.maxProseWindowChars,
    );
    expect(dw.start).toBe(3);
  });
});

describe("recall single pass", () => {
  test("parseRgOutput reads path\\0line:text rows and skips omitted long lines", () => {
    const out =
      "./a.ts\u00003:const x = 1;\nb/c.md\u000010:[Omitted long line with 2 matches]\nb/c.md\u000011:text: with colon\n";
    expect(parseRgOutput(out)).toEqual([
      { path: "a.ts", line: 3, text: "const x = 1;" },
      { path: "b/c.md", line: 11, text: "text: with colon" },
    ]);
  });
  test("attribute assigns each line to every keyword slot whose regex matches", () => {
    const m = [
      { path: "a", line: 1, text: "compactionThreshold and context_window" },
      { path: "a", line: 2, text: "return turn" },
    ];
    const slots = [
      {
        ki: 0,
        fragment: false,
        re: jsRegex("compactionThreshold|compaction_threshold"),
        literals: [],
      },
      { ki: 1, fragment: false, re: jsRegex("contextWindow|context_window"), literals: [] },
      { ki: 2, fragment: false, re: jsRegex("\\bturn"), literals: [] },
      { ki: 3, fragment: false, re: jsRegex("\\bret\\b"), literals: [] },
    ];
    const r = attribute(m, slots);
    expect(r.map((x) => x.map((y) => y.line))).toEqual([[1], [1], [2], []]);
  });
  test("keyword patterns with regex metacharacters compile in both dialects", () => {
    for (const k of [
      "foo(bar)",
      "a.b",
      "x|y",
      "[x]",
      "$HOME",
      "c++",
      "#hash",
      "a&b",
      "~t",
      "-dash",
      "x{2}",
    ]) {
      const re = jsRegex(k.replace(/[\\.+*?()|[\]{}^$#&\-~]/g, (m) => `\\${m}`));
      expect(re).not.toBeNull();
      expect(re!.test(`prefix ${k} suffix`)).toBe(true);
    }
  });
});

describe("judge helpers", () => {
  test("chunkEven balances groups", () => {
    expect(
      chunkEven(
        Array.from({ length: 69 }, (_, i) => i),
        60,
      ).map((c) => c.length),
    ).toEqual([35, 34]);
    expect(
      chunkEven(
        Array.from({ length: 60 }, (_, i) => i),
        60,
      ).map((c) => c.length),
    ).toEqual([60]);
    expect(chunkEven([], 60)).toEqual([]);
  });
  test("statusEvidence takes whole blocks, best first, under the cap", () => {
    const text = statusEvidence(
      [
        { block: "A".repeat(50), rel: 0.5 },
        { block: "B".repeat(50), rel: 0.9 },
        { block: "C".repeat(80), rel: 0.8 },
      ],
      110,
    );
    expect(text).toBe("B".repeat(50) + "\n\n" + "A".repeat(50));
  });
});

describeWithRipgrep("definition search on the fixture repo", () => {
  let root = "";
  beforeAll(() => {
    root = makeFixtureRepo();
  });
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });
  test("locateDefinitions: one pass, declarations beat keys, file counts for genericity", async () => {
    const session = new WorkspaceSession(
      new LocalCodeSearchWorkspace(root),
      new AbortController().signal,
      30_000,
    );
    const d = await locateDefinitions(
      session,
      ["clampRatio", "MIN_RATIO", "compactNow", "tokens", "notDefinedAnywhere"],
      cfg,
      excludeArgs(cfg),
    );
    const by = (n: string) => d.hits.filter((h) => h.name === n);
    expect(by("clampRatio")[0]).toMatchObject({
      path: "src/compaction.ts",
      line: 10,
      kind: "decl",
    });
    expect(by("MIN_RATIO")[0]).toMatchObject({ path: "src/compaction.ts", line: 16, kind: "decl" });
    expect(by("compactNow")[0]).toMatchObject({ path: "src/turn.ts", kind: "decl" });
    expect(by("tokens")[0]).toMatchObject({ path: "src/turn.ts", line: 4, kind: "key" }); // interface field
    expect(by("notDefinedAnywhere")).toEqual([]);
    expect(d.fileCounts.get("clampRatio")).toBe(1);
    expect(d.fileCounts.get("notDefinedAnywhere")).toBe(0);
  });
  test("a failed definition search yields no hits instead of failing the search", async () => {
    const failing = new WorkspaceSession(
      {
        ripgrep: async () => ({ stdout: "", exitCode: 2, truncated: false, timedOut: false }),
        readText: async () => null,
        pathKinds: async () => ({}),
      },
      new AbortController().signal,
      30_000,
    );
    const d = await locateDefinitions(failing, ["clampRatio"], cfg, excludeArgs(cfg));
    expect(d.hits).toEqual([]);
  });
});

describe("lead extraction", () => {
  test("SQL keywords followed by a parenthesis are not leads; SQL function calls are", () => {
    const seeds = [
      {
        path: "db/0001.sql",
        start: 1,
        rel: 0.9,
        lines: [
          "ALTER TABLE t ADD CONSTRAINT c CHECK (x > 0);",
          "SELECT resolve_session_owner(s.id) WHERE EXISTS (SELECT 1);",
        ],
      },
    ];
    const names = extractLeads(seeds, new Set(), new Set(), 10).map((l) => l.name);
    expect(names).toContain("resolve_session_owner");
    expect(names).not.toContain("CHECK");
    expect(names).not.toContain("EXISTS");
  });
});

describe("definition choice", () => {
  test("locality beats kind: the lead's own file, then its package", () => {
    const hits = [
      {
        name: "search",
        path: "apps/api/src/routes/sessions.ts",
        line: 10,
        kind: "decl" as const,
        text: "function search(",
      },
      {
        name: "search",
        path: "packages/runtime/src/other.ts",
        line: 5,
        kind: "method" as const,
        text: "search(q) {",
      },
      {
        name: "search",
        path: "packages/runtime/src/lazy.ts",
        line: 7,
        kind: "method" as const,
        text: "search(q) {",
      },
    ];
    const seen = new Map([["search", "packages/runtime/src/lazy.ts"]]);
    expect(chooseDefinitions(hits, new Set(), 1, false, seen).get("search")![0]!.path).toBe(
      "packages/runtime/src/lazy.ts",
    );
    const seen2 = new Map([["search", "packages/runtime/src/index.ts"]]);
    expect(chooseDefinitions(hits, new Set(), 1, false, seen2).get("search")![0]!.path).toBe(
      "packages/runtime/src/lazy.ts",
    );
    expect(chooseDefinitions(hits, new Set(), 1).get("search")![0]!.path).toBe(
      "apps/api/src/routes/sessions.ts",
    );
    expect(packageOf("apps/worker/src/x.ts")).toBe("apps/worker");
    expect(packageOf("docs/x.md")).toBe("docs");
  });
});

describe("paths", () => {
  test("release notes are recognised; history questions switch the down-weighting off", () => {
    expect(isChangelogPath("packages/core/CHANGELOG.md")).toBe(true);
    expect(isChangelogPath(".changeset/brave-dogs-run.md")).toBe(true);
    expect(isChangelogPath("docs/changelog-policy/x.ts")).toBe(false);
    expect(questionMentionsHistory("Which version changed the compaction threshold?")).toBe(true);
    expect(questionMentionsHistory("How is the compaction threshold computed?")).toBe(false);
  });
  test("pathPrior: changelog < doc < code; tests only when configured", () => {
    const c = codeSearchConfig({ pack: { changelogPrior: 0.5, docPrior: 0.85, testPrior: 0.8 } });
    const o = { cfg: c };
    expect(pathPrior("CHANGELOG.md", o)).toBe(0.5);
    expect(pathPrior("docs/a.md", o)).toBe(0.85);
    expect(pathPrior("src/a.test.ts", o)).toBe(0.8);
    expect(pathPrior("src/a.ts", o)).toBe(1);
    expect(pathPrior("CHANGELOG.md", { ...o, downweightChangelogs: false })).toBe(1);
    expect(pathPrior("src/a.test.ts", { ...o, downweightTests: false })).toBe(1);
  });
});

describe("pack ordering", () => {
  test("diverseOrder: a second passage of a file must beat another file's first by the penalty", () => {
    const a1 = ev("a1", "a.ts", 0.95);
    const a2 = ev("a2", "a.ts", 0.94);
    const b1 = ev("b1", "b.ts", 0.9);
    expect(diverseOrder([a1, a2, b1], (x) => x.rel, 0, new Map()).map((x) => x.id)).toEqual([
      "a1",
      "a2",
      "b1",
    ]);
    expect(diverseOrder([a1, a2, b1], (x) => x.rel, 0.1, new Map()).map((x) => x.id)).toEqual([
      "a1",
      "b1",
      "a2",
    ]);
  });
  test("priorityOrder applies the changelog prior to ordering but not to the inclusion floor", () => {
    const c = codeSearchConfig({ pack: { changelogPrior: 0.5, filePenalty: 0 } });
    const order = priorityOrder([ev("cl", "CHANGELOG.md", 0.99), ev("code", "src/a.ts", 0.8)], {
      subQuestions: [],
      T2: 0.5,
      cfg: c,
    }).map((x) => x.id);
    expect(order).toEqual(["code", "cl"]);
  });
  test("maxPassageChars trims long passages around their hits (only when >= minTrimLines lines fit)", () => {
    const c = codeSearchConfig({ pack: { maxPassageChars: 1200 } });
    const long = { ...ev("p", "src/a.ts", 0.9, 200, "const a = f(b);"), hits: [100] };
    const wide = {
      ...ev(
        "w",
        "src/b.ts",
        0.9,
        200,
        "export const someLongIdentifierName = computeSomething(argumentOne, argumentTwo);",
      ),
      hits: [100],
    };
    expect(
      packBody([wide], { subQuestions: [], T2: 0.5, bodyChars: 100_000, cfg: c }).included[0]!
        .trimmed,
    ).toBe(false);
    const p = packBody([long], { subQuestions: [], T2: 0.5, bodyChars: 100_000, cfg: c })
      .included[0]!;
    expect(p.trimmed).toBe(true);
    expect(p.block.length).toBeLessThanOrEqual(1200);
    expect(p.start).toBeLessThanOrEqual(100);
    expect(p.end).toBeGreaterThanOrEqual(100);
  });
});
