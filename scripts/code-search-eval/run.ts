#!/usr/bin/env bun
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
  clearIndexCache,
  hybridArm,
  jevRerankArm,
  repoMapArm,
} from "./harness/arms";
import { BudgetLedger, BudgetStop } from "./harness/budget";
import { codeSearchArm } from "./harness/code-search-arm";
import {
  contextBenchTask,
  readJsonl,
  splitByRepo,
  stratifiedSample,
  type ContextBenchRow,
} from "./harness/datasets";
import {
  createGatewayDecisionModel,
  loadGatewayTransport,
} from "./harness/gateway-decision-model";
import { RepoCache } from "./harness/repos";
import { renderReport, scoreRuns } from "./harness/report";
import type { Arm, ArmRun, Task } from "./harness/types";

const { values } = parseArgs({
  options: {
    contextbench: { type: "string" },
    tasks: { type: "string" },
    arms: { type: "string", default: "bm25,repomap,hybrid" },
    split: { type: "string", default: "test" },
    "per-language": { type: "string" },
    limit: { type: "string" },
    out: { type: "string", default: "code-search-eval-results" },
    "repo-cache": { type: "string", default: ".code-search-eval-repos" },
    "budget-usd": { type: "string", default: "0" },
    "allow-live": { type: "boolean", default: false },
    baseline: { type: "string", default: "bm25" },
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
  throw new Error("pass --contextbench rows.jsonl or --tasks tasks.jsonl");
}

let tasks = await loadTasks();
if (values.split !== "all")
  tasks = tasks.filter((t) => t.split === values.split);
if (values["per-language"])
  tasks = stratifiedSample(tasks, Number(values["per-language"]));
if (values.limit) tasks = tasks.slice(0, Number(values.limit));

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
let currentTask = "";
async function buildArms(): Promise<Arm[]> {
  const names = values.arms!.split(",").map((s) => s.trim());
  const live = names.filter((n) => n === "jev-rerank" || n === "code-search");
  let decisionModel;
  if (live.length) {
    if (!values["allow-live"] || ledger.capUsd <= 0)
      throw new Error(
        `arms ${live.join(", ")} make paid calls: pass --allow-live and an approved --budget-usd`,
      );
    const transport = await loadGatewayTransport();
    decisionModel = createGatewayDecisionModel({
      ...transport,
      ledger,
      arm: "jev",
      taskId: () => currentTask,
    });
  }
  return names.map((name) => {
    if (name === "bm25") return bm25Arm;
    if (name === "repomap") return repoMapArm;
    if (name === "hybrid") return hybridArm;
    if (name === "jev-rerank") return jevRerankArm(decisionModel!);
    if (name === "code-search") return codeSearchArm(decisionModel!);
    throw new Error(
      `unknown arm ${name}; agent and subagent arms run through the Opengeni runner and import with trajectory.ts`,
    );
  });
}

if (!values["report-only"]) {
  const arms = await buildArms();
  const repos = new RepoCache(values["repo-cache"]!);
  // Group by repository and commit so each checkout is indexed once and then removed.
  const groups = new Map<string, Task[]>();
  for (const t of tasks)
    groups.set(`${t.repo}@${t.commit}`, [
      ...(groups.get(`${t.repo}@${t.commit}`) ?? []),
      t,
    ]);
  outer: for (const group of groups.values()) {
    const { repo, repoUrl, commit } = group[0]!;
    const pending = group.flatMap((task) =>
      arms
        .filter((a) => !done.has(`${a.name}\0${task.id}`))
        .map((arm) => ({ task, arm })),
    );
    if (!pending.length) continue;
    const repoDir = repos.checkout(repo, repoUrl, commit);
    for (const { task, arm } of pending) {
      currentTask = task.id;
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
        if (error instanceof BudgetStop) {
          console.error(`stopped: ${error.message}`);
          break outer;
        }
        run = {
          taskId: task.id,
          arm: arm.name,
          prediction: { files: [], spans: [] },
          usage: {
            inputTokens: 0,
            cachedInputTokens: 0,
            outputTokens: 0,
            cashUsd: 0,
            apiEquivalentUsd: 0,
            modelCalls: 0,
            toolCalls: 0,
          },
          latencyMs: performance.now() - t0,
          error:
            error instanceof Error
              ? error.message.slice(0, 300)
              : String(error),
        };
      }
      appendFileSync(runsPath, `${JSON.stringify(run)}\n`);
    }
    clearIndexCache();
    repos.release(repo, repoUrl, commit);
  }
}

const runs = existsSync(runsPath) ? await readJsonl<ArmRun>(runsPath) : [];
const report = renderReport(scoreRuns(tasks, runs), values.baseline);
writeFileSync(join(values.out!, "report.md"), report);
console.log(report);
console.log(`spent $${ledger.spentUsd.toFixed(4)} of cap $${ledger.capUsd}`);
