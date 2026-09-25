import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  CodeSearchRipgrepMissingError,
  JevClient,
  JevRequestError,
  JevUnavailableError,
  codeSearchConfig,
  runCodeSearch,
  type CodeSearchWorkspace,
} from "../src";
import { recall } from "../src/code-search/recall";
import { WorkspaceSession } from "../src/code-search/session";
import {
  FIXTURE_FILES,
  fakeJevClient,
  fakeJevFetch,
  makeFixtureRepo,
  packPassages,
  type FakeJevLog,
} from "./helpers/fixture";
import { LocalCodeSearchWorkspace } from "./helpers/local-workspace";

const question = "How is the compaction token threshold computed and when does a turn compact?";
const keywords = [
  "compactionThresholdTokens",
  "compactNow",
  "contextWindow",
  "threshold",
  "shouldAutoCompactTurn",
];
const subQuestions = ["How is the threshold computed?", "When does a turn compact?"];
const cfg = codeSearchConfig();
/** The fixture has < 5 matching files under any prefix; do not widen for prefix-restriction checks. */
const noWiden = codeSearchConfig({ recall: { minCandidatesBeforeWiden: 1 } });

const roots: string[] = [];
function repo(files = FIXTURE_FILES): string {
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

let root = "";
beforeAll(() => {
  root = repo();
});

describe("recall on the fixture repo", () => {
  test("scores by distinct keywords, excludes node_modules/dist, down-weights tests, reports zero-hit keywords", async () => {
    const r = await recall({
      session: session(root),
      question,
      keywords,
      pathPrefixes: [],
      config: cfg,
    });
    const paths = r.candidates.map((c) => c.path);
    expect(paths).not.toContain("node_modules/pkg/index.js");
    expect(paths).not.toContain("dist/bundle.js");
    expect(paths[0]).toBe("src/turn.ts"); // 3 distinct keywords
    const testFile = r.candidates.find((c) => c.path === "test/compaction.test.ts")!;
    const comp = r.candidates.find((c) => c.path === "src/compaction.ts")!;
    expect(testFile.lexScore).toBeLessThan(comp.lexScore);
    expect(r.keywords.find((k) => k.raw === "shouldAutoCompactTurn")!.df).toBe(0);
  });

  test("paths restrict the search; the search widens to the whole workspace when nothing matches under them", async () => {
    const r1 = await recall({
      session: session(root),
      question,
      keywords,
      pathPrefixes: ["docs"],
      config: noWiden,
    });
    expect(r1.widened).toBe(false);
    expect(r1.candidates.every((c) => c.path.startsWith("docs/"))).toBe(true);
    const r2 = await recall({
      session: session(root),
      question,
      keywords: ["compactNow"],
      pathPrefixes: ["docs"],
      config: cfg,
    });
    expect(r2.widened).toBe(true);
    expect(r2.candidates.map((c) => c.path)).toContain("src/turn.ts");
  });

  test("fragments are used only for zero-hit compound keywords", async () => {
    const r = await recall({
      session: session(root),
      question: "q",
      keywords: ["computeCompactionThreshold", "clampRatio"],
      pathPrefixes: [],
      config: cfg,
    });
    expect(r.keywords[0]!.fragments).toEqual(["computeCompaction", "compactionThreshold"]);
    expect(r.keywords[0]!.df).toBeGreaterThan(0);
    expect(r.keywords[1]!.fragments).toEqual([]);
  });

  test("hidden directories are searched; .git directories and a worktree .git file are not", async () => {
    const r = repo({
      ...FIXTURE_FILES,
      ".github/workflows/review.yml": "on:\n  pull_request_target:\njobs: {}\n",
      ".git/config": "pull_request_target\n",
    });
    const rec = await recall({
      session: session(r),
      question: "q",
      keywords: ["pull_request_target"],
      pathPrefixes: [],
      config: cfg,
    });
    expect(rec.candidates.map((c) => c.path)).toEqual([".github/workflows/review.yml"]);
    const r2 = repo({
      ...FIXTURE_FILES,
      ".git": "gitdir: /x/compactionThreshold/worktrees/y\n",
      ".github/compaction.yml": "compactionThreshold: 1\n",
    });
    const rec2 = await recall({
      session: session(r2),
      question,
      keywords: ["compactionThreshold"],
      pathPrefixes: [],
      config: cfg,
    });
    expect(rec2.candidates.map((c) => c.path)).toContain(".github/compaction.yml");
    expect(rec2.candidates.map((c) => c.path)).not.toContain(".git");
  });

  test("a keyword containing a newline or tab is searched as a spaced phrase", async () => {
    const rec = await recall({
      session: session(root),
      question,
      keywords: ["compaction\nthreshold", "context\twindow"],
      pathPrefixes: [],
      config: cfg,
    });
    expect(rec.keywords.map((k) => k.raw)).toEqual(["compaction threshold", "context window"]);
    expect(rec.candidates.map((c) => c.path)).toContain("docs/compaction.md");
  });

  test("binary files that match only by path are dropped", async () => {
    const bin = new Uint8Array(2048);
    for (let i = 0; i < bin.length; i++) bin[i] = (i * 31) % 256;
    const r = repo({
      ...FIXTURE_FILES,
      "assets/compactionThreshold.bin": bin,
      "assets/compaction-threshold.sqlite": bin,
    });
    const rec = await recall({
      session: session(r),
      question,
      keywords: ["compactionThreshold", "compactNow"],
      pathPrefixes: [],
      config: cfg,
    });
    expect(rec.candidates.some((c) => c.path.startsWith("assets/"))).toBe(false);
    expect(rec.binaryDropped).toBe(2);
  });

  test("path prefixes: ./x/ is normalized; missing, absolute and escaping prefixes are reported missing", async () => {
    const rec = await recall({
      session: session(root),
      question,
      keywords: ["compactionThreshold"],
      pathPrefixes: ["./src/", "nope", "../x", "/etc", "."],
      config: noWiden,
    });
    expect(rec.validPrefixes).toEqual(["src", "."]);
    expect(rec.missingPrefixes).toEqual(["nope", "../x", "/etc"]);
  });
});

describe("runCodeSearch end to end with a fake Jev", () => {
  test("selects, verifies, follows a lead, packs under budget and reports status", async () => {
    const log: FakeJevLog = { requests: [] };
    const events: string[] = [];
    const ws = new LocalCodeSearchWorkspace(root);
    const r = await runCodeSearch({
      question,
      keywords,
      subQuestions,
      workspace: ws,
      jev: fakeJevClient({ log }),
      budgetTokens: 4000,
      onStage: (stage) => events.push(stage),
    });
    expect(r.status.label).toBe("sufficient");
    expect(r.status.overall).toBe(0.85);
    expect(r.status.subs).toEqual([0.85, 0.85]);
    const passages = packPassages(r.text);
    const paths = passages.map((p) => p.path);
    expect(paths).toContain("src/compaction.ts");
    expect(paths).toContain("src/turn.ts");
    expect(paths).not.toContain("src/unrelated.ts"); // fake Jev says 0.1
    // every included passage is verbatim with correct line numbers
    for (const p of passages) {
      const file = readFileSync(join(root, p.path), "utf8").split("\n");
      for (const l of p.lines) {
        const n = Number(l.split("|")[0]);
        expect(l).toBe(`${n}| ${file[n - 1]}`);
      }
    }
    expect(r.stats.packChars).toBeLessThanOrEqual(4000 * 3.2);
    expect(r.text.startsWith("code_search: evidence rating 0.85 (s1 0.85, s2 0.85) |")).toBe(true);
    expect(r.text.split("\n")[0]).toMatch(
      /^code_search: evidence rating .* \| \d+ passages from \d+ files, ~[\d.k]+ tokens \| [\d.]+s$/,
    );
    expect(r.text).toContain("Keywords with zero hits: shouldAutoCompactTurn");
    // wave 1: one Noul per candidate file; wave 2: relevance + 2 coverage Nouls per passage
    const w1 = log.requests.find((q) => q.state.files)!;
    expect(Object.keys(w1.questions).length).toBe(Object.keys(w1.state.files).length);
    const w2 = log.requests.find((q) => q.state.passages)!;
    expect(Object.keys(w2.questions).length).toBe(Object.keys(w2.state.passages).length * 3);
    // stats
    expect(r.stats.jev.requests).toBe(log.requests.length);
    expect(r.stats.jev.model).toBe("jev-fake-1");
    expect(r.stats.jev.inputTokens).toBeGreaterThan(0);
    expect(r.stats.jev.costUsd).toBeCloseTo((r.stats.jev.inputTokens * 0.042) / 1e6, 12);
    expect(r.stats.workspaceCalls).toBe(ws.calls.length);
    expect(r.stats.ripgrepTruncated).toBe(false);
    expect(r.stats.filesSelected).toBeGreaterThan(0);
    expect(r.stats.passagesIncluded).toBe(passages.length);
    expect(Object.keys(r.stats.stageMs).sort()).toEqual([
      "pack",
      "recall",
      "status",
      "wave1",
      "wave2",
      "wave3",
    ]);
    for (const s of ["start", "recall", "wave1", "wave2", "leads", "pack", "summary", "jev"])
      expect(events).toContain(s);
    // every ripgrep call stayed inside the allowlist (the local workspace enforces it)
    expect(ws.calls.filter((c) => c.kind === "ripgrep").length).toBeGreaterThanOrEqual(3);
  });

  test("the same inputs give the same pack (deterministic apart from the timing)", async () => {
    const run = () =>
      runCodeSearch({
        question,
        keywords,
        subQuestions,
        workspace: new LocalCodeSearchWorkspace(root),
        jev: fakeJevClient(),
      });
    const [a, b] = [await run(), await run()];
    const body = (t: string) => t.split("\n").slice(1).join("\n");
    expect(body(a.text)).toBe(body(b.text));
  });

  test("a question with no matching code yields an empty pack and status insufficient", async () => {
    const r = await runCodeSearch({
      question: "How is Kafka configured?",
      keywords: ["kafkaBroker", "KAFKA_URL"],
      workspace: new LocalCodeSearchWorkspace(root),
      jev: fakeJevClient(),
    });
    expect(packPassages(r.text).length).toBe(0);
    expect(r.status.label).toBe("insufficient");
    expect(r.text).toContain("No passage passed verification.");
    expect(r.text).toContain("Keywords with zero hits: kafkaBroker, KAFKA_URL");
  });

  test("a missing path is ignored and the whole workspace is searched, with a note", async () => {
    const r = await runCodeSearch({
      question,
      keywords,
      paths: ["does/not/exist"],
      workspace: new LocalCodeSearchWorkspace(root),
      jev: fakeJevClient(),
    });
    expect(packPassages(r.text).length).toBeGreaterThan(0);
    expect(r.text).toContain("Note: paths not found in the workspace (ignored): does/not/exist.");
    expect(r.text).toContain("Note: the whole workspace was searched.");
  });

  test("paths restrict the evidence", async () => {
    const r = await runCodeSearch({
      question,
      keywords,
      paths: ["src"],
      workspace: new LocalCodeSearchWorkspace(root),
      jev: fakeJevClient(),
      config: noWiden,
    });
    const ps = packPassages(r.text);
    expect(ps.length).toBeGreaterThan(0);
    expect(ps.every((p) => p.path.startsWith("src/"))).toBe(true);
  });

  test("binary files never become passages", async () => {
    const bin = new Uint8Array(2048);
    for (let i = 0; i < bin.length; i++) bin[i] = (i * 31) % 256;
    const r = repo({ ...FIXTURE_FILES, "assets/compactionThreshold.bin": bin });
    const res = await runCodeSearch({
      question,
      keywords: ["compactionThreshold", "compactNow"],
      workspace: new LocalCodeSearchWorkspace(r),
      jev: fakeJevClient({ good: ["compaction"] }),
    });
    expect(packPassages(res.text).some((p) => p.path.startsWith("assets/"))).toBe(false);
    expect(/[\u0000-\u0008\u000e-\u001f�]/.test(res.text)).toBe(false);
  });
});

describe("failures", () => {
  test("a Jev outage fails the search with JevUnavailableError (no keyword-only fallback)", async () => {
    const promise = runCodeSearch({
      question,
      keywords,
      workspace: new LocalCodeSearchWorkspace(root),
      jev: fakeJevClient({ fail: true }),
    });
    await expect(promise).rejects.toBeInstanceOf(JevUnavailableError);
    await expect(promise).rejects.toThrow(/503/);
  });

  test("a rejected Jev request fails the search with JevRequestError", async () => {
    const promise = runCodeSearch({
      question,
      keywords,
      workspace: new LocalCodeSearchWorkspace(root),
      jev: fakeJevClient({ rejectStatus: 422 }),
    });
    await expect(promise).rejects.toBeInstanceOf(JevRequestError);
  });

  test("Jev failing part-way (after wave 1) still fails the search", async () => {
    const ok = fakeJevFetch();
    let n = 0;
    const jev = new JevClient({
      apiKey: "k",
      baseUrl: "http://fake-jev.local",
      maxRetries: 0,
      fetch: async (url, init) =>
        init.method === "GET" || ++n <= 1
          ? ok(url, init)
          : Response.json({ detail: "down" }, { status: 503 }),
    });
    await expect(
      runCodeSearch({ question, keywords, workspace: new LocalCodeSearchWorkspace(root), jev }),
    ).rejects.toBeInstanceOf(JevUnavailableError);
  });

  test("only the status check fails: the Jev pack is kept, status unknown, the error is exposed", async () => {
    const good = await runCodeSearch({
      question,
      keywords,
      workspace: new LocalCodeSearchWorkspace(root),
      jev: fakeJevClient(),
    });
    const r = await runCodeSearch({
      question,
      keywords,
      workspace: new LocalCodeSearchWorkspace(root),
      jev: fakeJevClient({ failStatus: true }),
    });
    expect(r.status.label).toBe("unknown");
    expect(r.status.error).toMatch(/503/);
    expect(r.statusCheckError).toBeInstanceOf(JevUnavailableError);
    expect(r.text.split("\n")[0]).toMatch(
      /^code_search: evidence rating unknown \(check failed\) \|/,
    );
    const body = (t: string) => t.split("\n").slice(1).join("\n");
    expect(body(r.text)).toBe(body(good.text));
  });

  test("missing ripgrep propagates as CodeSearchRipgrepMissingError", async () => {
    const ws = new LocalCodeSearchWorkspace(root, { rgBin: "/nonexistent/rg-missing" });
    await expect(
      runCodeSearch({ question, keywords, workspace: ws, jev: fakeJevClient() }),
    ).rejects.toBeInstanceOf(CodeSearchRipgrepMissingError);
  });

  test("truncated ripgrep output continues and the header says the search was partial", async () => {
    const ws = new LocalCodeSearchWorkspace(root, { maxStdoutBytes: 120 });
    const r = await runCodeSearch({ question, keywords, workspace: ws, jev: fakeJevClient() });
    expect(r.stats.ripgrepTruncated).toBe(true);
    expect(r.text.split("\n")[0]).toMatch(
      /^code_search \(partial search: ripgrep output was cut at its size limit; some matches may be missing\): evidence rating /,
    );
  });

  test("a timed-out ripgrep search is reported as partial", async () => {
    const inner = new LocalCodeSearchWorkspace(root);
    const ws: CodeSearchWorkspace = {
      ripgrep: async (args, o) => ({
        ...(await inner.ripgrep(args, o)),
        timedOut: args.includes("--files"),
      }),
      readText: (p, o) => inner.readText(p, o),
      pathKinds: (p, o) => inner.pathKinds(p, o),
    };
    const r = await runCodeSearch({ question, keywords, workspace: ws, jev: fakeJevClient() });
    expect(r.stats.ripgrepTruncated).toBe(true);
    expect(r.text.split("\n")[0]).toContain("(partial search: a ripgrep search hit its time limit");
  });

  test("the caller's abort cancels the search and in-flight Jev requests", async () => {
    const controller = new AbortController();
    let inflight = 0;
    let aborted = 0;
    const jev = new JevClient({
      apiKey: "k",
      baseUrl: "http://fake-jev.local",
      fetch: (_url, init) => {
        if (init.method === "GET") return Promise.resolve(new Response("{}"));
        inflight++;
        controller.abort(new Error("turn interrupted"));
        return new Promise<Response>((_resolve, reject) => {
          if (init.signal?.aborted) {
            aborted++;
            reject(init.signal.reason);
          }
          init.signal?.addEventListener("abort", () => {
            aborted++;
            reject(init.signal!.reason);
          });
        });
      },
    });
    const promise = runCodeSearch({
      question,
      keywords,
      workspace: new LocalCodeSearchWorkspace(root),
      jev,
      signal: controller.signal,
    });
    await expect(promise).rejects.toThrow("turn interrupted");
    expect(inflight).toBeGreaterThan(0);
    expect(aborted).toBe(inflight);
  });

  test("an already-aborted signal makes no workspace or Jev call", async () => {
    const ws = new LocalCodeSearchWorkspace(root);
    const log: FakeJevLog = { requests: [] };
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await expect(
      runCodeSearch({
        question,
        keywords,
        workspace: ws,
        jev: fakeJevClient({ log }),
        signal: controller.signal,
      }),
    ).rejects.toThrow("stop");
    expect(ws.calls.length).toBe(0);
    expect(log.requests.length).toBe(0);
  });
});
