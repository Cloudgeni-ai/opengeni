import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { tool, type Model } from "@openai/agents";
import {
  CreateScheduledTaskRequest,
  UpdateScheduledTaskRequest,
  type AccessGrant,
} from "@opengeni/contracts";
import {
  createValidatedScheduledTask,
  updateScheduledTaskForApi,
  validatedScheduledTaskUpdate,
} from "@opengeni/core";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  getActiveSessionHistoryItemsPaged,
  hasPendingSteerForTurn,
  initializeSessionStartAtomically,
  listScheduledTaskRuns,
  listSessionEvents,
} from "@opengeni/db";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { ScriptedModel, functionCall, assistantMessage } from "@opengeni/testing/scripted-model";
import { createProductionAgentRuntime, type OpenGeniRuntime } from "@opengeni/runtime";
import { createActivityTestHarness } from "../src/activities";
import { createScheduledTaskActivities } from "../src/activities/scheduled-tasks";
import type { ActivityServices } from "../src/activities/types";

// An automation that continues a chat with overlap `steer` hands its own
// running turn over at the next model step when its next run arrives, the
// way a person's Steer does: the step's tool calls finish, and the next run
// starts on the same history. Work anyone else started in the chat, and the
// other overlap choices, keep waiting for the whole turn. Real worker turn
// and scheduled dispatch paths, real PostgreSQL in the production RLS
// posture, and an offline ScriptedModel. No provider, network or paid model.
setDefaultTimeout(180_000);
let shared: RestrictedRuntimeTestDatabase;
let app: ReturnType<typeof createDb>;
const bus = new MemoryEventBus();
beforeAll(async () => {
  const acquired = await acquireRestrictedRuntimeTestDatabase("automation-steer");
  if (!acquired) throw new Error("Native PostgreSQL required for automation steer tests");
  shared = acquired;
  app = createDb(shared.appUrl, { searchPath: shared.schema });
}, 600_000);
afterAll(async () => {
  await app?.close();
  await shared?.release();
}, 60_000);

const PROMPT = "Read the new messages and answer them";
/** A failed check inside the tool would only become a tool error; runTurn rethrows it. */
const callbackFailures: unknown[] = [];

function settings() {
  return testSettings({
    databaseUrl: shared.appUrl,
    openaiModel: "scripted-model",
    sandboxBackend: "none",
  });
}

async function fixture() {
  const subjectId = `user:automation-steer:${crypto.randomUUID()}`;
  const access = await bootstrapWorkspace(app.db, {
    accountExternalSource: "automation-steer",
    accountExternalId: crypto.randomUUID(),
    accountName: "Automation steer",
    workspaceExternalSource: "automation-steer",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Automation steer",
    subjectId,
  });
  const grant: AccessGrant = access.workspaceGrants[0]!;
  // A scheduled run acts as its owner, who needs current organization membership.
  const [personal] = await shared.admin<Array<{ id: string }>>`
    insert into workspaces (account_id, name) values (${grant.accountId}, 'Personal') returning id`;
  await shared.admin`insert into organization_memberships
    (account_id, subject_id, status, personal_workspace_id)
    values (${grant.accountId}, ${subjectId}, 'active', ${personal!.id})`;
  const session = await createSession(app.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    createdBy: { kind: "subject", subjectId },
    initialMessage: "Work through the long task",
    resources: [],
    tools: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  await initializeSessionStartAtomically(app.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    sessionId: session.id,
    reasoningEffortFallback: "medium",
    createdEventPayload: {},
    goal: null,
  });
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    grant,
    sessionId: session.id,
  };
}
type Ctx = Awaited<ReturnType<typeof fixture>>;

async function automation(
  ctx: Ctx,
  /** Undefined creates the automation with the default choice. */
  overlapPolicy: "steer" | "buffer_one" | "skip" | undefined,
  name = "Answer new messages",
) {
  return await createValidatedScheduledTask({
    settings: settings(),
    db: app.db,
    objectStorage: null,
    grant: ctx.grant,
    payload: CreateScheduledTaskRequest.parse({
      name,
      schedule: { type: "manual" },
      prompt: PROMPT,
      targetSessionId: ctx.sessionId,
      ...(overlapPolicy ? { overlapPolicy } : {}),
    }),
  });
}

async function fire(ctx: Ctx, taskId: string) {
  const result = await createScheduledTaskActivities(
    async () =>
      ({
        settings: settings(),
        db: app.db,
        bus,
        wakeSessionWorkflow: async () => undefined,
      }) as unknown as ActivityServices,
  ).dispatchScheduledTaskRun({
    workspaceId: ctx.workspaceId,
    taskId,
    triggerType: "scheduled",
    producerKey: `automation-steer:${crypto.randomUUID()}`,
  });
  return result;
}

/** Offline runtime: the production SDK call flow over a ScriptedModel plus one local tool. */
function scriptedRuntime(scripted: Model, onTool: () => Promise<void>): OpenGeniRuntime {
  const production = createProductionAgentRuntime({ model: scripted });
  return {
    ...production,
    configure: () => {},
    resolveTurnModel: () => ({
      provider: { id: "test-chat", label: "Offline", kind: "api-key", api: "chat", builtin: false },
      client: {} as NonNullable<ReturnType<OpenGeniRuntime["resolveTurnModel"]>>["client"],
      model: scripted,
      configured: {
        id: "scripted-model",
        label: "Offline",
        providerId: "test-chat",
        providerLabel: "Offline",
        api: "chat",
        contextWindowTokens: 250_000,
        effectiveContextWindowTokens: 250_000,
        autoCompactTokenLimit: 225_000,
        reasoningEffort: false,
        hostedWebSearch: false,
      },
    }),
    buildAgent: (...args) => {
      const agent = production.buildAgent(...args);
      agent.tools.push(
        tool({
          name: "local_fixture",
          description: "Offline step of the work",
          parameters: { type: "object", properties: {}, additionalProperties: false },
          strict: false,
          execute: async () => {
            try {
              await onTool();
            } catch (error) {
              callbackFailures.push(error);
            }
            // The step keeps working after the next run arrives: a handover
            // never cuts off a call in progress.
            await Bun.sleep(50);
            return "step done";
          },
        }),
      );
      return agent;
    },
  };
}

async function runTurn(ctx: Ctx, runtime: OpenGeniRuntime) {
  const result = await createActivityTestHarness({
    settings: settings(),
    db: app.db,
    bus,
    runtime,
  }).runAgentTurn({
    accountId: ctx.accountId,
    workspaceId: ctx.workspaceId,
    sessionId: ctx.sessionId,
    workflowId: `session-${ctx.sessionId}`,
    workflowRunId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  const failure = callbackFailures.shift();
  if (failure) throw failure;
  return result;
}

async function turns(sessionId: string) {
  return await shared.admin<
    Array<{ id: string; status: string; scheduled_task_run_id: string | null }>
  >`select id, status, scheduled_task_run_id from session_turns
     where session_id = ${sessionId} order by created_at`;
}

async function occurrences(sessionId: string) {
  return await shared.admin<Array<{ scheduled_task_run_id: string; state: string }>>`
    select scheduled_task_run_id, state from session_system_updates
     where session_id = ${sessionId} and kind = 'scheduled_occurrence' order by created_at`;
}

async function runsOldestFirst(ctx: Ctx, taskId: string) {
  return (await listScheduledTaskRuns(app.db, ctx.workspaceId, taskId)).reverse();
}

async function supersededAtModelStep(ctx: Ctx) {
  return (
    await listSessionEvents(app.db, ctx.workspaceId, ctx.sessionId, { after: 0, limit: 500 })
  ).filter((event) => event.type === "turn.superseded");
}

function historyShape(rows: Array<{ item: unknown }>) {
  return rows.flatMap((row) => {
    const item = row.item as { type?: string; role?: string; content?: unknown; name?: string };
    if (item.role === "system" || item.role === "developer") return [];
    const text = JSON.stringify(item.content ?? "");
    if (item.role === "user")
      return [
        text.includes(PROMPT)
          ? "user:automation"
          : text.includes("Work through the long task")
            ? "user:task"
            : "user:other",
      ];
    if (item.type === "function_call") return [`call:${item.name}`];
    if (item.type === "function_call_result") return ["result"];
    if (item.role === "assistant") return ["assistant"];
    return [`${item.type ?? "item"}:${item.role ?? "none"}`];
  });
}

/** The person's opening turn finishes before any automation runs. */
async function finishOpeningTurn(ctx: Ctx, scripted: ScriptedModel, runtime: OpenGeniRuntime) {
  expect((await runTurn(ctx, runtime)).status).toBe("idle");
  expect(scripted.calls).toBe(1);
}

test("steer: the automation's next run reaches its running turn at the next model step", async () => {
  const ctx = await fixture();
  const task = await automation(ctx, "steer");
  let secondRun = false;
  const scripted = new ScriptedModel([
    { id: `opening-${ctx.sessionId}`, output: [assistantMessage("Ready.")] },
    { id: `run-1-step-${ctx.sessionId}`, output: [functionCall("local_fixture", {}, "call-1")] },
    // Without the handover the first run would spend this response before
    // the second run is read; with it, the second run's turn answers here.
    { id: `run-2-answer-${ctx.sessionId}`, output: [assistantMessage("Answered both.")] },
  ]);
  const runtime = scriptedRuntime(scripted, async () => {
    if (secondRun) return;
    secondRun = true;
    // The next event arrives while the first run's tool step is working.
    expect((await fire(ctx, task.id)).action).toBe("signal");
  });
  await finishOpeningTurn(ctx, scripted, runtime);

  expect((await fire(ctx, task.id)).action).toBe("signal");
  expect((await runTurn(ctx, runtime)).status).toBe("idle");
  // The first run handed over before its second model request.
  expect(scripted.calls).toBe(2);
  const handovers = await supersededAtModelStep(ctx);
  expect(handovers).toHaveLength(1);
  expect(handovers[0]!.payload).toMatchObject({ reason: "steer", atModelStep: true });
  const [run1, run2] = await runsOldestFirst(ctx, task.id);
  const [, firstRunTurn] = await turns(ctx.sessionId);
  expect(firstRunTurn).toMatchObject({ status: "superseded", scheduled_task_run_id: run1!.id });
  expect(await occurrences(ctx.sessionId)).toEqual([
    { scheduled_task_run_id: run1!.id, state: "delivered" },
    { scheduled_task_run_id: run2!.id, state: "pending" },
  ]);

  // The second run starts next on the unchanged history: the first run's
  // call and result stay where they were, and the new run follows them.
  expect((await runTurn(ctx, runtime)).status).toBe("idle");
  expect(scripted.calls).toBe(3);
  const [, , secondRunTurn] = await turns(ctx.sessionId);
  expect(secondRunTurn).toMatchObject({ status: "completed", scheduled_task_run_id: run2!.id });
  const history = await getActiveSessionHistoryItemsPaged(app.db, ctx.workspaceId, ctx.sessionId);
  expect(historyShape(history)).toEqual([
    "user:task",
    "assistant",
    "user:automation",
    "call:local_fixture",
    "result",
    "user:automation",
    "assistant",
  ]);
});

test("steer never hands over a person's turn: the run waits until that turn finishes", async () => {
  const ctx = await fixture();
  const task = await automation(ctx, "steer");
  let fired = false;
  const scripted = new ScriptedModel([
    { id: `person-step-${ctx.sessionId}`, output: [functionCall("local_fixture", {}, "call-1")] },
    { id: `person-answer-${ctx.sessionId}`, output: [assistantMessage("Task done.")] },
    { id: `run-answer-${ctx.sessionId}`, output: [assistantMessage("Messages answered.")] },
  ]);
  const runtime = scriptedRuntime(scripted, async () => {
    if (fired) return;
    fired = true;
    expect((await fire(ctx, task.id)).action).toBe("signal");
  });

  expect((await runTurn(ctx, runtime)).status).toBe("idle");
  // The person's whole turn ran; the automation run did not cut in.
  expect(scripted.calls).toBe(2);
  expect(await supersededAtModelStep(ctx)).toEqual([]);
  const [personTurn] = await turns(ctx.sessionId);
  expect(personTurn).toMatchObject({ status: "completed", scheduled_task_run_id: null });
  const [run] = await runsOldestFirst(ctx, task.id);
  expect(await occurrences(ctx.sessionId)).toEqual([
    { scheduled_task_run_id: run!.id, state: "pending" },
  ]);

  expect((await runTurn(ctx, runtime)).status).toBe("idle");
  expect(scripted.calls).toBe(3);
  const history = await getActiveSessionHistoryItemsPaged(app.db, ctx.workspaceId, ctx.sessionId);
  expect(historyShape(history)).toEqual([
    "user:task",
    "call:local_fixture",
    "result",
    "assistant",
    "user:automation",
    "assistant",
  ]);
});

test("steer never hands over another automation's run in the same chat", async () => {
  const ctx = await fixture();
  const running = await automation(ctx, "steer", "Answer new messages");
  const other = await automation(ctx, "steer", "Post the daily brief");
  let fired = false;
  const scripted = new ScriptedModel([
    { id: `opening-${ctx.sessionId}`, output: [assistantMessage("Ready.")] },
    { id: `run-step-${ctx.sessionId}`, output: [functionCall("local_fixture", {}, "call-1")] },
    { id: `run-answer-${ctx.sessionId}`, output: [assistantMessage("Answered.")] },
  ]);
  const runtime = scriptedRuntime(scripted, async () => {
    if (fired) return;
    fired = true;
    expect((await fire(ctx, other.id)).action).toBe("signal");
  });
  await finishOpeningTurn(ctx, scripted, runtime);

  expect((await fire(ctx, running.id)).action).toBe("signal");
  expect((await runTurn(ctx, runtime)).status).toBe("idle");
  expect(scripted.calls).toBe(3);
  expect(await supersededAtModelStep(ctx)).toEqual([]);
  const [otherRun] = await runsOldestFirst(ctx, other.id);
  expect((await occurrences(ctx.sessionId)).at(-1)).toEqual({
    scheduled_task_run_id: otherRun!.id,
    state: "pending",
  });
});

test("queue keeps the next run waiting for the whole turn, and skip drops it", async () => {
  for (const overlapPolicy of ["buffer_one", "skip"] as const) {
    const ctx = await fixture();
    const task = await automation(ctx, overlapPolicy);
    let fired = false;
    const scripted = new ScriptedModel([
      { id: `opening-${ctx.sessionId}`, output: [assistantMessage("Ready.")] },
      { id: `run-1-step-${ctx.sessionId}`, output: [functionCall("local_fixture", {}, "call-1")] },
      { id: `run-1-answer-${ctx.sessionId}`, output: [assistantMessage("First run done.")] },
      { id: `run-2-answer-${ctx.sessionId}`, output: [assistantMessage("Second run done.")] },
    ]);
    const runtime = scriptedRuntime(scripted, async () => {
      if (fired) return;
      fired = true;
      await fire(ctx, task.id);
    });
    await finishOpeningTurn(ctx, scripted, runtime);

    expect((await fire(ctx, task.id)).action).toBe("signal");
    expect((await runTurn(ctx, runtime)).status).toBe("idle");
    // The first run finished its whole turn.
    expect(scripted.calls).toBe(3);
    expect(await supersededAtModelStep(ctx)).toEqual([]);
    const [run1, run2] = await runsOldestFirst(ctx, task.id);
    const [, firstRunTurn] = await turns(ctx.sessionId);
    expect(firstRunTurn).toMatchObject({ status: "completed", scheduled_task_run_id: run1!.id });
    if (overlapPolicy === "skip") {
      expect(run2).toMatchObject({ status: "skipped" });
      expect(await occurrences(ctx.sessionId)).toEqual([
        { scheduled_task_run_id: run1!.id, state: "delivered" },
      ]);
      continue;
    }
    expect(await occurrences(ctx.sessionId)).toEqual([
      { scheduled_task_run_id: run1!.id, state: "delivered" },
      { scheduled_task_run_id: run2!.id, state: "pending" },
    ]);
    expect((await runTurn(ctx, runtime)).status).toBe("idle");
    expect(scripted.calls).toBe(4);
    const [, , secondRunTurn] = await turns(ctx.sessionId);
    expect(secondRunTurn).toMatchObject({ status: "completed", scheduled_task_run_id: run2!.id });
  }
});

test("a paused steer automation no longer hands its running turn over", async () => {
  const ctx = await fixture();
  const task = await automation(ctx, "steer");
  let checked = false;
  const scripted = new ScriptedModel([
    { id: `opening-${ctx.sessionId}`, output: [assistantMessage("Ready.")] },
    { id: `run-step-${ctx.sessionId}`, output: [functionCall("local_fixture", {}, "call-1")] },
    { id: `run-answer-${ctx.sessionId}`, output: [assistantMessage("Answered.")] },
  ]);
  const runtime = scriptedRuntime(scripted, async () => {
    if (checked) return;
    checked = true;
    expect((await fire(ctx, task.id)).action).toBe("signal");
    const [, automationTurn] = await turns(ctx.sessionId);
    const pending = () =>
      hasPendingSteerForTurn(app.db, {
        accountId: ctx.accountId,
        workspaceId: ctx.workspaceId,
        sessionId: ctx.sessionId,
        turnId: automationTurn!.id,
      });
    expect(await pending()).toBe(true);
    // Let the steer watch notice the waiting run before the pause, so the
    // turn has to listen again rather than cut every later request short.
    await Bun.sleep(300);
    await shared.admin`update scheduled_tasks set status = 'paused' where id = ${task.id}`;
    expect(await pending()).toBe(false);
  });
  await finishOpeningTurn(ctx, scripted, runtime);

  expect((await fire(ctx, task.id)).action).toBe("signal");
  expect((await runTurn(ctx, runtime)).status).toBe("idle");
  // The turn finished its work and its reply; no request was cut short.
  expect(scripted.calls).toBe(3);
  expect(await supersededAtModelStep(ctx)).toEqual([]);
  const [, automationTurn] = await turns(ctx.sessionId);
  expect(automationTurn).toMatchObject({ status: "completed" });
  const history = await getActiveSessionHistoryItemsPaged(app.db, ctx.workspaceId, ctx.sessionId);
  expect(historyShape(history).slice(-1)).toEqual(["assistant"]);
});

test("new automations steer by default, and saved automations keep their choice", async () => {
  const ctx = await fixture();
  expect((await automation(ctx, undefined)).overlapPolicy).toBe("steer");
  // Runs in a new chat never overlap, so the default changes nothing for them.
  const perRun = await createValidatedScheduledTask({
    settings: settings(),
    db: app.db,
    objectStorage: null,
    grant: ctx.grant,
    payload: CreateScheduledTaskRequest.parse({
      name: "Weekly report",
      schedule: { type: "manual" },
      runMode: "new_session_per_run",
      agentConfig: { prompt: "Write the weekly report" },
    }),
  });
  expect(perRun.overlapPolicy).toBe("steer");
  // An automation saved with another choice keeps it through an edit.
  const queued = await automation(ctx, "buffer_one", "Post the daily brief");
  const update = await validatedScheduledTaskUpdate({
    settings: settings(),
    db: app.db,
    objectStorage: null,
    grant: ctx.grant,
    existing: queued,
    payload: UpdateScheduledTaskRequest.parse({ prompt: "Post the daily brief, shorter" }),
  });
  const edited = await updateScheduledTaskForApi(app.db, ctx.grant, queued.id, update);
  expect(edited.agentConfig.prompt).toBe("Post the daily brief, shorter");
  expect(edited.overlapPolicy).toBe("buffer_one");
});
