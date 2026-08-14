import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createDb,
  claimSessionWorkForAttempt,
  createRig,
  createRigChange,
  createRigVersion,
  createRigVersionForChangePromotion,
  createScheduledTask,
  createSession,
  getSession,
  listSessionEvents,
  listScheduledTaskRuns,
  updateScheduledTask,
  updateRigChangeStatus,
  type DbClient,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";
import { createScheduledTaskActivities } from "../src/activities/scheduled-tasks";
import { validateIncidentTelemetrySystemUpdateAuthority } from "../src/activities/incident-telemetry-authority";
import type { ActivityServices } from "../src/activities/types";
import { scheduledAlertOccurrenceIdentity } from "../src/scheduled-alert-occurrence";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql | null = null;
let client: DbClient | null = null;

function alertMetadata(
  input: {
    status?: "firing" | "resolved";
    startsAt?: string;
    fingerprint?: string;
    labels?: Record<string, string>;
    provider?: string;
  } = {},
): Record<string, unknown> {
  return {
    purpose: "incident-response",
    alert: {
      status: input.status ?? "firing",
      startsAt: input.startsAt ?? "2026-08-13T15:10:29Z",
      fingerprint: input.fingerprint ?? "provider-fingerprint-1",
      labels: input.labels ?? {
        alertname: "OpenGeniTurnWorkerMemoryConsumesReserve",
        severity: "warning",
        service: "worker-turn",
      },
      provider: input.provider ?? "alertmanager",
    },
  };
}

describe("scheduled alert occurrence identity", () => {
  test("canonicalizes simultaneous/redelivered forms without hashing prompt text", () => {
    const workspaceId = crypto.randomUUID();
    const scheduledTaskId = crypto.randomUUID();
    const first = scheduledAlertOccurrenceIdentity({
      workspaceId,
      scheduledTaskId,
      metadata: alertMetadata(),
    });
    const reordered = scheduledAlertOccurrenceIdentity({
      workspaceId,
      scheduledTaskId,
      metadata: alertMetadata({
        labels: {
          service: "worker-turn",
          severity: "warning",
          alertname: "OpenGeniTurnWorkerMemoryConsumesReserve",
        },
      }),
    });
    const resolved = scheduledAlertOccurrenceIdentity({
      workspaceId,
      scheduledTaskId,
      metadata: alertMetadata({ status: "resolved" }),
    });
    const paddedStart = scheduledAlertOccurrenceIdentity({
      workspaceId,
      scheduledTaskId,
      metadata: alertMetadata({ startsAt: "  2026-08-13T15:10:29Z  " }),
    });

    expect(first?.sessionCreateIdempotencyKey).toBe(reordered?.sessionCreateIdempotencyKey);
    expect(resolved?.sessionCreateIdempotencyKey).toBe(first?.sessionCreateIdempotencyKey);
    expect(paddedStart?.sessionCreateIdempotencyKey).toBe(first?.sessionCreateIdempotencyKey);
    expect(first?.sessionCreateIdempotencyKey).toMatch(
      /^scheduled-alert-occurrence:v1:[0-9a-f]{64}$/,
    );
    expect(first?.sessionCreateIdempotencyKey).not.toContain(
      "OpenGeniTurnWorkerMemoryConsumesReserve",
    );
    expect(first?.labels).toEqual({
      alertname: "OpenGeniTurnWorkerMemoryConsumesReserve",
      service: "worker-turn",
      severity: "warning",
    });
  });

  test("separates tasks, exact starts, provider fingerprints, labels, providers, workspaces, and reopenings", () => {
    const workspaceId = crypto.randomUUID();
    const scheduledTaskId = crypto.randomUUID();
    const key = (
      metadata: Record<string, unknown>,
      selectedWorkspaceId = workspaceId,
      selectedScheduledTaskId = scheduledTaskId,
    ) =>
      scheduledAlertOccurrenceIdentity({
        workspaceId: selectedWorkspaceId,
        scheduledTaskId: selectedScheduledTaskId,
        metadata,
      })?.sessionCreateIdempotencyKey;
    const original = key(alertMetadata());

    expect(key(alertMetadata({ startsAt: "2028-02-29T15:10:29Z" }))).toBeDefined();
    expect(key(alertMetadata({ startsAt: "2026-08-13T16:10:29Z" }))).not.toBe(original);
    expect(key(alertMetadata({ startsAt: "2026-08-13T17:10:29+02:00" }))).not.toBe(original);
    expect(key(alertMetadata({ fingerprint: "provider-fingerprint-2" }))).not.toBe(original);
    expect(
      key(
        alertMetadata({
          labels: {
            alertname: "OpenGeniTurnWorkerMemoryConsumesReserve",
            severity: "critical",
            service: "worker-turn",
          },
        }),
      ),
    ).not.toBe(original);
    expect(key(alertMetadata({ provider: "other-alert-provider" }))).not.toBe(original);
    expect(key(alertMetadata(), crypto.randomUUID())).not.toBe(original);
    expect(key(alertMetadata(), workspaceId, crypto.randomUUID())).not.toBe(original);

    const resolved = key(alertMetadata({ status: "resolved" }));
    const reopened = key(
      alertMetadata({
        status: "firing",
        startsAt: "2026-08-13T17:10:29Z",
      }),
    );
    expect(resolved).toBe(original);
    expect(reopened).not.toBe(original);
  });

  test("fails open to ordinary per-run sessions for incomplete or malformed declarations", () => {
    const workspaceId = crypto.randomUUID();
    const scheduledTaskId = crypto.randomUUID();
    for (const metadata of [
      {},
      { alert: "not-an-object" },
      {
        alert: {
          status: "firing",
          startsAt: "invalid",
          fingerprint: "fp",
          labels: {},
        },
      },
      {
        alert: {
          status: "unknown",
          startsAt: new Date().toISOString(),
          fingerprint: "fp",
          labels: { alertname: "A" },
        },
      },
      {
        alert: {
          status: "firing",
          startsAt: new Date().toISOString(),
          fingerprint: "fp",
          labels: { alertname: 7 },
        },
      },
      alertMetadata({ startsAt: "2026-02-30T15:10:29Z" }),
      alertMetadata({ startsAt: "2026-08-13T24:00:00Z" }),
      alertMetadata({ startsAt: "2026-08-13T15:10:29+24:00" }),
      alertMetadata({ startsAt: `2026-08-13T15:10:29.${"1".repeat(257)}Z` }),
    ]) {
      expect(
        scheduledAlertOccurrenceIdentity({ workspaceId, scheduledTaskId, metadata }),
      ).toBeNull();
    }
    for (const invalidScheduledTaskId of [" ", "x".repeat(257)]) {
      expect(
        scheduledAlertOccurrenceIdentity({
          workspaceId,
          scheduledTaskId: invalidScheduledTaskId,
          metadata: alertMetadata(),
        }),
      ).toBeNull();
    }
  });
});

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("worker-scheduled-alert-occurrence");
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error(
        "[worker-scheduled-alert-occurrence] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
      );
    }
    console.warn(
      "[worker-scheduled-alert-occurrence] PostgreSQL unavailable, skipping live assertions",
    );
    return;
  }
  admin = shared.admin;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
});

async function workspaceFixture() {
  const [account] = await admin!<{ id: string }[]>`
    insert into managed_accounts (name)
    values (${`scheduled-alert-${crypto.randomUUID()}`})
    returning id`;
  const [workspace] = await admin!<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${account!.id}, ${`scheduled-alert-${crypto.randomUUID()}`})
    returning id`;
  await admin!`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})`;
  return { accountId: account!.id, workspaceId: workspace!.id };
}

async function taskFixture(
  workspace: Awaited<ReturnType<typeof workspaceFixture>>,
  metadata = alertMetadata(),
  options: {
    incidentDeclaration?: boolean;
    underCapable?: boolean;
    runMode?: "new_session_per_run" | "reusable_session" | "existing_session";
    responderSessionId?: string;
    rig?: { id: string; name: string; credentialHookId: string };
    availableSeriesLabels?: string[];
  } = {},
) {
  const runMode = options.runMode ?? "new_session_per_run";
  const created = await createScheduledTask(client!.db, {
    ...workspace,
    name: `scheduled alert ${crypto.randomUUID()}`,
    status: "active",
    schedule: { type: "manual" },
    temporalScheduleId: `scheduled-alert-${crypto.randomUUID()}`,
    runMode,
    overlapPolicy: "allow_concurrent",
    agentConfig: {
      prompt: "Handle the exact structured alert occurrence without parsing this prompt.",
      resources: [],
      tools: options.underCapable ? [{ kind: "mcp" as const, id: "missing-observability" }] : [],
      metadata: { purpose: "incident-response" },
      ...(options.incidentDeclaration === false
        ? {}
        : {
            executionClass: "incident_telemetry" as const,
            incidentTelemetryPreflight: {
              requiredResources: [],
              requiredMcpServerIds: options.underCapable ? ["missing-observability"] : [],
              requiredFirstPartyMcpTools: options.underCapable ? [] : ["sessions_list"],
              requiredFirstPartyMcpPermissions: options.underCapable ? [] : ["sessions:read"],
              requiredRig: options.rig
                ? {
                    name: options.rig.name,
                    credentialHookIds: [options.rig.credentialHookId],
                  }
                : null,
              requiredVariableSetNames: [],
              requiredVariableNames: [],
              dataSource: {
                kind: "prometheus" as const,
                queryPath: "/api/v1/query" as const,
                workspaceLabel: "workspace_id",
                alertSelectorLabels: ["alertname"],
                route: options.underCapable
                  ? { kind: "mcp" as const, serverId: "missing-observability" }
                  : { kind: "first_party" as const, tool: "sessions_list" as const },
                requiredSeries: [
                  {
                    metric: "opengeni_alert_occurrence",
                    labels: ["workspace_id", "alertname"],
                  },
                ],
                availableSeries: [
                  {
                    metric: "opengeni_alert_occurrence",
                    labels: options.availableSeriesLabels ?? ["workspace_id", "alertname"],
                  },
                ],
              },
            },
          }),
      goal: {
        text: "Resolve the exact alert occurrence.",
        successCriteria: "The alert is resolved or an exact blocker is recorded.",
        maxAutoContinuations: 2,
      },
    },
    ...(runMode === "existing_session" && options.responderSessionId
      ? { targetSessionId: options.responderSessionId }
      : {}),
    ...(options.rig ? { rigId: options.rig.id } : {}),
    metadata,
  });
  if (runMode === "reusable_session" && options.responderSessionId) {
    return await updateScheduledTask(client!.db, workspace.workspaceId, created.id, {
      reusableSessionId: options.responderSessionId,
    });
  }
  return created;
}

function activities() {
  return createScheduledTaskActivities(
    async () =>
      ({
        settings: testSettings({
          databaseUrl: shared!.appUrl,
          sandboxBackend: "none",
        }),
        db: client!.db,
        bus: new MemoryEventBus(),
      }) as unknown as ActivityServices,
  );
}

describe("scheduled alert canonical responder session (real PostgreSQL)", () => {
  test("legacy structured alerts block before any run, session, event, usage, or task mutation", async () => {
    if (!shared || !client || !admin) return;
    const workspace = await workspaceFixture();
    const task = await taskFixture(workspace, alertMetadata(), { incidentDeclaration: false });
    const [before] = await admin<
      {
        runs: number;
        sessions: number;
        events: number;
        usage: number;
        taskUpdatedAt: Date;
      }[]
    >`
      select
        (select count(*)::int from scheduled_task_runs where workspace_id = ${workspace.workspaceId}) as runs,
        (select count(*)::int from sessions where workspace_id = ${workspace.workspaceId}) as sessions,
        (select count(*)::int from session_events where workspace_id = ${workspace.workspaceId}) as events,
        (select count(*)::int from usage_events where workspace_id = ${workspace.workspaceId}) as usage,
        (select updated_at from scheduled_tasks where workspace_id = ${workspace.workspaceId} and id = ${task.id}) as "taskUpdatedAt"`;

    const result = await activities().dispatchScheduledTaskRun({
      workspaceId: workspace.workspaceId,
      taskId: task.id,
      triggerType: "scheduled",
      producerKey: `legacy-preflight-${crypto.randomUUID()}`,
    });
    expect(result).toEqual({
      action: "blocked",
      reason: "incident_preflight_metadata_missing",
    });

    const [after] = await admin<
      {
        runs: number;
        sessions: number;
        events: number;
        usage: number;
        taskUpdatedAt: Date;
      }[]
    >`
      select
        (select count(*)::int from scheduled_task_runs where workspace_id = ${workspace.workspaceId}) as runs,
        (select count(*)::int from sessions where workspace_id = ${workspace.workspaceId}) as sessions,
        (select count(*)::int from session_events where workspace_id = ${workspace.workspaceId}) as events,
        (select count(*)::int from usage_events where workspace_id = ${workspace.workspaceId}) as usage,
        (select updated_at from scheduled_tasks where workspace_id = ${workspace.workspaceId} and id = ${task.id}) as "taskUpdatedAt"`;
    expect(after).toEqual(before);
    expect(await listScheduledTaskRuns(client.db, workspace.workspaceId, task.id, 10)).toEqual([]);
  });

  test("admits capable responders in all four scheduled run modes", async () => {
    if (!shared || !client) return;
    const workspace = await workspaceFixture();
    const existingResponder = async (label: string) =>
      await createSession(client.db, {
        ...workspace,
        initialMessage: label,
        resources: [],
        tools: [{ kind: "mcp", id: "opengeni" }],
        metadata: {},
        model: "scripted-model",
        sandboxBackend: "none",
      });
    const existing = await existingResponder("existing incident responder");
    const reusable = await existingResponder("reusable incident responder");
    const cases = [
      {
        label: "new_session_per_run",
        task: await taskFixture(workspace),
        expectedAction: "start",
      },
      {
        label: "reusable_session:new",
        task: await taskFixture(workspace, alertMetadata(), { runMode: "reusable_session" }),
        expectedAction: "start",
      },
      {
        label: "existing_session",
        task: await taskFixture(workspace, alertMetadata(), {
          runMode: "existing_session",
          responderSessionId: existing.id,
        }),
        expectedAction: "signal",
      },
      {
        label: "reusable_session:existing",
        task: await taskFixture(workspace, alertMetadata(), {
          runMode: "reusable_session",
          responderSessionId: reusable.id,
        }),
        expectedAction: "signal",
      },
    ] as const;

    for (const candidate of cases) {
      const result = await activities().dispatchScheduledTaskRun({
        workspaceId: workspace.workspaceId,
        taskId: candidate.task.id,
        triggerType: "scheduled",
        producerKey: `four-mode-${candidate.label}-${crypto.randomUUID()}`,
      });
      expect(result.action, candidate.label).toBe(candidate.expectedAction);
    }
  });

  test("blocks under-capable responders without run or delivery side effects in all four modes", async () => {
    if (!shared || !client || !admin) return;
    const workspace = await workspaceFixture();
    const existing = await createSession(client.db, {
      ...workspace,
      initialMessage: "existing under-capable responder",
      resources: [],
      tools: [{ kind: "mcp", id: "opengeni" }],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const reusable = await createSession(client.db, {
      ...workspace,
      initialMessage: "reusable under-capable responder",
      resources: [],
      tools: [{ kind: "mcp", id: "opengeni" }],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const tasks = [
      await taskFixture(workspace, alertMetadata(), { underCapable: true }),
      await taskFixture(workspace, alertMetadata(), {
        runMode: "reusable_session",
        underCapable: true,
      }),
      await taskFixture(workspace, alertMetadata(), {
        runMode: "existing_session",
        responderSessionId: existing.id,
        underCapable: true,
      }),
      await taskFixture(workspace, alertMetadata(), {
        runMode: "reusable_session",
        responderSessionId: reusable.id,
        underCapable: true,
      }),
    ];
    const [before] = await admin<{ runs: number; events: number; usage: number }[]>`
      select
        (select count(*)::int from scheduled_task_runs where workspace_id = ${workspace.workspaceId}) as runs,
        (select count(*)::int from session_events where workspace_id = ${workspace.workspaceId}) as events,
        (select count(*)::int from usage_events where workspace_id = ${workspace.workspaceId}) as usage`;

    for (const task of tasks) {
      expect(
        await activities().dispatchScheduledTaskRun({
          workspaceId: workspace.workspaceId,
          taskId: task.id,
          triggerType: "scheduled",
          producerKey: `four-mode-block-${task.id}`,
        }),
      ).toEqual({ action: "blocked", reason: "incident_responder_under_capable" });
    }

    const [after] = await admin<{ runs: number; events: number; usage: number }[]>`
      select
        (select count(*)::int from scheduled_task_runs where workspace_id = ${workspace.workspaceId}) as runs,
        (select count(*)::int from session_events where workspace_id = ${workspace.workspaceId}) as events,
        (select count(*)::int from usage_events where workspace_id = ${workspace.workspaceId}) as usage`;
    expect(after).toEqual(before);
  });

  test("blocks workspace-only and mismatched series with zero durable dispatch side effects", async () => {
    if (!shared || !client || !admin) return;
    const workspace = await workspaceFixture();
    const tasks = [
      await taskFixture(workspace, alertMetadata(), {
        availableSeriesLabels: ["workspace_id"],
      }),
      await taskFixture(workspace, alertMetadata(), {
        availableSeriesLabels: ["workspace_id", "service"],
      }),
    ];
    const snapshot = async () => {
      const [row] = await admin!<
        {
          runs: number;
          sessions: number;
          events: number;
          turns: number;
          updates: number;
          goals: number;
          usage: number;
        }[]
      >`
        select
          (select count(*)::int from scheduled_task_runs where workspace_id = ${workspace.workspaceId}) as runs,
          (select count(*)::int from sessions where workspace_id = ${workspace.workspaceId}) as sessions,
          (select count(*)::int from session_events where workspace_id = ${workspace.workspaceId}) as events,
          (select count(*)::int from session_turns where workspace_id = ${workspace.workspaceId}) as turns,
          (select count(*)::int from session_system_updates where workspace_id = ${workspace.workspaceId}) as updates,
          (select count(*)::int from session_goals where workspace_id = ${workspace.workspaceId}) as goals,
          (select count(*)::int from usage_events where workspace_id = ${workspace.workspaceId}) as usage`;
      return row!;
    };
    const before = await snapshot();

    for (const task of tasks) {
      expect(
        await activities().dispatchScheduledTaskRun({
          workspaceId: workspace.workspaceId,
          taskId: task.id,
          triggerType: "scheduled",
          producerKey: `series-block-${task.id}`,
        }),
      ).toEqual({ action: "blocked", reason: "incident_data_source_unsuitable" });
    }

    expect(await snapshot()).toEqual(before);
  });

  test("rejects a source-frozen responder when authority narrows before claim", async () => {
    if (!shared || !client || !admin) return;
    const workspace = await workspaceFixture();
    const task = await taskFixture(workspace);
    const dispatch = await activities().dispatchScheduledTaskRun({
      workspaceId: workspace.workspaceId,
      taskId: task.id,
      triggerType: "scheduled",
      producerKey: `authority-fence-${crypto.randomUUID()}`,
    });
    expect(dispatch.action).toBe("start");
    if (dispatch.action !== "start") return;

    await admin!`
      update sessions
      set first_party_mcp_tools = '[]'::jsonb,
          tool_policy_version = tool_policy_version + 1
      where workspace_id = ${workspace.workspaceId} and id = ${dispatch.sessionId}`;

    const claim = await claimSessionWorkForAttempt(client.db, workspace.workspaceId, {
      sessionId: dispatch.sessionId,
      workflowId: dispatch.workflowId,
      workflowRunId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
      validatePendingSystemUpdateAuthority: async (tx, update) =>
        await validateIncidentTelemetrySystemUpdateAuthority({
          db: tx,
          settings: testSettings({
            databaseUrl: shared!.appUrl,
            sandboxBackend: "none",
          }),
          workspaceId: workspace.workspaceId,
          sessionId: dispatch.sessionId,
          update,
        }),
    });
    expect(claim).toEqual({ action: "unclaimed", reason: "no-work" });

    const [run] = await listScheduledTaskRuns(client.db, workspace.workspaceId, task.id, 10);
    expect(run?.status).toBe("failed");
    const [state] = await admin!<{ state: string; turns: number }[]>`
      select
        (select state from session_system_updates
         where workspace_id = ${workspace.workspaceId}
           and session_id = ${dispatch.sessionId}
           and kind = 'scheduled_occurrence'
         order by created_at desc limit 1) as state,
        (select count(*)::int from session_turns
         where workspace_id = ${workspace.workspaceId}
           and session_id = ${dispatch.sessionId}) as turns`;
    expect(state).toEqual({ state: "failed", turns: 0 });
  });

  test("claims an unchanged source-frozen capable responder", async () => {
    if (!shared || !client) return;
    const workspace = await workspaceFixture();
    const task = await taskFixture(workspace);
    const dispatch = await activities().dispatchScheduledTaskRun({
      workspaceId: workspace.workspaceId,
      taskId: task.id,
      triggerType: "scheduled",
      producerKey: `authority-fence-valid-${crypto.randomUUID()}`,
    });
    expect(dispatch.action).toBe("start");
    if (dispatch.action !== "start") return;

    const claim = await claimSessionWorkForAttempt(client.db, workspace.workspaceId, {
      sessionId: dispatch.sessionId,
      workflowId: dispatch.workflowId,
      workflowRunId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
      validatePendingSystemUpdateAuthority: async (tx, update) =>
        await validateIncidentTelemetrySystemUpdateAuthority({
          db: tx,
          settings: testSettings({
            databaseUrl: shared!.appUrl,
            sandboxBackend: "none",
          }),
          workspaceId: workspace.workspaceId,
          sessionId: dispatch.sessionId,
          update,
        }),
    });
    expect(claim.action).toBe("claimed");
  });

  test("blocks an active but unverified incident rig before creating a run or session", async () => {
    if (!shared || !client) return;
    const workspace = await workspaceFixture();
    const rig = await createRig(client.db, {
      ...workspace,
      name: `unverified-incident-${crypto.randomUUID()}`,
      initialVersion: { credentialHooks: ["azure-monitor"] },
    });
    const task = await taskFixture(workspace, alertMetadata(), {
      rig: { id: rig.id, name: rig.name, credentialHookId: "azure-monitor" },
    });

    expect(
      await activities().dispatchScheduledTaskRun({
        workspaceId: workspace.workspaceId,
        taskId: task.id,
        triggerType: "scheduled",
        producerKey: `unverified-rig-${crypto.randomUUID()}`,
      }),
    ).toEqual({ action: "blocked", reason: "incident_responder_under_capable" });
    expect(await listScheduledTaskRuns(client.db, workspace.workspaceId, task.id, 10)).toEqual([]);
  });

  test("accepts a passing frozen rig version after a newer version becomes active", async () => {
    if (!shared || !client) return;
    const workspace = await workspaceFixture();
    const rig = await createRig(client.db, {
      ...workspace,
      name: `frozen-incident-${crypto.randomUUID()}`,
      initialVersion: { credentialHooks: ["azure-monitor"] },
    });
    const change = await createRigChange(client.db, {
      ...workspace,
      rigId: rig.id,
      baseVersionId: rig.activeVersion!.id,
      kind: "definition_edit",
      payload: { credentialHooks: ["azure-monitor"] },
    });
    await updateRigChangeStatus(client.db, workspace.workspaceId, change.id, {
      status: "proposed",
      verification: {
        startedAt: "2026-08-14T00:00:00.000Z",
        finishedAt: "2026-08-14T00:01:00.000Z",
        passed: true,
        checkResults: [],
      },
    });
    const promoted = await createRigVersionForChangePromotion(
      client.db,
      workspace.workspaceId,
      rig.id,
      change.id,
      {
        expectedActiveVersionId: rig.activeVersion!.id,
        credentialHooks: ["azure-monitor"],
      },
    );
    const responder = await createSession(client.db, {
      ...workspace,
      initialMessage: "frozen verified incident responder",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
      rigId: rig.id,
      rigVersionId: promoted.version.id,
    });
    await createRigVersion(
      client.db,
      workspace.workspaceId,
      rig.id,
      { credentialHooks: ["azure-monitor"] },
      { activate: true },
    );
    const task = await taskFixture(workspace, alertMetadata(), {
      runMode: "existing_session",
      responderSessionId: responder.id,
      rig: { id: rig.id, name: rig.name, credentialHookId: "azure-monitor" },
    });

    expect(
      (
        await activities().dispatchScheduledTaskRun({
          workspaceId: workspace.workspaceId,
          taskId: task.id,
          triggerType: "scheduled",
          producerKey: `frozen-rig-${crypto.randomUUID()}`,
        })
      ).action,
    ).toBe("signal");
  });

  test("redelivery reuses one canonical session and preserves the exact prompt", async () => {
    if (!shared || !client) return;
    const workspace = await workspaceFixture();
    const task = await taskFixture(workspace);
    const worker = activities();

    const first = await worker.dispatchScheduledTaskRun({
      workspaceId: workspace.workspaceId,
      taskId: task.id,
      triggerType: "scheduled",
      producerKey: `redelivery-first-${crypto.randomUUID()}`,
    });
    const second = await worker.dispatchScheduledTaskRun({
      workspaceId: workspace.workspaceId,
      taskId: task.id,
      triggerType: "scheduled",
      producerKey: `redelivery-second-${crypto.randomUUID()}`,
    });

    expect(first.action).toBe("start");
    expect(second.action).toBe("signal");
    expect(second.sessionId).toBe(first.sessionId);
    expect(
      (await getSession(client.db, workspace.workspaceId, first.sessionId))?.initialMessage,
    ).toBe(task.agentConfig.prompt);
    expect(
      (await listScheduledTaskRuns(client.db, workspace.workspaceId, task.id, 10)).map(
        (run) => run.sessionId,
      ),
    ).toEqual([first.sessionId, first.sessionId]);
  });

  test("simultaneous delivery for one task converges with exact run provenance", async () => {
    if (!shared || !client || !admin) return;
    const workspace = await workspaceFixture();
    const task = await taskFixture(workspace);
    const worker = activities();
    const producerKeys = [
      `simultaneous-first-${crypto.randomUUID()}`,
      `simultaneous-second-${crypto.randomUUID()}`,
    ];

    const results = await Promise.all(
      producerKeys.map(
        async (producerKey) =>
          await worker.dispatchScheduledTaskRun({
            workspaceId: workspace.workspaceId,
            taskId: task.id,
            triggerType: "scheduled",
            producerKey,
          }),
      ),
    );

    expect(new Set(results.map((result) => result.sessionId)).size).toBe(1);
    expect(results.map((result) => result.action).sort()).toEqual(["signal", "start"]);

    const sessionId = results[0]!.sessionId;
    const events = await listSessionEvents(client.db, workspace.workspaceId, sessionId, 0, 30);
    expect(events[0]?.type).toBe("session.created");
    expect(events[0]?.sequence).toBe(1);
    expect(events.filter((event) => event.type === "session.created")).toHaveLength(1);

    const goal = events.find((event) => event.type === "goal.set");
    expect(goal?.sequence).toBe(2);
    expect(goal?.payload).toMatchObject({ actor: "scheduled_task" });

    const updates = events.filter((event) => event.type === "system.update.pending");
    expect(updates).toHaveLength(2);
    const updatePayloads = updates.map((event) => event.payload as Record<string, unknown>);
    expect(new Set(updatePayloads.map((payload) => payload.updateId)).size).toBe(2);
    const taskRuns = await listScheduledTaskRuns(client.db, workspace.workspaceId, task.id, 10);
    expect(taskRuns).toHaveLength(2);
    expect(new Set(updatePayloads.map((payload) => payload.sourceId))).toEqual(
      new Set(taskRuns.map((run) => run.id)),
    );
    const producerRows = await admin<{ id: string; producerKey: string }[]>`
      select id, producer_key as "producerKey"
      from scheduled_task_runs
      where workspace_id = ${workspace.workspaceId}
        and task_id = ${task.id}`;
    expect(new Set(producerRows.map((row) => row.id))).toEqual(
      new Set(taskRuns.map((run) => run.id)),
    );
    expect(new Set(producerRows.map((row) => row.producerKey))).toEqual(new Set(producerKeys));
    expect(updates.every((event) => event.sequence > (goal?.sequence ?? 1))).toBe(true);
  });

  test("distinct task definitions keep separate responder roots", async () => {
    if (!shared || !client || !admin) return;
    const workspace = await workspaceFixture();
    const tasks = [await taskFixture(workspace), await taskFixture(workspace)];
    const worker = activities();

    const results = await Promise.all(
      tasks.map(
        async (task) =>
          await worker.dispatchScheduledTaskRun({
            workspaceId: workspace.workspaceId,
            taskId: task.id,
            triggerType: "scheduled",
            producerKey: `distinct-task-${task.id}`,
          }),
      ),
    );

    expect(new Set(results.map((result) => result.sessionId)).size).toBe(2);
    expect(results.map((result) => result.action)).toEqual(["start", "start"]);
    for (const [index, task] of tasks.entries()) {
      const taskRuns = await listScheduledTaskRuns(client.db, workspace.workspaceId, task.id, 10);
      expect(taskRuns).toHaveLength(1);
      expect(taskRuns[0]?.sessionId).toBe(results[index]?.sessionId);
    }
    const [count] = await admin<{ count: number }[]>`
      select count(*)::int as count
      from sessions
      where workspace_id = ${workspace.workspaceId}
        and create_idempotency_key like 'scheduled-alert-occurrence:v1:%'`;
    expect(count?.count).toBe(2);
  });

  test("an atomic multi-dispatch race creates exactly one responder root", async () => {
    if (!shared || !client || !admin) return;
    const workspace = await workspaceFixture();
    const task = await taskFixture(workspace);
    const worker = activities();
    const results = await Promise.all(
      Array.from(
        { length: 12 },
        async (_, index) =>
          await worker.dispatchScheduledTaskRun({
            workspaceId: workspace.workspaceId,
            taskId: task.id,
            triggerType: "scheduled",
            producerKey: `atomic-race-${index}-${crypto.randomUUID()}`,
          }),
      ),
    );
    const sessionIds = new Set(results.map((result) => result.sessionId));
    expect(sessionIds.size).toBe(1);
    expect(results.filter((result) => result.action === "start")).toHaveLength(1);
    expect(results.filter((result) => result.action === "signal")).toHaveLength(11);
    const [count] = await admin<{ count: number }[]>`
      select count(*)::int as count
      from sessions
      where workspace_id = ${workspace.workspaceId}
        and create_idempotency_key like 'scheduled-alert-occurrence:v1:%'`;
    expect(count?.count).toBe(1);
  });
});
