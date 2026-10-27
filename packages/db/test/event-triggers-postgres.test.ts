import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  DEFAULT_FIRST_PARTY_MCP_PERMISSIONS,
  DEFAULT_FIRST_PARTY_MCP_TOOLS,
  type ScheduledTask,
} from "@opengeni/contracts";
import {
  bootstrapWorkspace,
  bindGitHubInstallationRepositories,
  claimEventTriggerDispatch,
  createDb,
  createEventSource,
  createScheduledTask,
  createScheduledTaskRun,
  deleteEventSource,
  eventOccurrenceProducerKey,
  findAppEventSource,
  getEventOccurrenceForRun,
  getEventRunOccurrence,
  getNestedAgentDepthDeploymentPolicy,
  getScheduledTask,
  getScheduledTaskEvents,
  getScheduledTaskRunEventOccurrences,
  githubInstallationRouteKey,
  listDueEventTriggerTasks,
  listEventDeliveries,
  listEventSources,
  listGitHubEventRoutes,
  listInboundEvents,
  markEventOccurrenceStarted,
  markScheduledTaskRunFailedIfQueued,
  recordEventDelivery,
  recordEventOccurrenceStartFailure,
  rearmScheduledTaskEvents,
  resolveEventIngressRoute,
  retireExhaustedScheduledTask,
  reviewScheduledTaskBlockers,
  setScheduledTaskEvents,
  updateScheduledTask,
  withWorkspaceRls,
  type DbClient,
  type EventTriggerMatcher,
  type StoredEventInput,
} from "../src";
import { rawRows } from "../src/database";
import { migrate } from "../src/migrate";

let shared: SharedTestDatabase | null = null;
let client: DbClient;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("event-triggers-postgres");
  if (!shared) throw new Error("Real PostgreSQL is required");
  await migrate(shared.adminUrl);
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

// A minimal stand-in for core matching: exact types plus `*`.
const match: EventTriggerMatcher = (candidate, trigger) =>
  (candidate.actor.kind !== "opengeni" || trigger.includeOwnEvents) &&
  trigger.eventTypes.some((pattern) => pattern === "*" || pattern === candidate.type);

async function workspace() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "Event triggers",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "Event triggers",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: `subject-${suffix}`,
  };
}

type Space = Awaited<ReturnType<typeof workspace>>;

/** An automation; `owner` makes it a person's (runs then need that person's authority). */
async function task(space: Space, options: { owner?: string; schedule?: unknown } = {}) {
  return createScheduledTask(client.db, {
    accountId: space.accountId,
    workspaceId: space.workspaceId,
    ...(options.owner ? { ownerSubjectId: options.owner } : {}),
    name: "When something happens",
    status: "active",
    schedule: options.schedule ?? { type: "manual" },
    temporalScheduleId: `schedule-${crypto.randomUUID()}`,
    runMode: "new_session_per_run",
    overlapPolicy: "buffer_one",
    agentConfig: { prompt: "Look at what happened", resources: [], tools: [], metadata: {} },
    metadata: {},
    createdBy: options.owner
      ? { kind: "subject", subjectId: options.owner }
      : { kind: "service", subjectId: "scheduler" },
  } as Parameters<typeof createScheduledTask>[1]);
}

async function webhookSource(space: Space, visibility: "private" | "workspace" = "workspace") {
  const { source } = await createEventSource(client.db, {
    accountId: space.accountId,
    workspaceId: space.workspaceId,
    createdBySubjectId: space.subjectId,
    kind: "webhook",
    adapter: "standard",
    name: "Deploys",
    ownerSubjectId: space.subjectId,
    visibility,
    secretEncrypted: "encrypted-secret",
  });
  return source;
}

function event(type: string, overrides: Partial<StoredEventInput> = {}): StoredEventInput {
  return {
    externalId: null,
    streamKey: "",
    type,
    occurredAt: new Date(),
    subject: "deploy-1",
    summary: `${type} happened`,
    url: null,
    actor: { kind: "person", name: "Ada" },
    data: { id: "deploy-1" },
    dataTruncated: false,
    gapBefore: false,
    ...overrides,
  };
}

async function deliver(
  space: Space,
  sourceId: string,
  events: StoredEventInput[],
  dedupeKey = `webhook-id:${crypto.randomUUID()}`,
) {
  const body = new TextEncoder().encode(
    JSON.stringify({ events: events.map((entry) => entry.type) }),
  );
  return recordEventDelivery(client.db, {
    accountId: space.accountId,
    workspaceId: space.workspaceId,
    sourceId,
    status: "accepted",
    reason: null,
    dedupeKey,
    body,
    bodyBytes: body.byteLength,
    bodySha256: createHash("sha256").update(body).digest("hex"),
    headers: { "webhook-id": dedupeKey },
    events,
    match,
    settleMs: 0,
  });
}

async function settings(space: Space, taskId: string) {
  const [row] = await withWorkspaceRls(client.db, space.workspaceId, (scoped) =>
    rawRows<{
      dispatch_due_at: Date | null;
      throttled_since: Date | null;
      throttle_notified: boolean;
      completed_at: Date | null;
    }>(
      scoped,
      sql`select dispatch_due_at, throttled_since, throttle_notified, completed_at
        from scheduled_task_event_settings where task_id = ${taskId}`,
    ),
  );
  return row;
}

async function makeDue(space: Space, taskId: string) {
  await withWorkspaceRls(client.db, space.workspaceId, (scoped) =>
    scoped.execute(
      sql`update scheduled_task_event_settings set dispatch_due_at = now() where task_id = ${taskId}`,
    ),
  );
}

async function inboxStatuses(space: Space, taskId: string) {
  return (
    await withWorkspaceRls(client.db, space.workspaceId, (scoped) =>
      rawRows<{ status: string }>(
        scoped,
        sql`select status from scheduled_task_event_inbox where task_id = ${taskId} order by occurred_at, id`,
      ),
    )
  ).map((row) => row.status);
}

async function run(value: ScheduledTask, triggerType: "scheduled" | "event", producerKey: string) {
  const depth = await getNestedAgentDepthDeploymentPolicy(client.db);
  const runId = crypto.randomUUID();
  return createScheduledTaskRun(client.db, {
    runId,
    workspaceId: value.workspaceId,
    taskId: value.id,
    taskAuthorityRevision: value.authorityRevision,
    taskExecutionDigest: value.executionDigest,
    triggerType,
    producerKey,
    acceptedExecutionSnapshot: {
      version: 1,
      task: value,
      resolvedModel: "scripted-model",
      resolvedReasoningEffort: "medium",
      resolvedLatencyMode: "standard",
      resolvedSandboxBackend: "none",
      resolvedSandboxOs: "linux",
      resolvedTools: [],
      resolvedFirstPartyMcpTools: [...DEFAULT_FIRST_PARTY_MCP_TOOLS],
      resolvedFirstPartyMcpPermissions: [...DEFAULT_FIRST_PARTY_MCP_PERMISSIONS],
      resolvedVariableSet: null,
      resolvedRig: null,
      resolvedSlackBotConnection: null,
      targetSessionExecution: null,
      generatedSessionBinding: {
        createIdempotencyKey: `scheduled-task-run:${runId}`,
        effectiveMaxNestedAgentDepth: depth.maxNestedAgentDepth,
        nestedAgentDepthPolicySource: depth.policySource,
        codexCompactionMode: "portable",
      },
      personalConnectionDelegations: [],
      personalResourceAuthoritySubjectId: null,
      causalHumanSubjectId: null,
      causalHumanAuthority: null,
      xaiProviderAccountAuthoritySnapshot: { version: 1, scope: "workspace" },
      claudeProviderAccountAuthoritySnapshot: { version: 1, scope: "workspace" },
      claudeAuthoritySubjectId: null,
      xaiAuthoritySubjectId: null,
      connectionAuthoritySubjectId: null,
      triggerInitiator: { kind: "service", subjectId: "scheduler" },
      agentRunUsageIdempotencyKey: null,
      incidentPreflightRequired: false,
      alertOccurrenceLabels: null,
    },
  } as Parameters<typeof createScheduledTaskRun>[1]);
}

const everything = { eventTypes: ["*"], conditions: [], includeOwnEvents: false };

describe("event sources", () => {
  test("webhook sources get a routed URL; app sources are one per identity", async () => {
    const space = await workspace();
    const source = await webhookSource(space);
    expect(source.routeId).toBeTruthy();
    expect(await resolveEventIngressRoute(client.db, source.routeId!)).toEqual({
      accountId: space.accountId,
      workspaceId: space.workspaceId,
      sourceId: source.id,
      kind: "webhook",
    });
    const github = {
      accountId: space.accountId,
      workspaceId: space.workspaceId,
      createdBySubjectId: space.subjectId,
      kind: "github" as const,
      name: "GitHub",
      ownerSubjectId: null,
      visibility: "workspace" as const,
      externalKey: "installation:42",
    };
    const first = await createEventSource(client.db, github);
    const second = await createEventSource(client.db, github);
    expect(first.created).toBe(true);
    expect(second).toEqual({ source: first.source, created: false });
  });

  test("a custom webhook keeps its format and waits, blocked, for its secret", async () => {
    const space = await workspace();
    const format = {
      preset: "tailscale",
      signature: {
        scheme: "timestamped_hmac_sha256" as const,
        header: "Tailscale-Webhook-Signature",
        toleranceSeconds: 300,
      },
      batch: {},
      type: { path: "type" },
      occurredAt: "timestamp",
      summary: "message",
    };
    const { source } = await createEventSource(client.db, {
      accountId: space.accountId,
      workspaceId: space.workspaceId,
      createdBySubjectId: space.subjectId,
      kind: "webhook",
      adapter: "custom",
      format,
      name: "Tailnet",
      ownerSubjectId: space.subjectId,
      visibility: "private",
      status: "blocked",
      statusReason: { code: "awaiting_secret", text: "Paste the signing secret" },
    });
    expect(source).toMatchObject({ adapter: "custom", status: "blocked", format });
    expect(source.routeId).toBeTruthy();
    // An active custom source needs its secret.
    await expect(
      createEventSource(client.db, {
        accountId: space.accountId,
        workspaceId: space.workspaceId,
        createdBySubjectId: space.subjectId,
        kind: "webhook",
        adapter: "custom",
        format,
        name: "Tailnet",
        ownerSubjectId: space.subjectId,
        visibility: "private",
      }),
    ).rejects.toThrow();
    // A custom source needs a format, and only a custom source has one.
    await expect(
      createEventSource(client.db, {
        accountId: space.accountId,
        workspaceId: space.workspaceId,
        createdBySubjectId: space.subjectId,
        kind: "webhook",
        adapter: "custom",
        name: "No format",
        ownerSubjectId: space.subjectId,
        visibility: "private",
        status: "blocked",
        statusReason: { code: "awaiting_secret", text: "Paste the signing secret" },
      }),
    ).rejects.toThrow();
    await expect(
      createEventSource(client.db, {
        accountId: space.accountId,
        workspaceId: space.workspaceId,
        createdBySubjectId: space.subjectId,
        kind: "webhook",
        adapter: "linear",
        format,
        name: "Linear with a format",
        ownerSubjectId: space.subjectId,
        visibility: "private",
        status: "blocked",
        statusReason: { code: "awaiting_secret", text: "Paste the signing secret" },
      }),
    ).rejects.toThrow();
  });

  test("the route table keeps no provider identity", async () => {
    const space = await workspace();
    const routeSecret = new Uint8Array(32).fill(7);
    const installationId = 424_242;
    await bindGitHubInstallationRepositories(client.db, {
      ...space,
      installationId,
      linkedBySubjectId: space.subjectId,
      repositoryIds: [1],
      eventRouteSecret: routeSecret,
    });
    const app = {
      accountId: space.accountId,
      workspaceId: space.workspaceId,
      createdBySubjectId: space.subjectId,
      name: "App",
      visibility: "workspace" as const,
    };
    const { source: github } = await createEventSource(client.db, {
      ...app,
      kind: "github",
      ownerSubjectId: null,
      externalKey: "github",
      routeSecret,
    });
    const { source: slack } = await createEventSource(client.db, {
      ...app,
      kind: "slack",
      ownerSubjectId: null,
      externalKey: "team:T0001",
    });
    const { source: gmail } = await createEventSource(client.db, {
      ...app,
      kind: "gmail",
      ownerSubjectId: space.subjectId,
      externalKey: "email:someone@example.com",
    });
    const routes = await shared!.admin<{ source_id: string; external_key: string | null }[]>`
      SELECT source_id, external_key FROM event_ingress_routes
      WHERE source_id IN (${github.id}, ${slack.id}, ${gmail.id})`;
    // GitHub keeps one keyed route per installation; Slack and Gmail need none.
    expect([...routes]).toEqual([
      {
        source_id: github.id,
        external_key: githubInstallationRouteKey(routeSecret, installationId),
      },
    ]);
    expect(routes[0]!.external_key).not.toContain(String(installationId));
    expect(await listGitHubEventRoutes(client.db, routeSecret, installationId)).toEqual([
      { accountId: space.accountId, workspaceId: space.workspaceId, sourceId: github.id },
    ]);
    expect(
      await listGitHubEventRoutes(client.db, new Uint8Array(32).fill(8), installationId),
    ).toEqual([]);
    expect(await findAppEventSource(client.db, space.workspaceId, "slack", "team:T0001")).toEqual(
      expect.objectContaining({ id: slack.id }),
    );
    expect(
      await findAppEventSource(client.db, space.workspaceId, "slack", "team:T0002"),
    ).toBeNull();
  });

  test("people see shared sources, app sources and their own private ones", async () => {
    const space = await workspace();
    const mine = await webhookSource(space, "private");
    const workspaceWide = await webhookSource(space);
    const visible = await listEventSources(client.db, space.workspaceId, space.subjectId);
    expect(visible.map((source) => source.id).sort()).toEqual([mine.id, workspaceWide.id].sort());
    const others = await listEventSources(client.db, space.workspaceId, "someone-else");
    expect(others.map((source) => source.id)).toEqual([workspaceWide.id]);
  });

  test("a source automations use is kept and names them", async () => {
    const space = await workspace();
    const source = await webhookSource(space);
    const automation = await task(space);
    await setScheduledTaskEvents(client.db, {
      ...space,
      taskId: automation.id,
      triggers: [{ sourceId: source.id, ...everything }],
    });
    expect(await deleteEventSource(client.db, space.workspaceId, source.id)).toEqual({
      kind: "in_use",
      taskIds: [automation.id],
    });
    await setScheduledTaskEvents(client.db, { ...space, taskId: automation.id, triggers: [] });
    expect(await deleteEventSource(client.db, space.workspaceId, source.id)).toEqual({
      kind: "deleted",
    });
    expect(await deleteEventSource(client.db, space.workspaceId, source.id)).toEqual({
      kind: "missing",
    });
  });
});

describe("deliveries and matching", () => {
  test("a repeated delivery is counted, not stored again; repeated event ids are skipped", async () => {
    const space = await workspace();
    const source = await webhookSource(space);
    const once = () => [event("deploy.finished", { externalId: "evt-1" })];
    const first = await deliver(space, source.id, once(), "key-1");
    expect(first.duplicate).toBe(false);
    expect(first.eventIds).toHaveLength(1);
    const repeat = await deliver(space, source.id, once(), "key-1");
    expect(repeat.duplicate).toBe(true);
    expect(repeat.delivery.id).toBe(first.delivery.id);
    expect(repeat.delivery.duplicateCount).toBe(1);
    const redelivered = await deliver(space, source.id, once(), "key-2");
    expect(redelivered.duplicate).toBe(false);
    expect(redelivered.eventIds).toEqual([]);
    const page = await listEventDeliveries(client.db, space.workspaceId, source.id, { limit: 1 });
    expect(page.deliveries).toHaveLength(1);
    expect(page.nextCursor).toBeTruthy();
    const next = await listEventDeliveries(client.db, space.workspaceId, source.id, {
      limit: 5,
      cursor: page.nextCursor,
    });
    expect(next.deliveries.map((delivery) => delivery.id)).toEqual([first.delivery.id]);
    expect(next.deliveries[0]?.eventIds).toEqual(first.eventIds);
    expect(next.deliveries[0]?.bodyRetained).toBe(true);
    const events = await listInboundEvents(client.db, space.workspaceId, {
      sourceIds: [source.id],
      limit: 10,
    });
    expect(events.events.map((entry) => entry.id)).toEqual(first.eventIds);
  });

  test("matching queues events for active automations whose owner can see the source", async () => {
    const space = await workspace();
    const source = await webhookSource(space, "private");
    const automation = await task(space, { owner: space.subjectId });
    await setScheduledTaskEvents(client.db, {
      ...space,
      taskId: automation.id,
      triggers: [
        { sourceId: source.id, ...everything, eventTypes: ["deploy.finished"] },
        { sourceId: source.id, ...everything },
      ],
    });
    // Someone else's automation cannot use a private source.
    const other = await task(space);
    await setScheduledTaskEvents(client.db, {
      ...space,
      taskId: other.id,
      triggers: [{ sourceId: source.id, ...everything }],
    });
    const result = await deliver(space, source.id, [
      event("deploy.finished"),
      event("deploy.started"),
      event("deploy.finished", { actor: { kind: "opengeni", name: "opengeni[bot]" } }),
    ]);
    expect(result.matchedTaskIds).toEqual([automation.id]);
    expect(await inboxStatuses(space, automation.id)).toEqual(["pending", "pending"]);
    expect(await inboxStatuses(space, other.id)).toEqual([]);
    expect(await listDueEventTriggerTasks(client.db, 200)).toContainEqual({
      taskId: automation.id,
      workspaceId: space.workspaceId,
    });
  });

  test("paused automations queue nothing", async () => {
    const space = await workspace();
    const source = await webhookSource(space);
    const automation = await task(space);
    await setScheduledTaskEvents(client.db, {
      ...space,
      taskId: automation.id,
      triggers: [{ sourceId: source.id, ...everything }],
    });
    await updateScheduledTask(client.db, space.workspaceId, automation.id, { status: "paused" });
    expect((await deliver(space, source.id, [event("deploy.finished")])).matchedTaskIds).toEqual(
      [],
    );
  });
});

describe("dispatch", () => {
  async function armed(space: Space, policy: { maxRunsPerHour?: number; once?: boolean } = {}) {
    const source = await webhookSource(space);
    const automation = await task(space);
    const events = await setScheduledTaskEvents(client.db, {
      ...space,
      taskId: automation.id,
      triggers: [{ sourceId: source.id, ...everything }],
      ...policy,
    });
    return { source, automation, events: events! };
  }

  test("pending events become one occurrence that a run carries", async () => {
    const space = await workspace();
    const { source, automation, events } = await armed(space);
    expect(events).toMatchObject({ maxRunsPerHour: 30, once: false, completedAt: null });
    await deliver(space, source.id, [
      event("b", { occurredAt: new Date(Date.now() - 1_000) }),
      event("a", { occurredAt: new Date(Date.now() - 2_000), gapBefore: true }),
    ]);
    const dispatch = await claimEventTriggerDispatch(client.db, space.workspaceId, automation.id);
    expect(dispatch.throttleNotice).toBeNull();
    expect(dispatch.start).toHaveLength(1);
    const occurrenceId = dispatch.start[0]!.id;
    expect(await inboxStatuses(space, automation.id)).toEqual(["batched", "batched"]);
    expect((await settings(space, automation.id))?.dispatch_due_at).toBeNull();
    // Nothing more to do until another event arrives.
    expect(await claimEventTriggerDispatch(client.db, space.workspaceId, automation.id)).toEqual({
      start: [],
      throttleNotice: null,
    });
    const occurrence = await getEventOccurrenceForRun(client.db, space.workspaceId, occurrenceId);
    expect(occurrence?.eventCount).toBe(2);
    expect(occurrence?.gapBefore).toBe(true);
    expect(occurrence?.summaries.map((summary) => summary.type)).toEqual(["a", "b"]);
    expect(occurrence?.events.map((entry) => entry.type)).toEqual(["a", "b"]);
    await markEventOccurrenceStarted(client.db, space.workspaceId, occurrenceId);
    const eventRun = await run(automation, "event", eventOccurrenceProducerKey(occurrenceId));
    const carried = await getScheduledTaskRunEventOccurrences(client.db, space.workspaceId, [
      eventRun.id,
    ]);
    expect(carried.get(eventRun.id)?.events.map((summary) => summary.type)).toEqual(["a", "b"]);
    expect(await getEventRunOccurrence(client.db, space.workspaceId, eventRun.id)).toMatchObject({
      taskId: automation.id,
      occurrence: { eventCount: 2, events: [{ type: "a" }, { type: "b" }] },
    });
    const clockRun = await run(automation, "scheduled", `scheduled-${crypto.randomUUID()}`);
    expect(await getEventRunOccurrence(client.db, space.workspaceId, clockRun.id)).toBeNull();
  });

  test("a failed start is retried later", async () => {
    const space = await workspace();
    const { source, automation } = await armed(space);
    await deliver(space, source.id, [event("a")]);
    const [occurrence] = (
      await claimEventTriggerDispatch(client.db, space.workspaceId, automation.id)
    ).start;
    await recordEventOccurrenceStartFailure(
      client.db,
      space.workspaceId,
      occurrence!.id,
      "Temporal unavailable",
    );
    const due = (await settings(space, automation.id))?.dispatch_due_at;
    expect(due ? new Date(due).getTime() : 0).toBeGreaterThan(Date.now());
    await makeDue(space, automation.id);
    const retry = await claimEventTriggerDispatch(client.db, space.workspaceId, automation.id);
    expect(retry.start).toEqual([{ ...occurrence!, startAttempts: 1 }]);
  });

  test("the storm guard holds events back and the next run carries them together", async () => {
    const space = await workspace();
    const { source, automation } = await armed(space, { maxRunsPerHour: 1 });
    await deliver(space, source.id, [event("a")]);
    const [first] = (await claimEventTriggerDispatch(client.db, space.workspaceId, automation.id))
      .start;
    await markEventOccurrenceStarted(client.db, space.workspaceId, first!.id);
    await deliver(space, source.id, [event("b")]);
    await deliver(space, source.id, [event("c")]);
    const held = await claimEventTriggerDispatch(client.db, space.workspaceId, automation.id);
    expect(held.start).toEqual([]);
    // No chat to post in yet; the automation page shows the guard instead.
    expect(held.throttleNotice).toBeNull();
    const state = await settings(space, automation.id);
    expect(state?.throttled_since).toBeTruthy();
    expect(new Date(state!.dispatch_due_at!).getTime()).toBeGreaterThan(Date.now() + 3_000_000);
    const projected = await getScheduledTaskEvents(client.db, space.workspaceId, [automation.id]);
    expect(projected.get(automation.id)?.throttledSince).toBeTruthy();
    // An hour later, both held events arrive in one run.
    await withWorkspaceRls(client.db, space.workspaceId, (scoped) =>
      scoped.execute(
        sql`update scheduled_task_event_occurrences set created_at = now() - interval '61 minutes'
          where task_id = ${automation.id}`,
      ),
    );
    await makeDue(space, automation.id);
    const released = await claimEventTriggerDispatch(client.db, space.workspaceId, automation.id);
    expect(released.start).toHaveLength(1);
    const occurrence = await getEventOccurrenceForRun(
      client.db,
      space.workspaceId,
      released.start[0]!.id,
    );
    expect(occurrence?.events.map((entry) => entry.type)).toEqual(["b", "c"]);
    expect((await settings(space, automation.id))?.throttled_since).toBeNull();
  });

  test("the storm guard tells the owner once, in the chat the automation runs in", async () => {
    const space = await workspace();
    const { source, automation } = await armed(space, { maxRunsPerHour: 1 });
    await deliver(space, source.id, [event("a")]);
    const [first] = (await claimEventTriggerDispatch(client.db, space.workspaceId, automation.id))
      .start;
    await markEventOccurrenceStarted(client.db, space.workspaceId, first!.id);
    const eventRun = await run(automation, "event", eventOccurrenceProducerKey(first!.id));
    const sessionId = crypto.randomUUID();
    await withWorkspaceRls(client.db, space.workspaceId, (scoped) =>
      scoped.execute(
        sql`update scheduled_task_runs set session_id = ${sessionId} where id = ${eventRun.id}`,
      ),
    ).catch(() => undefined);
    await deliver(space, source.id, [event("b")]);
    const held = await claimEventTriggerDispatch(client.db, space.workspaceId, automation.id);
    const [runRow] = await withWorkspaceRls(client.db, space.workspaceId, (scoped) =>
      rawRows<{ session_id: string | null }>(
        scoped,
        sql`select session_id from scheduled_task_runs where id = ${eventRun.id}`,
      ),
    );
    if (runRow?.session_id) {
      expect(held.throttleNotice).toMatchObject({
        taskId: automation.id,
        sessionId: runRow.session_id,
        maxRunsPerHour: 1,
      });
      await deliver(space, source.id, [event("c")]);
      await makeDue(space, automation.id);
      const again = await claimEventTriggerDispatch(client.db, space.workspaceId, automation.id);
      expect(again.throttleNotice).toBeNull();
      expect((await settings(space, automation.id))?.throttle_notified).toBe(true);
    } else {
      // Sessions are foreign keys; without a real chat there is nothing to post in.
      expect(held.throttleNotice).toBeNull();
    }
  });

  test("a once-automation runs once and is then retired", async () => {
    const space = await workspace();
    const { source, automation } = await armed(space, { once: true });
    await deliver(space, source.id, [event("a")]);
    const dispatch = await claimEventTriggerDispatch(client.db, space.workspaceId, automation.id);
    expect(dispatch.start).toHaveLength(1);
    expect((await settings(space, automation.id))?.completed_at).toBeTruthy();
    // Later events no longer match.
    expect((await deliver(space, source.id, [event("b")])).matchedTaskIds).toEqual([]);
    // Not retired before its run exists.
    expect(await retireExhaustedScheduledTask(client.db, space.workspaceId, automation.id)).toBe(
      false,
    );
    const occurrenceId = dispatch.start[0]!.id;
    await markEventOccurrenceStarted(client.db, space.workspaceId, occurrenceId);
    expect(await retireExhaustedScheduledTask(client.db, space.workspaceId, automation.id)).toBe(
      false,
    );
    const eventRun = await run(automation, "event", eventOccurrenceProducerKey(occurrenceId));
    expect(await retireExhaustedScheduledTask(client.db, space.workspaceId, automation.id)).toBe(
      false,
    );
    await markScheduledTaskRunFailedIfQueued(
      client.db,
      space.workspaceId,
      eventRun.id,
      "synthetic failure",
    );
    // A failed last run is reviewed for its owner notice before retirement.
    await reviewScheduledTaskBlockers(client.db, space.workspaceId, automation.id, (facts) => ({
      kind: "none",
      reviewedRunId: facts.runs[0]?.id ?? null,
    }));
    expect(await retireExhaustedScheduledTask(client.db, space.workspaceId, automation.id)).toBe(
      true,
    );
    expect((await getScheduledTask(client.db, space.workspaceId, automation.id))?.status).toBe(
      "paused",
    );
    // Resuming re-arms it.
    await updateScheduledTask(client.db, space.workspaceId, automation.id, { status: "active" });
    await rearmScheduledTaskEvents(client.db, space.workspaceId, automation.id);
    expect((await settings(space, automation.id))?.completed_at).toBeNull();
    expect((await deliver(space, source.id, [event("c")])).matchedTaskIds).toEqual([automation.id]);
  });

  test("a once-automation whose schedule ran first completes without an event run", async () => {
    const space = await workspace();
    const { source, automation } = await armed(space, { once: true });
    await run(automation, "scheduled", `scheduled-${crypto.randomUUID()}`);
    await deliver(space, source.id, [event("a")]);
    const dispatch = await claimEventTriggerDispatch(client.db, space.workspaceId, automation.id);
    expect(dispatch.start).toEqual([]);
    expect(await inboxStatuses(space, automation.id)).toEqual(["skipped"]);
    expect((await settings(space, automation.id))?.completed_at).toBeTruthy();
  });

  test("repeating triggers outlive the schedule's last run; a finished once-automation does not", async () => {
    const space = await workspace();
    const source = await webhookSource(space);
    // A one-time date long past: the schedule itself has no run left.
    const spent = {
      type: "once",
      runAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      timeZone: "UTC",
    };
    const reviewedEvents = async (taskId: string) => {
      let seen: unknown = "unreviewed";
      await reviewScheduledTaskBlockers(client.db, space.workspaceId, taskId, (facts) => {
        seen = facts.task.events;
        return { kind: "none", reviewedRunId: null };
      });
      return seen;
    };

    const plain = await task(space, { schedule: spent });
    expect(await reviewedEvents(plain.id)).toBeNull();
    expect(await retireExhaustedScheduledTask(client.db, space.workspaceId, plain.id)).toBe(true);

    const listening = await task(space, { schedule: spent });
    await setScheduledTaskEvents(client.db, {
      ...space,
      taskId: listening.id,
      triggers: [{ sourceId: source.id, ...everything }],
    });
    expect(await reviewedEvents(listening.id)).toEqual({ once: false, completed: false });
    expect(await retireExhaustedScheduledTask(client.db, space.workspaceId, listening.id)).toBe(
      false,
    );
    expect((await deliver(space, source.id, [event("a")])).matchedTaskIds).toEqual([listening.id]);
    // Without its triggers, the spent schedule retires it as before.
    await setScheduledTaskEvents(client.db, { ...space, taskId: listening.id, triggers: [] });
    expect(await retireExhaustedScheduledTask(client.db, space.workspaceId, listening.id)).toBe(
      true,
    );

    const waiting = await task(space);
    await setScheduledTaskEvents(client.db, {
      ...space,
      taskId: waiting.id,
      triggers: [{ sourceId: source.id, ...everything }],
      once: true,
    });
    expect(await reviewedEvents(waiting.id)).toEqual({ once: true, completed: false });
    await deliver(space, source.id, [event("b")]);
    expect(
      (await claimEventTriggerDispatch(client.db, space.workspaceId, waiting.id)).start,
    ).toHaveLength(1);
    expect(await reviewedEvents(waiting.id)).toEqual({ once: true, completed: true });
  });

  test("events waiting for a paused automation are skipped", async () => {
    const space = await workspace();
    const { source, automation } = await armed(space);
    await deliver(space, source.id, [event("a")]);
    await updateScheduledTask(client.db, space.workspaceId, automation.id, { status: "paused" });
    expect(await claimEventTriggerDispatch(client.db, space.workspaceId, automation.id)).toEqual({
      start: [],
      throttleNotice: null,
    });
    expect(await inboxStatuses(space, automation.id)).toEqual(["skipped"]);
  });

  test("triggers keep their ids by position; removing them all drops the policy", async () => {
    const space = await workspace();
    const { source, automation, events } = await armed(space);
    const firstId = events.triggers[0]!.id;
    const updated = await setScheduledTaskEvents(client.db, {
      ...space,
      taskId: automation.id,
      triggers: [
        {
          sourceId: source.id,
          eventTypes: ["deploy.finished"],
          conditions: [{ field: "data.env", op: "equals", value: "prod" }],
          includeOwnEvents: true,
        },
        { sourceId: source.id, ...everything, eventTypes: ["deploy.failed"] },
      ],
      maxRunsPerHour: 5,
    });
    expect(updated?.triggers[0]?.id).toBe(firstId);
    expect(updated?.triggers[0]).toMatchObject({
      eventTypes: ["deploy.finished"],
      conditions: [{ field: "data.env", op: "equals", value: "prod" }],
      includeOwnEvents: true,
      sourceKind: "webhook",
    });
    expect(updated?.maxRunsPerHour).toBe(5);
    expect(
      await setScheduledTaskEvents(client.db, { ...space, taskId: automation.id, triggers: [] }),
    ).toBeNull();
    expect((await getScheduledTaskEvents(client.db, space.workspaceId, [automation.id])).size).toBe(
      0,
    );
  });
});
