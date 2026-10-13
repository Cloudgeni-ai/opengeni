import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import type { Permission, Session, SessionUsageLimit } from "@opengeni/contracts";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import { stampDelegatedHumanAuthorization, type ApiRouteDeps } from "@opengeni/core";
import type { SessionWorkflowClient } from "@opengeni/core";
import { createDb, createOrganizationApiKey, settleSessionUsageReceipt } from "@opengeni/db";
import {
  acquireRestrictedRuntimeTestDatabase,
  MemoryEventBus,
  testSettings,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing";
import { createApp } from "../src/app";

// per-task usage limit routes, edge refusal and write authority through the
// real HTTP app and real PostgreSQL in the production posture: NOSUPERUSER
// NOBYPASSRLS migration owner, dedicated data schema, restricted application
// role and FORCE RLS (definer routines are bound by RLS as deployed).
setDefaultTimeout(120_000);
const SECRET = "session-usage-limit-api-secret";
let shared: RestrictedRuntimeTestDatabase;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  const acquired = await acquireRestrictedRuntimeTestDatabase("session-usage-limit-api");
  if (!acquired) throw new Error("Session usage limit API tests require PostgreSQL");
  shared = acquired;
  client = createDb(shared.appUrl, { searchPath: shared.schema });
}, 600_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

class WorkflowRecorder implements SessionWorkflowClient {
  calls: string[] = [];
  async signalUserMessage(): Promise<void> {
    this.calls.push("signalUserMessage");
  }
  async wakeSessionWorkflow(): Promise<void> {
    this.calls.push("wakeSessionWorkflow");
  }
  async requestSessionWorkflowWakeDispatch(): Promise<void> {
    this.calls.push("requestSessionWorkflowWakeDispatch");
  }
  async signalApprovalDecision(): Promise<void> {
    this.calls.push("signalApprovalDecision");
  }
  async signalSessionControl(): Promise<void> {
    this.calls.push("signalSessionControl");
  }
  async syncScheduledTask(): Promise<void> {}
  async deleteScheduledTaskSchedule(): Promise<void> {}
  async triggerScheduledTask(): Promise<void> {}
}

const PERMISSIONS: Permission[] = [
  "workspace:read",
  "sessions:read",
  "sessions:create",
  "sessions:control",
];

async function fixture(enabled = true) {
  const [account] = await shared.admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('Usage limit API') returning id`;
  const accountId = account!.id;
  const [workspace] = await shared.admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${accountId}, 'Usage limit API') returning id`;
  const workspaceId = workspace!.id;
  await shared.admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspaceId}, ${accountId})`;
  const token = `ogk_${crypto.randomUUID()}`;
  await createOrganizationApiKey(client.db, {
    accountId,
    name: "Usage limit host",
    prefix: "test",
    keyHash: createHash("sha256").update(token).digest("hex"),
    permissions: PERMISSIONS,
  });
  const workflow = new WorkflowRecorder();
  const deps = (flag: boolean) =>
    ({
      settings: testSettings({
        databaseUrl: shared.appUrl,
        productAccessMode: "managed",
        delegationSecret: SECRET,
        sandboxBackend: "none",
        sessionUsageLimitsEnabled: flag,
      }),
      db: client.db,
      bus: new MemoryEventBus(),
      workflowClient: workflow,
      objectStorage: null,
      githubStateSecret: "usage-limit-test",
      documentIndexer: { indexDocument: async () => undefined },
      getDocumentServices: () => {
        throw new Error("unused");
      },
      resumeBoxById: async () => {
        throw new Error("unused");
      },
    }) as unknown as ApiRouteDeps;
  return {
    accountId,
    workspaceId,
    workflow,
    app: createApp(deps(enabled)),
    appWithFlag: (flag: boolean) => createApp(deps(flag)),
    host: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function bearer(
  f: Fixture,
  principalKind: "human_session" | "agent_attempt" | "service",
  sessionId?: string,
) {
  const token = await signDelegatedAccessToken(SECRET, {
    accountId: f.accountId,
    workspaceId: f.workspaceId,
    subjectId: `user:usage-limit:${principalKind}`,
    subjectLabel: principalKind,
    principalKind,
    permissions: PERMISSIONS,
    ...(principalKind === "agent_attempt"
      ? {
          sessionId: sessionId ?? crypto.randomUUID(),
          turnId: crypto.randomUUID(),
          attemptId: crypto.randomUUID(),
          executionGeneration: 1,
        }
      : sessionId
        ? { sessionId }
        : {}),
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

function sessionsPath(f: Fixture, suffix = "") {
  return `/v1/workspaces/${f.workspaceId}/sessions${suffix}`;
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

type ErrorBody = {
  error: { status: number; code: string; retryable: boolean; details?: Record<string, unknown> };
};

async function createRoot(f: Fixture, extra: Record<string, unknown> = {}, headers = f.host) {
  const response = await f.app.request(sessionsPath(f), {
    method: "POST",
    headers,
    body: JSON.stringify({ initialMessage: "root task", model: "scripted-model", ...extra }),
  });
  return response;
}

async function putLimit(
  f: Fixture,
  sessionId: string,
  body: { limitMicros: number | null; expectedVersion: number; operationId?: string },
  headers: Record<string, string> = f.host,
  app = f.app,
) {
  return await app.request(sessionsPath(f, `/${sessionId}/usage-limit`), {
    method: "PUT",
    headers,
    body: JSON.stringify({ operationId: crypto.randomUUID(), ...body }),
  });
}

async function getLimit(f: Fixture, sessionId: string, headers = f.host) {
  const response = await f.app.request(sessionsPath(f, `/${sessionId}/usage-limit`), { headers });
  expect(response.status, await response.clone().text()).toBe(200);
  return await json<SessionUsageLimit>(response);
}

async function sideEffects(f: Fixture, sessionId: string) {
  const [row] = await shared.admin<
    Array<{ events: string; turns: string; outbox: string; queue: string }>
  >`select
      (select count(*) from session_events where session_id = ${sessionId}) as events,
      (select count(*) from session_turns where session_id = ${sessionId}) as turns,
      (select count(*) from session_workflow_wake_outbox where session_id = ${sessionId}) as outbox,
      (select count(*) from session_turns where session_id = ${sessionId} and status = 'queued') as queue`;
  return { ...row!, workflow: f.workflow.calls.length };
}

describe("task usage limit API", () => {
  test("AC01/AC03/AC16: create echoes the limit; GET, CAS PUT, exact replay, conflict and detail projection", async () => {
    const f = await fixture();
    const created = await createRoot(f, { usageLimitMicros: 2_500_000 });
    expect(created.status, await created.clone().text()).toBe(202);
    const session = await json<Session>(created);
    expect(session.usageLimit).toMatchObject({
      basis: "model_api_equivalent_v1",
      rootSessionId: session.id,
      inherited: false,
      limitMicros: 2_500_000,
      usedMicros: 0,
      version: 1,
      status: "within",
    });

    const read = await getLimit(f, session.id);
    expect(read).toMatchObject({ limitMicros: 2_500_000, version: 1, history: "complete" });

    const operationId = crypto.randomUUID();
    const raised = await putLimit(f, session.id, {
      limitMicros: 5_000_000,
      expectedVersion: 1,
      operationId,
    });
    expect(raised.status, await raised.clone().text()).toBe(200);
    expect(await json<SessionUsageLimit>(raised)).toMatchObject({
      limitMicros: 5_000_000,
      version: 2,
    });
    // An exact replay of a committed change returns its committed result.
    const replay = await putLimit(f, session.id, {
      limitMicros: 5_000_000,
      expectedVersion: 1,
      operationId,
    });
    expect(replay.status).toBe(200);
    expect(await json<SessionUsageLimit>(replay)).toMatchObject({ version: 2 });
    // The same operation id for a different change is a conflict, not a write.
    const reused = await putLimit(f, session.id, {
      limitMicros: 1,
      expectedVersion: 2,
      operationId,
    });
    expect(reused.status).toBe(409);
    expect((await json<ErrorBody>(reused)).error.details?.code).toBe(
      "session_usage_limit_conflict",
    );
    // A stale version is refused with the current version.
    const stale = await putLimit(f, session.id, { limitMicros: 1, expectedVersion: 1 });
    expect(stale.status).toBe(409);
    expect((await json<ErrorBody>(stale)).error).toMatchObject({
      code: "conflict",
      details: { code: "session_usage_limit_conflict", currentVersion: 2 },
    });
    // Clearing keeps a version (tombstone) and reads as unlimited, not $0.
    const cleared = await putLimit(f, session.id, { limitMicros: null, expectedVersion: 2 });
    expect(await json<SessionUsageLimit>(cleared)).toMatchObject({
      limitMicros: null,
      version: 3,
      status: "unlimited",
    });
    const detail = await f.app.request(sessionsPath(f, `/${session.id}`), { headers: f.host });
    expect((await json<Session>(detail)).usageLimit).toMatchObject({
      limitMicros: null,
      version: 3,
    });
    const updates = await shared.admin<Array<{ payload: Record<string, unknown> }>>`
      select payload from session_events
      where session_id = ${session.id} and type = 'session.usage_limit.updated'
      order by sequence`;
    expect(updates.map((row) => row.payload)).toEqual([
      expect.objectContaining({ limitMicros: 5_000_000, previousLimitMicros: 2_500_000 }),
      expect.objectContaining({ limitMicros: null, previousLimitMicros: 5_000_000 }),
    ]);
  });

  test("AC21: flag off rejects new limits on create and PUT, but clearing and enforcement continue", async () => {
    const f = await fixture(true);
    const session = await json<Session>(await createRoot(f, { usageLimitMicros: 0 }));
    const off = f.appWithFlag(false);
    const offCreate = await off.request(sessionsPath(f), {
      method: "POST",
      headers: f.host,
      body: JSON.stringify({
        initialMessage: "x",
        model: "scripted-model",
        usageLimitMicros: 1,
      }),
    });
    expect(offCreate.status).toBe(422);
    expect(await offCreate.json()).toMatchObject({
      code: "SESSION_CREATE_REJECTED",
      details: { code: "session_usage_limit_disabled" },
    });
    const offSet = await putLimit(
      f,
      session.id,
      { limitMicros: 5, expectedVersion: 1 },
      f.host,
      off,
    );
    expect(offSet.status).toBe(422);
    // Persisted limits are still enforced with the flag off.
    const refused = await off.request(sessionsPath(f, `/${session.id}/steer`), {
      method: "POST",
      headers: f.host,
      body: JSON.stringify({ text: "more" }),
    });
    expect(refused.status).toBe(402);
    const config = await off.request("/v1/config/client", { headers: f.host });
    expect((await json<{ sessionUsageLimits?: unknown }>(config)).sessionUsageLimits).toEqual({
      enabled: false,
    });
    const offClear = await putLimit(
      f,
      session.id,
      { limitMicros: null, expectedVersion: 1 },
      f.host,
      off,
    );
    expect(offClear.status, await offClear.clone().text()).toBe(200);
    expect(await json<SessionUsageLimit>(offClear)).toMatchObject({ limitMicros: null });
  });

  test("AC08: a reached limit refuses fresh Send/Steer/composer submit before side effects; exact replay returns the committed result", async () => {
    const f = await fixture();
    const session = await json<Session>(await createRoot(f));
    const clientEventId = `send-${crypto.randomUUID()}`;
    const send = (id: string) =>
      f.app.request(sessionsPath(f, `/${session.id}/events`), {
        method: "POST",
        headers: f.host,
        body: JSON.stringify({ type: "user.message", clientEventId: id, payload: { text: "hi" } }),
      });
    const accepted = await send(clientEventId);
    expect(accepted.status, await accepted.clone().text()).toBeLessThan(300);
    const committed = await accepted.json();

    const current = await getLimit(f, session.id);
    expect(
      (await putLimit(f, session.id, { limitMicros: 0, expectedVersion: current.version })).status,
    ).toBe(200);
    const replay = await send(clientEventId);
    expect(replay.status).toBeLessThan(300);
    expect(await replay.json()).toEqual(committed);
    const before = await sideEffects(f, session.id);

    const fresh = await send(`send-${crypto.randomUUID()}`);
    expect(fresh.status).toBe(402);
    expect((await json<ErrorBody>(fresh)).error).toMatchObject({
      status: 402,
      code: "session_usage_limit_reached",
      retryable: false,
      details: {
        basis: "model_api_equivalent_v1",
        rootSessionId: session.id,
        limitMicros: 0,
        usedMicros: 0,
      },
    });
    const steer = await f.app.request(sessionsPath(f, `/${session.id}/steer`), {
      method: "POST",
      headers: f.host,
      body: JSON.stringify({ text: "interrupt" }),
    });
    expect(steer.status).toBe(402);
    expect((await json<ErrorBody>(steer)).error.code).toBe("session_usage_limit_reached");

    // A saved composer draft survives a refused submit unchanged.
    const saved = await f.app.request(sessionsPath(f, `/${session.id}/composer-draft`), {
      method: "PUT",
      headers: f.host,
      body: JSON.stringify({
        text: "keep me",
        annotations: [],
        resources: [],
        model: "scripted-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        expectedRevision: 0,
      }),
    });
    expect(saved.status, await saved.clone().text()).toBe(200);
    const draft = await json<{ revision: number; text: string }>(saved);
    const submit = await f.app.request(sessionsPath(f, `/${session.id}/composer-draft/submit`), {
      method: "POST",
      headers: f.host,
      body: JSON.stringify({
        text: "keep me",
        annotations: [],
        resources: [],
        model: "scripted-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        expectedDraftRevision: draft.revision,
        clientEventId: `submit-${crypto.randomUUID()}`,
        delivery: "send",
      }),
    });
    expect(submit.status).toBe(402);
    const after = await f.app.request(sessionsPath(f, `/${session.id}/composer-draft`), {
      headers: f.host,
    });
    expect(await json<{ revision: number; text: string }>(after)).toMatchObject({
      revision: draft.revision,
      text: "keep me",
    });
    // Zero queue, interruption, event or workflow side effects from refusals.
    expect(await sideEffects(f, session.id)).toEqual(before);
  });

  test("AC05/AC12: children share the root; PUT on a child is refused with the root; reached root refuses child creation", async () => {
    const f = await fixture();
    const root = await json<Session>(await createRoot(f));
    const childHeaders = await bearer(f, "service", root.id);
    const childResponse = await f.app.request(sessionsPath(f), {
      method: "POST",
      headers: childHeaders,
      body: JSON.stringify({ initialMessage: "child", model: "scripted-model" }),
    });
    expect(childResponse.status, await childResponse.clone().text()).toBe(202);
    const child = await json<Session>(childResponse);
    expect(await getLimit(f, child.id)).toMatchObject({ rootSessionId: root.id, inherited: true });
    const notRoot = await putLimit(f, child.id, { limitMicros: 1, expectedVersion: 0 });
    expect(notRoot.status).toBe(409);
    expect((await json<ErrorBody>(notRoot)).error.details).toMatchObject({
      code: "session_usage_limit_not_root",
      rootSessionId: root.id,
    });
    // A child's create may never carry a limit (children share their root's).
    const childLimit = await f.app.request(sessionsPath(f), {
      method: "POST",
      headers: childHeaders,
      body: JSON.stringify({
        initialMessage: "child with limit",
        model: "scripted-model",
        usageLimitMicros: null,
      }),
    });
    expect(childLimit.status).toBe(403);
    // Recorded child usage is the root's; at the limit no new child starts.
    await settleSessionUsageReceipt(client.db, {
      accountId: f.accountId,
      workspaceId: f.workspaceId,
      sessionId: child.id,
      sourceId: `api-test:${crypto.randomUUID()}`,
      amountMicros: 700,
      pricingSource: "configured_list_price",
      model: "scripted-model",
    });
    const rootState = await getLimit(f, root.id);
    expect(rootState).toMatchObject({ usedMicros: 700, pricedCalls: 1 });
    expect(
      (await putLimit(f, root.id, { limitMicros: 700, expectedVersion: rootState.version })).status,
    ).toBe(200);
    const refusedChild = await f.app.request(sessionsPath(f), {
      method: "POST",
      headers: childHeaders,
      body: JSON.stringify({ initialMessage: "another child", model: "scripted-model" }),
    });
    expect(refusedChild.status).toBe(402);
    expect((await json<ErrorBody>(refusedChild)).error.details).toMatchObject({
      rootSessionId: root.id,
      limitMicros: 700,
      usedMicros: 700,
    });
  });

  test("AC11: only a person or the host server writes; agents are refused even with full access", async () => {
    const f = await fixture();
    const session = await json<Session>(await createRoot(f));
    const human = await bearer(f, "human_session");
    const humanSet = await putLimit(f, session.id, { limitMicros: 10, expectedVersion: 0 }, human);
    expect(humanSet.status, await humanSet.clone().text()).toBe(200);

    // A forged or stale agent-attempt bearer is refused by attempt authority
    // itself; a live attempt is refused by the write-actor classifier (core
    // unit test). Either way nothing changes.
    const attempt = await bearer(f, "agent_attempt", session.id);
    const attemptSet = await putLimit(
      f,
      session.id,
      { limitMicros: null, expectedVersion: 1 },
      attempt,
    );
    expect(attemptSet.status).toBe(403);

    // A session-scoped service bearer (the token an agent's tools use).
    const scoped = await bearer(f, "service", session.id);
    const scopedSet = await putLimit(
      f,
      session.id,
      { limitMicros: null, expectedVersion: 1 },
      scoped,
    );
    expect(scopedSet.status).toBe(403);
    expect((await json<ErrorBody>(scopedSet)).error.details?.code).toBe(
      "session_usage_limit_forbidden",
    );
    const scopedCreate = await f.app.request(sessionsPath(f), {
      method: "POST",
      headers: scoped,
      body: JSON.stringify({
        initialMessage: "agent-made task",
        model: "scripted-model",
        usageLimitMicros: 1_000_000,
      }),
    });
    expect(scopedCreate.status).toBe(403);
    expect(await scopedCreate.json()).toMatchObject({
      code: "SESSION_CREATE_FORBIDDEN",
      details: { code: "session_usage_limit_forbidden" },
    });

    // An agent acting for a person (connected agent with full access, session
    // admin access or a personal API key) is refused before authorization.
    const delegatedBody = JSON.stringify({
      limitMicros: null,
      expectedVersion: 1,
      operationId: crypto.randomUUID(),
    });
    const delegated = new Request(
      `http://usage-limit.test${sessionsPath(f, `/${session.id}/usage-limit`)}`,
      {
        method: "PUT",
        headers: {
          ...f.host,
          "content-length": String(Buffer.byteLength(delegatedBody)),
        },
        body: delegatedBody,
      },
    );
    stampDelegatedHumanAuthorization(delegated, {
      organizationId: f.accountId,
      subjectId: "user:usage-limit:human_session",
      permissions: ["account:admin", "workspace:admin", ...PERMISSIONS] as never,
      workspaceScope: { kind: "all" },
    });
    const delegatedResponse = await f.app.request(delegated);
    // Refused (here already by delegated-person resolution; with a resolvable
    // person the route's own guard refuses it, see the core classifier test).
    expect(delegatedResponse.status).toBe(403);
    expect(await getLimit(f, session.id)).toMatchObject({ limitMicros: 10, version: 1 });
  });

  test("AC09: resuming a goal paused by a reached limit is refused until a person raises it", async () => {
    const f = await fixture();
    const session = await json<Session>(
      await createRoot(f, { goal: { text: "Finish" }, usageLimitMicros: 0 }),
    );
    await shared.admin`
      update session_goals set status = 'paused', paused_reason = 'session_usage_limit'
      where session_id = ${session.id}`;
    const resume = await f.app.request(sessionsPath(f, `/${session.id}/goal`), {
      method: "PATCH",
      headers: f.host,
      body: JSON.stringify({ status: "active" }),
    });
    expect(resume.status, await resume.clone().text()).toBe(422);
    const workflowBefore = f.workflow.calls.length;
    const state = await getLimit(f, session.id);
    expect(
      (await putLimit(f, session.id, { limitMicros: 1_000_000, expectedVersion: state.version }))
        .status,
    ).toBe(200);
    // Raising never resumes or wakes anything by itself.
    const [goal] = await shared.admin<Array<{ status: string; paused_reason: string }>>`
      select status, paused_reason from session_goals where session_id = ${session.id}`;
    expect(goal).toMatchObject({ status: "paused", paused_reason: "session_usage_limit" });
    expect(f.workflow.calls.length).toBe(workflowBefore);
  });
});
