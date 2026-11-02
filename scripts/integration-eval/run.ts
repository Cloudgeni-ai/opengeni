#!/usr/bin/env bun
/**
 * Integration eval runner. Drives real chats through the public API, approves
 * writes the way a person would, and grades each run from the session's tool
 * receipts (forensic session events), not from the answer text alone.
 *
 *   bun scripts/integration-eval/run.ts list [--cases core]
 *   bun scripts/integration-eval/run.ts models [--cells SPEC]
 *   bun scripts/integration-eval/run.ts run --out DIR [--cells all|subscription|model@effort|model@*|model@default,...]
 *       [--cases core|all|<id or prefix>,...] [--repeats N] [--concurrency N]
 *       [--skip-integrations a,b] [--rerun DIR/results.jsonl [--failed-only]]
 *   bun scripts/integration-eval/run.ts regrade --out DIR   (re-read stored chats; no new runs)
 *   bun scripts/integration-eval/run.ts report --out DIR
 *
 * Environment: OPENGENI_EVAL_API_URL, and OPENGENI_EVAL_API_KEY (billed as
 * API use) or OPENGENI_EVAL_LOGIN_EMAIL and OPENGENI_EVAL_LOGIN_PASSWORD (a
 * signed-in test person, billed as app use),
 * OPENGENI_EVAL_CONNECTED_WORKSPACE_ID (integrations connected),
 * OPENGENI_EVAL_EMPTY_WORKSPACE_ID (nothing connected; for not_connected rows),
 * optional OPENGENI_EVAL_APP_URL for chat links, and VERIFY_* (see verify.ts).
 *
 * Results append to DIR/results.jsonl; a rerun of the same DIR skips rows that
 * already have a record, so an interrupted grid resumes where it stopped.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { authFromEnv, OpengeniApi, type SessionEvent } from "./api";
import { CASES, DEFAULT_SCOPE } from "./catalogue";
import { gradeCase, type Verification } from "./grade";
import { INTEGRATIONS } from "./integrations";
import { parseReceipts } from "./receipts";
import type { EvalCase, Grade, RunRecord } from "./types";
import { verify } from "./verify";

type Cell = { model: string; effort: string };
type Job = { testCase: EvalCase; cell: Cell; repeat: number };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const RUN_TIMEOUT_MS = Number(process.env.OPENGENI_EVAL_RUN_TIMEOUT_MS ?? 20 * 60_000);
const POLL_MS = 4_000;
const WAKE_GRACE_MS = 30_000;

function args(argv: string[]): { command: string; flags: Map<string, string> } {
  const [command = "help", ...rest] = argv;
  const flags = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index]!;
    if (!key.startsWith("--")) continue;
    const next = rest[index + 1];
    if (next === undefined || next.startsWith("--")) flags.set(key.slice(2), "true");
    else {
      flags.set(key.slice(2), next);
      index += 1;
    }
  }
  return { command, flags };
}

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`set ${name}`);
  return value;
}

/**
 * `core` is the grid set: core rows of integrations in DEFAULT_SCOPE. `scope`
 * is every row in that scope and `all` every row. Integrations with a skip
 * reason (disabled on the deployment) are dropped unless named in `include`.
 */
export function selectCases(
  selector: string | undefined,
  skip: readonly string[] = [],
  include: readonly string[] = [],
): EvalCase[] {
  const skipped = new Set([
    ...skip,
    ...INTEGRATIONS.filter((spec) => spec.skipReason && !include.includes(spec.id)).map(
      (spec) => spec.id,
    ),
  ]);
  const all = CASES.filter((testCase) => !skipped.has(testCase.integration));
  if (!selector || selector === "core") {
    return all.filter((testCase) => testCase.core && DEFAULT_SCOPE.includes(testCase.integration));
  }
  if (selector === "scope") {
    return all.filter((testCase) => DEFAULT_SCOPE.includes(testCase.integration));
  }
  if (selector === "all") return all;
  const parts = selector
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return all.filter((testCase) =>
    parts.some((part) => testCase.id === part || testCase.id.startsWith(`${part}.`)),
  );
}

type ModelConfig = {
  id: string;
  cost?: string;
  capabilities?: {
    reasoning?: { efforts?: string[]; defaultEffort?: string; runnable?: boolean };
  };
};

function configModels(config: Record<string, unknown>): ModelConfig[] {
  const allowed = new Set((config.allowedModels as string[] | undefined) ?? []);
  return ((config.models as ModelConfig[] | undefined) ?? []).filter(
    (model) => allowed.size === 0 || allowed.has(model.id),
  );
}

function modelEfforts(model: ModelConfig | undefined): string[] {
  const efforts = model?.capabilities?.reasoning?.efforts ?? [];
  return efforts.length > 0 ? efforts : ["medium"];
}

/**
 * Every model this workspace can run, at every effort it offers: credit models
 * by default, or models served through a connected subscription (`codex/*`).
 */
export function cellsFromConfig(
  config: Record<string, unknown>,
  source: "credit" | "subscription" = "credit",
): Cell[] {
  return configModels(config)
    .filter((model) => (model.cost === "subscription") === (source === "subscription"))
    .flatMap((model) => modelEfforts(model).map((effort) => ({ model: model.id, effort })));
}

/**
 * `all` (credit models), `subscription`, or comma-separated `model@effort`,
 * where effort `*` means every effort the model offers and `default` its
 * default effort.
 */
export function parseCells(spec: string | undefined, config: Record<string, unknown>): Cell[] {
  if (!spec || spec === "all") return cellsFromConfig(config);
  const models = configModels(config);
  return spec.split(",").flatMap((part) => {
    if (part === "all") return cellsFromConfig(config);
    if (part === "subscription") return cellsFromConfig(config, "subscription");
    const at = part.lastIndexOf("@");
    if (at <= 0) throw new Error(`cell "${part}" must be model@effort`);
    const model = part.slice(0, at);
    const effort = part.slice(at + 1);
    const known = models.find((candidate) => candidate.id === model);
    if (effort === "*") return modelEfforts(known).map((each) => ({ model, effort: each }));
    if (effort === "default") {
      return [{ model, effort: known?.capabilities?.reasoning?.defaultEffort ?? "medium" }];
    }
    return [{ model, effort }];
  });
}

function readRecords(file: string): RunRecord[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as RunRecord];
      } catch {
        return [];
      }
    });
}

const jobKey = (caseId: string, model: string, effort: string, repeat: number) =>
  `${caseId}|${model}|${effort}|${repeat}`;

function runMarker(): string {
  return Math.random().toString(36).slice(2, 8);
}

/** Drive one chat to rest, approving writes and letting the agent decide questions. */
async function driveSession(
  api: OpengeniApi,
  workspaceId: string,
  sessionId: string,
  decision: "approve" | "reject" = "approve",
): Promise<{ events: SessionEvent[]; timedOut: boolean }> {
  const events: SessionEvent[] = [];
  const decided = new Set<string>();
  let cursor = 0;
  let stableIdlePolls = 0;
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const page = await api.events(workspaceId, sessionId, cursor);
    events.push(...page.events);
    cursor = page.cursor;

    const receipts = parseReceipts(events);
    for (const approval of receipts.approvals) {
      if (approval.decision !== null || decided.has(approval.approvalId)) continue;
      decided.add(approval.approvalId);
      try {
        await api.decideApproval(workspaceId, sessionId, approval.approvalId, decision);
      } catch (error) {
        console.warn(`approval ${approval.approvalId} failed: ${String(error)}`);
      }
    }

    const snapshot = await api.session(workspaceId, sessionId);
    if (snapshot.status === "requires_action") {
      try {
        for (const request of await api.pendingHumanInput(workspaceId, sessionId)) {
          if (decided.has(request.id)) continue;
          decided.add(request.id);
          await api.skipHumanInput(workspaceId, sessionId, request.id);
        }
      } catch (error) {
        console.warn(`human input handling failed: ${String(error)}`);
      }
    }
    const ended = events.some((event) => /^turn\.(completed|failed|cancelled)$/.test(event.type));
    // The agent may end a turn with wait_for_input (for example to retry after
    // a rate limit); its wake starts another turn, so the chat is not done
    // until shortly after that deadline.
    const inputWait = snapshot.inputWait as { deadlineAt?: string } | null | undefined;
    const wakeAt = inputWait?.deadlineAt ? Date.parse(inputWait.deadlineAt) : Number.NaN;
    const awaitingWake = Number.isFinite(wakeAt) && Date.now() < wakeAt + WAKE_GRACE_MS;
    const resting =
      !awaitingWake &&
      !snapshot.activeTurnId &&
      !["running", "queued", "requires_action"].includes(snapshot.status);
    if (ended && resting && page.events.length === 0) {
      stableIdlePolls += 1;
      if (stableIdlePolls >= 2) return { events, timedOut: false };
    } else stableIdlePolls = 0;
  }
  return { events, timedOut: true };
}

type GradedFields = Pick<
  RunRecord,
  "grade" | "toolsUsed" | "cards" | "approvals" | "finalAnswerExcerpt" | "usage"
>;

/** Grades one finished chat from its events; shared by `run` and `regrade`. */
function gradeEvents(
  testCase: EvalCase,
  events: SessionEvent[],
  timedOut: boolean,
  verification: Verification | null,
  receiptsFile: string,
): GradedFields {
  mkdirSync(join(receiptsFile, ".."), { recursive: true });
  const receipts = parseReceipts(events);
  writeFileSync(receiptsFile, JSON.stringify(receipts, null, 2));
  let grade: Grade = timedOut
    ? { pass: false, category: "harness_error", reasons: ["run timed out"] }
    : gradeCase(testCase, receipts, verification);
  if (
    !timedOut &&
    receipts.tools.length === 0 &&
    receipts.finalAnswer === "" &&
    receipts.cards.length === 0
  ) {
    grade = {
      pass: false,
      category: "harness_error",
      reasons: ["no answer and no tool calls", ...grade.reasons],
    };
  }
  return {
    grade,
    toolsUsed: receipts.tools.map((tool) => `${tool.effectiveName}${tool.errored ? "!" : ""}`),
    cards: receipts.cards.map((card) => card.capabilityName ?? card.capabilityId ?? "?"),
    approvals: receipts.approvals.map(
      (approval) => `${approval.name}:${approval.decision ?? "pending"}`,
    ),
    finalAnswerExcerpt: receipts.finalAnswer.slice(0, 600),
    usage: receipts.usage,
  };
}

async function runJob(api: OpengeniApi, job: Job, outDir: string): Promise<RunRecord> {
  const { testCase, cell, repeat } = job;
  const marker = runMarker();
  const workspaceId =
    testCase.kind === "not_connected"
      ? env("OPENGENI_EVAL_EMPTY_WORKSPACE_ID")
      : env("OPENGENI_EVAL_CONNECTED_WORKSPACE_ID");
  const appUrl = (process.env.OPENGENI_EVAL_APP_URL ?? api.baseUrl).replace(/\/+$/, "");
  const started = Date.now();
  const base: Omit<
    RunRecord,
    | "grade"
    | "verification"
    | "toolsUsed"
    | "cards"
    | "approvals"
    | "finalAnswerExcerpt"
    | "usage"
    | "error"
    | "finishedAt"
    | "durationMs"
  > = {
    runId: marker,
    caseId: testCase.id,
    integration: testCase.integration,
    kind: testCase.kind,
    model: cell.model,
    effort: cell.effort,
    repeat,
    workspaceId,
    sessionId: null,
    chatUrl: null,
    startedAt: new Date(started).toISOString(),
  };
  const emptyUsage = { inputTokens: 0, cachedTokens: 0, outputTokens: 0, costMicros: null };
  try {
    const session = await api.createSession(workspaceId, {
      initialMessage: testCase.prompt.replaceAll("{RUN}", marker),
      model: cell.model,
      reasoningEffort: cell.effort,
      title: `eval ${testCase.id} ${cell.model}@${cell.effort} #${repeat} ${marker}`,
      idempotencyKey: `integration-eval-${marker}`,
      metadata: {
        integrationEval: {
          caseId: testCase.id,
          model: cell.model,
          effort: cell.effort,
          repeat,
          marker,
        },
      },
    });
    base.sessionId = session.id;
    base.chatUrl = `${appUrl}/workspaces/${workspaceId}/sessions/${session.id}`;
    const { events, timedOut } = await driveSession(
      api,
      workspaceId,
      session.id,
      testCase.decision ?? "approve",
    );
    const verification = testCase.kind === "write" ? await verify(testCase.verify, marker) : null;
    const graded = gradeEvents(
      testCase,
      events,
      timedOut,
      verification,
      join(outDir, "receipts", `${marker}.json`),
    );
    const finished = Date.now();
    return {
      ...base,
      finishedAt: new Date(finished).toISOString(),
      durationMs: finished - started,
      verification,
      ...graded,
      error: null,
    };
  } catch (error) {
    const finished = Date.now();
    return {
      ...base,
      finishedAt: new Date(finished).toISOString(),
      durationMs: finished - started,
      grade: { pass: false, category: "harness_error", reasons: ["run failed before grading"] },
      verification: null,
      toolsUsed: [],
      cards: [],
      approvals: [],
      finalAnswerExcerpt: "",
      usage: emptyUsage,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runAll(flags: Map<string, string>) {
  const outDir =
    flags.get("out") ??
    join("integration-eval-results", new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(outDir, { recursive: true });
  const resultsFile = join(outDir, "results.jsonl");
  const api = await new OpengeniApi(env("OPENGENI_EVAL_API_URL"), authFromEnv()).init();
  const skip = (flags.get("skip-integrations") ?? "").split(",").filter(Boolean);

  let jobs: Job[];
  const rerun = flags.get("rerun");
  if (rerun) {
    const previous = readRecords(rerun).filter(
      (record) => flags.get("failed-only") !== "true" || !record.grade.pass,
    );
    jobs = previous.flatMap((record) => {
      const testCase = CASES.find((item) => item.id === record.caseId);
      return testCase
        ? [
            {
              testCase,
              cell: { model: record.model, effort: record.effort },
              repeat: record.repeat,
            },
          ]
        : [];
    });
  } else {
    const include = (flags.get("include") ?? "").split(",").filter(Boolean);
    const cases = selectCases(flags.get("cases"), skip, include);
    const cells = parseCells(flags.get("cells"), api.clientConfig);
    const repeats = Number(flags.get("repeats") ?? 1);
    jobs = [];
    for (let repeat = 1; repeat <= repeats; repeat += 1) {
      for (const cell of cells) for (const testCase of cases) jobs.push({ testCase, cell, repeat });
    }
  }
  const done = new Set(
    readRecords(resultsFile).map((record) =>
      jobKey(record.caseId, record.model, record.effort, record.repeat),
    ),
  );
  const pending = jobs.filter(
    (job) => !done.has(jobKey(job.testCase.id, job.cell.model, job.cell.effort, job.repeat)),
  );
  // Interleave cells and integrations so a partial grid still covers every
  // model, and a capped service's rows spread across the run.
  pending.sort((a, b) => a.repeat - b.repeat || a.testCase.id.localeCompare(b.testCase.id));
  const seen = new Map<string, number>();
  const order = new Map(
    pending.map((job) => {
      const key = `${job.repeat}:${job.testCase.integration}`;
      const index = seen.get(key) ?? 0;
      seen.set(key, index + 1);
      return [job, index] as const;
    }),
  );
  pending.sort((a, b) => a.repeat - b.repeat || order.get(a)! - order.get(b)!);
  console.log(
    `${pending.length} runs to do (${jobs.length - pending.length} already recorded) -> ${resultsFile}`,
  );
  if (flags.get("dry-run") === "true") {
    for (const job of pending)
      console.log(`${job.testCase.id} ${job.cell.model}@${job.cell.effort} #${job.repeat}`);
    return;
  }

  const concurrency = Math.max(1, Number(flags.get("concurrency") ?? 4));
  // `--integration-concurrency slack=1,linear=2` caps parallel chats that
  // reach one service (its API rate limits), apart from not_connected rows.
  const caps = new Map(
    (flags.get("integration-concurrency") ?? "")
      .split(",")
      .filter(Boolean)
      .map((part) => {
        const [name = "", limit = "1"] = part.split("=");
        return [name, Math.max(1, Number(limit) || 1)] as const;
      }),
  );
  const running = new Map<string, number>();
  const capped = (job: Job) =>
    job.testCase.kind === "not_connected" ? null : (job.testCase.integration as string);
  const takeNext = (): Job | undefined => {
    const index = pending.findIndex((job) => {
      const key = capped(job);
      const limit = key ? caps.get(key) : undefined;
      return limit === undefined || (running.get(key!) ?? 0) < limit;
    });
    return index >= 0 ? pending.splice(index, 1)[0] : undefined;
  };
  const total = pending.length;
  let finished = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (pending.length > 0) {
        const job = takeNext();
        if (!job) {
          await sleep(1_000);
          continue;
        }
        const key = capped(job);
        if (key) running.set(key, (running.get(key) ?? 0) + 1);
        let record: RunRecord;
        try {
          record = await runJob(api, job, outDir);
        } finally {
          if (key) running.set(key, (running.get(key) ?? 1) - 1);
        }
        appendFileSync(resultsFile, `${JSON.stringify(record)}\n`);
        finished += 1;
        const verdict = record.grade.pass ? "PASS" : `FAIL ${record.grade.category}`;
        console.log(
          `[${finished}/${total}] ${verdict} ${record.caseId} ${record.model}@${record.effort} #${record.repeat} ${record.chatUrl ?? record.error ?? ""}`,
        );
      }
    }),
  );
  writeReport(outDir);
}

/**
 * Regrades every recorded chat from its session events with the current
 * catalogue and grader, without new chats. Write rows keep the verification
 * they had; runs that failed before grading are left as they were.
 */
async function regradeAll(flags: Map<string, string>) {
  const outDir = flags.get("out") ?? env("OPENGENI_EVAL_OUT");
  const resultsFile = join(outDir, "results.jsonl");
  const api = await new OpengeniApi(env("OPENGENI_EVAL_API_URL"), authFromEnv()).init();
  const updated: RunRecord[] = [];
  let changed = 0;
  for (const record of readRecords(resultsFile)) {
    const testCase = CASES.find((item) => item.id === record.caseId);
    const timedOut = record.grade.reasons.includes("run timed out");
    if (!testCase || !record.sessionId || record.error) {
      updated.push(record);
      continue;
    }
    try {
      const { events } = await api.events(record.workspaceId, record.sessionId, 0);
      const graded = gradeEvents(
        testCase,
        events,
        timedOut,
        record.verification,
        join(outDir, "receipts", `${record.runId}.json`),
      );
      if (graded.grade.pass !== record.grade.pass) changed += 1;
      updated.push({ ...record, ...graded });
    } catch (error) {
      console.warn(`regrade ${record.runId} failed: ${String(error)}`);
      updated.push(record);
    }
  }
  writeFileSync(resultsFile, updated.map((record) => `${JSON.stringify(record)}\n`).join(""));
  console.log(`regraded ${updated.length} runs; ${changed} changed verdict`);
  writeReport(outDir);
}

type Tally = { runs: number; pass: number; harness: number };

function tally(records: readonly RunRecord[]): Tally {
  return {
    runs: records.length,
    pass: records.filter((record) => record.grade.pass).length,
    harness: records.filter((record) => record.grade.category === "harness_error").length,
  };
}

/** Wilson 95% interval, in percent, over runs that produced a product verdict. */
export function wilson(pass: number, total: number): [number, number] {
  if (total === 0) return [0, 100];
  const z = 1.96;
  const p = pass / total;
  const denominator = 1 + (z * z) / total;
  const centre = (p + (z * z) / (2 * total)) / denominator;
  const margin =
    (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denominator;
  return [
    Math.round(Math.max(0, centre - margin) * 100),
    Math.round(Math.min(1, centre + margin) * 100),
  ];
}

const csv = (value: unknown) => {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

export function writeReport(outDir: string) {
  const records = readRecords(join(outDir, "results.jsonl"));
  const groups = new Map<string, RunRecord[]>();
  for (const record of records) {
    const key = `${record.integration}|${record.model}|${record.effort}`;
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  const matrix = [
    [
      "integration",
      "model",
      "effort",
      "runs",
      "pass",
      "fail",
      "harness_errors",
      "pass_rate",
      "failure_categories",
      "failing_chats",
    ],
  ];
  for (const [key, group] of [...groups.entries()].sort()) {
    const [integration, model, effort] = key.split("|");
    const counts = tally(group);
    const graded = counts.runs - counts.harness;
    const categories = new Map<string, number>();
    for (const record of group) {
      if (!record.grade.pass && record.grade.category) {
        categories.set(record.grade.category, (categories.get(record.grade.category) ?? 0) + 1);
      }
    }
    matrix.push([
      integration!,
      model!,
      effort!,
      String(counts.runs),
      String(counts.pass),
      String(graded - counts.pass),
      String(counts.harness),
      graded > 0 ? (counts.pass / graded).toFixed(2) : "",
      [...categories.entries()].map(([name, count]) => `${name}:${count}`).join(" "),
      group
        .filter((record) => !record.grade.pass && record.chatUrl)
        .map((record) => record.chatUrl)
        .join(" "),
    ]);
  }
  writeFileSync(
    join(outDir, "matrix.csv"),
    `${matrix.map((row) => row.map(csv).join(",")).join("\n")}\n`,
  );

  const runsHeader = [
    "case",
    "integration",
    "kind",
    "model",
    "effort",
    "repeat",
    "pass",
    "category",
    "reasons",
    "verification",
    "tools",
    "cards",
    "approvals",
    "duration_s",
    "cost_usd",
    "chat",
    "error",
  ];
  const runRows = records.map((record) => [
    record.caseId,
    record.integration,
    record.kind,
    record.model,
    record.effort,
    record.repeat,
    record.grade.pass,
    record.grade.category ?? "",
    record.grade.reasons.join("; "),
    record.verification
      ? `${record.verification.ran ? (record.verification.ok ? "ok" : "missing") : "not run"}: ${record.verification.detail}`
      : "",
    record.toolsUsed.join(" "),
    record.cards.join(" "),
    record.approvals.join(" "),
    Math.round(record.durationMs / 1000),
    record.usage.costMicros === null ? "" : (record.usage.costMicros / 1e6).toFixed(4),
    record.chatUrl ?? "",
    record.error ?? "",
  ]);
  writeFileSync(
    join(outDir, "runs.csv"),
    `${[runsHeader, ...runRows].map((row) => row.map(csv).join(",")).join("\n")}\n`,
  );

  const lines = ["# Integration eval summary", "", `Runs: ${records.length}`, ""];
  const byModel = new Map<string, RunRecord[]>();
  for (const record of records) {
    const key = `${record.model}@${record.effort}`;
    byModel.set(key, [...(byModel.get(key) ?? []), record]);
  }
  lines.push("| Cell | Runs | Pass rate (95% CI) | Harness errors |", "|---|---|---|---|");
  for (const [key, group] of [...byModel.entries()].sort()) {
    const counts = tally(group);
    const graded = counts.runs - counts.harness;
    const [low, high] = wilson(counts.pass, graded);
    const rate = graded > 0 ? Math.round((counts.pass / graded) * 100) : 0;
    lines.push(`| ${key} | ${counts.runs} | ${rate}% (${low}–${high}) | ${counts.harness} |`);
  }
  const byCategory = new Map<string, number>();
  for (const record of records) {
    if (!record.grade.pass)
      byCategory.set(
        record.grade.category ?? "?",
        (byCategory.get(record.grade.category ?? "?") ?? 0) + 1,
      );
  }
  lines.push("", "Failures by category:", "");
  for (const [category, count] of [...byCategory.entries()].sort((a, b) => b[1] - a[1]))
    lines.push(`- ${category}: ${count}`);
  writeFileSync(join(outDir, "summary.md"), `${lines.join("\n")}\n`);
  console.log(`wrote matrix.csv, runs.csv and summary.md in ${outDir}`);
}

async function main() {
  const { command, flags } = args(process.argv.slice(2));
  if (command === "list") {
    const include = (flags.get("include") ?? "").split(",").filter(Boolean);
    for (const testCase of selectCases(flags.get("cases") ?? "all", [], include)) {
      console.log(`${testCase.id}\t${testCase.kind}${testCase.core ? "\tcore" : ""}`);
    }
    return;
  }
  if (command === "models") {
    const api = await new OpengeniApi(env("OPENGENI_EVAL_API_URL"), authFromEnv()).init();
    for (const cell of parseCells(flags.get("cells"), api.clientConfig))
      console.log(`${cell.model}@${cell.effort}`);
    return;
  }
  if (command === "run") return runAll(flags);
  if (command === "regrade") return regradeAll(flags);
  if (command === "report") return writeReport(flags.get("out") ?? env("OPENGENI_EVAL_OUT"));
  console.log(readFileSync(new URL(import.meta.url), "utf8").split("*/")[0]);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exit(1);
  });
}
