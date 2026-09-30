/**
 * Unit tests for the scout-0.4 additions: symbol discovery (symbols.ts), keyword vocabulary notes (vocab.ts),
 * whole-file tiling and coverage outlines (windows.ts), the adaptive pack and its footer (pack.ts) and the
 * symbol judge request (judge.ts).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { codeSearchConfig, JevClient } from "../src";
import { buildSymbolRequest, JevJudge, PROMPTS, type LeadItem } from "../src/code-search/judge";
import {
  complementRanges,
  fmtRanges,
  inclusionRel,
  isImportOnly,
  mergeRanges,
  packBody,
  priorityOrder,
  renderFooter,
  renderWhole,
  type CoverageFile,
  type EvidencePassage,
  type FooterInput,
  type PackOptions,
} from "../src/code-search/pack";
import { recall } from "../src/code-search/recall";
import { WorkspaceSession } from "../src/code-search/session";
import {
  extractSymbols,
  importNames,
  locateUsages,
  MAX_SYMBOL_LINE,
  specificName,
  symbolCandidates,
  usagePatterns,
  type SymbolSourceFile,
} from "../src/code-search/symbols";
import { keywordNotes, keywordStems, stemRegex } from "../src/code-search/vocab";
import { declName, outlineRanges, tileFile, type Window } from "../src/code-search/windows";
import { makeFixtureRepo } from "./helpers/fixture";
import { LocalCodeSearchWorkspace } from "./helpers/local-workspace";

// These run the real ripgrep binary; skip them where it is not installed.
const describeWithRipgrep = Bun.which("rg") ? describe : describe.skip;

const cfg = codeSearchConfig();

const roots: string[] = [];
function repo(files: Record<string, string>): string {
  const root = makeFixtureRepo(files);
  roots.push(root);
  return root;
}
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
function session(root: string): WorkspaceSession {
  return new WorkspaceSession(
    new LocalCodeSearchWorkspace(root),
    new AbortController().signal,
    30_000,
  );
}

const occ = (lines: string[]) => extractSymbols(lines).map((o) => [o.name, o.kind, o.line]);

// ---------------------------------------------------------------------------
describe("extractSymbols / importNames", () => {
  test("a multi-line import list yields each imported name (renames by their local name) on the import line", () => {
    const lines = [
      "import {",
      "  useArtifactCatalog,",
      "  formatSize as fmtSize,",
      "  type ArtifactRecord,",
      '} from "./catalog";',
      "const total = computeTotal(1);",
    ];
    const s = extractSymbols(lines);
    expect(s.filter((o) => o.kind === "import").map((o) => [o.name, o.line, o.from])).toEqual([
      ["useArtifactCatalog", 1, "./catalog"],
      ["fmtSize", 1, "./catalog"],
      ["ArtifactRecord", 1, "./catalog"],
    ]);
    // the block is consumed; scanning resumes after it
    expect(s.some((o) => o.name === "formatSize")).toBe(false);
    expect(s.find((o) => o.name === "computeTotal")).toMatchObject({ kind: "call", line: 6 });
  });

  test("a function with a destructured parameter list is a declaration, not an import", () => {
    const lines = [
      "export function ArtifactList({ items, onLoadMore }) {",
      "  return <ArtifactRow item={items[0]} onMore={onLoadMore} />;",
      "}",
    ];
    const s = extractSymbols(lines);
    expect(s.filter((o) => o.kind === "import")).toEqual([]);
    expect(s.find((o) => o.name === "ArtifactList" && o.kind === "decl")?.line).toBe(1);
    expect(s.find((o) => o.name === "ArtifactRow" && o.kind === "jsx")?.line).toBe(2);
    // a multi-line destructured parameter list is not joined as an import block either
    const multi = extractSymbols([
      "export function ArtifactList({",
      "  items,",
      "  onLoadMore,",
      "}: Props) {",
      "  return null;",
      "}",
    ]);
    expect(multi.filter((o) => o.kind === "import")).toEqual([]);
    expect(multi.find((o) => o.name === "ArtifactList")?.kind).toBe("decl");
  });

  test("Python from-imports and Rust use lists", () => {
    expect(occ(["from pkg.mod import alpha_one, beta_two"])).toEqual([
      ["alpha_one", "import", 1],
      ["beta_two", "import", 1],
    ]);
    expect(importNames("from pkg import (alpha_one, beta_two as bt)").map((x) => x.name)).toEqual([
      "alpha_one",
      "bt",
    ]);
    const rs = importNames("use crate::store::{Reader, Writer};").map((x) => x.name);
    expect(rs).toContain("Reader");
    expect(rs).toContain("Writer");
    expect(importNames("use crate::store::Reader;").map((x) => x.name)).toEqual(["Reader"]);
  });

  // BUG (src/code-search/symbols.ts importNames): a Rust brace list matches both the generic `{...}` branch and
  // the `use` branch, so every name is returned twice and counted twice in symbolCandidates' occurrence weight.
  // importNames("use crate::store::{Reader, Writer};") -> Reader, Writer, Reader, Writer
  test("importNames returns each name of a Rust use-list once", () => {
    expect(importNames("use crate::store::{Reader, Writer};").map((x) => x.name)).toEqual([
      "Reader",
      "Writer",
    ]);
  });

  test("TS default + named imports, type-only names, require destructuring", () => {
    expect(importNames('import Default, { a1, type Bee, c1 as d1 } from "m"')).toEqual([
      { name: "a1", from: "m" },
      { name: "Bee", from: "m" },
      { name: "d1", from: "m" },
      { name: "Default", from: "m" },
    ]);
    expect(importNames('const { readFile, writeFile } = require("node:fs")')).toEqual([
      { name: "readFile", from: "node:fs" },
      { name: "writeFile", from: "node:fs" },
    ]);
  });

  test("calls, member calls and JSX are told apart; comment lines are skipped", () => {
    const s = extractSymbols([
      "const rows = loadRows(query);",
      "client.fetchItems(1);",
      "// commentedCall(1)",
      " * docCall(2)",
      "# pyComment(3)",
      "-- sqlComment(4)",
      "<ArtifactPanel open />",
    ]);
    expect(s.find((o) => o.name === "loadRows")?.kind).toBe("call");
    expect(s.filter((o) => o.name === "fetchItems").map((o) => o.kind)).toEqual(["member"]);
    expect(s.find((o) => o.name === "ArtifactPanel")?.kind).toBe("jsx");
    for (const n of ["commentedCall", "docCall", "pyComment", "sqlComment"])
      expect(s.some((o) => o.name === n)).toBe(false);
    // keywords and names under 3 chars are never symbols
    expect(extractSymbols(["if (ok) return fn(x);"]).map((o) => o.name)).toEqual([]);
  });

  test("UPPER_SNAKE constants and PascalCase types", () => {
    const s = extractSymbols(["let n: ArtifactRecord = MAX_ITEMS;"]);
    expect(s.find((o) => o.name === "MAX_ITEMS")?.kind).toBe("constant");
    expect(s.find((o) => o.name === "ArtifactRecord")?.kind).toBe("type");
  });
});

describe("extractSymbols on long lines", () => {
  test("lines longer than MAX_SYMBOL_LINE are skipped", () => {
    const pad = " ".repeat(MAX_SYMBOL_LINE);
    expect(extractSymbols([`const longValue = loadRows(1);${pad}`])).toEqual([]);
    // a line of exactly MAX_SYMBOL_LINE chars is still read
    const exact = "const keptValue = loadRows(1);".padEnd(MAX_SYMBOL_LINE, " ");
    expect(exact.length).toBe(MAX_SYMBOL_LINE);
    expect(extractSymbols([exact]).map((o) => o.name)).toContain("loadRows");
    // the other lines of the file are unaffected
    const s = extractSymbols([`x(${"a".repeat(MAX_SYMBOL_LINE)})`, "const rows = loadRows(1);"]);
    expect(s.map((o) => [o.name, o.line])).toContainEqual(["loadRows", 2]);
  });
  test("a 200k-char minified line returns quickly", () => {
    const minified = "define(a):b".repeat(200_000 / 11);
    expect(minified.length).toBeGreaterThan(199_000);
    const t0 = performance.now();
    expect(extractSymbols([minified, "const rows = loadRows(1);"]).map((o) => o.name)).toContain(
      "loadRows",
    );
    expect(performance.now() - t0).toBeLessThan(200);
    // a long continuation line inside a multi-line import block is bounded too
    const t1 = performance.now();
    extractSymbols(["import {", `  ${"define(a):b,".repeat(200_000 / 12)}`, '} from "m";']);
    expect(performance.now() - t1).toBeLessThan(200);
  });
});

describe("specificName", () => {
  test("rejects generic locals and framework names, accepts compound, Pascal and UPPER names", () => {
    for (const n of ["items", "result", "load", "useState", "useEffect", "abc", "MAX"])
      expect(specificName(n)).toBe(false);
    for (const n of ["useArtifactCatalog", "ArtifactListRoute", "MAX_ITEMS", "load_rows"])
      expect(specificName(n)).toBe(true);
  });
});

describe("usagePatterns", () => {
  test("groups names into ASCII-word-bounded alternations under the char cap, dropping names that never fit", () => {
    expect(usagePatterns(["alphaOne", "betaTwo"])).toEqual([
      "(?-u:\\b)(?:alphaOne|betaTwo)(?-u:\\b)",
    ]);
    const names = Array.from({ length: 10 }, (_, i) => `someIdentifier${i}`);
    const pats = usagePatterns(names, 80);
    expect(pats.length).toBeGreaterThan(1);
    for (const p of pats) expect(p.length).toBeLessThanOrEqual(80);
    expect(pats.join("|").match(/someIdentifier\d/g)!.length).toBe(10);
    expect(usagePatterns(["x".repeat(100)], 80)).toEqual([]);
  });
});

describe("symbolCandidates", () => {
  const files: SymbolSourceFile[] = [
    {
      path: "src/list.tsx",
      p: 0.9,
      hitLines: [20],
      lines: [
        'import { useArtifactCatalog } from "./catalog";',
        "",
        "function formatRowLabel(x) {",
        "  return String(x);",
        "}",
        "",
        "export function ArtifactList({ items }) {",
        "  const cat = useArtifactCatalog();",
        "  const label = formatRowLabel(items.length);",
        "  const [open, setOpen] = useState(false);",
        "  return label;",
        "}",
      ],
    },
    {
      path: "src/page.tsx",
      p: 0.8,
      hitLines: [],
      lines: [
        'import { useArtifactCatalog } from "./catalog";',
        "const data = useArtifactCatalog();",
      ],
    },
  ];
  test("an imported name called across files outranks a local helper; generic names are skipped", () => {
    const c = symbolCandidates(files, new Set(), new Set());
    const names = c.map((x) => x.name);
    expect(names[0]).toBe("useArtifactCatalog");
    expect(names).toContain("formatRowLabel");
    for (const n of ["items", "useState", "label", "setOpen"]) expect(names).not.toContain(n);
    const hook = c.find((x) => x.name === "useArtifactCatalog")!;
    const local = c.find((x) => x.name === "formatRowLabel")!;
    expect(hook.weight).toBeGreaterThan(local.weight);
    expect(hook.files.sort()).toEqual(["src/list.tsx", "src/page.tsx"]);
    expect(hook.kinds).toContain("import");
    expect(hook.kinds).toContain("call");
    expect(hook.context).toBe(
      'imported from "./catalog" at src/list.tsx:1: import { useArtifactCatalog } from "./catalog";',
    );
    expect(hook.seenAt).toEqual({ path: "src/list.tsx", line: 1 });
    // sorted by weight
    for (let i = 1; i < c.length; i++)
      expect(c[i - 1]!.weight).toBeGreaterThanOrEqual(c[i]!.weight);
  });
  test("excluded names (exact or lowercased) are skipped; question words raise a name", () => {
    const ex = symbolCandidates(files, new Set(["useartifactcatalog"]), new Set()).map(
      (x) => x.name,
    );
    expect(ex).not.toContain("useArtifactCatalog");
    const base = symbolCandidates(files, new Set(), new Set()).find(
      (x) => x.name === "formatRowLabel",
    )!;
    const q = symbolCandidates(files, new Set(), new Set(["format", "row", "label"])).find(
      (x) => x.name === "formatRowLabel",
    )!;
    expect(q.weight).toBeGreaterThan(base.weight);
  });
});

describeWithRipgrep("locateUsages", () => {
  const many = Array.from({ length: 12 }, (_, i) => `  useArtifactCatalog(${i});`).join("\n");
  const root = repo({
    "src/catalog.ts": "export function useArtifactCatalog() {\n  return [];\n}\n",
    "src/list.tsx": [
      'import { useArtifactCatalog } from "./catalog";',
      "export function List() {",
      "  const data = useArtifactCatalog();",
      "  return <ArtifactListRoute rows={data} />;",
      "}",
    ].join("\n"),
    "src/route.tsx": "export const ArtifactListRoute = () => null;\n",
    "src/many.ts": `export function run() {\n${many}\n}\n`,
    "test/catalog.test.ts": "useArtifactCatalog();\n",
    "src/catalog.spec.ts": "useArtifactCatalog();\n",
    "docs/catalog.md": "Call useArtifactCatalog() to list artifacts.\n",
  });
  test("classifies definitions, imports and references; caps lines per file; skips prose and tests", async () => {
    const u = await locateUsages(
      session(root),
      ["useArtifactCatalog", "ArtifactListRoute"],
      cfg,
      [],
      false,
      5,
    );
    const at = (path: string) =>
      u.hits.filter((h) => h.path === path).map((h) => [h.name, h.line, h.kind]);
    expect(at("src/catalog.ts")).toEqual([["useArtifactCatalog", 1, "def"]]);
    expect(at("src/list.tsx")).toEqual([
      ["useArtifactCatalog", 1, "import"],
      ["useArtifactCatalog", 3, "ref"],
      ["ArtifactListRoute", 4, "ref"],
    ]);
    expect(at("src/route.tsx")).toEqual([["ArtifactListRoute", 1, "def"]]);
    expect(at("src/many.ts").length).toBe(5);
    expect(u.cappedFiles).toBe(1);
    expect([...u.files.get("useArtifactCatalog")!].sort()).toEqual([
      "src/catalog.ts",
      "src/list.tsx",
      "src/many.ts",
    ]);
    expect([...u.files.get("ArtifactListRoute")!].sort()).toEqual([
      "src/list.tsx",
      "src/route.tsx",
    ]);
    // hits are sorted by path, then line
    const keys = u.hits.map((h) => `${h.path}\0${String(h.line).padStart(6, "0")}`);
    expect(keys).toEqual([...keys].sort());
  });
  test("tests are included when allowed", async () => {
    const u = await locateUsages(session(root), ["useArtifactCatalog"], cfg, [], true);
    const files = [...u.files.get("useArtifactCatalog")!];
    expect(files).toContain("test/catalog.test.ts");
    expect(files).toContain("src/catalog.spec.ts");
    expect(files).not.toContain("docs/catalog.md");
    expect(u.cappedFiles).toBe(0);
  });
  test("no names: no search", async () => {
    const ws = new LocalCodeSearchWorkspace(root);
    const u = await locateUsages(
      new WorkspaceSession(ws, new AbortController().signal, 30_000),
      [],
      cfg,
      [],
      false,
    );
    expect(u).toEqual({ hits: [], files: new Map(), cappedFiles: 0, ms: 0 });
    expect(ws.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("keywordStems / stemRegex", () => {
  test("stems cut plural and verb endings and drop short or stop words", () => {
    expect(keywordStems("invalidateQueries")).toEqual(["invalidat", "quer"]);
    expect(keywordStems("useQuery")).toEqual(["quer"]);
    expect(keywordStems("loading_items")).toEqual(["load", "item"]);
    expect(keywordStems("v2")).toEqual([]);
  });
  test("stemRegex matches identifiers containing the stems in order, case-insensitively", () => {
    const re = stemRegex(keywordStems("invalidateQueries"))!;
    expect(re.test("invalidateArtifactQuery")).toBe(true);
    expect(re.test("INVALIDATE_QUERY_CACHE")).toBe(true);
    expect(re.test("queryInvalidate")).toBe(false);
    expect(stemRegex([])).toBeNull();
    // stems are escaped
    expect(stemRegex(["a.b"])!.test("axb")).toBe(false);
  });
  // BUG (src/code-search/vocab.ts keywordStems): `ies` -> `y` turns "queries" into the stem "query", which is not a
  // substring of "queries", so the ordered stem regex misses plural identifiers and even the keyword itself:
  // stemRegex(keywordStems("invalidateQueries")) = /invalidat[\w$]*query/i, and .test("invalidateQueries") is false.
  // (keywordNotes still finds such identifiers through the single-stem fallback, with a lower score.)
  test("the stem regex of a keyword matches the keyword and its plural identifiers", () => {
    const re = stemRegex(keywordStems("invalidateQueries"))!;
    expect(re.test("invalidateQueries")).toBe(true);
    expect(re.test("invalidateArtifactQueries")).toBe(true);
  });
});

describeWithRipgrep("keywordNotes", () => {
  const root = repo({
    "src/artifacts.ts": [
      "export function invalidateArtifactQueries(ids: string[]) {",
      "  return refreshArtifactList(ids);",
      "}",
      "export function refreshArtifactList(ids: string[]) {",
      "  return ids;",
      "}",
    ].join("\n"),
    "src/cache.ts": "export const staleTime = 5;\nexport const staleTimeout = 10;\n",
    "src/cache2.ts": "export const staleTime = 6;\n",
  });
  test("a zero-hit keyword gets real identifiers; one that matched only irrelevant files is reported with a file count", async () => {
    const s = session(root);
    const rec = await recall({
      session: s,
      question: "How are artifact queries invalidated?",
      keywords: ["invalidateQueries", "staleTime", "artifact"],
      pathPrefixes: [],
      config: cfg,
    });
    const notes = await keywordNotes({
      session: s,
      keywords: rec.keywords,
      candidates: rec.candidates,
      relevantFiles: new Set(["src/artifacts.ts"]),
      suggestFrom: ["src/artifacts.ts", "src/cache.ts", "src/cache2.ts"],
      cfg,
      excludeArgs: [],
    });
    const zero = notes.find((n) => n.raw === "invalidateQueries")!;
    expect(zero.status).toBe("zero");
    expect(zero.suggestions[0]).toBe("invalidateArtifactQueries");
    const irr = notes.find((n) => n.raw === "staleTime")!;
    expect(irr.status).toBe("irrelevant");
    expect(irr.files).toBe(2);
    // the keyword itself is never suggested
    expect(irr.suggestions).not.toContain("staleTime");
    expect(irr.suggestions).toContain("staleTimeout");
    // a keyword with hits in a relevant file gets no note
    expect(notes.some((n) => n.raw === "artifact")).toBe(false);
  });
  test("nothing to note: no ripgrep call", async () => {
    const ws = new LocalCodeSearchWorkspace(root);
    const s = new WorkspaceSession(ws, new AbortController().signal, 30_000);
    const rec = await recall({
      session: s,
      question: "q",
      keywords: ["artifact"],
      pathPrefixes: [],
      config: cfg,
    });
    const calls = ws.calls.length;
    const notes = await keywordNotes({
      session: s,
      keywords: rec.keywords,
      candidates: rec.candidates,
      relevantFiles: new Set(["src/artifacts.ts"]),
      suggestFrom: ["src/artifacts.ts"],
      cfg,
      excludeArgs: [],
    });
    expect(notes).toEqual([]);
    expect(ws.calls.length).toBe(calls);
  });
});

// ---------------------------------------------------------------------------
/** A function of `body` statement lines (no nested declarations) plus a blank line: body + 3 lines. */
const fn = (name: string, body: number) => [
  `export function ${name}(x: number): number {`,
  ...Array.from({ length: body }, (_, i) => `  x += ${i};`),
  "  return x;",
  "}",
  "",
];
const tiles = (ws: Window[]) => ws.map((w) => [w.start, w.end]);
function expectExactCover(ws: Window[], n: number) {
  let next = 1;
  for (const w of ws) {
    expect(w.start).toBe(next);
    expect(w.end).toBeGreaterThanOrEqual(w.start);
    next = w.end + 1;
  }
  expect(next).toBe(n + 1);
}

describe("tileFile", () => {
  test("covers every line exactly once and cuts at declaration boundaries", () => {
    const lines = [
      'import { a } from "a";',
      "",
      ...fn("alpha", 16),
      ...fn("beta", 16),
      ...fn("gamma", 16),
    ];
    const ws = tileFile(lines, [5, 30, 5], "brace", cfg);
    expectExactCover(ws, lines.length);
    // every tile after the first starts at a function declaration
    expect(ws.slice(1).map((w) => lines[w.start - 1])).toEqual([
      "export function beta(x: number): number {",
      "export function gamma(x: number): number {",
    ]);
    expect(ws.map((w) => w.hits)).toEqual([[5], [30], []]);
    expect(ws[1]!.label).toEqual({
      line: ws[1]!.start,
      text: "export function beta(x: number): number {",
    });
    expect(ws.every((w) => w.kind === "hit" && w.score === 0)).toBe(true);
  });

  test("leading comments stay with their declaration", () => {
    const lines = [...fn("alpha", 20), "/** Beta doc. */", "// more", ...fn("beta", 20)];
    const ws = tileFile(lines, [], "brace", cfg);
    expectExactCover(ws, lines.length);
    expect(lines[ws[1]!.start - 1]).toBe("/** Beta doc. */");
  });

  // BUG (src/code-search/windows.ts tileFile): any line isDeclLine accepts, including an indented `const` inside a
  // function body, ends a tile once it is tileTargetLines long. When a top-level declaration lands just before
  // the target, the next tile starts inside its body, separating the signature from its body. Input: a file
  // `import {a}`, blank, then alpha/beta/gamma each `export function NAME(x) {` + 15 lines `  const vI = x + I;`
  // + `  return x;` + `}` + blank (default config): tile 2 is 22-41 and ends ON gamma's signature (line 41); tile 3
  // starts at 42 with `  const v0 = x + 0;` and is labelled with that line instead of gamma.
  test("tileFile never ends a tile on a declaration line whose body continues in the next tile", () => {
    const f = (name: string) => [
      `export function ${name}(x: number): number {`,
      ...Array.from({ length: 15 }, (_, i) => `  const v${i} = x + ${i};`),
      "  return x;",
      "}",
      "",
    ];
    const lines = ['import { a } from "a";', "", ...f("alpha"), ...f("beta"), ...f("gamma")];
    for (const w of tileFile(lines, [], "brace", cfg))
      expect(lines[w.end - 1]).not.toMatch(/^export function/);
  });

  test("hard cut at maxWindowLines, preferring a blank line in the tile's last quarter", () => {
    const other = Array.from({ length: 400 }, (_, i) => `row ${i + 1}`);
    expect(tiles(tileFile(other, [], "other", cfg))).toEqual([
      [1, 150],
      [151, 300],
      [301, 400],
    ]);
    const withBlank = [...other];
    withBlank[129] = ""; // line 130
    const ws = tileFile(withBlank, [], "other", cfg);
    expect(ws[0]).toMatchObject({ start: 1, end: 130 });
    expectExactCover(ws, withBlank.length);
    expect(ws.every((w) => w.label === undefined)).toBe(true);
    const c = codeSearchConfig({ wave2: { maxWindowLines: 40 } });
    for (const w of tileFile(other, [], "other", c))
      expect(w.end - w.start + 1).toBeLessThanOrEqual(40);
  });

  test("tiles over the char cap are split into consecutive whole-line chunks", () => {
    const wide = Array.from({ length: 40 }, (_, i) => `const v${i} = "${"x".repeat(380)}";`);
    const ws = tileFile(wide, [3, 25], "brace", cfg);
    expectExactCover(ws, wide.length);
    expect(ws.length).toBeGreaterThan(1);
    for (const w of ws) {
      const chars = wide
        .slice(w.start - 1, w.end)
        .reduce((s, l, i) => s + `${w.start + i}| ${l}`.length + 1, 0);
      expect(chars).toBeLessThanOrEqual(cfg.wave2.maxWindowChars);
    }
    expect(ws.flatMap((w) => w.hits)).toEqual([3, 25]);
  });

  test("a tiny tail tile folds into its predecessor; blank-only tiles are dropped", () => {
    const lines = [...fn("alpha", 20), "export const tail = 1;", "export const tail2 = 2;"];
    const ws = tileFile(lines, [], "brace", cfg);
    expect(tiles(ws)).toEqual([[1, lines.length]]);
    expect(tileFile([], [], "brace", cfg)).toEqual([]);
    expect(tileFile(["", "  ", ""], [], "brace", cfg)).toEqual([]);
  });
});

describe("declName / outlineRanges", () => {
  test("declName reads the declared name", () => {
    expect(declName("export async function loadRows(a) {")).toBe("loadRows");
    expect(declName("  const rollback = async () => {")).toBe("rollback");
    expect(declName("  handleSave(item) {")).toBe("handleSave");
    expect(declName("## Threshold")).toBe("Threshold");
    expect(declName("  if (x) {")).toBeUndefined();
  });
  const file = [
    'import { useEffect } from "react";',
    "import {",
    "  formatSize,",
    '} from "./fmt";',
    "const MAX_ITEMS = 10;",
    "export function Panel({ id }) {",
    "  const count = 1;",
    "  const ctx = useAppContext();",
    "  const rollback = async () => {",
    "    await api.rollback(id);",
    "  };",
    "  useEffect(() => {",
    "    load();",
    "  }, []);",
    "  const cells = [",
    "    formatSize(x),",
    "  ];",
    "  function handleSave(x) {",
    "    return x;",
    "  }",
    "  return null;",
    "}",
    "class Store {",
    "  save(item) {",
    "  }",
    "}",
  ];
  test("names functions and handlers, not value consts, calls or imports; outermost first, capped", () => {
    expect(outlineRanges(file, "brace", [[1, file.length]], 20)).toEqual([
      { name: "Panel", line: 6 },
      { name: "rollback", line: 9 },
      { name: "handleSave", line: 18 },
      { name: "Store", line: 23 },
      { name: "save", line: 24 },
    ]);
    // capped: the outermost level (Panel, Store) wins, then the result is returned in line order
    expect(outlineRanges(file, "brace", [[1, file.length]], 3)).toEqual([
      { name: "Panel", line: 6 },
      { name: "rollback", line: 9 },
      { name: "Store", line: 23 },
    ]);
    expect(outlineRanges(file, "brace", [[1, file.length]], 2)).toEqual([
      { name: "Panel", line: 6 },
      { name: "Store", line: 23 },
    ]);
  });
  test("only the given ranges are scanned; other languages and max <= 0 give nothing", () => {
    expect(outlineRanges(file, "brace", [[7, 20]], 20).map((d) => d.name)).toEqual([
      "rollback",
      "handleSave",
    ]);
    expect(
      outlineRanges(
        file,
        "brace",
        [
          [1, 5],
          [23, 99],
        ],
        20,
      ).map((d) => d.name),
    ).toEqual(["Store", "save"]);
    expect(outlineRanges(file, "other", [[1, file.length]], 20)).toEqual([]);
    expect(outlineRanges(file, "brace", [[1, file.length]], 0)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("isImportOnly / inclusionRel", () => {
  test("import blocks (including multi-line lists) are import-only; code is not", () => {
    expect(isImportOnly(['import { a } from "a";', 'import b from "b";'])).toBe(true);
    expect(
      isImportOnly(["import {", "  alpha,", "  beta,", '} from "./x";', 'import c from "c";']),
    ).toBe(true);
    expect(
      isImportOnly(["from x import a", "use crate::y::{b, c};", 'const z = require("z");']),
    ).toBe(true);
    expect(isImportOnly(['export { a } from "./a";', 'export type { B } from "./b";'])).toBe(true);
    expect(
      isImportOnly([
        "export function f({",
        "  alpha,",
        "  beta,",
        "}) {",
        "  return alpha + beta;",
        "}",
      ]),
    ).toBe(false);
    expect(isImportOnly(["const a = 1;", "const b = a + 1;", "return b;"])).toBe(false);
    // mostly code with one import
    expect(
      isImportOnly(['import { a } from "a";', "const b = a();", "const c = b();", "run(c);"]),
    ).toBe(false);
    // fewer than two code lines, and comments do not count
    expect(isImportOnly(['import { a } from "a";'])).toBe(false);
    expect(isImportOnly(["// import x", 'import { a } from "a";', "", "/* c */"])).toBe(false);
  });
  test("inclusionRel scales import-only passages by importPrior", () => {
    const x = { rel: 0.8, importOnly: true } as EvidencePassage;
    expect(inclusionRel(x, cfg)).toBeCloseTo(0.4);
    expect(inclusionRel({ ...x, importOnly: false }, cfg)).toBe(0.8);
  });
});

describe("ranges", () => {
  test("fmtRanges, mergeRanges, complementRanges", () => {
    expect(
      fmtRanges([
        [1, 3],
        [5, 5],
        [7, 9],
      ]),
    ).toBe("1-3, 5, 7-9");
    expect(
      mergeRanges([
        [10, 12],
        [1, 3],
        [4, 6],
        [11, 20],
        [30, 31],
      ]),
    ).toEqual([
      [1, 6],
      [10, 20],
      [30, 31],
    ]);
    expect(
      complementRanges(40, [
        [5, 10],
        [1, 2],
        [20, 40],
      ]),
    ).toEqual([
      [3, 4],
      [11, 19],
    ]);
    expect(complementRanges(10, [])).toEqual([[1, 10]]);
    expect(complementRanges(10, [[1, 10]])).toEqual([]);
    expect(complementRanges(0, [])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
const bigFile = Array.from(
  { length: 400 },
  (_, i) => `const v${i + 1} = ${i + 1}; // filler text for line ${i + 1}`,
);
const smallFile = Array.from({ length: 20 }, (_, i) => `const s${i + 1} = ${i + 1};`);
function ev(
  id: string,
  path: string,
  start: number,
  end: number,
  rel: number,
  cov: number[] = [],
  fileLines = bigFile,
): EvidencePassage {
  return { id, path, start, end, fileLines, hits: [start], kind: "hit", rel, cov };
}
const opts = (o: Partial<PackOptions> = {}): PackOptions => ({
  subQuestions: [],
  T2: 0.5,
  bodyChars: 100_000,
  cfg,
  ...o,
});

describe("priorityOrder: sub-question fallback and fillMin", () => {
  test("a weak sub-question gets its best subFallback passages at or above subFloor", () => {
    const ps = [
      ev("strong", "a.ts", 1, 10, 0.9, [0.9, 0.1]),
      ev("w1", "b.ts", 1, 10, 0.05, [0.1, 0.45]),
      ev("w2", "c.ts", 1, 10, 0.2, [0.1, 0.4]),
      ev("w3", "d.ts", 1, 10, 0.2, [0.1, 0.35]),
      ev("w4", "e.ts", 1, 10, 0.2, [0.1, 0.2]),
    ];
    const c = codeSearchConfig({ pack: { minPassages: 1 } });
    const order = priorityOrder(ps, { subQuestions: ["s1", "s2"], T2: 0.5, cfg: c }).map(
      (x) => x.id,
    );
    // w1 is below minRelevance but its coverage reaches subFloor
    expect(order).toEqual(["strong", "w1", "w2"]);
    const one = priorityOrder(ps, {
      subQuestions: ["s1", "s2"],
      T2: 0.5,
      cfg: codeSearchConfig({ pack: { minPassages: 1, subFallback: 1 } }),
    }).map((x) => x.id);
    expect(one).toEqual(["strong", "w1"]);
    // nothing reaches subFloor: no fallback
    const none = priorityOrder(
      ps.map((x) => ({ ...x, cov: [x.cov[0]!, Math.min(0.29, x.cov[1]!)] })),
      { subQuestions: ["s1", "s2"], T2: 0.5, cfg: c },
    ).map((x) => x.id);
    expect(none).toEqual(["strong"]);
  });
  test("a sub-question whose best passage reaches T2 takes only that passage", () => {
    const ps = [ev("a", "a.ts", 1, 10, 0.2, [0.7]), ev("b", "b.ts", 1, 10, 0.2, [0.45])];
    const order = priorityOrder(ps, {
      subQuestions: ["s1"],
      T2: 0.5,
      cfg: codeSearchConfig({ pack: { minPassages: 1 } }),
    }).map((x) => x.id);
    expect(order).toEqual(["a"]);
  });
  test("fillMin adds the passages at or above it after the T2 ones", () => {
    const ps = [
      ev("a", "a.ts", 1, 10, 0.9),
      ev("b", "b.ts", 1, 10, 0.35),
      ev("c", "c.ts", 1, 10, 0.32),
      ev("d", "d.ts", 1, 10, 0.2),
    ];
    const c = codeSearchConfig({ pack: { minPassages: 1 } });
    expect(priorityOrder(ps, { subQuestions: [], T2: 0.5, cfg: c }).map((x) => x.id)).toEqual([
      "a",
    ]);
    expect(
      priorityOrder(ps, { subQuestions: [], T2: 0.5, cfg: c, fillMin: 0.3 }).map((x) => x.id),
    ).toEqual(["a", "b", "c"]);
  });
  test("an import-only passage needs rel / importPrior to pass T2", () => {
    const imp = { ...ev("imp", "a.ts", 1, 10, 0.8), importOnly: true };
    const c = codeSearchConfig({ pack: { minPassages: 0 } });
    expect(priorityOrder([imp], { subQuestions: [], T2: 0.5, cfg: c })).toEqual([]);
    expect(priorityOrder([{ ...imp, rel: 1 }], { subQuestions: [], T2: 0.5, cfg: c }).length).toBe(
      1,
    );
  });
});

describe("packBody: whole files, stitching, file order, budget cuts", () => {
  test("a small relevant file is shown whole; its other passages are subsumed", () => {
    const a = ev("a", "src/small.ts", 1, 5, 0.9, [], smallFile);
    const b = ev("b", "src/small.ts", 12, 16, 0.8, [], smallFile);
    const body = packBody([a, b], opts());
    expect(body.included.length).toBe(1);
    const p = body.included[0]!;
    expect(p).toMatchObject({
      path: "src/small.ts",
      start: 1,
      end: 20,
      whole: true,
      trimmed: false,
    });
    expect(p.block.split("\n")[0]).toBe("== src/small.ts:1-20  rel 0.90  (whole file)");
    expect(p.block).toContain("20| const s20 = 20;");
    expect(p.block).toBe(renderWhole(a, opts()));
    expect(body.excluded).toEqual([]);
    expect(body.budgetCut).toEqual([]);
  });

  test("whole-file display is off for files over wholeFileMaxChars, below T2, or with wholeFileMaxChars 0", () => {
    const big = packBody([ev("a", "src/big.ts", 1, 5, 0.9)], opts());
    expect(big.included[0]!.whole).toBeUndefined();
    const weak = packBody([ev("a", "src/small.ts", 1, 5, 0.3, [], smallFile)], opts());
    expect(weak.included[0]!.whole).toBeUndefined();
    const off = packBody(
      [ev("a", "src/small.ts", 1, 5, 0.9, [], smallFile)],
      opts({ cfg: codeSearchConfig({ pack: { wholeFileMaxChars: 0 } }) }),
    );
    expect(off.included[0]!).toMatchObject({ start: 1, end: 5 });
  });

  test("a whole file replaces an earlier passage of that file and refunds its budget", () => {
    // p1 enters first (it is the best passage for s1, but below T2), then p2 (>= T2) shows the file whole
    const p1 = ev("p1", "src/small.ts", 1, 5, 0.3, [0.9], smallFile);
    const p2 = ev("p2", "src/small.ts", 12, 16, 0.9, [0.1], smallFile);
    const whole = renderWhole(p2, opts({ subQuestions: ["s1"] }));
    // room for the whole block and a little more, but not for the whole block plus p1's block
    const bodyChars = whole.length + 2 + 60;
    const body = packBody([p1, p2], opts({ subQuestions: ["s1"], bodyChars }));
    expect(body.priority).toEqual(["p1", "p2"]);
    expect(body.included.map((p) => [p.id, p.whole])).toEqual([["p2", true]]);
    expect(body.body.length).toBeLessThanOrEqual(bodyChars);
  });

  test("passages of one file separated by at most stitchGap lines are joined", () => {
    const a = ev("a", "src/big.ts", 10, 20, 0.9);
    const b = ev("b", "src/big.ts", 30, 40, 0.8); // 9 lines between
    const c = ev("c", "src/big.ts", 60, 70, 0.7); // 19 lines between
    const body = packBody([a, b, c], opts());
    expect(body.included.map((p) => [p.id, p.start, p.end])).toEqual([
      ["a+b", 10, 40],
      ["c", 60, 70],
    ]);
    const joined = body.included[0]!;
    expect(joined.block.split("\n")[0]).toBe("== src/big.ts:10-40  rel 0.90");
    expect(joined.block).toContain("25| const v25 = 25;");
    expect(body.excluded).toEqual([]);
    // off
    const off = packBody([a, b, c], opts({ cfg: codeSearchConfig({ pack: { stitchGap: 0 } }) }));
    expect(off.included.map((p) => p.id)).toEqual(["a", "b", "c"]);
    // a gap of exactly stitchGap lines still joins
    const edge = packBody(
      [a, ev("e", "src/big.ts", 33, 40, 0.8)],
      opts({ cfg: codeSearchConfig({ pack: { stitchGap: 12 } }) }),
    );
    expect(edge.included.map((p) => p.id)).toEqual(["a+e"]);
    const over = packBody(
      [a, ev("e", "src/big.ts", 34, 40, 0.8)],
      opts({ cfg: codeSearchConfig({ pack: { stitchGap: 12 } }) }),
    );
    expect(over.included.map((p) => p.id)).toEqual(["a", "e"]);
  });

  test("files: the best passage's file first, then each sub-question's best, then by relevance", () => {
    const ps = [
      ev("z", "src/z.ts", 1, 10, 0.8, [0, 0]),
      ev("y", "src/y.ts", 1, 10, 0.55, [0, 0.9]),
      ev("x", "src/x.ts", 1, 10, 0.95, [0.9, 0]),
      ev("x2", "src/x.ts", 200, 210, 0.6, [0, 0]),
    ];
    const body = packBody(ps, opts({ subQuestions: ["s1", "s2"] }));
    expect(body.included.map((p) => p.id)).toEqual(["x", "x2", "y", "z"]);
    expect(body.body.split("\n\n")[0]!.split("\n")[0]).toBe("== src/x.ts:1-10  rel 0.95  [s1]");
    // without sub-questions y goes last
    expect(packBody(ps, opts()).included.map((p) => p.id)).toEqual(["x", "x2", "z", "y"]);
  });

  test("budgetCut lists the passages at or above T2 that did not fit", () => {
    const ps = [
      ev("a", "src/a.ts", 1, 10, 0.9),
      ev("b", "src/b.ts", 1, 10, 0.8),
      ev("c", "src/c.ts", 1, 10, 0.7),
      ev("low", "src/d.ts", 1, 10, 0.2),
    ];
    const one = packBody(ps.slice(0, 1), opts()).body.length;
    const body = packBody(ps, opts({ bodyChars: one + 210 }));
    expect(body.included.map((p) => p.id)).toEqual(["a"]);
    expect(body.budgetCut.map((x) => x.id)).toEqual(["b", "c"]);
    expect(body.excluded.map((x) => x.id)).toEqual(["b", "c", "low"]);
  });

  test("a caller passage's header names the lead it uses", () => {
    const x = { ...ev("c", "src/big.ts", 1, 10, 0.9), caller: "useArtifactCatalog" };
    expect(packBody([x], opts()).included[0]!.block.split("\n")[0]).toBe(
      "== src/big.ts:1-10  rel 0.90  (uses useArtifactCatalog)",
    );
  });
});

// ---------------------------------------------------------------------------
describe("renderFooter", () => {
  const base = (o: Partial<FooterInput> = {}): FooterInput => ({
    coverage: [],
    cuts: [],
    excluded: [],
    otherFiles: [],
    leadsNotFollowed: [],
    keywords: [],
    cfg,
    maxChars: 10_000,
    ...o,
  });
  const cov: CoverageFile[] = [
    {
      path: "src/a.ts",
      lines: 100,
      shown: [
        [1, 20],
        [15, 30],
        [50, 60],
      ],
      checked: [
        { start: 70, end: 80, rel: 0.31 },
        { start: 85, end: 90, rel: 0.2 },
      ],
      outline: [
        { name: "handleSave", line: 40 },
        { name: "rollback", line: 90 },
      ],
    },
    {
      path: "src/b.ts",
      lines: 50,
      shown: [],
      checked: [],
      note: "file triage 0.83",
      outline: [{ name: "Store", line: 3 }],
    },
    { path: "src/c.ts", lines: 10, shown: [[1, 10]], checked: [] },
    { path: "src/d.ts", lines: 0, shown: [], checked: [] },
  ];
  test("coverage lines: shown ranges, not-shown ranges with declarations, checked passages below the bar", () => {
    const out = renderFooter(base({ coverage: cov }));
    expect(out.split("\n")).toEqual([
      "Relevant files and what this pack did not show (read the not-shown ranges in full before changing code there):",
      "  src/a.ts (100 lines): shown 1-30, 50-60; not shown 31-49, 61-100 (declares handleSave 40, rollback 90); checked, below the bar: 70-80 (0.31), 85-90 (0.20)",
      "  src/b.ts (50 lines, file triage 0.83): not shown (declares Store 3)",
      "  src/c.ts (10 lines): shown 1-10; whole file shown",
      "  src/d.ts (not read): not shown",
    ]);
  });
  test("Cut by limits, more candidates, leads and keyword sections", () => {
    const out = renderFooter(
      base({
        coverage: cov.slice(2, 3),
        cuts: ["file triage: 2 more files passed (limit 16): src/x.ts (0.70)"],
        excluded: [ev("e", "src/e.ts", 3, 9, 0.42), ev("c", "src/c.ts", 1, 2, 0.4)],
        otherFiles: [{ path: "src/f.ts", score: 0.35 }],
        leadsNotFollowed: [{ name: "loadRows", score: 0.44, seenAt: "src/a.ts:3" }],
        keywords: [
          { raw: "useQuery", fragments: [], suggestions: ["useArtifactCatalog"], status: "zero" },
          { raw: "compactCtx", fragments: ["compact"], suggestions: [], status: "fragments" },
          { raw: "staleTime", fragments: [], suggestions: [], status: "irrelevant", files: 3 },
          { raw: "gcTime", fragments: [], suggestions: [], status: "irrelevant", files: 1 },
        ],
        widenedNote: "Note: the whole workspace was searched.",
      }),
    );
    expect(out.split("\n")).toEqual([
      "Relevant files and what this pack did not show (read the not-shown ranges in full before changing code there):",
      "  src/c.ts (10 lines): shown 1-10; whole file shown",
      "Cut by limits:",
      "  file triage: 2 more files passed (limit 16): src/x.ts (0.70)",
      "More candidates (not included; read if needed):",
      "  src/e.ts:3-9 (0.42)",
      "  files: src/f.ts (0.35)",
      "Leads not followed: loadRows (0.44) @src/a.ts:3",
      "Keywords with zero hits: useQuery (identifiers here: useArtifactCatalog), compactCtx (matched fragments: compact)",
      "Keywords that matched only files judged irrelevant: staleTime (3 files), gcTime (1 file)",
      "Note: the whole workspace was searched.",
    ]);
  });
  test("truncation drops list entries first and keeps the top coverage files", () => {
    const many: CoverageFile[] = Array.from({ length: 20 }, (_, i) => ({
      path: `src/module${String(i).padStart(2, "0")}.ts`,
      lines: 200,
      shown: [[1, 10]],
      checked: [1, 2, 3, 4, 5].map((k) => ({ start: k * 20, end: k * 20 + 5, rel: 0.3 })),
      outline: [{ name: `handler${i}`, line: 100 }],
    }));
    const longCut = `regions per file: not checked ${"src/some/long/path.ts: 1-9; ".repeat(20)}`;
    const input = base({
      coverage: many,
      cuts: [longCut],
      otherFiles: Array.from({ length: 10 }, (_, i) => ({ path: `src/other${i}.ts`, score: 0.3 })),
      leadsNotFollowed: Array.from({ length: 8 }, (_, i) => ({
        name: `leadName${i}`,
        score: 0.3,
        seenAt: "a.ts:1",
      })),
      keywords: [{ raw: "nope", fragments: [], suggestions: [], status: "zero" }],
    });
    const full = renderFooter({ ...input, maxChars: 100_000 });
    expect(full).toContain(`  (4 more relevant files not listed)`); // coverageFiles = 16
    expect(full).toContain("src/module15.ts");
    const maxChars = 1200;
    const out = renderFooter({ ...input, maxChars });
    expect(out.length).toBeLessThanOrEqual(maxChars);
    expect(out).toContain(
      "  src/module00.ts (200 lines): shown 1-10; not shown 11-200 (declares handler0 100)",
    );
    expect(out).not.toContain("src/module19.ts");
    expect(out).toMatch(/\(\d+ more relevant files not listed\)/);
    expect(out).not.toContain("src/other");
    expect(out).toContain("Keywords with zero hits: nope");
    // the long cut line is shortened with an ellipsis rather than dropped
    const cut = out.split("\n").find((l) => l.startsWith("  regions per file"))!;
    expect(cut.length).toBe(2 + 160);
    expect(cut.endsWith("...")).toBe(true);
    // checked lists shrink to one entry before coverage files go
    expect(out).toMatch(/checked, below the bar: 20-25 \(0\.30\)$/m);
  });
});

// ---------------------------------------------------------------------------
describe("symbol judge", () => {
  const ctx = {
    question: "How does the artifact list load more rows?",
    subQuestions: ["Where is paging?"],
  };
  const items: LeadItem[] = [
    {
      id: "y1000",
      name: "useArtifactCatalog",
      seenAt: "src/a.ts:1",
      context: "imported at src/a.ts:1: import ...",
      lex: 1,
    },
    {
      id: "y1001",
      name: "loadMoreRows",
      seenAt: "src/a.ts:9",
      context: "called at src/a.ts:9: loadMoreRows()",
      lex: 0.4,
    },
  ];
  test("buildSymbolRequest: one Noul per identifier, identifier and context in the state", () => {
    const { state, questions } = buildSymbolRequest(items, ctx, cfg);
    expect(Object.keys(questions)).toEqual(["y1000", "y1001"]);
    const st = state as any;
    expect(st.task).toBe(PROMPTS.symbolTask);
    expect(st.criteria).toEqual(PROMPTS.symbolCriteria);
    expect(st.question).toBe(ctx.question);
    expect(st.symbols).toEqual({
      y1000: "useArtifactCatalog  (imported at src/a.ts:1: import ...)",
      y1001: "loadMoreRows  (called at src/a.ts:9: loadMoreRows())",
    });
    expect(questions.y1000!.instructions as string).toContain("`useArtifactCatalog`");
    expect(questions.y1000!.instructions as string).toContain("symbols.y1000");
    expect(questions.y1000!.instructions as string).toContain(ctx.question);
  });
  test("scoreSymbols maps answers by id and splits large batches evenly", async () => {
    const sizes: number[] = [];
    const client = new JevClient({
      apiKey: "k",
      baseUrl: "http://fake-jev.local",
      maxRetries: 0,
      fetch: async (_url: string, init: RequestInit) => {
        if (init.method === "GET") return new Response("{}");
        const body = JSON.parse(String(init.body));
        const ids = Object.keys(body.questions);
        sizes.push(ids.length);
        const answers: Record<string, unknown> = {};
        for (const id of ids) answers[id] = { type: "noul", noul: id === "y1000" ? 0.8 : 0.2 };
        return Response.json({ model: "m", answers, usage: { input_tokens: 1, output_tokens: 0 } });
      },
    });
    const judge = new JevJudge({ client, config: cfg, signal: new AbortController().signal });
    const scores = await judge.scoreSymbols(items, ctx);
    expect(scores.get("y1000")).toBe(0.8);
    expect(scores.get("y1001")).toBe(0.2);
    expect(judge.stats().symbols!.requests).toBeGreaterThanOrEqual(1);
    expect(await judge.scoreSymbols([], ctx)).toEqual(new Map());
    sizes.length = 0;
    const many = Array.from({ length: 130 }, (_, i) => ({
      ...items[0]!,
      id: `y2${String(i).padStart(3, "0")}`,
    }));
    const s2 = await judge.scoreSymbols(many, ctx);
    expect(s2.size).toBe(130);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(130);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(120);
  });
});
