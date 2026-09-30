/**
 * End to end with the fake Jev: "must change together" declarations, the adaptive pack round, root file names
 * starting with a dash, sandbox state under .opengeni and the symbol-window cap.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { codeSearchConfig, runCodeSearch, type CodeSearchConfig } from "../src";
import {
  fakeJevClient,
  makeFixtureRepo,
  packPassages,
  type FakeJevLog,
  type FakeJevOptions,
} from "./helpers/fixture";
import { assertAllowedRipgrepArgs, LocalCodeSearchWorkspace } from "./helpers/local-workspace";

const describeWithRipgrep = Bun.which("rg") ? describe : describe.skip;

const roots: string[] = [];
function repo(files: Record<string, string>): string {
  const root = makeFixtureRepo(files);
  roots.push(root);
  return root;
}
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** A top-level function of n long statement lines that mention none of the judged names. */
const filler = (name: string, n: number) => [
  `export function ${name}(rows: number[]): number {`,
  "  let total = 0;",
  ...Array.from(
    { length: n },
    (_, i) =>
      `  total += rows.length * ${i} + Math.max(0, rows[${i % 7}] ?? 0) - Math.min(${i}, rows.length) * 3;`,
  ),
  "  return total;",
  "}",
  "",
];

type Events = Array<[string, Record<string, any>]>;
async function search(
  root: string,
  o: {
    question: string;
    keywords: string[];
    subQuestions?: string[];
    paths?: string[];
    jev: FakeJevOptions;
    config?: CodeSearchConfig;
  },
) {
  const events: Events = [];
  const workspace = new LocalCodeSearchWorkspace(root);
  const r = await runCodeSearch({
    question: o.question,
    keywords: o.keywords,
    subQuestions: o.subQuestions,
    paths: o.paths,
    workspace,
    jev: fakeJevClient(o.jev),
    config: o.config,
    onStage: (stage, data) => events.push([stage, data]),
  });
  const stage = (name: string) => events.find(([s]) => s === name)?.[1] as any;
  const jevStages = events.filter(([s]) => s === "jev").map(([, d]) => d);
  return { r, events, stage, jevStages, workspace };
}

// ---------------------------------------------------------------------------
describeWithRipgrep("must change together", () => {
  // archiveArtifact matches the keyword; invalidateArtifactCache (far below, in no keyword window) mentions
  // none of the fake's good names, so its literal relevance is 0.1, but the change judge chooses it.
  // The file is too large to show whole and too large to tile (tileMaxLines is lowered).
  const serviceLines = [
    "export async function archiveArtifact(id: string) {",
    '  await store.setStatus(id, "archived");',
    "  return id;",
    "}",
    "",
    ...filler("summarizeColumns", 60),
    "export async function invalidateArtifactCache(id: string) {",
    "  cacheLayer.drop(id);",
    "  await cacheLayer.flush();",
    "}",
    "",
  ];
  const root = repo({ "src/artifacts/service.ts": serviceLines.join("\n") });
  const declLine =
    serviceLines.findIndex((l) => l.includes("function invalidateArtifactCache")) + 1;

  test("a chosen declaration outside every window gets its own passage, verified with the symbol windows, packed right after the sub-question bests", async () => {
    const { r, stage, jevStages } = await search(root, {
      question: "How is an artifact archived?",
      subQuestions: ["Where is the status set?"],
      keywords: ["archiveArtifact"],
      jev: { good: ["archiveArtifact"], changeGood: ["invalidateArtifactCache"] },
      config: codeSearchConfig({ wave2: { tileMaxLines: 10 } }),
    });
    const change = stage("change");
    expect(change.chosen).toEqual([`invalidateArtifactCache@src/artifacts/service.ts:${declLine}`]);
    expect(change.judged.find((d: any) => d.name === "archiveArtifact").p).toBe(0.1);

    // its passage is a definition window made for it (no keyword window holds the line)
    const sw = stage("symbol_windows");
    const own = sw.passages.find(
      (p: any) => p.path === "src/artifacts/service.ts" && p.start <= declLine && p.end >= declLine,
    );
    expect(own).toBeDefined();
    // ... and verified in the symbol_windows Jev round, not in wave 2
    const swJev = jevStages.filter((d) => d.jevStage === "symbol_windows");
    expect(swJev.length).toBeGreaterThan(0);
    expect(swJev.some((d) => Object.keys(d.questions).includes(`rel::${own.id}`))).toBe(true);
    expect(
      jevStages
        .filter((d) => d.jevStage === "wave2")
        .some((d) => Object.keys(d.questions).includes(`rel::${own.id}`)),
    ).toBe(false);

    // priority: the sub-question's best passage, then the change-together declaration (below T2), then the rest
    const pack = stage("pack");
    const subBest = pack.included.find((p: any) => p.start === 1);
    expect(pack.priority[0]).toBe(subBest.id);
    expect(pack.priority[1]).toBe(own.id);
    const block = r.text
      .split("\n\n")
      .find((b) => b.startsWith(`== src/artifacts/service.ts:${own.start}-`))!;
    expect(block).toBeDefined();
    expect(block.split("\n")[0]).toContain("rel 0.10");
    expect(block.split("\n")[0]).toContain("[change together: invalidateArtifactCache]");
    expect(block).toContain(
      `${declLine}| export async function invalidateArtifactCache(id: string) {`,
    );
  });

  test("without a change-good declaration nothing is tagged", async () => {
    const { r, stage } = await search(root, {
      question: "How is an artifact archived?",
      keywords: ["archiveArtifact"],
      jev: { good: ["archiveArtifact"] },
      config: codeSearchConfig({ wave2: { tileMaxLines: 10 } }),
    });
    expect(stage("change").chosen).toEqual([]);
    expect(r.text).not.toContain("[change together:");
  });
});

// ---------------------------------------------------------------------------
describeWithRipgrep("adaptive pack round", () => {
  // computeLimit calls helperAlpha and helperBeta (each defined in its own file, which no keyword matches);
  // with maxLeadsFollowed 1 the first round follows one of them and the follow-up round the other. The
  // second tile of limits.ts (filler) scores 0.1: it is packed only by a refill (fillMinRelevance 0.1).
  const root = repo({
    "src/limits.ts": [
      'import { helperAlpha } from "./alpha";',
      'import { helperBeta } from "./beta";',
      "",
      "export function computeLimit(n: number): number {",
      "  return helperAlpha(n) + helperBeta(n);",
      "}",
      "",
      ...filler("summarizeColumns", 30),
      ...filler("measureColumns", 30),
    ].join("\n"),
    "src/alpha.ts": "export function helperAlpha(n: number): number {\n  return n * 2;\n}\n",
    "src/beta.ts": "export function helperBeta(n: number): number {\n  return n * 3;\n}\n",
  });
  const cfg = codeSearchConfig({
    wave3: { maxLeadsFollowed: 1 },
    // stitching off: the refilled filler tile is adjacent to the computeLimit tile (see the todo below)
    pack: { minPassages: 1, fillMinRelevance: 0.1, stitchGap: 0 },
  });
  const base = {
    question: "How is the limit computed?",
    keywords: ["computeLimit"],
    config: cfg,
  };
  const good = ["computeLimit", "helperAlpha", "helperBeta"];

  test("rating 0.3: the follow-up round follows the next leads and checks again", async () => {
    const { r, stage, jevStages } = await search(root, {
      ...base,
      jev: { good, statusScore: 0.3 },
    });
    const pack = stage("pack");
    expect(pack.firstRating).toBe(0.3);
    expect(pack.adaptive.some((a: string) => a.includes("followed 1 more leads"))).toBe(true);
    expect(jevStages.filter((d) => d.jevStage === "status").length).toBe(2);
    expect(r.text).toContain("(definition of helperAlpha)");
    expect(r.text).toContain("(definition of helperBeta)");
    expect(r.statusCheckError).toBeUndefined();
  });

  test("rating 0.6: refills without a second status request and says the rating covers the passages above the bar", async () => {
    const { r, stage, jevStages } = await search(root, {
      ...base,
      jev: { good, statusScore: 0.6 },
    });
    const pack = stage("pack");
    expect(pack.adaptive).toEqual(["rating 0.60: filled the budget with passages rel >= 0.1"]);
    expect(jevStages.filter((d) => d.jevStage === "status").length).toBe(1);
    expect(r.text.split("\n")[0]).toContain(
      "evidence rating 0.60 for the passages above the bar; weaker passages fill the rest",
    );
    // the refill packed the 0.1 filler tile
    expect(pack.included.some((p: any) => p.rel === 0.1)).toBe(true);
    expect(r.status.overall).toBe(0.6);
  });

  // BUG (src/code-search/search.ts, the refill branch of the adaptive pack): "did the refill add anything" is
  // `body.included.length !== before`, but packBody stitches a refilled passage into an adjacent included one
  // of the same file, so the count stays the same. The weaker passage is packed, yet the refill is not reported
  // (pack.adaptive empty) and the header lacks "for the passages above the bar". Input: this fixture with
  // statusScore 0.6 and the default stitchGap 12 (limits.ts tile 1-42 rel 0.9 + filler tile 43-76 rel 0.1
  // are packed as one block 1-76 while the header reads "evidence rating 0.60 | ...").
  test("a refilled passage stitched into an included one is still reported as a refill", async () => {
    const { r, stage } = await search(root, {
      ...base,
      config: codeSearchConfig({
        wave3: { maxLeadsFollowed: 1 },
        pack: { minPassages: 1, fillMinRelevance: 0.1 },
      }),
      jev: { good, statusScore: 0.6 },
    });
    expect(stage("pack").priority.length).toBe(3);
    expect(r.text.split("\n")[0]).toContain("for the passages above the bar");
  });

  test("rating 0.85: no adaptive round", async () => {
    const { r, stage, jevStages } = await search(root, { ...base, jev: { good } });
    expect(stage("pack").adaptive).toEqual([]);
    expect(jevStages.filter((d) => d.jevStage === "status").length).toBe(1);
    expect(r.text.split("\n")[0]).not.toContain("above the bar");
  });

  test("a failed second status check keeps the first rating and is not reported as a status error", async () => {
    const log: FakeJevLog = { requests: [] };
    const { r, stage } = await search(root, {
      ...base,
      jev: { good, statusScore: [0.3], failStatusCalls: [2], log },
    });
    // the second status request was made (and failed)
    expect(log.requests.filter((q) => q.state.evidence !== undefined).length).toBe(2);
    expect(stage("pack").adaptive.some((a: string) => a.includes("followed"))).toBe(true);
    expect(r.statusCheckError).toBeUndefined();
    expect(r.status.overall).toBe(0.3);
    expect(r.status.error).toBeUndefined();
    expect(r.text.split("\n")[0]).toContain("evidence rating 0.30 for the passages above the bar");
    // the follow-up round's passages are still packed
    expect(r.text).toContain("(definition of helperBeta)");
  });

  test("a failed first status check is reported and skips the adaptive round", async () => {
    const { r, stage } = await search(root, { ...base, jev: { good, failStatusCalls: [1] } });
    expect(stage("pack").adaptive).toEqual([]);
    expect(r.statusCheckError).toBeDefined();
    expect(r.text.split("\n")[0]).toContain("evidence rating unknown (check failed)");
  });
});

// ---------------------------------------------------------------------------
describeWithRipgrep("a root file whose name starts with a dash", () => {
  test("the suggestion search for a zero-hit keyword passes it as ./-name and succeeds", async () => {
    const root = repo({
      "-notes.ts":
        "export function computeLimit(n: number) {\n  return invalidateLimitQueries(n);\n}\n",
      "src/limit.ts": "export function invalidateLimitQueries(n: number) {\n  return n;\n}\n",
    });
    const { r, workspace, stage } = await search(root, {
      question: "How is the limit computed?",
      keywords: ["computeLimit", "invalidateQueries"],
      jev: { good: ["computeLimit"] },
    });
    expect(stage("recall").candidates.map((c: any) => c.path)).toContain("-notes.ts");
    const note = stage("pack").keywords.find((k: any) => k.raw === "invalidateQueries");
    expect(note.status).toBe("zero");
    expect(r.text).toContain("Keywords with zero hits: invalidateQueries");
    const rg = workspace.calls.filter((c) => c.kind === "ripgrep");
    const pathArgs = rg.flatMap((c) => c.args.slice(c.args.indexOf("--") + 1));
    expect(pathArgs).toContain("./-notes.ts");
    expect(pathArgs.some((p) => p.startsWith("-"))).toBe(false);
    // the file itself is read by its workspace-relative name
    expect(workspace.calls.some((c) => c.kind === "readText" && c.args[0] === "-notes.ts")).toBe(
      true,
    );
  });
  test("the test workspace still rejects a bare dash path and unknown flags", () => {
    expect(() => assertAllowedRipgrepArgs(["-e", "x", "--", "-notes.ts"])).toThrow(
      /path not allowed/,
    );
    expect(() => assertAllowedRipgrepArgs(["--pre", "sh", "-e", "x", "--", "."])).toThrow(
      /flag not allowed/,
    );
    expect(() => assertAllowedRipgrepArgs(["-e", "x", "--", "./-notes.ts"])).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
describeWithRipgrep(".opengeni sandbox state", () => {
  const root = repo({
    ".opengeni/codemode-tokens/t": "computeLimit secret-token-value\n",
    ".opengeni/clients/computeLimit.ts": "export function computeLimit() { return 1; }\n",
    "src/limit.ts": "export function computeLimit(n: number) {\n  return n * 2;\n}\n",
  });
  const touched = (w: LocalCodeSearchWorkspace) =>
    w.calls.some((c) =>
      c.kind === "ripgrep"
        ? c.args.slice(c.args.indexOf("--") + 1).some((p) => p.includes(".opengeni"))
        : c.args.some((p) => p.includes(".opengeni")),
    );
  test("is never searched, read or returned", async () => {
    const { r, workspace, stage } = await search(root, {
      question: "How is the limit computed?",
      keywords: ["computeLimit", "secret-token-value"],
      jev: { good: ["computeLimit", "secret-token-value"] },
    });
    expect(stage("recall").candidates.map((c: any) => c.path)).toEqual(["src/limit.ts"]);
    expect(touched(workspace)).toBe(false);
    expect(r.text).not.toContain(".opengeni");
    expect(r.text).not.toMatch(/\d+\| .*secret-token-value/);
    // every ripgrep call over the workspace excludes it
    for (const c of workspace.calls.filter((x) => x.kind === "ripgrep" && x.args.at(-1) === "."))
      expect(c.args).toContain("!**/.opengeni/**");
  });
  test("even when a path names it explicitly", async () => {
    const { r, workspace } = await search(root, {
      question: "How is the limit computed?",
      keywords: ["computeLimit"],
      paths: [".opengeni", ".opengeni/codemode-tokens"],
      jev: { good: ["computeLimit"] },
    });
    expect(touched(workspace)).toBe(false);
    expect(packPassages(r.text).map((p) => p.path)).toEqual(["src/limit.ts"]);
    expect(packPassages(r.text).some((p) => p.path.includes(".opengeni"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describeWithRipgrep("symbol-window cap", () => {
  test("a symbol-added file with more windows than the limit is reported under Cut by limits", async () => {
    const thing = [
      "export function useThingState(id: string) {",
      "  return { id };",
      "}",
      "",
      ...filler("paddingOne", 40),
      "export function firstUser() {",
      "  return useThingState('a');",
      "}",
      "",
      ...filler("paddingTwo", 40),
      "export function secondUser() {",
      "  return useThingState('b');",
      "}",
      "",
    ];
    const root = repo({
      "src/panel.ts": [
        'import { useThingState } from "./thing";',
        "export function renderPanel(id: string) {",
        "  return useThingState(id);",
        "}",
      ].join("\n"),
      "src/thing.ts": thing.join("\n"),
    });
    const { r, stage } = await search(root, {
      question: "How is the panel rendered?",
      keywords: ["renderPanel"],
      jev: { good: ["renderPanel", "useThingState"], symbolGood: ["useThingState"] },
      // the added file is not tiled (tileNewMaxLines), so it gets hit windows capped at windowsPerFile
      config: codeSearchConfig({ symbols: { tileNewMaxLines: 5 }, wave2: { windowsPerFile: 1 } }),
    });
    expect(stage("symbols").added.map((a: any) => a.path)).toEqual(["src/thing.ts"]);
    const sw = stage("symbol_windows");
    expect(sw.tiled).toEqual([]);
    expect(sw.passages.filter((p: any) => p.path === "src/thing.ts").length).toBe(1);
    const footer = r.text.slice(r.text.indexOf("Cut by limits:"));
    expect(r.text).toContain("Cut by limits:");
    expect(footer).toMatch(/\n {2}symbol regions in src\/thing\.ts \(limit 1\): not checked \d+/);
  });
});
