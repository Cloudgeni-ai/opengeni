import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { signDelegatedAccessToken, type Permission } from "@opengeni/contracts";
import { bootstrapWorkspace, createDb, type DbClient } from "@opengeni/db";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { Hono } from "hono";
import { registerSlackTaskPolicyRoutes } from "../src/routes/slack-task-policy";

const SECRET = "slack-task-policy-test-secret-at-least-32-bytes";
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
let app: Hono | null = null;
let grant: Awaited<ReturnType<typeof bootstrapWorkspace>>["workspaceGrants"][number];

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api-slack-task-policy");
  if (!shared) return;
  client = createDb(shared.appUrl);
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `api-slack-task-policy-${crypto.randomUUID()}`,
    accountName: "Slack policy account",
    workspaceExternalSource: "test",
    workspaceExternalId: `api-slack-task-policy-workspace-${crypto.randomUUID()}`,
    workspaceName: "Slack policy workspace",
    subjectId: "human:slack-policy-admin",
  });
  grant = access.workspaceGrants[0]!;
  app = new Hono();
  registerSlackTaskPolicyRoutes(app, {
    settings: testSettings({ productAccessMode: "managed", delegationSecret: SECRET }),
    db: client.db,
  } as ApiRouteDeps);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
});

async function bearer(permissions: Permission[]): Promise<string> {
  return `Bearer ${await signDelegatedAccessToken(SECRET, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: grant.subjectId,
    permissions,
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1000) + 3_600,
  })}`;
}

const policy = {
  allowedTeamIds: ["T_EXTERNAL", "T_HOME"],
  allowedConversationIds: ["C_SHARED"],
  allowGuestInitiators: false,
  allowExternalInitiators: true,
  allowMpim: false,
  sharedConversationMode: "private_handoff",
  resultPublicationMode: "approval_required",
} as const;

describe("Slack task-policy API authority", () => {
  test("creates immutable policy history with CAS and idempotency", async () => {
    if (!app) return;
    const operationId = crypto.randomUUID();
    const body = {
      operationId,
      policy,
      expectedCurrentRevisionId: null,
      expectedActivationVersion: 0,
      reason: "Allow this exact partner channel with private handoff",
    };
    const unauthorized = await app.request(
      `http://x/v1/workspaces/${grant.workspaceId}/slack-task-policy`,
      {
        method: "PUT",
        headers: {
          authorization: await bearer(["workspace:read"]),
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    expect(unauthorized.status).toBe(403);

    const created = await app.request(
      `http://x/v1/workspaces/${grant.workspaceId}/slack-task-policy`,
      {
        method: "PUT",
        headers: {
          authorization: await bearer(["workspace:read", "workspace:admin"]),
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    expect(created.status, await created.clone().text()).toBe(200);
    const result = (await created.json()) as Record<string, any>;
    expect(result).toMatchObject({
      revision: { policy, supersedesRevisionId: null },
      head: { revisionId: result.revision.id, activationVersion: 1 },
      event: { newRevision: { id: result.revision.id }, oldRevision: null },
    });

    const replay = await app.request(
      `http://x/v1/workspaces/${grant.workspaceId}/slack-task-policy`,
      {
        method: "PUT",
        headers: {
          authorization: await bearer(["workspace:read", "workspace:admin"]),
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    expect(replay.status).toBe(200);
    expect((await replay.json()) as Record<string, any>).toMatchObject({
      revision: { id: result.revision.id },
      event: { id: result.event.id },
    });

    const reusedOperation = await app.request(
      `http://x/v1/workspaces/${grant.workspaceId}/slack-task-policy`,
      {
        method: "PUT",
        headers: {
          authorization: await bearer(["workspace:read", "workspace:admin"]),
          "content-type": "application/json",
        },
        body: JSON.stringify({ ...body, reason: "A conflicting replay" }),
      },
    );
    expect(reusedOperation.status).toBe(409);
    expect(await reusedOperation.json()).toMatchObject({
      code: "SLACK_TASK_POLICY_OPERATION_REUSED",
    });

    const stale = await app.request(
      `http://x/v1/workspaces/${grant.workspaceId}/slack-task-policy`,
      {
        method: "PUT",
        headers: {
          authorization: await bearer(["workspace:read", "workspace:admin"]),
          "content-type": "application/json",
        },
        body: JSON.stringify({ ...body, operationId: crypto.randomUUID() }),
      },
    );
    expect(stale.status).toBe(409);

    const read = await app.request(
      `http://x/v1/workspaces/${grant.workspaceId}/slack-task-policy`,
      { headers: { authorization: await bearer(["workspace:read"]) } },
    );
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      current: { revisionId: result.revision.id },
      activeRevision: { id: result.revision.id, policy },
      revisions: [expect.objectContaining({ id: result.revision.id })],
    });
  });
});
