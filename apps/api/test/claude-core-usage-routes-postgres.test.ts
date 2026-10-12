/**
 * Claude usage routes on the shared core (design 5.3, Claude track C2a,
 * EP-N24 and EP-S13) through the real app, on real PostgreSQL as the
 * non-owner application role: who may read and refresh which connection.
 *
 * Claude stays unregistered in production until its cutover (C3); this file
 * registers the production binding in its own process and admits it on its
 * own test database. The usage endpoint is scripted through `claudeFetch`;
 * real network is denied.
 *
 * Run this file in its own process: the registration replaces module
 * bindings for the whole process.
 */
import { afterAll, beforeAll, describe, expect, mock, setDefaultTimeout, test } from "bun:test";
import { signDelegatedAccessToken, type Permission } from "@opengeni/contracts";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import {
  subscriptionCoreClaudeProvider,
  type SubscriptionCoreClaudeCredential,
} from "../../../packages/db/src/subscription-core-claude-adapter";
import { encryptEnvironmentValue } from "../../../packages/db/src/environment-crypto";
import { installNetworkDenialGuard } from "../../../packages/db/test/fixtures/subscription-core-fake-api-key";
import {
  admitTestSubscriptionCoreProvider,
  testSubscriptionCoreProviderModules,
} from "../../../packages/db/test/helpers/subscription-core-test-provider";

setDefaultTimeout(180_000);

const CLAUDE = subscriptionCoreClaudeProvider({
  fetch: (async () => {
    throw new Error("no OAuth refresh is expected in this suite");
  }) as unknown as typeof fetch,
});
for (const [specifier, factory] of testSubscriptionCoreProviderModules(CLAUDE))
  mock.module(specifier, factory);

const {
  createDb,
  bootstrapWorkspace,
  createManagedOrganization,
  createOrganizationWorkspace,
  createOrganizationInvitation,
  acceptOrganizationInvitation,
} = await import("@opengeni/db");
const { stampDelegatedHumanAuthorization } = await import("@opengeni/core");
const { createApp } = await import("../src/app");
type DbClient = Awaited<ReturnType<typeof createDb>>;

const DELEGATION_SECRET = "claude-core-usage-postgres-delegation-secret";
const key = Buffer.alloc(32, 61);
const settings = testSettings({
  productAccessMode: "managed",
  delegationSecret: DELEGATION_SECRET,
  environmentsEncryptionKey: key.toString("base64"),
  claudeSubscriptionEnabled: true,
  sandboxBackend: "none",
});
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

let shared: SharedTestDatabase;
let client: DbClient;
let network: ReturnType<typeof installNetworkDenialGuard>;
const usageCalls: string[] = [];

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("claude-core-usage-routes-postgres");
  if (!acquired) throw new Error("Real PostgreSQL is required");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 6 });
  network = installNetworkDenialGuard(() => []);
  await admitTestSubscriptionCoreProvider(shared.admin, CLAUDE);
}, 180_000);

afterAll(async () => {
  network?.restore();
  network?.assertNoEscapes();
  await client?.close();
  await shared?.release();
}, 180_000);

type Org = {
  accountId: string;
  workspaceId: string;
  personalWorkspaceId: string;
  ownerSubjectId: string;
  ownerMembershipId: string;
  memberSubjectId: string;
};

/** An organization on the Claude core route: an owner (administrator) and a plain member. */
async function organization(): Promise<Org> {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `claude-usage-routes-${suffix}`,
    accountName: "Claude usage routes",
    workspaceExternalSource: "test",
    workspaceExternalId: `claude-usage-routes-${suffix}`,
    workspaceName: "Claude usage routes",
    subjectId: `user:claude-usage-owner-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const [personal] = await shared.admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${grant.accountId}, 'Owner Personal workspace') returning id::text as id`;
  const [membership] = await shared.admin<{ id: string }[]>`
    insert into organization_memberships (account_id, subject_id, role, status, personal_workspace_id)
    values (${grant.accountId}, ${grant.subjectId}, 'owner', 'active', ${personal!.id})
    returning id::text as id`;
  await shared.admin`
    insert into workspace_memberships (account_id, workspace_id, subject_id, role)
    values (${grant.accountId}::uuid, ${personal!.id}::uuid, ${grant.subjectId}, 'owner')
    on conflict do nothing`;
  const memberSubjectId = `user:claude-usage-member-${suffix}`;
  const [memberPersonal] = await shared.admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${grant.accountId}, 'Member Personal workspace') returning id::text as id`;
  await shared.admin`
    insert into organization_memberships (account_id, subject_id, role, status, personal_workspace_id)
    values (${grant.accountId}, ${memberSubjectId}, 'member', 'active', ${memberPersonal!.id})`;
  await shared.admin`
    insert into workspace_memberships (account_id, workspace_id, subject_id, role)
    values (${grant.accountId}::uuid, ${grant.workspaceId}::uuid, ${memberSubjectId}, 'member')
    on conflict do nothing`;
  await shared.admin`
    insert into subscription_provider_cutovers (account_id, provider, enabled)
    values (${grant.accountId}::uuid, 'claude', true)
    on conflict (account_id, provider) do update set enabled = excluded.enabled`;
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    personalWorkspaceId: personal!.id,
    ownerSubjectId: grant.subjectId,
    ownerMembershipId: membership!.id,
    memberSubjectId,
  };
}

function credential(label: string): string {
  const value: SubscriptionCoreClaudeCredential = {
    version: 1,
    token: `sk-ant-oat01-${label}`,
    identity: { accountUuid: crypto.randomUUID(), deviceId: "d".repeat(64) },
    oauth: {
      refreshToken: `refresh-${label}`,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      scopes: ["user:inference", "user:profile"],
    },
  };
  return encryptEnvironmentValue(key, JSON.stringify(value));
}

/** A shared connection of one pool, assigned to the shared workspace. */
async function sharedConnection(
  org: Org,
  label: string,
  pool: "organization" | "workspace" = "organization",
): Promise<string> {
  const [row] = await shared.admin<{ id: string }[]>`
    insert into subscription_connections (
      account_id, provider, kind, credential_encrypted, ownership, scope_kind,
      provider_account_id, provider_state, expires_at, label, managed_by_workspace_id
    ) values (
      ${org.accountId}::uuid, 'claude', 'subscription', ${credential(label)}, 'shared',
      'organization', ${`claude-${label}-${crypto.randomUUID()}`},
      ${shared.admin.json({ oauthScopes: ["user:inference", "user:profile"] })}::jsonb,
      ${new Date(Date.now() + 86_400_000).toISOString()}::timestamptz, ${label},
      ${pool === "workspace" ? org.workspaceId : null}::uuid
    ) returning id::text as id`;
  await shared.admin`
    insert into subscription_connection_assignment_policies (
      account_id, connection_id, workspace_id, inference_pool, allowed_model_ids
    ) values (
      ${org.accountId}::uuid, ${row!.id}::uuid, ${org.workspaceId}::uuid, ${pool}, null
    )`;
  return row!.id;
}

/** The owner's personal connection. */
async function personalConnection(org: Org, label: string): Promise<string> {
  const connectionId = crypto.randomUUID();
  const authorityId = crypto.randomUUID();
  await shared.admin`
    insert into organization_user_resource_authorities (
      id, account_id, organization_membership_id, resource_kind, resource_id, generation, status
    ) values (
      ${authorityId}::uuid, ${org.accountId}::uuid, ${org.ownerMembershipId}::uuid,
      'subscription_connection', ${connectionId}::uuid, 1, 'active'
    )`;
  await shared.admin`
    insert into subscription_connections (
      id, account_id, provider, credential_encrypted, ownership, scope_kind,
      owner_organization_membership_id, owner_subject_id, authority_id,
      authority_resource_kind, authority_generation, provider_account_id, provider_state, expires_at
    ) values (
      ${connectionId}::uuid, ${org.accountId}::uuid, 'claude', ${credential(label)},
      'personal', 'people', ${org.ownerMembershipId}::uuid, ${org.ownerSubjectId},
      ${authorityId}::uuid, 'subscription_connection', 1, ${`claude-${label}`},
      ${shared.admin.json({ oauthScopes: ["user:inference", "user:profile"] })}::jsonb,
      ${new Date(Date.now() + 86_400_000).toISOString()}::timestamptz
    )`;
  return connectionId;
}

async function connectionVersion(connectionId: string): Promise<number> {
  const [row] = await shared.admin<{ version: number }[]>`
    select version::int as version from subscription_connections where id = ${connectionId}::uuid`;
  return row!.version;
}

const scriptedUsage = (async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url !== USAGE_URL) throw new Error(`unexpected request ${url}`);
  usageCalls.push(url);
  return new Response(
    JSON.stringify({
      five_hour: { utilization: 12, resets_at: new Date(Date.now() + 3_600_000).toISOString() },
      seven_day: { utilization: 30, resets_at: new Date(Date.now() + 86_400_000).toISOString() },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}) as typeof fetch;

function app() {
  return createApp({
    settings,
    db: client.db,
    bus: { publish: async () => undefined } as never,
    workflowClient: {
      wakeSessionWorkflow: async () => undefined,
      requestSessionWorkflowWakeDispatch: async () => undefined,
    } as never,
    managedAuth: null,
    claudeFetch: scriptedUsage,
  } as never);
}

async function workspaceRequest(
  org: Org,
  subjectId: string,
  permissions: Permission[],
  path: string,
  method: "GET" | "POST" = "GET",
) {
  const token = await signDelegatedAccessToken(DELEGATION_SECRET, {
    accountId: org.accountId,
    workspaceId: org.workspaceId,
    subjectId,
    permissions,
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  return await app().request(path, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  });
}

/** The organization path, as the person an agent acts for (the real administrator check). */
async function organizationRequest(
  org: Org,
  subjectId: string,
  path: string,
  method: "GET" | "POST" = "GET",
) {
  const request = new Request(`http://opengeni.test${path}`, {
    method,
    headers: { "content-type": "application/json", "content-length": "0" },
  });
  stampDelegatedHumanAuthorization(request, {
    organizationId: org.accountId,
    subjectId,
    permissions: ["account:read", "account:admin"] as never,
    workspaceScope: { kind: "all" },
  });
  return await app().request(request);
}

const memberPermissions: Permission[] = ["workspace:read", "sessions:read", "connections:write"];
const adminPermissions: Permission[] = [...memberPermissions, "workspace:admin"];

describe("the application role", () => {
  test("is neither superuser nor RLS-bypassing", async () => {
    const [role] = await shared.admin<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
      select rolsuper, rolbypassrls from pg_roles
      where rolname = ${new URL(shared.appUrl).username}`;
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
  });
});

describe("Claude usage routes on the core route", () => {
  test("a member never sees someone else's personal connection", async () => {
    const org = await organization();
    const personal = await personalConnection(org, "owner-personal");
    for (const method of ["GET", "POST"] as const) {
      const response = await workspaceRequest(
        org,
        org.memberSubjectId,
        memberPermissions,
        `/v1/workspaces/${org.workspaceId}/claude/accounts/${personal}/usage${method === "POST" ? "/refresh" : ""}`,
        method,
      );
      expect(response.status).toBe(404);
    }
    // Not on the organization path either, for the member or the administrator.
    expect(
      (
        await organizationRequest(
          org,
          org.ownerSubjectId,
          `/v1/organizations/${org.accountId}/claude/accounts/${personal}/usage`,
        )
      ).status,
    ).toBe(404);
    expect(usageCalls).toEqual([]);
  });

  test("a member reads a workspace connection but may not refresh it; an administrator refreshes it live", async () => {
    const org = await organization();
    const connection = await sharedConnection(org, "ws-pool", "workspace");
    const path = `/v1/workspaces/${org.workspaceId}/claude/accounts/${connection}/usage`;
    const read = await workspaceRequest(org, org.memberSubjectId, memberPermissions, path);
    expect(read.status).toBe(200);
    expect(read.headers.get("cache-control")).toBe("private, no-store");
    const stored = (await read.json()) as Record<string, unknown>;
    expect(stored.credentialVersion).toBe(await connectionVersion(connection));
    expect(stored.connected).toBe(true);

    const refused = await workspaceRequest(
      org,
      org.memberSubjectId,
      memberPermissions,
      `${path}/refresh`,
      "POST",
    );
    expect(refused.status).toBe(403);
    expect(usageCalls).toEqual([]);

    const refreshed = await workspaceRequest(
      org,
      org.ownerSubjectId,
      adminPermissions,
      `${path}/refresh`,
      "POST",
    );
    expect(refreshed.status).toBe(200);
    const body = (await refreshed.json()) as {
      refreshStatus: string;
      credentialVersion: number;
      windows: Array<{ id: string; usedPercent: number | null }>;
    };
    expect(body.refreshStatus).toBe("available");
    expect(body.credentialVersion).toBe(await connectionVersion(connection));
    expect(body.windows.find((window) => window.id === "five_hour")?.usedPercent).toBe(12);
    expect(usageCalls).toHaveLength(1);
    usageCalls.length = 0;
  });

  test("an organization-pool connection is read on the workspace path and refreshed only in organization settings", async () => {
    const org = await organization();
    const connection = await sharedConnection(org, "org-pool");
    const path = `/v1/workspaces/${org.workspaceId}/claude/accounts/${connection}/usage`;
    expect((await workspaceRequest(org, org.memberSubjectId, memberPermissions, path)).status).toBe(
      200,
    );
    // The legacy rule: an organization account is managed in organization settings.
    for (const [subjectId, permissions] of [
      [org.memberSubjectId, memberPermissions],
      [org.ownerSubjectId, adminPermissions],
    ] as const) {
      const refused = await workspaceRequest(
        org,
        subjectId,
        [...permissions],
        `${path}/refresh`,
        "POST",
      );
      expect(refused.status).toBe(409);
    }
    expect(usageCalls).toEqual([]);
  });

  test("the organization path: an administrator reads and gets the stored projection on refresh; a member is refused", async () => {
    const org = await organization();
    const connection = await sharedConnection(org, "org-admin");
    const path = `/v1/organizations/${org.accountId}/claude/accounts/${connection}/usage`;
    const read = await organizationRequest(org, org.ownerSubjectId, path);
    expect(read.status).toBe(200);
    expect(((await read.json()) as { credentialVersion: number }).credentialVersion).toBe(
      await connectionVersion(connection),
    );
    const refresh = await organizationRequest(org, org.ownerSubjectId, `${path}/refresh`, "POST");
    expect(refresh.status).toBe(200);
    // No workspace context for the credential seam: nothing is read live.
    expect(((await refresh.json()) as { refreshStatus: string }).refreshStatus).toBe("unavailable");
    expect(usageCalls).toEqual([]);

    for (const method of ["GET", "POST"] as const) {
      const refused = await organizationRequest(
        org,
        org.memberSubjectId,
        method === "POST" ? `${path}/refresh` : path,
        method,
      );
      expect(refused.status).toBe(403);
    }
  });
});

describe("the owner's personal connection on the core route", () => {
  const origin = "http://opengeni.test";
  /** The app with real browser sign-in (Better Auth on the test database). */
  function managedApp() {
    return createApp({
      settings: testSettings({
        databaseUrl: shared.adminUrl,
        productAccessMode: "managed",
        delegationSecret: DELEGATION_SECRET,
        environmentsEncryptionKey: key.toString("base64"),
        claudeSubscriptionEnabled: true,
        sandboxBackend: "none",
        betterAuthSecret: "claude-core-usage-routes-secret-32-bytes",
        publicBaseUrl: origin,
      }),
      db: client.db,
      bus: { publish: async () => undefined } as never,
      workflowClient: {
        wakeSessionWorkflow: async () => undefined,
        requestSessionWorkflowWakeDispatch: async () => undefined,
      } as never,
      claudeFetch: scriptedUsage,
    } as never);
  }

  /** A person signed up and signed in through the browser. */
  async function signedInPerson(api: ReturnType<typeof managedApp>) {
    const email = `claude-usage-${crypto.randomUUID()}@example.test`;
    const password = "password1234";
    await api.request("/v1/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Claude Owner", email, password }),
    });
    await shared.admin`update auth_users set email_verified = true where email = ${email}`;
    const signedIn = await api.request("/v1/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, rememberMe: true }),
    });
    const cookie = signedIn.headers
      .getSetCookie()
      .find((value) => value.includes("better-auth.session_token="))!
      .split(";", 1)[0]!;
    const [user] = await shared.admin<{ id: string }[]>`
      select id from auth_users where email = ${email}`;
    return { email, cookie, subjectId: `user:${user!.id}` };
  }

  /** A person signed in through the browser, owning a new organization. */
  async function signedInOwner(api: ReturnType<typeof managedApp>) {
    const { email, cookie, subjectId } = await signedInPerson(api);
    const created = await createManagedOrganization(client.db, {
      subjectId,
      subjectLabel: email,
      name: "Claude usage organization",
      operationId: crypto.randomUUID(),
    });
    // A shared workspace of the organization, created by its owner.
    const sharedWorkspace = await createOrganizationWorkspace(client.db, {
      organizationId: created.organization.id,
      actorSubjectId: subjectId,
      name: "Claude usage shared workspace",
      operationId: crypto.randomUUID(),
    });
    const access = (await (await api.request("/v1/access/me", { headers: { cookie } })).json()) as {
      accountGrants: Array<{ accountId: string }>;
      workspaceGrants: Array<{ workspaceId: string }>;
    };
    const accountId = access.accountGrants[0]!.accountId;
    const [membership] = await shared.admin<
      { id: string; personal_workspace_id: string | null }[]
    >`select id::text as id, personal_workspace_id::text as personal_workspace_id
      from organization_memberships
      where account_id = ${accountId}::uuid and subject_id = ${subjectId}`;
    expect(access.workspaceGrants.map((grant) => grant.workspaceId)).toContain(sharedWorkspace.id);
    await shared.admin`
      insert into subscription_provider_cutovers (account_id, provider, enabled)
      values (${accountId}::uuid, 'claude', true)
      on conflict (account_id, provider) do update set enabled = excluded.enabled`;
    const org: Org = {
      accountId,
      workspaceId: sharedWorkspace.id,
      personalWorkspaceId: membership!.personal_workspace_id!,
      ownerSubjectId: subjectId,
      ownerMembershipId: membership!.id,
      memberSubjectId: `user:claude-usage-member-${crypto.randomUUID()}`,
    };
    return { org, cookie };
  }

  test("the owner reads it and gets its stored projection on refresh only in their own Personal workspace", async () => {
    usageCalls.length = 0;
    const api = managedApp();
    const { org, cookie } = await signedInOwner(api);
    expect(org.personalWorkspaceId).toBeTruthy();
    const personal = await personalConnection(org, "owner-personal");
    const browser = {
      cookie,
      origin,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    };
    const usagePath = (workspaceId: string) =>
      `/v1/workspaces/${workspaceId}/claude/accounts/${personal}/usage`;

    // In a shared workspace it is not there, for its owner either.
    for (const method of ["GET", "POST"] as const) {
      const response = await api.request(
        `${usagePath(org.workspaceId)}${method === "POST" ? "/refresh" : ""}`,
        method === "POST" ? { method, headers: browser, body: "{}" } : { headers: browser },
      );
      expect(response.status).toBe(404);
    }
    const refusal = async (
      method: "GET" | "POST",
      headers: Record<string, string>,
    ): Promise<{ status: number; message: string | undefined }> => {
      const response = await api.request(
        `${usagePath(org.personalWorkspaceId)}${method === "POST" ? "/refresh" : ""}`,
        method === "POST" ? { method, headers, body: "{}" } : { headers },
      );
      const body = (await response.json()) as { error?: { message?: string } };
      return { status: response.status, message: body.error?.message };
    };
    // Another organization's signed-in owner cannot reach it.
    const stranger = await signedInOwner(api);
    // A signed-in member of the same organization cannot reach it either.
    const member = await signedInPerson(api);
    const invitation = await createOrganizationInvitation(client.db, {
      organizationId: org.accountId,
      actorSubjectId: org.ownerSubjectId,
      operationId: crypto.randomUUID(),
      targetSubjectId: member.subjectId,
      targetEmail: member.email,
      role: "member",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    await acceptOrganizationInvitation(client.db, {
      organizationId: org.accountId,
      actorSubjectId: member.subjectId,
      operationId: crypto.randomUUID(),
      invitationId: invitation.id,
      expectedRevision: invitation.revision,
    });
    // A plain signed bearer naming the owner is not a verified owning user.
    const ownerBearer = await signDelegatedAccessToken(DELEGATION_SECRET, {
      accountId: org.accountId,
      workspaceId: org.personalWorkspaceId,
      subjectId: org.ownerSubjectId,
      permissions: adminPermissions,
      principalKind: "human_session",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    for (const method of ["GET", "POST"] as const) {
      expect(await refusal(method, { ...browser, cookie: stranger.cookie })).toEqual({
        status: 403,
        message: "workspace access denied",
      });
      expect(await refusal(method, { ...browser, cookie: member.cookie })).toEqual({
        status: 403,
        message: "workspace access denied",
      });
      expect(
        await refusal(method, {
          authorization: `Bearer ${ownerBearer}`,
          "content-type": "application/json",
        }),
      ).toEqual({
        status: 403,
        message: "Private Claude accounts require a verified owning user",
      });
    }

    // The owner, in their own Personal workspace: GET projects the stored
    // connection (no 409 from the legacy ordinary-workspace rule).
    const read = await api.request(usagePath(org.personalWorkspaceId), { headers: browser });
    expect(read.status).toBe(200);
    expect(read.headers.get("cache-control")).toBe("private, no-store");
    const stored = (await read.json()) as { connected: boolean; credentialVersion: number };
    expect(stored.connected).toBe(true);
    expect(stored.credentialVersion).toBe(await connectionVersion(personal));
    // POST answers the stored projection as `unavailable` until the owner-only
    // live read lands (C2c); nothing is read live.
    const refreshed = await api.request(`${usagePath(org.personalWorkspaceId)}/refresh`, {
      method: "POST",
      headers: browser,
      body: "{}",
    });
    expect(refreshed.status).toBe(200);
    expect(refreshed.headers.get("cache-control")).toBe("private, no-store");
    const body = (await refreshed.json()) as {
      refreshStatus: string;
      refreshCheckedAt: string | null;
      credentialVersion: number;
    };
    expect(body.refreshStatus).toBe("unavailable");
    expect(body.refreshCheckedAt).toBeNull();
    expect(body.credentialVersion).toBe(await connectionVersion(personal));
    expect(usageCalls).toEqual([]);
  });
});
