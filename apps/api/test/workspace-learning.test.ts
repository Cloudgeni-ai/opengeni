import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { signDelegatedAccessToken, type Permission } from "@opengeni/contracts";
import { bootstrapWorkspace, createDb, type DbClient } from "@opengeni/db";
import { migrate } from "@opengeni/db/migrate";
import { provisionRoles } from "@opengeni/db/provision-roles";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { Hono } from "hono";
import postgres from "postgres";
import { registerWorkspaceLearningRoutes } from "../src/routes/workspace-learning";

const SECRET = "workspace-learning-test-secret-at-least-32-bytes";
type Grant = Awaited<ReturnType<typeof bootstrapWorkspace>>["workspaceGrants"][number];

let shared: SharedTestDatabase;
let client: DbClient;
let app: Hono;
let grant: Grant;

beforeAll(async () => {
  const explicitAdminUrl = process.env.OPENGENI_WORKSPACE_LEARNING_TEST_ADMIN_URL;
  const explicitAppUrl = process.env.OPENGENI_WORKSPACE_LEARNING_TEST_APP_URL;
  if (explicitAdminUrl && explicitAppUrl) {
    const explicitAppPassword = decodeURIComponent(new URL(explicitAppUrl).password);
    await migrate(explicitAdminUrl);
    await provisionRoles(explicitAdminUrl, { appPassword: explicitAppPassword });
    const admin = postgres(explicitAdminUrl, { max: 4 });
    shared = {
      admin,
      adminUrl: explicitAdminUrl,
      appUrl: explicitAppUrl,
      release: async () => await admin.end(),
    };
  } else {
    const acquired = await acquireSharedTestDatabase("workspace-learning-api");
    if (!acquired) throw new Error("PostgreSQL test database unavailable");
    shared = acquired;
  }
  client = createDb(shared.appUrl);
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `learning-account-${crypto.randomUUID()}`,
    accountName: "Learning account",
    workspaceExternalSource: "test",
    workspaceExternalId: `learning-workspace-${crypto.randomUUID()}`,
    workspaceName: "Learning workspace",
    subjectId: "user:learning-admin",
  });
  grant = access.workspaceGrants[0]!;
  app = new Hono();
  registerWorkspaceLearningRoutes(app, {
    settings: testSettings({ productAccessMode: "managed", delegationSecret: SECRET }),
    db: client.db,
  } as ApiRouteDeps);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function request(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    permissions?: Permission[];
    principalKind?: "human_session" | "service";
  } = {},
): Promise<Response> {
  const token = await signDelegatedAccessToken(SECRET, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: grant.subjectId,
    permissions: options.permissions ?? ["workspace:read", "workspace:admin"],
    principalKind: options.principalKind ?? "human_session",
    exp: Math.floor(Date.now() / 1000) + 3_600,
  });
  return await app.request(`http://x/v1/workspaces/${grant.workspaceId}${path}`, {
    method: options.method ?? "GET",
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

describe("workspace learning API", () => {
  test("keeps settings human-admin-only and exposes bounded CAS history", async () => {
    const empty = await request("/learning");
    expect(empty.status).toBe(200);
    expect(await empty.json()).toMatchObject({
      head: null,
      revisions: [],
      policyEvents: [],
      decisions: [],
      activations: [],
      undos: [],
      truncated: false,
      effectiveBoundary: "next_accepted_attempt",
    });

    const nonHumanHistory = await request("/learning", { principalKind: "service" });
    expect(nonHumanHistory.status).toBe(403);

    const denied = await request("/learning/revisions", {
      method: "POST",
      permissions: ["workspace:read"],
      body: { workspaceMode: "suggest" },
    });
    expect(denied.status).toBe(403);

    const firstResponse = await request("/learning/revisions", {
      method: "POST",
      body: { workspaceMode: "suggest" },
    });
    expect(firstResponse.status).toBe(201);
    const first = (await firstResponse.json()) as { id: string; revision: number };
    expect(first.revision).toBe(1);

    const firstActivation = await request(`/learning/revisions/${first.id}/activate`, {
      method: "POST",
      body: {
        expectedCurrentRevisionId: null,
        expectedActivationVersion: 0,
        reason: "Enable review-first learning",
      },
    });
    expect(firstActivation.status).toBe(200);
    expect(await firstActivation.json()).toMatchObject({
      head: { revisionId: first.id, activationVersion: 1 },
      event: { type: "activate", activationVersion: 1 },
    });

    const secondResponse = await request("/learning/revisions", {
      method: "POST",
      body: {
        workspaceMode: "automatic",
        supersedesRevisionId: first.id,
        sourceOverrides: [{ kind: "task-note", id: "note:finance", mode: "suggest" }],
      },
    });
    expect(secondResponse.status).toBe(201);
    const second = (await secondResponse.json()) as { id: string; revision: number };

    const secondActivation = await request(`/learning/revisions/${second.id}/activate`, {
      method: "POST",
      body: {
        expectedCurrentRevisionId: first.id,
        expectedActivationVersion: 1,
        reason: "Enable guarded automatic learning",
      },
    });
    expect(secondActivation.status).toBe(200);

    const staleRollback = await request("/learning/rollback", {
      method: "POST",
      body: {
        targetRevisionId: first.id,
        expectedCurrentRevisionId: first.id,
        expectedActivationVersion: 1,
        reason: "Stale rollback",
      },
    });
    expect(staleRollback.status).toBe(409);

    const rollback = await request("/learning/rollback", {
      method: "POST",
      body: {
        targetRevisionId: first.id,
        expectedCurrentRevisionId: second.id,
        expectedActivationVersion: 2,
        reason: "Restore review-first learning",
      },
    });
    expect(rollback.status).toBe(200);
    expect(await rollback.json()).toMatchObject({
      head: { revisionId: first.id, activationVersion: 3 },
      event: { type: "rollback", activationVersion: 3 },
    });

    const history = await request("/learning?limit=10");
    expect(history.status).toBe(200);
    expect(await history.json()).toMatchObject({
      head: { revisionId: first.id, activationVersion: 3 },
      revisions: [{ id: second.id }, { id: first.id }],
      policyEvents: [
        { type: "rollback", activationVersion: 3 },
        { type: "activate", activationVersion: 2 },
        { type: "activate", activationVersion: 1 },
      ],
      effectiveBoundary: "next_accepted_attempt",
    });
  });
});
