import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  DecisionModel,
  DecisionQuestion,
} from "../../../packages/decisions/src/types";
import {
  bm25Arm,
  bm25FileArm,
  budgetSpans,
  clearIndexCache,
  hybridArm,
  jevRerankArm,
  queryKeywords,
  repoMapArm,
  spansFromPack,
} from "./arms";
import { BudgetLedger, BudgetStop, classifyProviderError } from "./budget";
import { codeSearchArm } from "./code-search-arm";
import {
  contextBenchTask,
  mergeSpans,
  patchFiles,
  repoRelativePath,
  splitByRepo,
  stratifiedSample,
  sweBenchTask,
} from "./datasets";
import {
  createDecisionModelsDecisionModel,
  TokenLedger,
} from "./decision-models";
import {
  createGatewayDecisionModel,
  toGatewayQuestion,
  type GatewayEvaluate,
} from "./gateway-decision-model";
import {
  Bm25,
  chunkFile,
  reciprocalRankFusion,
  tokenize,
} from "./index-lexical";
import { extractDefinitions, RepoMap } from "./index-repomap";
import {
  clusterBootstrap,
  pairedDifference,
  pairedSampleSize,
  scoreTask,
} from "./metrics";
import {
  calibrateCut,
  renderReport,
  scoreRuns,
  thresholdVariant,
} from "./report";
import { subagentArm, type SubagentModel } from "./subagent";
import {
  clipToLineCounts,
  localizeTrajectory,
  predictionFromAnswer,
  viewedSpans,
} from "./trajectory";
import type { Task } from "./types";

const task = (over: Partial<Task> = {}): Task => ({
  id: "t1",
  repo: "o/r",
  repoUrl: "",
  commit: "c",
  language: "python",
  source: "x",
  query: "q",
  oracle: {
    files: ["a.py", "b.py"],
    spans: [
      { file: "a.py", start: 10, end: 19 },
      { file: "b.py", start: 1, end: 10 },
    ],
  },
  ...over,
});

describe("datasets", () => {
  test("patch files skip created files", () => {
    const patch =
      "--- a/x/y.py\n+++ b/x/y.py\n@@\n--- /dev/null\n+++ b/new.py\n";
    expect(patchFiles(patch)).toEqual(["x/y.py"]);
  });
  test("spans merge when overlapping or adjacent", () => {
    expect(
      mergeSpans([
        { file: "a", start: 5, end: 9 },
        { file: "a", start: 1, end: 4 },
        { file: "a", start: 20, end: 21 },
        { file: "a", start: 3, end: 0 },
      ]),
    ).toEqual([
      { file: "a", start: 1, end: 9 },
      { file: "a", start: 20, end: 21 },
    ]);
  });
  test("ContextBench row becomes a task with merged gold", () => {
    const t = contextBenchTask({
      instance_id: "i",
      repo: "o/r",
      repo_url: "u",
      language: "go",
      base_commit: "abc",
      source: "Multi",
      problem_statement: "p",
      gold_context: [
        { file: "m.go", start_line: 1, end_line: 5 },
        { file: "m.go", start_line: 4, end_line: 8 },
        { file: "n.go", start_line: 2, end_line: 2 },
      ],
    });
    expect(t.oracle.files).toEqual(["m.go", "n.go"]);
    expect(t.oracle.spans[0]).toEqual({ file: "m.go", start: 1, end: 8 });
  });
  test("annotator container paths become repository-relative", () => {
    expect(
      repoRelativePath("/workspace/expressjs__express__0.1/lib/view.js"),
    ).toBe("lib/view.js");
    expect(repoRelativePath("/workspace/reproduce_error.js")).toBeNull();
    expect(repoRelativePath("src/a.rs")).toBe("src/a.rs");
  });
  test("split is by repository and deterministic", () => {
    const tasks = Array.from({ length: 400 }, (_, i) =>
      task({ id: `t${i}`, repo: `o/r${i % 40}` }),
    );
    const a = splitByRepo(tasks);
    expect(splitByRepo(tasks)).toEqual(a);
    for (const repo of new Set(a.map((t) => t.repo)))
      expect(
        new Set(a.filter((t) => t.repo === repo).map((t) => t.split)).size,
      ).toBe(1);
    const dev = a.filter((t) => t.split === "dev").length / a.length;
    expect(dev).toBeGreaterThan(0.02);
    expect(dev).toBeLessThan(0.4);
  });
  test("stratified sample is capped per language and stable", () => {
    const tasks = Array.from({ length: 90 }, (_, i) =>
      task({ id: `t${i}`, language: ["go", "c", "python"][i % 3]! }),
    );
    const s = stratifiedSample(tasks, 10);
    expect(s.length).toBe(30);
    expect(stratifiedSample(tasks, 10).map((t) => t.id)).toEqual(
      s.map((t) => t.id),
    );
  });
});

describe("metrics", () => {
  test("file and line scores", () => {
    const s = scoreTask(task(), {
      files: ["c.py", "a.py"],
      spans: [{ file: "a.py", start: 15, end: 24 }],
    });
    expect(s.fileRecall).toBe(0.5);
    expect(s.filePrecision).toBe(0.5);
    expect(s.mrr).toBe(0.5);
    expect(s.recallAt[1]).toBe(0);
    expect(s.lineRecall).toBeCloseTo(5 / 20);
    expect(s.linePrecision).toBeCloseTo(5 / 10);
  });
  test("empty prediction scores zero", () => {
    const s = scoreTask(task(), { files: [], spans: [] });
    expect([s.fileRecall, s.filePrecision, s.lineRecall, s.mrr]).toEqual([
      0, 0, 0, 0,
    ]);
  });
  test("cluster bootstrap brackets the mean and is reproducible", () => {
    const values = Array.from({ length: 200 }, (_, i) => ({
      cluster: `r${i % 20}`,
      value: (i % 7) / 7,
    }));
    const a = clusterBootstrap(values);
    expect(a.low).toBeLessThanOrEqual(a.mean);
    expect(a.high).toBeGreaterThanOrEqual(a.mean);
    expect(clusterBootstrap(values)).toEqual(a);
  });
  test("paired difference uses shared tasks", () => {
    const a = new Map([
      ["x", { cluster: "r1", value: 0.2 }],
      ["y", { cluster: "r2", value: 0.4 }],
      ["z", { cluster: "r3", value: 0.1 }],
    ]);
    const b = new Map([
      ["x", { cluster: "r1", value: 0.5 }],
      ["y", { cluster: "r2", value: 0.7 }],
    ]);
    expect(pairedDifference(a, b).mean).toBeCloseTo(0.3);
    expect(pairedDifference(a, b).n).toBe(2);
  });
  test("sample size for the planned paired interval", () => {
    expect(pairedSampleSize(0.3, 0.03)).toBe(385);
  });
});

describe("lexical index", () => {
  test("tokenize splits identifiers", () => {
    expect(tokenize("parseHTTPRequest_v2")).toEqual(
      expect.arrayContaining([
        "parsehttprequest_v2",
        "parse",
        "http",
        "request",
        "v2",
      ]),
    );
  });
  test("chunks overlap and cover the file", () => {
    const chunks = chunkFile(
      "f.py",
      Array.from({ length: 130 }, (_, i) => `l${i}`).join("\n"),
    );
    expect(chunks.map((c) => [c.start, c.end])).toEqual([
      [1, 60],
      [41, 100],
      [81, 130],
    ]);
  });
  test("bm25 ranks the matching chunk first", () => {
    const docs = [
      ...chunkFile("x/alpha.py", "def frobnicate():\n  pass"),
      ...chunkFile("y/beta.py", "def other():\n  return 1"),
    ];
    expect(new Bm25(docs).search("frobnicate fails")[0]!.chunk.file).toBe(
      "x/alpha.py",
    );
  });
  test("reciprocal rank fusion rewards agreement", () => {
    expect(
      reciprocalRankFusion([
        ["a", "b", "c"],
        ["b", "a", "d"],
      ])
        .slice(0, 2)
        .sort(),
    ).toEqual(["a", "b"]);
    expect(
      reciprocalRankFusion([
        ["a", "b"],
        ["b", "c"],
      ])[0],
    ).toBe("b");
  });
});

describe("repo map", () => {
  test("definitions across languages", () => {
    const names = (f: string, t: string) =>
      extractDefinitions(f, t).map((d) => d.name);
    expect(
      names("a.py", "class Foo:\n    def bar(self):\n        pass"),
    ).toEqual(["Foo", "bar"]);
    expect(
      names(
        "a.ts",
        "export function go() {}\nexport interface Thing {}\nconst run = async () => 1",
      ),
    ).toEqual(["go", "Thing", "run"]);
    expect(
      names("a.go", "func (s *Server) Serve() {\n}\ntype Server struct {"),
    ).toEqual(["Serve", "Server"]);
    expect(names("a.rs", "pub fn make() {}\nstruct Pt {")).toEqual([
      "make",
      "Pt",
    ]);
  });
  test("pagerank favours query-named and referenced files", () => {
    const map = new RepoMap(
      new Map([
        ["core/engine.py", "def render_frame():\n    pass\n"],
        ["ui/a.py", "from core.engine import render_frame\nrender_frame()"],
        ["ui/b.py", "render_frame()"],
        ["misc/c.py", "def unrelated():\n    pass"],
      ]),
    );
    expect(map.rank("render_frame crashes")[0]!.file).toBe("core/engine.py");
    expect(map.spansFor("core/engine.py", "render_frame")[0]).toMatchObject({
      start: 1,
    });
  });
});

describe("budget", () => {
  test("reservation enforces the cap including in-flight calls", () => {
    const ledger = new BudgetLedger(1);
    const a = ledger.reserve("x", "t", 0.6);
    expect(() => ledger.reserve("x", "t", 0.6)).toThrow(BudgetStop);
    a.settle(0.1);
    ledger.reserve("x", "t", 0.6).settle(0.2);
    expect(ledger.spentUsd).toBeCloseTo(0.3);
  });
  test("credit and auth errors stop the run and survive a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "cse-ledger-"));
    const path = join(dir, "ledger.jsonl");
    const ledger = new BudgetLedger(5, path);
    ledger.reserve("x", "t", 0.1).settle(0.05);
    expect(
      ledger.fail("x", "t", { status: 402, message: "Insufficient credits" })
        ?.reason,
    ).toBe("credit");
    expect(() => ledger.reserve("x", "t", 0.01)).toThrow(BudgetStop);
    const resumed = new BudgetLedger(5, path);
    expect(resumed.spentUsd).toBeCloseTo(0.05);
    expect(resumed.stop?.reason).toBe("credit");
    rmSync(dir, { recursive: true });
  });
  test("ordinary errors do not stop the run", () => {
    expect(
      classifyProviderError({ status: 500, message: "upstream" }),
    ).toBeNull();
    expect(classifyProviderError({ status: 401 })).toBe("auth");
  });
});

describe("gateway decision model", () => {
  const questions = {
    p: { type: "predicate", instructions: "Is it?" },
    c: { type: "choice", instructions: "Which?", criteria: { a: "A", b: "B" } },
  } satisfies Record<string, DecisionQuestion>;
  const ok: GatewayEvaluate = async (request) => {
    expect(request.maxRetries).toBe(0);
    expect((request.questions.p as { type: string }).type).toBe("boolean");
    return {
      answers: {
        p: { type: "boolean", probability: 0.8 },
        c: { type: "choice", choice: "b", probabilities: { a: 0.1, b: 0.9 } },
      },
      usage: { inputTokens: 1000, outputTokens: 2 },
      providerMetadata: { gateway: { cost: "0.000042" } },
    };
  };
  test("maps predicate to boolean and answers back", async () => {
    expect(toGatewayQuestion({ type: "predicate", instructions: "x" })).toEqual(
      { type: "boolean", instructions: "x" },
    );
    const ledger = new BudgetLedger(1);
    const model = createGatewayDecisionModel({
      evaluate: ok,
      model: {},
      ledger,
      arm: "jev",
      taskId: () => "t",
    });
    const result = await model.decide({ s: 1 }, questions);
    expect(result.answers.p).toEqual({ type: "predicate", probability: 0.8 });
    expect(result.answers.c).toMatchObject({ type: "choice", choice: "b" });
    expect(result.usage.costSource).toBe("provider-reported");
    expect(ledger.spentUsd).toBeCloseTo(0.000042);
  });
  test("a response without billed cost stops rather than guessing", async () => {
    const ledger = new BudgetLedger(1);
    const evaluate: GatewayEvaluate = async (r) => ({
      ...(await ok(r)),
      providerMetadata: {},
    });
    const model = createGatewayDecisionModel({
      evaluate,
      model: {},
      ledger,
      arm: "jev",
      taskId: () => "t",
    });
    await expect(model.decide({}, questions)).rejects.toBeInstanceOf(
      BudgetStop,
    );
  });
  test("credit error stops all later calls", async () => {
    const ledger = new BudgetLedger(1);
    let calls = 0;
    const evaluate: GatewayEvaluate = async () => {
      calls++;
      throw Object.assign(new Error("insufficient credits"), { status: 402 });
    };
    const model = createGatewayDecisionModel({
      evaluate,
      model: {},
      ledger,
      arm: "jev",
      taskId: () => "t",
    });
    await expect(model.decide({}, questions)).rejects.toBeInstanceOf(
      BudgetStop,
    );
    await expect(model.decide({}, questions)).rejects.toBeInstanceOf(
      BudgetStop,
    );
    expect(calls).toBe(1);
  });
  test("invalid answers are rejected", async () => {
    const evaluate: GatewayEvaluate = async (r) => ({
      ...(await ok(r)),
      answers: {
        p: { type: "boolean", probability: 2 },
        c: { type: "choice", choice: "z" },
      },
    });
    const model = createGatewayDecisionModel({
      evaluate,
      model: {},
      ledger: new BudgetLedger(1),
      arm: "jev",
      taskId: () => "t",
    });
    await expect(model.decide({}, questions)).rejects.toThrow(
      "invalid typed answers",
    );
  });
});

describe("trajectory import", () => {
  test("viewed spans from shell reads", () => {
    expect(
      viewedSpans("sed -n '10,40p' src/a.py && cat ./b.py | head", ["/work"]),
    ).toEqual([
      { file: "src/a.py", start: 10, end: 40 },
      { file: "b.py", start: 1, end: 1_000_000 },
    ]);
    expect(viewedSpans("head -n 50 /work/c.go", ["/work"])).toEqual([
      { file: "c.go", start: 1, end: 50 },
    ]);
  });
  test("events give viewed, searched and edited files", () => {
    const loc = localizeTrajectory(
      [
        {
          type: "agent.toolCall.created",
          payload: {
            id: "1",
            name: "exec_command",
            arguments: JSON.stringify({ cmd: "grep -rn foo ." }),
          },
        },
        {
          type: "agent.toolCall.output",
          payload: { id: "1", output: "./pkg/x.py:3:foo()\npkg/y.py:9:foo" },
        },
        {
          type: "agent.toolCall.created",
          payload: {
            id: "2",
            name: "exec_command",
            arguments: { cmd: "sed -n '1,20p' pkg/x.py" },
          },
        },
        {
          type: "agent.toolCall.created",
          payload: {
            id: "3",
            name: "apply_patch",
            arguments: {
              patch: "*** Begin Patch\n*** Update File: pkg/x.py\n",
            },
          },
        },
      ],
      ["/repo"],
    );
    expect(loc.searchedFiles).toEqual(["pkg/x.py", "pkg/y.py"]);
    expect(loc.viewed.spans).toEqual([{ file: "pkg/x.py", start: 1, end: 20 }]);
    expect(loc.editedFiles).toEqual(["pkg/x.py"]);
    expect(loc.calls).toEqual({ explore: 2, total: 3 });
  });
  test("clipping whole-file placeholders to real line counts", () => {
    const p = clipToLineCounts(
      {
        files: ["a"],
        spans: [
          { file: "a", start: 1, end: 1_000_000 },
          { file: "gone", start: 1, end: 2 },
        ],
      },
      (f) => (f === "a" ? 30 : undefined),
    );
    expect(p.spans).toEqual([{ file: "a", start: 1, end: 30 }]);
  });
  test("answer references", () => {
    expect(
      predictionFromAnswer("See src/a.py:10-20 and lib/b.ts:7.").spans,
    ).toEqual([
      { file: "src/a.py", start: 10, end: 20 },
      { file: "lib/b.ts", start: 7, end: 7 },
    ]);
  });
});

describe("arms on a real checkout", () => {
  let repo: string;
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "cse-repo-"));
    mkdirSync(join(repo, "core"));
    mkdirSync(join(repo, "ui"));
    writeFileSync(
      join(repo, "core/scheduler.py"),
      "class Scheduler:\n    def schedule_job(self, job):\n        raise ValueError('bad timezone')\n",
    );
    writeFileSync(
      join(repo, "ui/view.py"),
      "from core.scheduler import Scheduler\n\ndef show():\n    Scheduler().schedule_job(None)\n",
    );
    writeFileSync(
      join(repo, "README.md"),
      "Unrelated docs about installation.\n",
    );
    for (const args of [
      ["init", "-q"],
      ["add", "."],
      ["-c", "user.email=e@x", "-c", "user.name=n", "commit", "-qm", "init"],
    ])
      Bun.spawnSync(["git", ...args], { cwd: repo });
  });
  afterAll(() => {
    clearIndexCache();
    rmSync(repo, { recursive: true, force: true });
  });
  const t = () =>
    task({
      query: "schedule_job raises ValueError for a timezone",
      oracle: {
        files: ["core/scheduler.py"],
        spans: [{ file: "core/scheduler.py", start: 2, end: 3 }],
      },
    });
  const ctx = () => ({ repoDir: repo, signal: AbortSignal.timeout(20_000) });

  test("model-free arms find the oracle file", async () => {
    for (const arm of [bm25Arm, bm25FileArm, repoMapArm, hybridArm]) {
      const { prediction } = await arm.run(t(), ctx());
      expect(prediction.files[0]).toBe("core/scheduler.py");
      if (arm !== bm25FileArm)
        expect(scoreTask(t(), prediction).lineRecall).toBe(1);
    }
  });

  test("jev rerank keeps files the decision model accepts", async () => {
    const fake: DecisionModel = {
      async decide(input, questions) {
        const state = input as { candidates: Record<string, { path: string }> };
        const answers = Object.fromEntries(
          Object.keys(questions).map((id) => [
            id,
            {
              type: "predicate",
              probability:
                state.candidates[id]!.path === "ui/view.py" ? 0.9 : 0.1,
            },
          ]),
        );
        return {
          answers: answers as never,
          usage: {
            model: "m",
            provider: "p",
            inputTokens: 10,
            outputTokens: 0,
            requests: 1,
            costUsd: 0.001,
            costSource: "estimate",
          },
        };
      },
    };
    const { prediction, usage } = await jevRerankArm(fake, {
      threshold: 0.2,
    }).run(t(), ctx());
    expect(
      (await jevRerankArm(fake).run(t(), ctx())).prediction.fileScores?.[
        "ui/view.py"
      ],
    ).toBe(0.9);
    expect(prediction.files).toEqual(["ui/view.py"]);
    expect(usage.cashUsd).toBeGreaterThan(0);
  });

  test("code_search arm runs the real pipeline on a local workspace", async () => {
    const neutral: DecisionModel = {
      async decide(_input, questions) {
        const answers = Object.fromEntries(
          Object.entries(questions).map(([id, q]) => [
            id,
            q.type === "predicate"
              ? { type: "predicate", probability: 0.9 }
              : q.type === "choice"
                ? { type: "choice", choice: Object.keys(q.criteria)[0]! }
                : { type: "score", score: q.criteria.length - 1 },
          ]),
        );
        return {
          answers: answers as never,
          usage: {
            model: "m",
            provider: "p",
            inputTokens: 5,
            outputTokens: 0,
            requests: 1,
            costUsd: 0,
            costSource: "estimate",
          },
        };
      },
    };
    const { prediction } = await codeSearchArm(neutral).run(t(), ctx());
    expect(prediction.files).toContain("core/scheduler.py");
  });

  test("subagent arm runs tools in parallel and parses its answer", async () => {
    let turn = 0;
    const model: SubagentModel = {
      name: "fake",
      worstCaseUsdPerTurn: 0.01,
      async step({ messages }) {
        turn++;
        const usage = {
          inputTokens: 100,
          cachedInputTokens: 0,
          outputTokens: 10,
          costUsd: 0.001,
        };
        if (turn === 1)
          return {
            text: "",
            usage,
            toolCalls: [
              { id: "a", name: "rg", args: { pattern: "schedule_job" } },
              { id: "b", name: "ls", args: { path: "core" } },
            ],
          };
        expect(
          messages
            .filter((m) => m.role === "tool")
            .map((m) => m.content)
            .join("\n"),
        ).toContain("core/scheduler.py:2:");
        return { text: "core/scheduler.py:2-3", usage, toolCalls: [] };
      },
    };
    const ledger = new BudgetLedger(1);
    const { prediction, usage } = await subagentArm(model, ledger).run(
      t(),
      ctx(),
    );
    expect(prediction.spans).toEqual([
      { file: "core/scheduler.py", start: 2, end: 3 },
    ]);
    expect(usage.toolCalls).toBe(2);
    expect(ledger.spentUsd).toBeCloseTo(0.002);
  });
});

describe("decision models", () => {
  const reply = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status });
  const questions = {
    p: { type: "predicate", instructions: "Is it?" },
  } satisfies Record<string, DecisionQuestion>;
  test("native System One shape, token ledger settles reported usage", async () => {
    const ledger = new TokenLedger(1_000_000);
    let sent: Record<string, unknown> = {};
    const model = createDecisionModelsDecisionModel({
      apiKey: "k",
      model: "s1-pro",
      ledger,
      arm: "dm",
      taskId: () => "t",
      fetch: async (url, init) => {
        expect(url).toBe("https://api.decisionmodels.io/v1/systemone");
        sent = JSON.parse(String(init.body));
        return reply({
          model: "s1-pro-x",
          answers: { p: { type: "noul", noul: 0.7 } },
          usage: { input_tokens: 321 },
        });
      },
    });
    const result = await model.decide({ s: 1 }, questions);
    expect(sent.model).toBe("s1-pro");
    expect((sent.questions as Record<string, { type: string }>).p.type).toBe(
      "noul",
    );
    expect(result.answers.p).toEqual({ type: "predicate", probability: 0.7 });
    expect(ledger.usedTokens).toBe(321);
  });
  test("402 halts every later call; 400 is a miss that is not billed", async () => {
    const ledger = new TokenLedger(1_000_000);
    let status = 400;
    let calls = 0;
    const model = createDecisionModelsDecisionModel({
      apiKey: "k",
      model: "s1-pro",
      ledger,
      arm: "dm",
      taskId: () => "t",
      fetch: async () => (calls++, reply({ error: { message: "x" } }, status)),
    });
    await expect(model.decide({}, questions)).rejects.toThrow();
    expect(ledger.usedTokens).toBe(0);
    expect(ledger.stop).toBeNull();
    status = 402;
    await expect(model.decide({}, questions)).rejects.toBeInstanceOf(
      BudgetStop,
    );
    const before = calls;
    await expect(model.decide({}, questions)).rejects.toBeInstanceOf(
      BudgetStop,
    );
    expect(calls).toBe(before);
  });
  test("token cap refuses a call that could exceed it", async () => {
    const ledger = new TokenLedger(500);
    const model = createDecisionModelsDecisionModel({
      apiKey: "k",
      model: "s1-pro",
      ledger,
      arm: "dm",
      taskId: () => "t",
      fetch: async () => reply({}),
    });
    await expect(
      model.decide({ big: "x".repeat(4000) }, questions),
    ).rejects.toBeInstanceOf(BudgetStop);
  });
});

describe("helpers and report", () => {
  test("thresholds are applied from stored scores and calibrated on given tasks", () => {
    const usage = {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      cashUsd: 0,
      apiEquivalentUsd: 0,
      modelCalls: 0,
      toolCalls: 0,
    };
    const runs = [
      {
        taskId: "t1",
        arm: "r",
        usage,
        latencyMs: 1,
        prediction: {
          files: ["a.py", "c.py", "b.py"],
          spans: [],
          fileScores: { "a.py": 0.9, "c.py": 0.5, "b.py": 0.3 },
        },
      },
    ];
    expect(thresholdVariant(runs, "r", 0.4)[0]!.prediction.files).toEqual([
      "a.py",
      "c.py",
    ]);
    expect(calibrateCut([task()], runs, "r", [0.2, 0.6])).toBe(0.2);
  });
  test("file-level BM25 and Acc@k", async () => {
    expect(
      scoreTask(task(), { files: ["b.py", "x", "a.py"], spans: [] }).allAt,
    ).toMatchObject({ 1: 0, 3: 1 });
    expect(
      sweBenchTask({
        instance_id: "i",
        repo: "o/r",
        base_commit: "c",
        problem_statement: "q",
        patch: "--- a/x.py\n+++ b/x.py\n",
      }).oracle.files,
    ).toEqual(["x.py"]);
  });
  test("budget spans stop at the token budget", () => {
    expect(
      budgetSpans(
        [
          { file: "a", start: 1, end: 100 },
          { file: "b", start: 1, end: 100 },
        ],
        1500,
      ),
    ).toHaveLength(1);
  });
  test("pack headers and query keywords", () => {
    expect(
      spansFromPack(
        "status\n== src/a.ts:3-9  rel 0.81\n3 x\n== b.go:1-2  rel 0.5\n",
      ),
    ).toEqual([
      { file: "src/a.ts", start: 3, end: 9 },
      { file: "b.go", start: 1, end: 2 },
    ]);
    expect(
      queryKeywords(
        "Calling `foo.bar()` with parse_date and getValue fails in os.path",
      ),
    ).toEqual(["foo.bar()", "foo.bar", "parse_date", "getValue", "os.path"]);
  });
  test("report renders arms and paired differences", () => {
    const tasks = [task({ id: "x" }), task({ id: "y", repo: "o/s" })];
    const usage = {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      cashUsd: 0,
      apiEquivalentUsd: 0,
      modelCalls: 0,
      toolCalls: 0,
    };
    const runs = ["bm25", "hybrid"].flatMap((arm) =>
      tasks.map((t) => ({
        taskId: t.id,
        arm,
        usage,
        latencyMs: 1000,
        prediction: {
          files: arm === "hybrid" ? ["a.py", "b.py"] : ["a.py"],
          spans: [],
        },
      })),
    );
    const text = renderReport(scoreRuns(tasks, runs), "bm25");
    expect(text).toContain("| hybrid | 2 |");
    expect(text).toContain("Paired differences against bm25");
  });
});
