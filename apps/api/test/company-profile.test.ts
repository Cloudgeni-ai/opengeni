import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { signDelegatedAccessToken, type Permission } from "@opengeni/contracts";
import {
  completeSelfServiceOrganizationSetup,
  createDb,
  createOrganizationSharedWorkspace,
  ensureManagedAccessForUser,
  grantWorkspaceAccess,
  type DbClient,
} from "@opengeni/db";
import { stampDelegatedHumanAuthorization, type ApiRouteDeps } from "@opengeni/core";
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
let grant: Awaited<ReturnType<typeof ensureManagedAccessForUser>>["workspaceGrants"][number];

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api-company-profile");
  if (!shared) return;
  client = createDb(shared.appUrl);
  const userId = `api-company-profile-${crypto.randomUUID()}`;
  const subjectId = `user:${userId}`;
  await shared.admin`insert into auth_users (id, name, email, email_verified)
    values (${userId}, 'API company profile owner', ${`${userId}@example.test`}, true)`;
  const setup = await completeSelfServiceOrganizationSetup(client.db, {
    authUserId: userId,
    actorSubjectId: subjectId,
    organizationName: "Company profile account",
    operationId: crypto.randomUUID(),
    requestFingerprint: "a".repeat(64),
  });
  const workspace = await createOrganizationSharedWorkspace(client.db, {
    organizationId: setup.organizationId,
    actorSubjectId: subjectId,
    name: "Company profile workspace",
    operationId: crypto.randomUUID(),
  });
  await grantWorkspaceAccess(client.db, {
    accountId: setup.organizationId,
    workspaceId: workspace.id,
    subjectId,
    role: "owner",
    permissions: ["workspace:read", "workspace:admin"],
  });
  const access = await ensureManagedAccessForUser(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "API company profile owner",
  });
  grant = access.workspaceGrants.find((candidate) => candidate.workspaceId === workspace.id)!;
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

function delegatedRequest(path: string, permissions: Permission[], init?: RequestInit) {
  const request = new Request(path, init);
  stampDelegatedHumanAuthorization(request, {
    organizationId: grant.accountId,
    subjectId: grant.subjectId,
    permissions,
    workspaceScope: { kind: "selected", workspaceIds: [grant.workspaceId] },
  });
  return app!.fetch(request);
}

describe("company-profile API authority", () => {
  test("requires verified literal account admin for writes while exposing current history to readers", async () => {
    if (!app) return;
    const policyEndpoint = `http://x/v1/workspaces/${grant.workspaceId}/company-profile/agent-policy`;
    expect(
      (await delegatedRequest(policyEndpoint, ["workspace:read", "workspace:admin"])).status,
    ).toBe(403);
    const initialPolicy = await delegatedRequest(policyEndpoint, [
      "account:admin",
      "workspace:read",
    ]);
    expect(initialPolicy.status).toBe(200);
    expect(await initialPolicy.json()).toMatchObject({
      organizationId: grant.accountId,
      mode: "suggest",
      version: 0,
    });
    const automaticPolicy = await delegatedRequest(
      policyEndpoint,
      ["account:admin", "workspace:read"],
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          mode: "automatic",
          expectedVersion: 0,
          operationId: crypto.randomUUID(),
        }),
      },
    );
    expect(automaticPolicy.status).toBe(200);
    expect(await automaticPolicy.json()).toMatchObject({
      organizationId: grant.accountId,
      mode: "automatic",
      version: 1,
      changed: true,
    });

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
    const workspaceAdmin = await delegatedRequest(
      `http://x/v1/workspaces/${grant.workspaceId}/company-profile`,
      ["workspace:read", "workspace:admin"],
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    expect(workspaceAdmin.status).toBe(403);

    const legacyHuman = await app.request(
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
    expect(legacyHuman.status).toBe(403);

    const accountAdmin = await delegatedRequest(
      `http://x/v1/workspaces/${grant.workspaceId}/company-profile`,
      ["account:admin", "workspace:read"],
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
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
      activeRevision: { id: created.revision.id },
      revisions: [expect.objectContaining({ id: created.revision.id })],
    });
  });
});
