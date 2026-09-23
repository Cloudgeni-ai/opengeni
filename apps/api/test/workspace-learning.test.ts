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
  test("preserves human-admin history and retires competing policy mutations", async () => {
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

    for (const path of [
      "/learning/revisions",
      "/learning/revisions/00000000-0000-4000-8000-000000000001/activate",
      "/learning/rollback",
    ]) {
      const retired = await request(path, { method: "POST", body: {} });
      expect(retired.status).toBe(410);
      expect(await retired.json()).toMatchObject({ error: { code: "learning_settings_replaced" } });
    }
    expect(await (await request("/learning")).json()).toMatchObject({
      head: null,
      revisions: [],
      policyEvents: [],
    });
  });
});
