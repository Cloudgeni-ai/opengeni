import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import postgres from "postgres";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  completeSelfServiceOrganizationSetup,
  createApiKey,
  createDb,
  createOrganizationApiKey,
  createWorkspace,
  type DbClient,
} from "@opengeni/db";
import { synchronizeCanonicalHumanLoginBindings } from "@opengeni/db/canonical-human-identities";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { registerOrganizationIntegrationPolicyRoutes } from "../src/routes/organization-integration-policy";

let shared: SharedTestDatabase;
let client: DbClient;
const origin = "http://opengeni.test";
const secret = "organization-policy-administration-delegation";
const users: string[] = [];
const accounts: string[] = [];
const identities: string[] = [];
type Human = {
  userId: string;
  subjectId: string;
  sessionId: string;
  email: string;
  accountId: string;
  workspaceId: string;
};
let owner: Human;
let outsider: Human;

beforeAll(async () => {
  const adminUrl = process.env.OPENGENI_INTEGRATION_POLICY_TEST_ADMIN_URL;
  const appUrl = process.env.OPENGENI_INTEGRATION_POLICY_TEST_APP_URL;
  if (Boolean(adminUrl) !== Boolean(appUrl)) throw new Error("Set both policy fixture URLs");
  const acquired =
    adminUrl && appUrl
      ? {
          admin: postgres(adminUrl),
          adminUrl,
          appUrl,
          release: async () => {
            await shared.admin.end();
          },
        }
      : await acquireSharedTestDatabase("organization-integration-administration");
  if (!acquired) throw new Error("Administration tests require real PostgreSQL");
  shared = acquired;
  client = createDb(shared.appUrl);
  owner = await human();
  outsider = await human();
}, 180_000);
afterAll(async () => {
  if (shared) {
    for (const accountId of accounts) {
      // Remove only this fixture's dependent activation/setup evidence before
      // its account. No runtime role or production lifecycle is relaxed.
      await shared.admin`delete from session_tenancy_greenfield_activation_evidence where account_id = ${accountId}`;
      await shared.admin`delete from session_tenancy_activations where account_id = ${accountId}`;
      await shared.admin`delete from self_service_organization_setup_receipts where account_id = ${accountId}`;
      await shared.admin`delete from managed_accounts where id = ${accountId}`;
    }
    for (const userId of users) {
      await shared.admin`delete from canonical_human_identity_operations where actor_auth_user_id = ${userId}`;
      await shared.admin`delete from canonical_human_identity_subjects where auth_user_id = ${userId}`;
      await shared.admin`delete from auth_users where id = ${userId}`;
    }
    for (const identityId of identities) {
      await shared.admin`update canonical_human_identities set active_login_binding_id = null where id = ${identityId}`;
      await shared.admin`delete from canonical_human_login_bindings where identity_id = ${identityId}`;
      await shared.admin`delete from canonical_human_identities where id = ${identityId}`;
    }
  }
  await client?.close();
  await shared?.release();
}, 60_000);

async function human(): Promise<Human> {
  const userId = `policy-admin-${crypto.randomUUID()}`;
  users.push(userId);
  const subjectId = `user:${userId}`;
  const email = `${userId}@example.test`;
  await shared.admin`insert into auth_users (id, name, email, email_verified) values (${userId}, 'Policy fixture', ${email}, true)`;
  const setup = await completeSelfServiceOrganizationSetup(client.db, {
    authUserId: userId,
    actorSubjectId: subjectId,
    organizationName: "Policy fixture",
    operationId: crypto.randomUUID(),
    requestFingerprint: "a".repeat(64),
  });
  accounts.push(setup.organizationId);
  await shared.admin`insert into auth_identities (id, user_id, provider_id, account_id) values (${crypto.randomUUID()}, ${userId}, 'credential', ${userId})`;
  const identity = await synchronizeCanonicalHumanLoginBindings(client.db, userId);
  identities.push(identity.identityId);
  const sessionId = `session-${crypto.randomUUID()}`;
  await shared.admin`insert into auth_sessions (id, user_id, token, expires_at, identity_id, identity_revision, auth_revision)
    values (${sessionId}, ${userId}, ${crypto.randomUUID()}, now() + interval '1 hour', ${identity.identityId}, ${identity.identityRevision}, ${identity.authRevision})`;
  return {
    userId,
    subjectId,
    email,
    sessionId,
    accountId: setup.organizationId,
    workspaceId: setup.personalWorkspaceId,
  };
}

function app(actor = owner): Hono {
  const application = new Hono();
  application.onError((error, c) => {
    if (error instanceof HTTPException) return c.json({ message: error.message }, error.status);
    throw error;
  });
  registerOrganizationIntegrationPolicyRoutes(application, {
    db: client.db,
    settings: testSettings({
      productAccessMode: "managed",
      publicBaseUrl: origin,
      betterAuthSecret: "policy-administration-cookie-secret-at-least-32-bytes",
      delegationSecret: secret,
    }),
    // This adapter supplies the cookie response; getManagedSession still checks
    // the durable identity-bound session and canonical human login revisions.
    managedAuth: {
      api: {
        getSession: async () => ({
          headers: new Headers(),
          response: {
            session: { id: actor.sessionId },
            user: {
              id: actor.userId,
              email: actor.email,
              name: "Policy fixture",
              emailVerified: true,
            },
          },
        }),
      },
    } as never,
  } as ApiRouteDeps);
  return application;
}
const path = (accountId = owner.accountId) =>
  `${origin}/v1/organizations/${accountId}/integration-policy`;
const browser = () => ({
  cookie: "session=present",
  "content-type": "application/json",
  origin,
  "sec-fetch-site": "same-origin",
});
const request = (revision: number) => ({
  mode: "restricted",
  allowedIntegrationKeys: ["github-app"],
  expectedRevision: revision,
  operationId: crypto.randomUUID(),
});
async function currentRevision() {
  const [row] =
    await shared.admin`select revision from organization_integration_policies where account_id = ${owner.accountId}`;
  return row ? Number(row.revision) : 0;
}
async function matrix(
  application: Hono,
  headers: Record<string, string>,
  expected: number,
  accountId = owner.accountId,
) {
  for (const endpoint of [path(accountId), `${path(accountId)}/catalog`]) {
    const response = await application.request(endpoint, { headers });
    expect({
      status: response.status,
      body: response.status === expected ? undefined : await response.text(),
    }).toEqual({ status: expected, body: undefined });
  }
  const response = await application.request(path(accountId), {
    method: "PUT",
    headers,
    body: JSON.stringify(request(await currentRevision())),
  });
  expect({
    status: response.status,
    body: response.status === expected ? undefined : await response.text(),
  }).toEqual({ status: expected, body: undefined });
}

test("canonical managed owner and admin may read, list catalog and write; ordinary member may not", async () => {
  const application = app();
  await matrix(application, browser(), 200);
  await shared.admin`update organization_memberships set role = 'admin' where account_id = ${owner.accountId} and subject_id = ${owner.subjectId}`;
  try {
    await matrix(application, browser(), 200);
    await shared.admin`update organization_memberships set role = 'member' where account_id = ${owner.accountId} and subject_id = ${owner.subjectId}`;
    const before = await currentRevision();
    await matrix(application, browser(), 403);
    expect(await currentRevision()).toBe(before);
  } finally {
    await shared.admin`update organization_memberships set role = 'owner' where account_id = ${owner.accountId} and subject_id = ${owner.subjectId}`;
  }
});

test("canonical cookie cannot cross organizations; cookie mutations require complete same-origin evidence", async () => {
  await matrix(app(outsider), browser(), 403);
  const before = await currentRevision();
  for (const replacement of [
    { origin: "https://attacker.example" },
    { origin: "" },
    { "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": "" },
    { "content-type": "text/plain" },
  ]) {
    const response = await app().request(path(), {
      method: "PUT",
      headers: { ...browser(), ...replacement },
      body: JSON.stringify(request(before)),
    });
    expect(response.status).toBe(403);
  }
  expect(await currentRevision()).toBe(before);
});

test("signed delegated owner cannot substitute human-session claims or a cookie for native provenance", async () => {
  const authorization = `Bearer ${await signDelegatedAccessToken(secret, {
    accountId: owner.accountId,
    workspaceId: owner.workspaceId,
    subjectId: owner.subjectId,
    permissions: ["workspace:admin"],
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}`;
  await matrix(app(), { ...browser(), authorization }, 403);
  const { cookie: _cookie, ...withoutCookie } = browser();
  await matrix(app(), { ...withoutCookie, authorization }, 403);
});

test("signed agent-attempt authority is never native organization administration", async () => {
  // This route must reject the authenticated agent provenance before acquiring
  // organization administration; it must not promote signed workspace admin.
  const sessionId = crypto.randomUUID();
  const authorization = `Bearer ${await signDelegatedAccessToken(secret, {
    accountId: owner.accountId,
    workspaceId: owner.workspaceId,
    subjectId: `worker:${sessionId}`,
    permissions: ["workspace:admin"],
    principalKind: "agent_attempt",
    sessionId,
    turnId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    executionGeneration: 1,
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}`;
  await matrix(app(), { ...browser(), authorization }, 403);
});

test("full organization service key is workspace-independent; read-only and workspace keys cannot administer", async () => {
  const token = crypto.randomUUID();
  const key = await createOrganizationApiKey(client.db, {
    accountId: owner.accountId,
    name: "Policy service",
    prefix: "test",
    keyHash: createHash("sha256").update(token).digest("hex"),
    permissions: ["workspace:admin"],
  });
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  await matrix(app(), headers, 200);
  await matrix(app(), headers, 403, outsider.accountId);
  await shared.admin`update api_keys set permissions = '["workspace:read"]'::jsonb where id = ${key.id}`;
  await matrix(app(), headers, 403);
  const workspace = await createWorkspace(client.db, {
    accountId: owner.accountId,
    name: "Shared fixture",
  });
  const scopedToken = crypto.randomUUID();
  await createApiKey(client.db, {
    accountId: owner.accountId,
    workspaceId: workspace.id,
    name: "Scoped fixture",
    prefix: "test",
    keyHash: createHash("sha256").update(scopedToken).digest("hex"),
    permissions: ["workspace:admin"],
  });
  await matrix(app(), { ...headers, authorization: `Bearer ${scopedToken}` }, 403);
});

test("exact completed policy receipt does not bypass revoked administrator authority", async () => {
  const application = app();
  const body = JSON.stringify(request(await currentRevision()));
  const write = () => application.request(path(), { method: "PUT", headers: browser(), body });
  const completed = await write();
  expect(completed.status).toBe(200);
  const result = await completed.json();
  expect(await (await write()).json()).toEqual(result);
  await shared.admin`update organization_memberships set role = 'member' where account_id = ${owner.accountId} and subject_id = ${owner.subjectId}`;
  try {
    expect((await write()).status).toBe(403);
    expect(await currentRevision()).toBe(result.revision);
  } finally {
    await shared.admin`update organization_memberships set role = 'owner' where account_id = ${owner.accountId} and subject_id = ${owner.subjectId}`;
  }
});
