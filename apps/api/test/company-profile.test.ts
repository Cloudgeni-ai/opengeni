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
import { registerCompanyProfileRoutes } from "../src/routes/company-profile";

const SECRET = "company-profile-test-secret-at-least-32-bytes";
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
let app: Hono | null = null;
let grant: Awaited<ReturnType<typeof bootstrapWorkspace>>["workspaceGrants"][number];

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api-company-profile");
  if (!shared) return;
  client = createDb(shared.appUrl);
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `api-company-profile-${crypto.randomUUID()}`,
    accountName: "API company profile",
    workspaceExternalSource: "test",
    workspaceExternalId: `api-company-profile-workspace-${crypto.randomUUID()}`,
    workspaceName: "API company profile workspace",
    subjectId: "human:profile-admin",
  });
  grant = access.workspaceGrants[0]!;
  app = new Hono();
  registerCompanyProfileRoutes(app, {
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

describe("company-profile API authority", () => {
  test("requires direct account admin for writes while exposing current history to readers", async () => {
    if (!app) return;
    const body = {
      operationId: crypto.randomUUID(),
      profile: {
        identity: "CloudGeni builds OpenGeni.",
        mission: "Make durable autonomous work dependable.",
        products: [],
        customers: [],
        goals: [],
        constraints: [],
      },
      expectedCurrentRevisionId: null,
      expectedActivationVersion: 0,
      reason: "Initial profile",
    };
    const workspaceAdmin = await app.request(
      `http://x/v1/workspaces/${grant.workspaceId}/company-profile`,
      {
        method: "PUT",
        headers: {
          authorization: await bearer(["workspace:read", "workspace:admin"]),
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    expect(workspaceAdmin.status).toBe(403);

    const accountAdmin = await app.request(
      `http://x/v1/workspaces/${grant.workspaceId}/company-profile`,
      {
        method: "PUT",
        headers: {
          authorization: await bearer(["account:admin", "workspace:read"]),
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    expect(accountAdmin.status).toBe(200);
    const created = (await accountAdmin.json()) as Record<string, any>;
    expect(created).toMatchObject({
      revision: { profile: { identity: "CloudGeni builds OpenGeni." } },
      head: { revisionId: created.revision.id, activationVersion: 1 },
      event: { type: "activate" },
    });

    const read = await app.request(`http://x/v1/workspaces/${grant.workspaceId}/company-profile`, {
      headers: { authorization: await bearer(["workspace:read"]) },
    });
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      current: { revisionId: created.revision.id },
      revisions: [expect.objectContaining({ id: created.revision.id })],
    });
  });
});
