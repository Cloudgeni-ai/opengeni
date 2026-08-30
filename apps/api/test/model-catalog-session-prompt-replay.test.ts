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

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("model-catalog-session-prompt-replay");
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
});
