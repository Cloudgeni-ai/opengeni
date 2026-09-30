/**
 * End to end with the fake Jev: symbol discovery, whole-file tiling, call sites of followed leads and the
 * footer's coverage map.
 *
 * Only src/components/ArtifactList.tsx matches the keywords. It imports useArtifactPaging (src/hooks/paging.ts,
 * which no keyword matches); the fake judges only that identifier worth following, so symbol discovery must add
 * paging.ts. paging.ts calls fetchRowPage (defined in src/api/rows.ts); the fake judges fetchRowPage a good lead
 * but not a symbol, so wave 3 follows it and windows its call site in src/toolbar/Toolbar.tsx, a large file no
 * keyword or symbol leads to. ArtifactList.tsx is too large to show whole, and its handleRetry handler sits in
 * a tile the fake scores 0.1, so the coverage map must name it among the not-shown declarations.
 */
import {
  codeSearchConfig, afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { codeSearchConfig, runCodeSearch } from "../src";
import { fakeJevClient, makeFixtureRepo, packPassages } from "./helpers/fixture";
import { LocalCodeSearchWorkspace } from "./helpers/local-workspace";

const describeWithRipgrep = Bun.which("rg") ? describe : describe.skip;

/** A top-level function of n long statement lines that mention none of the judged names. */
const filler = (name: string, n: number) => [
  `export function ${name}(rows: number[]): number {`,
  "  let total = 0;",
  ...Array.from(
    { length: n },
    (_, i) => `  total += rows.length * ${i} + Math.max(0, rows[${i % 7}] ?? 0) - Math.min(${i}, rows.length) * 3;`,
  ),
  "  return total;",
  "}",
  "",
];

const FILES: Record<string, string> = {
  "src/components/ArtifactList.tsx": [
    'import { useArtifactPaging } from "../hooks/paging";',
    "",
    "export function ArtifactList({ items, onLoadMore }) {",
    "  const paging = useArtifactPaging(items, onLoadMore);",
    "  return <List rows={paging.rows} onEnd={onLoadMore} />;",
    "}",
    "",
    ...filler("summarizeColumns", 30),
    "export const handleRetry = async (id: string) => {",
    "  const attempt = await restartJob(id);",
    "  if (!attempt.ok) throw new Error(attempt.reason);",
    "  notifyUser(`restarted ${id}`);",
    "  return attempt;",
    "};",
    "",
    ...filler("measureColumns", 30),
  ].join("\n"),
  "src/hooks/paging.ts": [
    'import { fetchRowPage } from "../api/rows";',
    "",
    "export function useArtifactPaging(items: string[]) {",
    "  const rows = fetchRowPage(items, 0);",
    "  return { rows };",
    "}",
    "",
  ].join("\n"),
  "src/api/rows.ts": [
    "export async function fetchRowPage(ids: string[], page: number) {",
    "  const res = await fetch(`/rows?page=${page}&ids=${ids.join(',')}`);",
    "  return res.json();",
    "}",
    "",
  ].join("\n"),
  "src/toolbar/Toolbar.tsx": [
    'import { fetchRowPage } from "../api/rows";',
    "",
    ...filler("toolbarWidth", 40),
    "export function RefreshButton({ ids }) {",
    "  const onClick = () => fetchRowPage(ids, 0);",
    "  return <button onClick={onClick}>Refresh</button>;",
    "}",
    "",
    ...filler("toolbarHeight", 40),
  ].join("\n"),
  "src/unrelated.ts": "export const pageSize = 50;\n",
};

let root = "";
beforeAll(() => {
  root = makeFixtureRepo(FILES);
});
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describeWithRipgrep("symbol discovery, call sites and the coverage map end to end", () => {
  test("adds a file no keyword matched, windows a lead's call site and names a not-shown handler", async () => {
    const events: Array<[string, Record<string, unknown>]> = [];
    const r = await runCodeSearch({
      question: "How does the artifact list load more rows?",
      keywords: ["ArtifactList", "onLoadMore"],
      workspace: new LocalCodeSearchWorkspace(root),
      // two symbol rounds, so each round's sources are asserted exactly
      config: codeSearchConfig({ symbols: { maxRounds: 2, triage: true } }),
      jev: fakeJevClient({
        good: ["useArtifactPaging", "fetchRowPage"],
        symbolGood: ["useArtifactPaging"],
      }),
      onStage: (stage, data) => events.push([stage, data]),
    });
    const stage = (name: string) => events.find(([s]) => s === name)![1] as any;

    // recall matched only ArtifactList.tsx
    expect(stage("recall").candidates.map((c: any) => c.path)).toEqual(["src/components/ArtifactList.tsx"]);

    // symbol discovery judged the file's identifiers, followed useArtifactPaging and added paging.ts
    const sym = stage("symbols");
    expect(sym.rounds[0].sources).toEqual(["src/components/ArtifactList.tsx"]);
    expect(sym.rounds[0].chosen).toEqual(["useArtifactPaging"]);
    expect(sym.rounds[0].judged.map((j: any) => j.name)).toContain("handleRetry");
    expect(sym.added).toEqual([{ path: "src/hooks/paging.ts", p: 0.9, via: ["useArtifactPaging"] }]);
    expect(sym.selected).toEqual(["src/components/ArtifactList.tsx", "src/hooks/paging.ts"]);
    // round 2 judged paging.ts's identifiers (fetchRowPage is not a symbol worth following for the fake)
    expect(sym.rounds[1].sources).toEqual(["src/hooks/paging.ts"]);
    expect(sym.rounds[1].chosen).toEqual([]);

    // both relevant small files were tiled whole
    expect(stage("wave2").tiled).toEqual(["src/components/ArtifactList.tsx"]);
    // paging.ts, added by symbol discovery, is tiled in the symbol-window batch
    expect(stage("symbol_windows").tiled).toEqual(["src/hooks/paging.ts"]);

    // wave 3 followed fetchRowPage: its definition and its call site in Toolbar.tsx
    const leads = stage("leads");
    expect(leads.followed).toEqual([{ name: "fetchRowPage", score: 0.9, def: "src/api/rows.ts:1" }]);
    const toolbarLines = FILES["src/toolbar/Toolbar.tsx"]!.split("\n");
    const callLine = toolbarLines.findIndex((l) => l.includes("() => fetchRowPage(")) + 1;
    const caller = leads.defPassages.find((p: any) => p.caller)!;
    expect(caller).toMatchObject({ path: "src/toolbar/Toolbar.tsx", lead: "fetchRowPage", rel: 0.9 });
    expect(caller.start).toBeLessThanOrEqual(callLine);
    expect(caller.end).toBeGreaterThanOrEqual(callLine);

    const text = r.text;
    const blocks = text.split("\n\n");
    const callerBlock = blocks.find((b) => b.startsWith("== src/toolbar/Toolbar.tsx:"))!;
    expect(callerBlock).toBeDefined();
    const head = callerBlock.split("\n")[0]!;
    expect(head).toContain("(uses fetchRowPage)");
    expect(head).not.toContain("(whole file)");
    expect(callerBlock).toContain(`${callLine}|   const onClick = () => fetchRowPage(ids, 0);`);
    const defBlock = blocks.find((b) => b.startsWith("== src/api/rows.ts:"))!;
    expect(defBlock).toContain("1| export async function fetchRowPage(");

    // paging.ts is shown (whole: it is small), although no keyword matched it
    const paging = packPassages(text).find((p) => p.path === "src/hooks/paging.ts")!;
    expect(paging).toBeDefined();
    expect(blocks.find((b) => b.startsWith("== src/hooks/paging.ts:"))!.split("\n")[0]).toContain("(whole file)");

    // ArtifactList.tsx: its first tile is shown, the handleRetry tile is not, and the coverage map names it
    const listLines = FILES["src/components/ArtifactList.tsx"]!.split("\n");
    const retryLine = listLines.findIndex((l) => l.startsWith("export const handleRetry")) + 1;
    const shownList = packPassages(text).filter((p) => p.path === "src/components/ArtifactList.tsx");
    expect(shownList.length).toBeGreaterThan(0);
    expect(shownList.some((p) => p.start <= 4 && p.end >= 4)).toBe(true);
    expect(shownList.some((p) => p.start <= retryLine && p.end >= retryLine)).toBe(false);
    const footerStart = text.indexOf("Relevant files and what this pack did not show");
    expect(footerStart).toBeGreaterThan(0);
    const coverageLine = text
      .slice(footerStart)
      .split("\n")
      .find((l) => l.startsWith("  src/components/ArtifactList.tsx ("))!;
    expect(coverageLine).toMatch(/^ {2}src\/components\/ArtifactList\.tsx \(\d+ lines\): shown [\d, -]+; not shown [\d, -]+ \(declares /);
    expect(coverageLine).toContain(`handleRetry ${retryLine}`);
    expect(coverageLine).toContain(`checked, below the bar:`);
    // the value-only locals and calls of the file are not named
    expect(coverageLine).not.toMatch(/\btotal\b|restartJob|notifyUser/);
  });

  test("with symbol discovery off the hook file is never read", async () => {
    const events: Array<[string, Record<string, unknown>]> = [];
    const r = await runCodeSearch({
      question: "How does the artifact list load more rows?",
      keywords: ["ArtifactList", "onLoadMore"],
      workspace: new LocalCodeSearchWorkspace(root),
      jev: fakeJevClient({ good: ["useArtifactPaging", "fetchRowPage"], symbolGood: ["useArtifactPaging"] }),
      config: codeSearchConfig({ symbols: { enabled: false } }),
      onStage: (stage, data) => events.push([stage, data]),
    });
    const sym = events.find(([s]) => s === "symbols")![1] as any;
    expect(sym.rounds).toEqual([]);
    expect(sym.added).toEqual([]);
    // wave 3 still follows useArtifactPaging as a lead (its definition), not paging.ts as a triaged file
    const leads = events.find(([s]) => s === "leads")![1] as any;
    expect(leads.followed.map((l: any) => l.name)).toContain("useArtifactPaging");
    expect(r.text).toContain("(definition of useArtifactPaging)");
  });
});
