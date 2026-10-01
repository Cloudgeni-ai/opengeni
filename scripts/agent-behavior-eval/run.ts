/**
 * Agent behavior eval — runs fixed scenarios against a REAL model through the
 * production agent-turn path and scores them. See README.md in this folder.
 *
 *   bun run eval:behavior -- --variants legacy --repeats 3
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

import { configuredModelPricing } from "@opengeni/config";

import { loadModelEnv } from "./env";
import { JUDGE_PROMPT_VERSION, judgeRun } from "./judge";
import { enrichObservation, SCENARIOS, selectScenarios, type Scenario } from "./scenarios";
import {
  compareVariants,
  deterministicPass,
  estimateCostUsd,
  renderMarkdown,
  summarizeVariant,
  type ScenarioInfo,
  type VariantComparison,
  type VariantSummary,
} from "./scoring";
import { startEvalStack, type EvalStack } from "./stack";
import { writeEvalCaBundle } from "./tls";
import type { RunObservation, ScenarioRunResult, UsageTotals } from "./types";
import { selectVariants, VARIANTS, type Variant } from "./variants";

const USAGE = `Usage: bun run eval:behavior -- [options]

  --variants <ids>        comma-separated variants (default: legacy; known: ${Object.keys(VARIANTS).join(", ")})
  --scenarios <ids>       comma-separated scenario ids or letter prefixes (default: all)
  --repeats <n>           runs per scenario and variant (default: 3)
  --concurrency <n>       parallel runs (default: 5)
  --model <id>            agent model (default: gpt-5.6-luna)
  --reasoning <effort>    agent reasoning effort (default: medium)
  --judge-model <id>      judge model (default: gpt-5.6-sol)
  --judge-reasoning <e>   judge reasoning effort (default: low)
  --no-judge              skip the LLM judge
  --env-file <path>       .env with OpenAI/Azure OpenAI keys (default: ./.env, then the main checkout's .env)
  --out-dir <path>        report directory (default: .agent/evidence/eval/<timestamp>-<variants> when .agent exists)
  --compare <report.json> gate every variant against the first variant of an earlier report
  --run-timeout-ms <ms>   per-run wall-clock bound (default: 480000)
  --list                  list scenarios and variants, then exit
`;

type Options = {
  variants: Variant[];
  scenarios: Scenario[];
  repeats: number;
  concurrency: number;
  model: string;
  reasoning: string;
  judgeModel: string | null;
  judgeReasoning: string;
  envFile: string | undefined;
  outDir: string;
  compare: string | undefined;
  runTimeoutMs: number;
};

function positiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function parseOptions(argv: string[]): Options | null {
  const { values } = parseArgs({
    args: argv,
    options: {
      variants: { type: "string" },
      variant: { type: "string" },
      scenarios: { type: "string" },
      repeats: { type: "string" },
      concurrency: { type: "string" },
      model: { type: "string" },
      reasoning: { type: "string" },
      "judge-model": { type: "string" },
      "judge-reasoning": { type: "string" },
      "no-judge": { type: "boolean" },
      "env-file": { type: "string" },
      "out-dir": { type: "string" },
      compare: { type: "string" },
      "run-timeout-ms": { type: "string" },
      list: { type: "boolean" },
      help: { type: "boolean" },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return null;
  }
  const variants = selectVariants(values.variants ?? values.variant);
  const scenarios = selectScenarios(values.scenarios);
  if (values.list) {
    for (const scenario of SCENARIOS) {
      process.stdout.write(
        `${scenario.id}${scenario.informational ? " (informational)" : ""} — ${scenario.intent}\n`,
      );
    }
    for (const variant of Object.values(VARIANTS)) {
      process.stdout.write(`variant ${variant.id} — ${variant.description}\n`);
    }
    return null;
  }
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-").replace(/Z$/u, "Z");
  const label = `${stamp}-${variants.map((variant) => variant.id).join("+")}`;
  const defaultRoot = existsSync(".agent")
    ? join(".agent", "evidence", "eval")
    : join(tmpdir(), "opengeni-behavior-eval");
  return {
    variants,
    scenarios,
    repeats: positiveInt(values.repeats, 3, "--repeats"),
    concurrency: positiveInt(values.concurrency, 5, "--concurrency"),
    model: values.model ?? "gpt-5.6-luna",
    reasoning: values.reasoning ?? "medium",
    judgeModel: values["no-judge"] ? null : (values["judge-model"] ?? "gpt-5.6-sol"),
    judgeReasoning: values["judge-reasoning"] ?? "low",
    envFile: values["env-file"],
    outDir: resolve(values["out-dir"] ?? join(defaultRoot, label)),
    compare: values.compare,
    runTimeoutMs: positiveInt(values["run-timeout-ms"], 480_000, "--run-timeout-ms"),
  };
}

// ---------------------------------------------------------------------------
// Process setup: Bun reads NODE_EXTRA_CA_CERTS only at startup, so the parent
// writes a CA bundle trusting the loopback TLS fake-MCP certificate and
// re-executes this script once.
// ---------------------------------------------------------------------------

function reexecWithEvalTrust(): never {
  const bundle = writeEvalCaBundle(process.env.NODE_EXTRA_CA_CERTS);
  const noProxy = [process.env.NO_PROXY, "127.0.0.1", "localhost"].filter(Boolean).join(",");
  const child = Bun.spawnSync(
    [process.execPath, "--no-env-file", import.meta.path, ...process.argv.slice(2)],
    {
      env: {
        ...process.env,
        OPENGENI_BEHAVIOR_EVAL_CHILD: "1",
        NODE_EXTRA_CA_CERTS: bundle,
        NO_PROXY: noProxy,
        no_proxy: noProxy,
      },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  process.exit(child.exitCode ?? 1);
}

function progress(line: string): void {
  process.stderr.write(`[eval] ${line}\n`);
}

/** Route the stack's own console output into harness.log so progress stays readable. */
function captureConsole(logPath: string): void {
  const write =
    (level: string) =>
    (...args: unknown[]) => {
      const text = args
        .map((arg) => (typeof arg === "string" ? arg : Bun.inspect(arg, { depth: 4 })))
        .join(" ");
      appendFileSync(logPath, `${new Date().toISOString()} ${level} ${text}\n`);
    };
  console.log = write("log");
  console.info = write("info");
  console.debug = write("debug");
  console.warn = write("warn");
  console.error = write("error");
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

type Task = { variant: Variant; scenario: Scenario; repeat: number };

function sumUsage(observation: RunObservation): UsageTotals {
  const total: UsageTotals = {
    modelCalls: 0,
    inputTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  };
  for (const session of observation.sessions) {
    for (const key of Object.keys(total) as Array<keyof UsageTotals>)
      total[key] += session.usage[key];
  }
  return total;
}

function transcriptOf(observation: RunObservation): NonNullable<ScenarioRunResult["transcript"]> {
  return {
    sessions: observation.sessions.map((session) => ({
      sessionId: session.sessionId,
      userMessages: session.userMessages,
      turnOutputs: session.turnOutputs,
      toolCalls: session.toolCalls.map((call) => ({
        name: call.name,
        arguments: (typeof call.arguments === "string"
          ? call.arguments
          : JSON.stringify(call.arguments ?? null)
        ).slice(0, 2000),
        output: call.output === null ? null : call.output.slice(0, 2000),
      })),
      availableTools: session.availableTools,
      driveStop: session.drive.stop,
      driveErrors: session.drive.errors,
    })),
  };
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  controller: AbortController,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`run exceeded ${ms} ms`));
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function runTask(
  stack: EvalStack,
  options: Options,
  task: Task,
  judgeUsage: UsageTotals,
): Promise<ScenarioRunResult> {
  const { scenario, variant, repeat } = task;
  const base = { scenarioId: scenario.id, variant: variant.id, repeat };
  const cleanups: Array<() => void | Promise<void>> = [];
  const sandboxRoots = new Set<string>();
  const controller = new AbortController();
  const started = performance.now();
  try {
    const workspace = await stack.newWorkspace(`${scenario.id} ${variant.id}#${repeat}`);
    const observation = await withTimeout(
      scenario.run({
        stack,
        workspace,
        variant,
        scenario,
        facts: {},
        signal: controller.signal,
        onCleanup: (hook) => cleanups.push(hook),
        sandboxRoots,
      }),
      options.runTimeoutMs,
      controller,
    );
    const latencyMs = performance.now() - started;
    await enrichObservation(scenario, observation, sandboxRoots);
    const transcript = transcriptOf(observation);
    if (scenario.requiresAnyTool) {
      const wanted = scenario.requiresAnyTool.tools;
      const available = observation.sessions.some((session) =>
        session.availableTools.some((tool) => wanted.includes(tool)),
      );
      if (!available) {
        return {
          ...base,
          status: "skipped",
          skipReason: `${scenario.requiresAnyTool.reason} (none of ${wanted.join(", ")} offered to the model)`,
          checks: [],
          deterministicPass: false,
          judge: null,
          metrics: null,
          transcript,
        };
      }
    }
    const environmentSkip = scenario.skipIf?.(observation) ?? null;
    if (environmentSkip) {
      return {
        ...base,
        status: "skipped",
        skipReason: environmentSkip,
        checks: [],
        deterministicPass: false,
        judge: null,
        metrics: null,
        transcript,
      };
    }
    const checks = scenario.checks(observation);
    let judge: ScenarioRunResult["judge"] = null;
    if (options.judgeModel && scenario.judgeRubric) {
      const judged = await judgeRun(
        {
          model: options.judgeModel,
          modelEnv: stack.modelEnv,
          reasoningEffort: options.judgeReasoning,
        },
        { intent: scenario.intent, rubric: scenario.judgeRubric, observation },
      );
      judge = judged.result;
      for (const key of Object.keys(judgeUsage) as Array<keyof UsageTotals>)
        judgeUsage[key] += judged.usage[key];
    }
    const usage = sumUsage(observation);
    const lastSession = observation.sessions.at(-1);
    const toolNames = observation.sessions.flatMap((session) =>
      session.toolCalls.map((call) => call.name),
    );
    return {
      ...base,
      status: "completed",
      checks,
      deterministicPass: deterministicPass(checks),
      judge,
      metrics: {
        latencyMs,
        turns: observation.sessions.reduce((sum, session) => sum + session.drive.turns, 0),
        toolCallCount: toolNames.length,
        toolNames,
        usage,
        costUsd: estimateCostUsd(usage, configuredModelPricing(stack.settings)[options.model]),
        systemPromptChars: lastSession?.systemPromptChars ?? null,
        prefixTokens: lastSession?.prefixTokens ?? null,
        upfrontToolCount: lastSession ? lastSession.upfrontTools.length : null,
      },
      transcript: transcriptOf(observation),
    };
  } catch (error) {
    return {
      ...base,
      status: "error",
      error: error instanceof Error ? error.message : String(error),
      checks: [],
      deterministicPass: false,
      judge: null,
      metrics: null,
      transcript: null,
    };
  } finally {
    for (const hook of cleanups) await Promise.resolve(hook()).catch(() => undefined);
    for (const root of sandboxRoots) {
      // Only remove provider-owned temp workspaces, never an arbitrary path.
      if (
        resolve(root).startsWith(resolve(tmpdir()) + sep) ||
        root.startsWith("/private/var/folders/") ||
        root.startsWith("/tmp/")
      ) {
        await rm(root, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }
}

async function pool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const item = items[next++]!;
        await worker(item);
      }
    }),
  );
}

function scenarioInfo(scenario: Scenario): ScenarioInfo {
  return {
    id: scenario.id,
    title: scenario.title,
    intent: scenario.intent,
    informational: scenario.informational === true,
  };
}

function gitHead(): string {
  const result = Bun.spawnSync(["git", "rev-parse", "HEAD"], { stdout: "pipe", stderr: "ignore" });
  return result.exitCode === 0 ? result.stdout.toString().trim() : "unknown";
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (!options) return;
  if (process.env.OPENGENI_BEHAVIOR_EVAL_CHILD !== "1") reexecWithEvalTrust();
  mkdirSync(options.outDir, { recursive: true });
  const logPath = join(options.outDir, "harness.log");
  const resultsPath = join(options.outDir, "results.jsonl");
  captureConsole(logPath);
  const { path: envPath, env: modelEnv } = loadModelEnv(options.envFile);
  progress(
    `model credentials from ${envPath} (${Object.keys(modelEnv).length} keys; values not logged)`,
  );
  progress(`output → ${options.outDir}`);
  const startedAt = new Date();
  const stack = await startEvalStack({
    modelEnv,
    model: options.model,
    reasoningEffort: options.reasoning,
    log: progress,
  });
  const tasks: Task[] = [];
  for (let repeat = 1; repeat <= options.repeats; repeat += 1) {
    for (const variant of options.variants) {
      for (const scenario of options.scenarios) {
        if (variant.scenarios && !variant.scenarios.includes(scenario.id)) continue;
        tasks.push({ variant, scenario, repeat });
      }
    }
  }
  const results: ScenarioRunResult[] = [];
  const judgeUsage: UsageTotals = {
    modelCalls: 0,
    inputTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  };
  const skipReasons = new Map<string, string>();
  let done = 0;
  try {
    await pool(tasks, options.concurrency, async (task) => {
      const key = `${task.variant.id}:${task.scenario.id}`;
      const knownSkip = skipReasons.get(key);
      const result: ScenarioRunResult = knownSkip
        ? {
            scenarioId: task.scenario.id,
            variant: task.variant.id,
            repeat: task.repeat,
            status: "skipped",
            skipReason: knownSkip,
            checks: [],
            deterministicPass: false,
            judge: null,
            metrics: null,
            transcript: null,
          }
        : await runTask(stack, options, task, judgeUsage);
      if (result.status === "skipped" && result.skipReason) skipReasons.set(key, result.skipReason);
      results.push(result);
      appendFileSync(resultsPath, `${JSON.stringify(result)}\n`);
      done += 1;
      const judge = result.judge
        ? "score" in result.judge
          ? ` judge=${result.judge.score}`
          : " judge=err"
        : "";
      const failed = result.checks
        .filter((check) => !check.pass && !check.informational)
        .map((check) => check.id);
      progress(
        `${done}/${tasks.length} ${task.scenario.id} ${task.variant.id}#${task.repeat} ${result.status === "completed" ? (result.deterministicPass ? "PASS" : `FAIL(${failed.join(",")})`) : result.status.toUpperCase()}${judge}${result.metrics ? ` ${(result.metrics.latencyMs / 1000).toFixed(1)}s` : ""}${result.error ? ` ${result.error.slice(0, 160)}` : ""}${result.skipReason && !knownSkip ? ` ${result.skipReason}` : ""}`,
      );
    });
  } finally {
    await stack.close().catch((error) => progress(`stack close failed: ${String(error)}`));
  }
  const finishedAt = new Date();
  results.sort(
    (a, b) =>
      a.variant.localeCompare(b.variant) ||
      a.scenarioId.localeCompare(b.scenarioId) ||
      a.repeat - b.repeat,
  );
  const infos = options.scenarios.map(scenarioInfo);
  const summaries: VariantSummary[] = options.variants.map((variant) =>
    summarizeVariant(variant.id, infos, results),
  );
  const comparisons: VariantComparison[] = [];
  if (summaries.length > 1) {
    for (const candidate of summaries.slice(1))
      comparisons.push(compareVariants(summaries[0]!, candidate));
  }
  if (options.compare) {
    const previous = JSON.parse(readFileSync(options.compare, "utf8")) as {
      variants?: VariantSummary[];
    };
    const baseline = previous.variants?.[0];
    if (!baseline) throw new Error(`${options.compare} has no variant summaries`);
    for (const candidate of summaries) comparisons.push(compareVariants(baseline, candidate));
  }
  const judgePrice = options.judgeModel
    ? configuredModelPricing(stack.settings)[options.judgeModel]
    : undefined;
  const judgeCostUsd = estimateCostUsd(judgeUsage, judgePrice) ?? 0;
  const agentCostUsd = summaries.reduce((sum, summary) => sum + summary.aggregate.costUsd, 0);
  const meta: Record<string, string> = {
    Started: startedAt.toISOString(),
    Duration: `${((finishedAt.getTime() - startedAt.getTime()) / 60_000).toFixed(1)} min`,
    "Git head": gitHead(),
    "Agent model": `${options.model} (reasoning ${options.reasoning})`,
    Judge: options.judgeModel
      ? `${options.judgeModel} (reasoning ${options.judgeReasoning}, prompt v${JUDGE_PROMPT_VERSION})`
      : "disabled",
    Repeats: String(options.repeats),
    Concurrency: String(options.concurrency),
    "Sandbox backend": "local",
    "Approx. cost": `agent $${agentCostUsd.toFixed(3)} + judge $${judgeCostUsd.toFixed(3)} (list price, no margin)`,
  };
  const report = {
    schemaVersion: 1,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    gitHead: gitHead(),
    model: options.model,
    reasoningEffort: options.reasoning,
    judge: options.judgeModel
      ? {
          model: options.judgeModel,
          reasoningEffort: options.judgeReasoning,
          promptVersion: JUDGE_PROMPT_VERSION,
        }
      : null,
    repeats: options.repeats,
    concurrency: options.concurrency,
    envFile: envPath,
    cost: { agentUsd: agentCostUsd, judgeUsd: judgeCostUsd, judgeUsage },
    scenarios: infos,
    variants: summaries,
    comparisons,
    results,
  };
  writeFileSync(join(options.outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(
    join(options.outDir, "report.md"),
    renderMarkdown({
      title: `Agent behavior eval — ${options.variants.map((variant) => variant.id).join(", ")}`,
      meta,
      scenarios: infos,
      variants: summaries,
      comparisons,
      results,
    }),
  );
  progress(`report → ${join(options.outDir, "report.md")}`);
  const gateFailed = comparisons.some((comparison) => !comparison.pass);
  process.exit(gateFailed ? 2 : 0);
}

await main();
