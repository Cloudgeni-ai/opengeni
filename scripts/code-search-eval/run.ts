#!/usr/bin/env bun
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  bm25Arm,
  bm25FileArm,
  clearIndexCache,
  denseArm,
  densePool,
  hybridArm,
  hybridDenseArm,
  jevRerankArm,
  repoMapArm,
  type DenseScores,
} from "./harness/arms";
import { BudgetLedger, BudgetStop } from "./harness/budget";
import { codeSearchArm } from "./harness/code-search-arm";
import {
  contextBenchTask,
  readJsonl,
  splitByRepo,
  stratifiedSample,
  sweBenchTask,
  type ContextBenchRow,
  type SweBenchRow,
} from "./harness/datasets";
import {
  createDecisionModelsDecisionModel,
  TokenLedger,
} from "./harness/decision-models";
import {
  createGatewayDecisionModel,
  loadGatewayTransport,
} from "./harness/gateway-decision-model";
import { RepoCache } from "./harness/repos";
import {
  calibrateCut,
  renderReport,
  scoreRuns,
  thresholdVariant,
} from "./harness/report";
import type { DecisionModel } from "../../packages/decisions/src/types";
import type { Arm, ArmRun, Task } from "./harness/types";

const { values } = parseArgs({
  options: {
    contextbench: { type: "string" },
    swebench: { type: "string" },
    tasks: { type: "string" },
    arms: { type: "string", default: "bm25,repomap,hybrid" },
    split: { type: "string", default: "test" },
    "per-language": { type: "string" },
    limit: { type: "string" },
    shard: { type: "string" },
    concurrency: { type: "string", default: "1" },
    out: { type: "string", default: "code-search-eval-results" },
    "repo-cache": { type: "string", default: ".code-search-eval-repos" },
    "budget-usd": { type: "string", default: "0" },
    "token-cap": { type: "string", default: "0" },
    "token-ledger": { type: "string" },
    "dm-model": { type: "string", default: "s1-pro" },
    "dump-pool": { type: "string" },
    "dense-scores": { type: "string" },
    "allow-live": { type: "boolean", default: false },
    baseline: { type: "string", default: "bm25" },
    "calibrate-on": { type: "string" },
    "report-only": { type: "boolean", default: false },
  },
});

async function loadTasks(): Promise<Task[]> {
  if (values.tasks) return readJsonl<Task>(values.tasks);
  // Tasks whose whole gold lies outside the repository have nothing a search could find.
  if (values.contextbench)
    return splitByRepo(
      (await readJsonl<ContextBenchRow>(values.contextbench)).map(
        contextBenchTask,
      ),
    ).filter((t) => t.oracle.files.length);
  if (values.swebench)
    return (await readJsonl<SweBenchRow>(values.swebench))
      .map((r) => ({ ...sweBenchTask(r), split: "test" as const }))
      .filter((t) => t.oracle.files.length);
  throw new Error("pass --contextbench, --swebench or --tasks");
}

let tasks = await loadTasks();
if (values.split !== "all")
  tasks = tasks.filter((t) => t.split === values.split);
if (values["per-language"])
  tasks = stratifiedSample(tasks, Number(values["per-language"]));
if (values.limit) tasks = tasks.slice(0, Number(values.limit));
if (values.shard) {
  // i/n: a repository always lands in the same shard, so shards never share a checkout.
  const [i, n] = values.shard.split("/").map(Number) as [number, number];
  tasks = tasks.filter(
    (t) =>
      createHash("sha256").update(t.repo).digest().readUInt32BE(0) % n === i,
  );
}

mkdirSync(values.out!, { recursive: true });
const runsPath = join(values.out!, "runs.jsonl");
writeFileSync(
  join(values.out!, "tasks.jsonl"),
  tasks.map((t) => JSON.stringify(t)).join("\n") + "\n",
);
const done = new Set(
  existsSync(runsPath)
    ? readFileSync(runsPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          const r = JSON.parse(l) as ArmRun;
          return `${r.arm}\0${r.taskId}`;
        })
    : [],
);

const ledger = new BudgetLedger(
  Number(values["budget-usd"]),
  join(values.out!, "ledger.jsonl"),
);
const tokens = new TokenLedger(
  Number(values["token-cap"]),
  values["token-ledger"] ?? join(values.out!, "tokens.jsonl"),
);
/** Per-task attribution of decision usage under concurrency. */
const taskStore = new AsyncLocalStorage<string>();
const currentTask = {
  run: <T>(id: string, fn: () => Promise<T>) => taskStore.run(id, fn),
  get: () => taskStore.getStore() ?? "",
};

async function buildArms(): Promise<Arm[]> {
  const names = values.arms!.split(",").map((s) => s.trim());
  let denseScores: DenseScores | undefined;
  if (values["dense-scores"]) {
    denseScores = new Map();
    for (const row of await readJsonl<{
      taskId: string;
      chunks: DenseScores extends Map<string, infer V> ? V : never;
    }>(values["dense-scores"]))
      denseScores.set(row.taskId, row.chunks);
  }
  const gatewayArms = names.filter(
    (n) => n === "jev-rerank" || n === "code-search",
  );
  const dmArms = names.filter(
    (n) => n === "dm-rerank" || n === "dm-code-search",
  );
  let gatewayModel: DecisionModel | undefined;
  let dmModel: DecisionModel | undefined;
  if (gatewayArms.length) {
    if (!values["allow-live"] || ledger.capUsd <= 0)
      throw new Error(
        `arms ${gatewayArms.join(", ")} make paid calls: pass --allow-live and an approved --budget-usd`,
      );
    const transport = await loadGatewayTransport();
    gatewayModel = createGatewayDecisionModel({
      ...transport,
      ledger,
      arm: "jev",
      taskId: () => currentTask.get(),
    });
  }
  if (dmArms.length) {
    if (!values["allow-live"] || tokens.capTokens <= 0)
      throw new Error(
        `arms ${dmArms.join(", ")} use the Decision Models allowance: pass --allow-live and --token-cap`,
      );
    const apiKey = process.env.DECISION_MODELS_API_KEY;
    if (!apiKey) throw new Error("DECISION_MODELS_API_KEY is not set");
    dmModel = createDecisionModelsDecisionModel({
      apiKey,
      model: values["dm-model"]!,
      ledger: tokens,
      arm: "decision-models",
      taskId: () => currentTask.get(),
    });
  }
  return names.map((name) => {
    if (name === "bm25") return bm25Arm;
    if (name === "bm25-file") return bm25FileArm;
    if (name === "repomap") return repoMapArm;
    if (name === "hybrid") return hybridArm;
    if (name === "jev-rerank") return jevRerankArm(gatewayModel!);
    if (name === "code-search") return codeSearchArm(gatewayModel!);
    if (name === "dm-rerank")
      // Decision Models takes 3 questions and 8K input tokens per s1-pro request: 3 candidates per
      // call with shorter excerpts keeps a call inside both limits.
      return jevRerankArm(dmModel!, {
        name: "dm-rerank",
        batch: 3,
        excerptLines: 30,
        maxTaskChars: 5000,
      });
    if (name === "dm-code-search")
      return codeSearchArm(dmModel!, "dm-code-search");
    if (name === "dense" || name === "hybrid-dense") {
      if (!denseScores) throw new Error(`${name} needs --dense-scores`);
      return name === "dense"
        ? denseArm(denseScores)
        : hybridDenseArm(denseScores);
    }
    throw new Error(
      `unknown arm ${name}; agent and subagent arms import through trajectory.ts`,
    );
  });
}

const emptyUsage = () => ({
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  cashUsd: 0,
  apiEquivalentUsd: 0,
  modelCalls: 0,
  toolCalls: 0,
});

async function mapLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, limit) }, async () => {
      while (next < items.length) await fn(items[next++]!);
    }),
  );
}

if (!values["report-only"]) {
  const arms = await buildArms();
  const repos = new RepoCache(values["repo-cache"]!);
  const poolPath = values["dump-pool"];
  const pooled = new Set(
    poolPath && existsSync(poolPath)
      ? readFileSync(poolPath, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => (JSON.parse(l) as { taskId: string }).taskId)
      : [],
  );
  const groups = new Map<string, Task[]>();
  for (const t of tasks)
    groups.set(`${t.repo}@${t.commit}`, [
      ...(groups.get(`${t.repo}@${t.commit}`) ?? []),
      t,
    ]);
  let stop: BudgetStop | null = null;
  for (const group of groups.values()) {
    if (stop) break;
    const { repo, repoUrl, commit } = group[0]!;
    const pending = group.flatMap((task) =>
      arms
        .filter((a) => !done.has(`${a.name}\0${task.id}`))
        .map((arm) => ({ task, arm })),
    );
    const poolPending = poolPath ? group.filter((t) => !pooled.has(t.id)) : [];
    if (!pending.length && !poolPending.length) continue;
    let repoDir: string;
    try {
      repoDir = repos.checkout(repo, repoUrl, commit);
    } catch (error) {
      for (const { task, arm } of pending)
        appendFileSync(
          runsPath,
          `${JSON.stringify({ taskId: task.id, arm: arm.name, prediction: { files: [], spans: [] }, usage: emptyUsage(), latencyMs: 0, error: `checkout: ${String(error).slice(0, 200)}` })}\n`,
        );
      continue;
    }
    for (const task of poolPending) {
      const pool = await densePool(task, repoDir);
      appendFileSync(
        poolPath!,
        `${JSON.stringify({ taskId: task.id, query: task.query.slice(0, 8000), pool })}\n`,
      );
    }
    await mapLimit(
      pending,
      Number(values.concurrency),
      async ({ task, arm }) => {
        if (stop) return;
        await currentTask.run(task.id, async () => {
          const t0 = performance.now();
          let run: ArmRun;
          try {
            const { prediction, usage } = await arm.run(task, {
              repoDir,
              signal: AbortSignal.timeout(300_000),
            });
            run = {
              taskId: task.id,
              arm: arm.name,
              prediction,
              usage,
              latencyMs: performance.now() - t0,
            };
          } catch (error) {
            const budgetStop =
              error instanceof BudgetStop
                ? error
                : (error as { cause?: unknown })?.cause instanceof BudgetStop
                  ? (error as { cause: BudgetStop }).cause
                  : null;
            if (budgetStop) {
              stop = budgetStop;
              console.error(`stopped: ${budgetStop.message}`);
              return;
            }
            run = {
              taskId: task.id,
              arm: arm.name,
              prediction: { files: [], spans: [] },
              usage: emptyUsage(),
              latencyMs: performance.now() - t0,
              error:
                error instanceof Error
                  ? error.message.slice(0, 300)
                  : String(error),
            };
          }
          appendFileSync(runsPath, `${JSON.stringify(run)}\n`);
        });
      },
    );
    clearIndexCache();
    try {
      repos.release(repo, repoUrl, commit);
    } catch {}
  }
}

let runs = existsSync(runsPath) ? await readJsonl<ArmRun>(runsPath) : [];
// A cut for each scoring arm, chosen on dev runs only, then applied to these runs.
if (values["calibrate-on"]) {
  const devDir = values["calibrate-on"];
  const devTasks = await readJsonl<Task>(join(devDir, "tasks.jsonl"));
  const devRuns = await readJsonl<ArmRun>(join(devDir, "runs.jsonl"));
  for (const arm of [
    ...new Set(
      devRuns.filter((r) => r.prediction.fileScores).map((r) => r.arm),
    ),
  ]) {
    const cut = calibrateCut(devTasks, devRuns, arm);
    console.log(`${arm}: dev-calibrated cut ${cut}`);
    runs = [...runs, ...thresholdVariant(runs, arm, cut)];
  }
}
const report = renderReport(scoreRuns(tasks, runs), values.baseline);
writeFileSync(join(values.out!, "report.md"), report);
console.log(report);
console.log(
  `spent $${ledger.spentUsd.toFixed(4)} of cap $${ledger.capUsd}; decision tokens ${tokens.usedTokens} of cap ${tokens.capTokens}`,
);
