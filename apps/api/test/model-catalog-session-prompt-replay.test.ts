import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ApiRouteDeps, SessionWorkflowClient } from "@opengeni/core";
import { bootstrapWorkspace, createDb, type DbClient } from "@opengeni/db";
import { signDelegatedAccessToken, type AccessGrant } from "@opengeni/contracts";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { Hono } from "hono";
import postgres from "postgres";
import { registerSessionRoutes } from "../src/routes/sessions";

const DELEGATION_SECRET = "model-catalog-prompt-replay-secret";

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;

class FakeWorkflowClient {
  wakeups: unknown[] = [];

  async wakeSessionWorkflow(input: unknown): Promise<void> {
    this.wakeups.push(input);
  }
}

function buildApp(workflow: FakeWorkflowClient): Hono {
  const noop = async () => undefined;
  const app = new Hono();
  registerSessionRoutes(app, {
    settings: testSettings({
      databaseUrl: shared!.appUrl,
      sandboxBackend: "none",
      productAccessMode: "managed",
      delegationSecret: DELEGATION_SECRET,
      modelCatalogSource: "database",
    }),
    db: client.db,
    bus: new MemoryEventBus(),
    workflowClient: {
      signalUserMessage: noop,
      wakeSessionWorkflow: workflow.wakeSessionWorkflow.bind(workflow),
      requestSessionWorkflowWakeDispatch: noop,
      signalApprovalDecision: noop,
      signalSessionControl: noop,
      syncScheduledTask: noop,
      deleteScheduledTaskSchedule: noop,
      triggerScheduledTask: noop,
    } as unknown as SessionWorkflowClient,
    objectStorage: null,
    githubStateSecret: "test",
    documentIndexer: { indexDocument: noop },
    getDocumentServices: () => ({}) as never,
  } as unknown as ApiRouteDeps);
  return app;
}

async function provisionActor(input: {
  accountExternalId: string;
  workspaceExternalId: string;
  subjectId: string;
}): Promise<AccessGrant> {
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "model-catalog-prompt-replay",
    accountExternalId: input.accountExternalId,
    accountName: "Model catalog prompt replay account",
    workspaceExternalSource: "model-catalog-prompt-replay",
    workspaceExternalId: input.workspaceExternalId,
    workspaceName: "Model catalog prompt replay workspace",
    subjectId: input.subjectId,
  });
  return access.workspaceGrants.find(
    (candidate) => candidate.workspaceId === access.defaultWorkspaceId,
  )!;
}

async function bearer(grant: AccessGrant): Promise<string> {
  const token = await signDelegatedAccessToken(DELEGATION_SECRET, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: grant.subjectId,
    permissions: ["sessions:create", "sessions:read", "sessions:control"],
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1_000) + 3_600,
  });
  return `Bearer ${token}`;
}

async function installCatalog(document: Record<string, unknown>, version: number): Promise<void> {
  await shared!.admin`
    insert into deployment_model_catalog (singleton, document, version)
    values (true, ${shared!.admin.json(document)}::jsonb, ${version})
    on conflict (singleton) do update set
      document = excluded.document,
      version = excluded.version,
      updated_at = now()
  `;
}

async function durablePromptFacts(workspaceId: string, sessionId: string) {
  const [row] = await shared!.admin<
    Array<{
      events: number;
      turns: number;
      receipts: number;
      usageEvents: number;
      wakeRevision: number;
    }>
  >`
    select
      (select count(*)::int from session_events where workspace_id = ${workspaceId} and session_id = ${sessionId}) as events,
      (select count(*)::int from session_turns where workspace_id = ${workspaceId} and session_id = ${sessionId}) as turns,
      (select count(*)::int from session_command_receipts where workspace_id = ${workspaceId} and target_session_id = ${sessionId} and action in ('prompt.send', 'prompt.steer')) as receipts,
      (select count(*)::int from usage_events where workspace_id = ${workspaceId} and session_id = ${sessionId} and source_resource_type = 'session_turn') as "usageEvents",
      coalesce((select wake_revision::int from session_workflow_wake_outbox where workspace_id = ${workspaceId} and session_id = ${sessionId}), 0) as "wakeRevision"
  `;
  if (!row) throw new Error("prompt durability query returned no row");
  return row;
}

async function waitForBlockedBackend(blockerPid: number, description: string): Promise<number> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const [row] = await shared!.admin<Array<{ pid: number }>>`
      select activity.pid
      from pg_stat_activity activity
      where activity.datname = current_database()
        and activity.state = 'active'
        and activity.wait_event_type = 'Lock'
        and ${blockerPid} = any(pg_blocking_pids(activity.pid))
      order by activity.pid
      limit 1
    `;
    if (row) return row.pid;
    await Bun.sleep(10);
  }
  throw new Error(`${description} did not block behind backend ${blockerPid}`);
}

async function acquireDatabase(): Promise<SharedTestDatabase | null> {
  const adminUrl = process.env.OPENGENI_TEST_POSTGRES_ADMIN_URL;
  const appUrl = process.env.OPENGENI_TEST_POSTGRES_APP_URL;
  if (!adminUrl && !appUrl) {
    return await acquireSharedTestDatabase("model-catalog-session-prompt-replay");
  }
  if (!adminUrl || !appUrl) {
    throw new Error(
      "OPENGENI_TEST_POSTGRES_ADMIN_URL and OPENGENI_TEST_POSTGRES_APP_URL must be set together",
    );
  }
  const admin = postgres(adminUrl, { max: 4 });
  return {
    admin,
    adminUrl,
    appUrl,
    release: async () => await admin.end().catch(() => undefined),
  };
}

beforeAll(async () => {
  shared = await acquireDatabase();
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
      throw new Error("PostgreSQL test database unavailable");
    }
    available = false;
    // eslint-disable-next-line no-console
    console.warn("[model-catalog-session-prompt-replay] docker unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl, { max: 2 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

describe("model catalog prompt receipt replay (real PostgreSQL)", () => {
  test("replays committed Send and Steer before a removed deployment model is resolved", async () => {
    if (!available) return;
    const fixture = crypto.randomUUID();
    const owner = await provisionActor({
      accountExternalId: `account-${fixture}`,
      workspaceExternalId: `workspace-${fixture}`,
      subjectId: `user:owner-${fixture}`,
    });
    const ownerAuthorization = await bearer(owner);
    const workflow = new FakeWorkflowClient();
    const app = buildApp(workflow);
    const headers = {
      authorization: ownerAuthorization,
      "content-type": "application/json",
    };

    try {
      await installCatalog(
        {
          schemaVersion: 1,
          defaultModel: "scripted-model",
          builtInModels: ["scripted-model"],
        },
        1,
      );

      const create = async (label: string) => {
        const request = {
          initialMessage: `initial ${label}`,
          model: "scripted-model",
          sandboxBackend: "none",
          idempotencyKey: `create-${crypto.randomUUID()}`,
        };
        const response = await app.request(`http://x/v1/workspaces/${owner.workspaceId}/sessions`, {
          method: "POST",
          headers,
          body: JSON.stringify(request),
        });
        expect(response.status).toBe(202);
        return {
          session: (await response.json()) as { id: string; initialTurnId: string | null },
          request,
        };
      };
      const targetCreate = await create("target");
      const otherTargetCreate = await create("other target");
      const target = targetCreate.session;
      const otherTarget = otherTargetCreate.session;

      const sendKey = crypto.randomUUID();
      const sendBody = {
        type: "user.message",
        clientEventId: sendKey,
        payload: { text: "send with the stored session model" },
      };
      const sendResponse = await app.request(
        `http://x/v1/workspaces/${owner.workspaceId}/sessions/${target.id}/events`,
        { method: "POST", headers, body: JSON.stringify(sendBody) },
      );
      expect(sendResponse.status).toBe(202);
      const acceptedSend = (await sendResponse.json()) as { id: string };

      const steerKey = crypto.randomUUID();
      const steerBody = {
        text: "steer with an explicit deployment model",
        model: "scripted-model",
        clientEventId: steerKey,
      };
      const steerResponse = await app.request(
        `http://x/v1/workspaces/${owner.workspaceId}/sessions/${target.id}/steer`,
        { method: "POST", headers, body: JSON.stringify(steerBody) },
      );
      expect(steerResponse.status).toBe(202);
      const acceptedSteer = (await steerResponse.json()) as {
        accepted: { id: string };
        turn: { id: string };
        receipt: { id: string };
        replay: boolean;
      };
      expect(acceptedSteer.replay).toBeFalse();

      await installCatalog(
        {
          schemaVersion: 1,
          defaultModel: "replacement-model",
          builtInModels: ["replacement-model"],
        },
        2,
      );

      const createReplay = await app.request(
        `http://x/v1/workspaces/${owner.workspaceId}/sessions`,
        { method: "POST", headers, body: JSON.stringify(targetCreate.request) },
      );
      expect(createReplay.status).toBe(202);
      expect(await createReplay.json()).toMatchObject({
        id: target.id,
        initialTurnId: target.initialTurnId,
      });
      const beforeRemovalReplay = await durablePromptFacts(owner.workspaceId, target.id);

      const sendReplay = await app.request(
        `http://x/v1/workspaces/${owner.workspaceId}/sessions/${target.id}/events`,
        { method: "POST", headers, body: JSON.stringify(sendBody) },
      );
      expect(sendReplay.status).toBe(202);
      expect(await sendReplay.json()).toMatchObject({ id: acceptedSend.id });

      const steerReplay = await app.request(
        `http://x/v1/workspaces/${owner.workspaceId}/sessions/${target.id}/steer`,
        { method: "POST", headers, body: JSON.stringify(steerBody) },
      );
      expect(steerReplay.status).toBe(202);
      expect(await steerReplay.json()).toMatchObject({
        accepted: { id: acceptedSteer.accepted.id },
        turn: { id: acceptedSteer.turn.id },
        receipt: { id: acceptedSteer.receipt.id },
        replay: true,
      });
      expect(await durablePromptFacts(owner.workspaceId, target.id)).toEqual(beforeRemovalReplay);

      const expectConflict = async (response: Response) => {
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
      };
      await expectConflict(
        await app.request(
          `http://x/v1/workspaces/${owner.workspaceId}/sessions/${target.id}/events`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              ...sendBody,
              payload: { text: "changed text" },
            }),
          },
        ),
      );
      await expectConflict(
        await app.request(
          `http://x/v1/workspaces/${owner.workspaceId}/sessions/${target.id}/events`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              ...sendBody,
              payload: { ...sendBody.payload, model: "replacement-model" },
            }),
          },
        ),
      );
      await expectConflict(
        await app.request(
          `http://x/v1/workspaces/${owner.workspaceId}/sessions/${target.id}/steer`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({ text: sendBody.payload.text, clientEventId: sendKey }),
          },
        ),
      );
      await expectConflict(
        await app.request(
          `http://x/v1/workspaces/${owner.workspaceId}/sessions/${otherTarget.id}/events`,
          { method: "POST", headers, body: JSON.stringify(sendBody) },
        ),
      );

      const otherActor = await provisionActor({
        accountExternalId: `account-${fixture}`,
        workspaceExternalId: `workspace-${fixture}`,
        subjectId: `user:other-${fixture}`,
      });
      const otherResponse = await app.request(
        `http://x/v1/workspaces/${owner.workspaceId}/sessions/${target.id}/events`,
        {
          method: "POST",
          headers: {
            authorization: await bearer(otherActor),
            "content-type": "application/json",
          },
          body: JSON.stringify(sendBody),
        },
      );
      expect(otherResponse.status).not.toBe(202);
      const otherBody = await otherResponse.text();
      expect(otherBody).not.toContain(acceptedSend.id);
      expect(otherBody).not.toContain(acceptedSteer.turn.id);
      expect(await durablePromptFacts(owner.workspaceId, target.id)).toEqual(beforeRemovalReplay);
    } finally {
      await shared!.admin`delete from deployment_model_catalog`;
    }
  });

  test("an overlapping same-key retry replays after mutable model admission fails", async () => {
    if (!available) return;
    const fixture = crypto.randomUUID();
    const owner = await provisionActor({
      accountExternalId: `overlap-account-${fixture}`,
      workspaceExternalId: `overlap-workspace-${fixture}`,
      subjectId: `user:overlap-owner-${fixture}`,
    });
    const workflow = new FakeWorkflowClient();
    const app = buildApp(workflow);
    const headers = {
      authorization: await bearer(owner),
      "content-type": "application/json",
    };

    try {
      await installCatalog(
        {
          schemaVersion: 1,
          defaultModel: "scripted-model",
          builtInModels: ["scripted-model", "switch-model"],
        },
        1,
      );
      const createResponse = await app.request(
        `http://x/v1/workspaces/${owner.workspaceId}/sessions`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            initialMessage: "overlapping prompt replay fixture",
            model: "scripted-model",
            sandboxBackend: "none",
            idempotencyKey: `create-${fixture}`,
          }),
        },
      );
      expect(createResponse.status).toBe(202);
      const session = (await createResponse.json()) as { id: string };
      const clientEventId = crypto.randomUUID();
      const body = JSON.stringify({
        text: "switch exactly once",
        model: "switch-model",
        clientEventId,
      });
      const before = await durablePromptFacts(owner.workspaceId!, session.id);
      let originalPromise: Promise<Response> | null = null;
      let retryPromise: Promise<Response> | null = null;

      await shared!.admin.begin(async (barrier) => {
        const [backend] = await barrier<Array<{ pid: number }>>`select pg_backend_pid() as pid`;
        if (!backend) throw new Error("database barrier has no backend pid");
        await barrier`lock table audit_events in access exclusive mode`;

        originalPromise = app.request(
          `http://x/v1/workspaces/${owner.workspaceId}/sessions/${session.id}/steer`,
          { method: "POST", headers, body },
        );
        const originalBackendPid = await waitForBlockedBackend(
          backend.pid,
          "original prompt transaction",
        );

        await installCatalog(
          {
            schemaVersion: 1,
            defaultModel: "scripted-model",
            builtInModels: ["scripted-model"],
          },
          2,
        );
        retryPromise = app.request(
          `http://x/v1/workspaces/${owner.workspaceId}/sessions/${session.id}/steer`,
          { method: "POST", headers, body },
        );
        await waitForBlockedBackend(originalBackendPid, "serialized same-key retry");
      });

      if (!originalPromise || !retryPromise) {
        throw new Error("overlapping prompt requests were not started");
      }
      const [originalResponse, retryResponse] = await Promise.all([originalPromise, retryPromise]);
      expect(originalResponse.status).toBe(202);
      expect(retryResponse.status).toBe(202);
      const original = (await originalResponse.json()) as {
        accepted: { id: string };
        turn: { id: string };
        receipt: { id: string };
        replay: boolean;
      };
      const retry = (await retryResponse.json()) as typeof original;
      expect(original.replay).toBeFalse();
      expect(retry).toMatchObject({
        accepted: { id: original.accepted.id },
        turn: { id: original.turn.id },
        receipt: { id: original.receipt.id },
        replay: true,
      });

      const afterOverlap = await durablePromptFacts(owner.workspaceId!, session.id);
      expect(afterOverlap).toEqual({
        events: before.events + 2,
        turns: before.turns + 1,
        receipts: before.receipts + 1,
        usageEvents: before.usageEvents + 1,
        wakeRevision: before.wakeRevision + 1,
      });
      const [operationRows] = await shared!.admin<
        Array<{ events: number; turns: number; receipts: number; usageEvents: number }>
      >`
        select
          (select count(*)::int from session_events
            where workspace_id = ${owner.workspaceId}
              and session_id = ${session.id}
              and client_event_id = ${clientEventId}) as events,
          (select count(*)::int from session_turns
            where workspace_id = ${owner.workspaceId}
              and id = ${original.turn.id}) as turns,
          (select count(*)::int from session_command_receipts
            where workspace_id = ${owner.workspaceId}
              and operation_key = ${clientEventId}) as receipts,
          (select count(*)::int from usage_events
            where workspace_id = ${owner.workspaceId}
              and source_resource_type = 'session_turn'
              and source_resource_id = ${original.turn.id}) as "usageEvents"
      `;
      expect(operationRows).toEqual({ events: 1, turns: 1, receipts: 1, usageEvents: 1 });

      const replayResponse = await app.request(
        `http://x/v1/workspaces/${owner.workspaceId}/sessions/${session.id}/steer`,
        { method: "POST", headers, body },
      );
      expect(replayResponse.status).toBe(202);
      expect(await replayResponse.json()).toMatchObject({
        accepted: { id: original.accepted.id },
        turn: { id: original.turn.id },
        receipt: { id: original.receipt.id },
        replay: true,
      });
      expect(await durablePromptFacts(owner.workspaceId!, session.id)).toEqual(afterOverlap);
    } finally {
      await shared!.admin`delete from deployment_model_catalog`;
    }
  });
});
