import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ModelRequest, type StreamEvent } from "@openai/agents";
import type postgres from "postgres";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { ScriptedModel, functionCall, assistantMessage } from "@opengeni/testing/scripted-model";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  initializeSessionStartAtomically,
  recoverSessionDispatch,
} from "@opengeni/db";
import { createObservability, type Observability } from "@opengeni/observability";
import {
  recordModelTransportDispatched,
  recordModelTransportStarted,
} from "../../../packages/runtime/src/model-preparation-diagnostics";
import { createActivityTestHarness } from "../src/activities";
import {
  HistoryScriptedModel,
  adminSql,
  appendCrashLog as appendCrashLogInParent,
  durableCallState,
  readCrashLog,
  scriptedRuntime,
} from "./fixtures/tool-call-crash-support";

// Every model-emitted tool call is durable (pending-call receipt and created
// event) before its tool runs, and the response's usage settles alongside.
// The crash matrix kills a real worker process at each point between a
// response's end and the next model dispatch, then runs worker-death recovery
// and a new attempt on the same PostgreSQL.

setDefaultTimeout(300_000);
let shared: RestrictedRuntimeTestDatabase;
let app: ReturnType<typeof createDb>;
let sql: postgres.Sql;
let scratch: string;
beforeAll(async () => {
  const acquired = await acquireRestrictedRuntimeTestDatabase("tool-call-durable-overlap");
  if (!acquired) throw new Error("Native PostgreSQL required");
  shared = acquired;
  app = createDb(shared.appUrl, { searchPath: shared.schema });
  sql = adminSql(shared.appUrl, shared.schema);
  scratch = mkdtempSync(join(tmpdir(), "tool-call-crash-"));
}, 600_000);
afterAll(async () => {
  await sql?.end();
  await app?.close();
  await shared?.release();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
}, 60_000);

async function fixture() {
  const subjectId = `user:tool-call-durable-overlap:${crypto.randomUUID()}`;
  const access = await bootstrapWorkspace(app.db, {
    accountExternalSource: "tool-call-durable-overlap",
    accountExternalId: crypto.randomUUID(),
    accountName: "Tool call durable overlap",
    workspaceExternalSource: "tool-call-durable-overlap",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Tool call durable overlap",
    subjectId,
  });
  const grant = access.workspaceGrants[0]!;
  return { accountId: grant.accountId, workspaceId: grant.workspaceId!, subjectId };
}
type Ctx = Awaited<ReturnType<typeof fixture>>;

/** A scripted provider that passes the same transport admission and dispatch
 * boundaries a real HTTP provider does, so dispatch timing is observed. */
class WireScriptedModel extends ScriptedModel {
  override async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    await recordModelTransportStarted();
    recordModelTransportDispatched(performance.now());
    // Provider generation time; zero by default.
    const modelMs = Number(process.env.OPENGENI_OVERLAP_BENCH_MODEL_MS ?? "0");
    if (modelMs > 0) await Bun.sleep(modelMs);
    yield* super.getStreamedResponse(request);
  }
}

async function startSession(ctx: Ctx) {
  const session = await createSession(app.db, {
    accountId: ctx.accountId,
    workspaceId: ctx.workspaceId,
    createdBy: { kind: "subject", subjectId: ctx.subjectId },
    initialMessage: "Work through the steps",
    resources: [],
    tools: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  await initializeSessionStartAtomically(app.db, {
    accountId: ctx.accountId,
    workspaceId: ctx.workspaceId,
    sessionId: session.id,
    reasoningEffortFallback: "medium",
    createdEventPayload: {},
    goal: null,
  });
  return session;
}

type Histogram = { name: string; labels?: Record<string, string> | undefined; value: number };

function recordingObservability(settings: ReturnType<typeof testSettings>) {
  const base = createObservability(settings, { component: "worker" });
  const histograms: Histogram[] = [];
  const observability: Observability = new Proxy(base, {
    get(target, key, receiver) {
      if (key === "observeHistogram") {
        return (input: Histogram) => {
          histograms.push({ name: input.name, labels: input.labels, value: input.value });
          return target.observeHistogram(input as never);
        };
      }
      return Reflect.get(target, key, receiver);
    },
  });
  return { observability, histograms };
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

test("bench: response end to next dispatch over a multi-step local turn", async () => {
  const steps = Number(process.env.OPENGENI_OVERLAP_BENCH_STEPS ?? "12");
  const toolMs = Number(process.env.OPENGENI_OVERLAP_BENCH_TOOL_MS ?? "0");
  const ctx = await fixture();
  const session = await startSession(ctx);
  const scripted = new WireScriptedModel([
    ...Array.from({ length: steps }, (_, index) => ({
      id: `step-${index}-${session.id}`,
      output: [functionCall("local_fixture", { index }, `call-${index}`)],
    })),
    { id: `answer-${session.id}`, output: [assistantMessage("All steps done.")] },
  ]);
  const atToolStart: Array<Awaited<ReturnType<typeof durableCallState>>> = [];
  const runtime = scriptedRuntime(scripted, async (callId) => {
    atToolStart.push(await durableCallState(sql, session.id, callId));
    if (toolMs > 0) await Bun.sleep(toolMs);
    return "step done";
  });
  const settings = testSettings({
    databaseUrl: shared.appUrl,
    openaiModel: "scripted-model",
    sandboxBackend: "none",
  });
  const { observability, histograms } = recordingObservability(settings);
  const activities = createActivityTestHarness({
    settings,
    db: app.db,
    bus: new MemoryEventBus(),
    runtime,
    observability,
  });
  const result = await activities.runAgentTurn({
    accountId: ctx.accountId,
    workspaceId: ctx.workspaceId,
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  expect(result.status).toBe("idle");
  expect(scripted.calls).toBe(steps + 1);
  const gaps = histograms.filter(
    (entry) => entry.name === "opengeni_model_response_to_next_dispatch_seconds",
  );
  const phases = new Map<string, number[]>();
  for (const gap of gaps) {
    const phase = gap.labels?.phase ?? "unknown";
    phases.set(phase, [...(phases.get(phase) ?? []), gap.value * 1_000]);
  }
  const totals = phases.get("total") ?? [];
  expect(totals.length).toBe(steps);
  const summary = Object.fromEntries(
    [...phases].map(([phase, values]) => [phase, Math.round(median(values) * 10) / 10]),
  );
  const stepPhases = histograms.filter(
    (entry) => entry.name === "opengeni_model_step_phase_duration_seconds",
  );
  const stepSummary = new Map<string, number[]>();
  for (const entry of stepPhases) {
    const phase = entry.labels?.phase ?? "unknown";
    stepSummary.set(phase, [...(stepSummary.get(phase) ?? []), entry.value * 1_000]);
  }
  console.log(
    "OVERLAP_BENCH",
    JSON.stringify({
      steps,
      toolMs,
      modelMs: Number(process.env.OPENGENI_OVERLAP_BENCH_MODEL_MS ?? "0"),
      responseToNextDispatchMedianMs: summary,
      modelStepPhaseMedianMs: Object.fromEntries(
        [...stepSummary].map(([phase, values]) => [phase, Math.round(median(values) * 10) / 10]),
      ),
    }),
  );
  // Every call was recoverable before its tool started.
  expect(atToolStart).toHaveLength(steps);
  for (const state of atToolStart) expect(state).toEqual({ pendingRows: 1, createdEvents: 1 });
});

const CRASH_POINTS = [
  // The provider stream ended; nothing of the response is durable yet.
  "response_end",
  // Usage settlement started (lease renewed); billing not committed.
  "settlement_started",
  // Billing committed; the usage event and history checkpoint are not.
  "billing_committed",
  // Usage event and history checkpoint committed.
  "usage_committed",
  // The tool was invoked; its side effect has not happened.
  "tool_entry",
  // The tool's side effect happened; it has not returned.
  "tool_ran",
  // The tool returned; its output is not yet persisted.
  "tool_completed",
  // Everything settled; the next model request is about to be sent.
  "next_dispatch",
] as const;

async function runCrashedAttempt(ctx: Ctx, sessionId: string, point: string, logFile: string) {
  const attemptId = crypto.randomUUID();
  const child = Bun.spawn(["bun", join(import.meta.dir, "fixtures/tool-call-crash-worker.ts")], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      TOOL_CRASH_APP_URL: shared.appUrl,
      TOOL_CRASH_SCHEMA: shared.schema,
      TOOL_CRASH_LOG: logFile,
      TOOL_CRASH_POINT: point,
      TOOL_CRASH_ACCOUNT_ID: ctx.accountId,
      TOOL_CRASH_WORKSPACE_ID: ctx.workspaceId,
      TOOL_CRASH_SESSION_ID: sessionId,
      TOOL_CRASH_ATTEMPT_ID: attemptId,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  await child.exited;
  return { attemptId, signal: child.signalCode, exitCode: child.exitCode, stdout, stderr };
}

async function durableTurnState(sessionId: string) {
  const outputs = await sql<{ id: string; payload: Record<string, unknown> }[]>`
    select payload->>'id' as id, payload from session_events
    where session_id = ${sessionId} and type = 'agent.toolCall.output' order by sequence`;
  const created = await sql<{ id: string }[]>`
    select payload->>'id' as id from session_events
    where session_id = ${sessionId} and type = 'agent.toolCall.created' order by sequence`;
  const openCalls = await sql<{ call_id: string }[]>`
    select call_id from session_pending_tool_calls
    where session_id = ${sessionId} and result_recorded_at is null`;
  const usage = await sql<{ source_resource_id: string | null; idempotency_key: string }[]>`
    select source_resource_id, idempotency_key from usage_events
    where session_id = ${sessionId} and event_type = 'model.tokens'`;
  const usageEvents = await sql<{ response_id: string | null }[]>`
    select payload->>'responseId' as response_id from session_events
    where session_id = ${sessionId} and type = 'agent.model.usage'`;
  return { outputs, created, openCalls, usage, usageEvents };
}

for (const point of CRASH_POINTS) {
  test(`a worker killed at ${point} loses no tool call or settled usage`, async () => {
    const ctx = await fixture();
    const session = await startSession(ctx);
    const logFile = join(scratch, `${point}-${session.id}.jsonl`);
    const crashed = await runCrashedAttempt(ctx, session.id, point, logFile);
    if (crashed.signal !== "SIGKILL") {
      throw new Error(
        `child did not crash at ${point} (exit ${crashed.exitCode}): ${crashed.stdout}\n${crashed.stderr.slice(-4_000)}`,
      );
    }
    const atCrash = await durableTurnState(session.id);

    // Worker-death recovery, then the same turn's next attempt (in process).
    const recovered = await recoverSessionDispatch(app.db, ctx.workspaceId, {
      sessionId: session.id,
      attemptId: crashed.attemptId,
      timeoutType: "HEARTBEAT",
      maxRedispatches: 3,
    });
    expect(recovered.action).toBe("recovering");
    const recoveredState = await durableTurnState(session.id);
    expect(recoveredState.openCalls).toHaveLength(0);

    const model = new HistoryScriptedModel({
      onResponse: (step, responseId) =>
        appendCrashLogInParent(logFile, { kind: "response", pid: process.pid, step, responseId }),
    });
    const runtime = scriptedRuntime(model, async (callId) => {
      const durable = await durableCallState(sql, session.id, callId);
      appendCrashLogInParent(logFile, { kind: "tool_entry", pid: process.pid, callId, ...durable });
      appendCrashLogInParent(logFile, { kind: "tool", pid: process.pid, callId });
      return `${callId} done`;
    });
    const settings = testSettings({
      databaseUrl: shared.appUrl,
      openaiModel: "scripted-model",
      sandboxBackend: "none",
    });
    const activities = createActivityTestHarness({
      settings,
      db: app.db,
      bus: new MemoryEventBus(),
      runtime,
      observability: createObservability(settings, { component: "worker" }),
    });
    const resumed = await activities.runAgentTurn({
      accountId: ctx.accountId,
      workspaceId: ctx.workspaceId,
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    expect(resumed.status).toBe("idle");

    const log = await readCrashLog(logFile);
    const final = await durableTurnState(session.id);
    const executions = new Map<string, number>();
    for (const entry of log) {
      if (entry.kind === "tool")
        executions.set(entry.callId, (executions.get(entry.callId) ?? 0) + 1);
    }
    // No tool started before its call was recoverable.
    for (const entry of log) {
      if (entry.kind === "tool_entry") {
        expect({
          point,
          callId: entry.callId,
          pendingRows: entry.pendingRows,
          createdEvents: entry.createdEvents,
        }).toEqual({ point, callId: entry.callId, pendingRows: 1, createdEvents: 1 });
      }
    }
    // No duplicate execution: each call ran at most once across both attempts.
    expect(executions.get("call-0")).toBe(1);
    expect(executions.get("call-1") ?? 0).toBeLessThanOrEqual(1);
    // No lost tool call: every recorded or executed call has exactly one
    // durable result, and none is left open.
    const recordedCalls = new Set([...final.created.map((row) => row.id), ...executions.keys()]);
    for (const callId of recordedCalls) {
      expect({ callId, results: final.outputs.filter((row) => row.id === callId).length }).toEqual({
        callId,
        results: 1,
      });
    }
    expect(final.openCalls).toHaveLength(0);
    // A call that ran before the crash is never asked for again: recovery
    // closed it and the model saw its (interrupted) result.
    if (atCrash.created.some((row) => row.id === "call-1")) {
      expect(
        log.filter((entry) => entry.kind === "response" && entry.step === "call-1"),
      ).toHaveLength(1);
    }
    // No lost or doubled usage: every response billed before the crash, and
    // every response of the resumed attempt, is billed exactly once.
    const billedBeforeCrash = log.flatMap((entry) =>
      entry.kind === "billed" ? [entry.responseId] : [],
    );
    const resumedResponses = log.flatMap((entry) =>
      entry.kind === "response" && entry.pid === process.pid ? [entry.responseId] : [],
    );
    const usageFor = (responseId: string) =>
      final.usage.filter(
        (row) =>
          row.source_resource_id?.includes(responseId) || row.idempotency_key.includes(responseId),
      ).length;
    for (const responseId of [...billedBeforeCrash, ...resumedResponses]) {
      expect({ responseId, usage: usageFor(responseId) }).toEqual({ responseId, usage: 1 });
    }
    for (const entry of log) {
      if (entry.kind === "response") expect(usageFor(entry.responseId)).toBeLessThanOrEqual(1);
    }
    console.log(
      "TOOL_CRASH_MATRIX",
      JSON.stringify({
        point,
        atCrash: {
          created: atCrash.created.map((row) => row.id),
          outputs: atCrash.outputs.map((row) => row.id),
          openCalls: atCrash.openCalls.map((row) => row.call_id),
          billedResponses: atCrash.usage.length,
        },
        executions: Object.fromEntries(executions),
        modelResponses: log
          .filter((entry) => entry.kind === "response")
          .map((entry) => (entry as { step: string }).step),
        billedResponses: final.usage.length,
      }),
    );
  });
}
