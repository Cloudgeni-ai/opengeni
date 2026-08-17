import { bootstrapWorkspace, createDb, createSession, listSessionEvents } from "@opengeni/db";
import { createNatsEventBus } from "@opengeni/events";
import { createObservability } from "@opengeni/observability";
import { createProductionAgentRuntime } from "@opengeni/runtime";
import { ScriptedModel, startTestServices, testSettings } from "@opengeni/testing";
import postgres from "postgres";
import { createActivityTestHarness } from "../apps/worker/src/activities";
import { runtimeMetricsHooksForObservability } from "../apps/worker/src/observability-metrics";
import { submitTestHumanPrompt } from "../test/integration/helpers/session-control";

type CaseReceipt = {
  historyRows: number;
  historyBodyBytes: number;
  wallMs: number;
  resultStatus: string;
  terminalEvents?: Array<{ type: string; payload: unknown }>;
  eventAppendPhasesMs: Record<string, number>;
  workerPreparationMs: number | null;
  phasesMs: Record<string, number>;
};

const HISTORY_BODY_BYTES = integerArgument("--history-body-bytes", 768);
const CASE_ROWS = integerListArgument("--history-rows", [0, 100, 1_000, 8_000]);
if (HISTORY_BODY_BYTES < 0 || HISTORY_BODY_BYTES > 16_384) {
  throw new Error("--history-body-bytes must be 0..16384");
}
if (CASE_ROWS.length === 0 || CASE_ROWS.some((value) => value < 0 || value > 10_000)) {
  throw new Error("--history-rows entries must be 0..10000");
}

const services = await startTestServices({ temporal: true });
let dbClient: ReturnType<typeof createDb> | undefined;
let bus: Awaited<ReturnType<typeof createNatsEventBus>> | undefined;

try {
  await migrateQuietly();
  dbClient = createDb(services.databaseUrl);
  bus = await createNatsEventBus(services.natsUrl);

  const runId = crypto.randomUUID();
  const context = await bootstrapWorkspace(dbClient.db, {
    accountExternalSource: "bench:turn-startup",
    accountExternalId: `account:${runId}`,
    accountName: "Turn startup benchmark",
    workspaceExternalSource: "bench:turn-startup",
    workspaceExternalId: `workspace:${runId}`,
    workspaceName: "Turn startup benchmark",
    subjectId: `bench:turn-startup:${runId}`,
    subjectLabel: "Turn startup benchmark",
  });
  const grant = context.workspaceGrants[0];
  if (!grant) throw new Error("benchmark workspace grant was not created");

  const receipts: CaseReceipt[] = [];
  for (const historyRows of CASE_ROWS) {
    const session = await createSession(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: `measure ${historyRows} history rows`,
      resources: [],
      tools: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    await seedHistoryRows(services.databaseUrl, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      count: historyRows,
      bodyBytes: HISTORY_BODY_BYTES,
    });
    await submitTestHumanPrompt(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      subjectId: grant.subjectId,
      text: `measure ${historyRows} history rows`,
      resources: [],
      tools: [],
      delivery: "send",
      reasoningEffortFallback: "medium",
    });

    const settings = testSettings({
      databaseUrl: services.databaseUrl,
      natsUrl: services.natsUrl,
      temporalHost: services.temporalHost,
      sandboxBackend: "none",
      sandboxOwnershipEnabled: true,
      observabilityMetricsEnabled: true,
    });
    const observability = createObservability(settings, {
      component: `turn-startup-bench-${historyRows}`,
    });
    const runtime = createProductionAgentRuntime({
      model: new ScriptedModel([{ outputText: "ready" }]),
      metrics: runtimeMetricsHooksForObservability(observability),
    });
    const activities = createActivityTestHarness({
      settings,
      db: dbClient.db,
      bus,
      observability,
      runtime,
    });

    const startedAt = performance.now();
    const result = await activities.runAgentTurn({
      attemptId: crypto.randomUUID(),
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      trigger: { kind: "next" },
      workflowId: `bench-session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
    });
    const wallMs = performance.now() - startedAt;
    const metrics = await observability.prometheusMetrics();
    const terminalEvents =
      result.status === "failed"
        ? (await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 500))
            .slice(-12)
            .map((event) => ({ type: event.type, payload: event.payload }))
        : undefined;
    receipts.push({
      historyRows,
      historyBodyBytes: HISTORY_BODY_BYTES,
      wallMs,
      resultStatus: result.status,
      ...(terminalEvents ? { terminalEvents } : {}),
      eventAppendPhasesMs: labeledMetricSumsMs(
        metrics,
        "opengeni_session_event_append_phase_seconds",
        "phase",
      ),
      workerPreparationMs: metricSumMs(
        metrics,
        "opengeni_turn_worker_preparation_duration_seconds",
      ),
      phasesMs: phaseSumsMs(metrics),
    });
  }

  console.log(JSON.stringify({ receipts }, null, 2));
} finally {
  await Promise.allSettled([bus?.close(), dbClient?.close()]);
  await services.down();
}

// The direct activity harness intentionally owns production-style background
// handles whose public test surface has no aggregate close method. Every
// external service and client above is drained before this benchmark exits;
// do not leave a completed receipt hanging on an unrelated unref'd handle.
process.exit(0);

async function migrateQuietly(): Promise<void> {
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = () => undefined;
  console.warn = () => undefined;
  try {
    await services.migrate();
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
}

async function seedHistoryRows(
  databaseUrl: string,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    count: number;
    bodyBytes: number;
  },
): Promise<void> {
  if (input.count === 0) return;
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const body = "h".repeat(input.bodyBytes);
    for (let offset = 0; offset < input.count; offset += 500) {
      const length = Math.min(500, input.count - offset);
      const values = Array.from({ length }, (_, index) => {
        const position = offset + index;
        const user = position % 2 === 0;
        return {
          id: crypto.randomUUID(),
          account_id: input.accountId,
          workspace_id: input.workspaceId,
          session_id: input.sessionId,
          position,
          item: JSON.stringify({
            type: "message",
            role: user ? "user" : "assistant",
            status: "completed",
            content: [
              {
                type: user ? "input_text" : "output_text",
                text: `${String(position).padStart(5, "0")}:${body}`,
              },
            ],
          }),
        };
      });
      await sql`
        insert into session_history_items
          (id, account_id, workspace_id, session_id, position, item, active)
        select
          source.id::uuid,
          source.account_id::uuid,
          source.workspace_id::uuid,
          source.session_id::uuid,
          source.position::numeric,
          source.item::jsonb,
          true
        from jsonb_to_recordset(${sql.json(values)}::jsonb) as source(
          id text,
          account_id text,
          workspace_id text,
          session_id text,
          position integer,
          item text
        )
      `;
    }
  } finally {
    await sql.close();
  }
}

function metricSumMs(metrics: string, name: string): number | null {
  const line = metrics.split("\n").find((candidate) => candidate.startsWith(`${name}_sum`));
  if (!line) return null;
  const value = Number(line.slice(line.lastIndexOf(" ") + 1));
  return Number.isFinite(value) ? value * 1_000 : null;
}

function phaseSumsMs(metrics: string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const line of metrics.split("\n")) {
    if (!line.startsWith("opengeni_turn_startup_phase_duration_seconds_sum{")) continue;
    const phase = /(?:^|,)phase="([^"]+)"/u.exec(line)?.[1];
    const value = Number(line.slice(line.lastIndexOf(" ") + 1));
    if (!phase || !Number.isFinite(value)) continue;
    result[phase] = (result[phase] ?? 0) + value * 1_000;
  }
  return Object.fromEntries(Object.entries(result).sort((a, b) => b[1] - a[1]));
}

function labeledMetricSumsMs(
  metrics: string,
  name: string,
  labelName: string,
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const line of metrics.split("\n")) {
    if (!line.startsWith(`${name}_sum{`)) continue;
    const label = new RegExp(`(?:^|,)${labelName}="([^"]+)"`, "u").exec(line)?.[1];
    const value = Number(line.slice(line.lastIndexOf(" ") + 1));
    if (!label || !Number.isFinite(value)) continue;
    result[label] = (result[label] ?? 0) + value * 1_000;
  }
  return Object.fromEntries(Object.entries(result).sort((left, right) => right[1] - left[1]));
}

function stringArgument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function integerArgument(name: string, fallback: number): number {
  const value = stringArgument(name);
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
}

function integerListArgument(name: string, fallback: number[]): number[] {
  const value = stringArgument(name);
  if (value === undefined) return fallback;
  const parsed = value.split(",").map((item) => Number.parseInt(item, 10));
  if (parsed.some((item) => !Number.isSafeInteger(item))) {
    throw new Error(`${name} must be a comma-separated list of integers`);
  }
  return parsed;
}
