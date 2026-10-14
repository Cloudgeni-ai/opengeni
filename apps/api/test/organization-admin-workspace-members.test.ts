import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  createDb,
  ensureManagedAccessForUserWithOrganizationMemberships,
  ensureWorkspaceByExternalIdentity,
  listSelfOrganizationMemberships,
  type DbClient,
} from "@opengeni/db";
import { synchronizeCanonicalHumanLoginBindings } from "@opengeni/db/canonical-human-identities";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { Hono } from "hono";
import { organizationApiKeyPermissions } from "../src/routes/api-keys";
import { registerWorkspaceRoutes } from "../src/routes/workspaces";

// The workspace Members surface (`/v1/workspaces/:id/members*`) admits an
// active organization owner or admin for any shared workspace in their
// organization, with or without their own workspace grant, exactly like the
// organization control plane. Ordinary members still need members:manage on
// their own grant; Personal workspaces, other organizations, and organization
// API keys are unchanged.

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
let app: Hono | null = null;
const sessions = new Map<string, { sessionId: string; email: string; name: string }>();
const createdUsers: string[] = [];
const createdAccounts: string[] = [];

type Human = { userId: string; subject: string; cookie: string };

async function signedInHuman(label: string): Promise<Human> {
  const userId = `${label}-${crypto.randomUUID()}`;
  const email = `${userId}@example.test`;
  createdUsers.push(userId);
  await shared!.admin`
    insert into auth_users (id, name, email, email_verified)
    values (${userId}, ${label}, ${email}, true)`;
  await shared!.admin`
    insert into auth_identities (id, user_id, provider_id, account_id)
    values (${crypto.randomUUID()}, ${userId}, 'credential', ${userId})`;
  const identity = await synchronizeCanonicalHumanLoginBindings(client!.db, userId);
  const sessionId = `session-${crypto.randomUUID()}`;
  await shared!.admin`
    insert into auth_sessions (
      id, user_id, token, expires_at, identity_id, identity_revision, auth_revision
    ) values (
      ${sessionId}, ${userId}, ${crypto.randomUUID()}, now() + interval '1 hour',
      ${identity.identityId}, ${identity.identityRevision}, ${identity.authRevision}
    )`;
  sessions.set(userId, { sessionId, email, name: label });
  return { userId, subject: `user:${userId}`, cookie: `session=${userId}` };
}

/** A human who owns a fresh organization (and its Personal workspace). */
async function organizationOwner(label: string) {
  const human = await signedInHuman(label);
  const session = sessions.get(human.userId)!;
  await ensureManagedAccessForUserWithOrganizationMemberships(client!.db, {
    userId: human.userId,
    email: session.email,
    name: label,
    emailVerified: true,
  });
  const [membership] = await listSelfOrganizationMemberships(client!.db, human.subject);
  createdAccounts.push(membership!.organizationId);
  return {
    ...human,
    organizationId: membership!.organizationId,
    membershipId: membership!.id,
    personalWorkspaceId: membership!.personalWorkspaceId!,
  };
}

/** A signed-in human joined to `organizationId` with an organization role. */
async function organizationMember(organizationId: string, role: "admin" | "member") {
  const human = await signedInHuman(role);
  const membershipId = crypto.randomUUID();
  const personalWorkspaceId = crypto.randomUUID();
  await shared!.admin`
    insert into workspaces (id, account_id, name)
    values (${personalWorkspaceId}, ${organizationId}, 'Personal')`;
  await shared!.admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${personalWorkspaceId}, ${organizationId})`;
  await shared!.admin`
    insert into organization_memberships (
      id, account_id, subject_id, role, status, personal_workspace_id
    ) values (
      ${membershipId}, ${organizationId}, ${human.subject}, ${role}, 'active',
      ${personalWorkspaceId}
    )`;
  return { ...human, membershipId, personalWorkspaceId };
}

async function tenantWorkspace(organizationId: string): Promise<string> {
  const { workspace } = await ensureWorkspaceByExternalIdentity(client!.db, {
    accountId: organizationId,
    externalSource: "tenant",
    externalId: `tenant-${crypto.randomUUID()}`,
    name: "Embedded tenant",
  });
  return workspace.id;
}

async function giveWorkspaceRow(
  organizationId: string,
  workspaceId: string,
  subject: string,
  permissions: string[],
) {
  await shared!.admin`
    insert into workspace_memberships (account_id, workspace_id, subject_id, role, permissions)
    values (${organizationId}, ${workspaceId}, ${subject}, 'member', ${shared!.admin.json(permissions)})`;
}

function request(
  cookieOrBearer: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const auth = cookieOrBearer.startsWith("Bearer ")
    ? { authorization: cookieOrBearer }
    : { cookie: cookieOrBearer };
  return Promise.resolve(
    app!.request(`http://x${path}`, {
      method,
      headers: { ...auth, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api-organization-admin-workspace-members");
  if (!shared) {
    if (requireRealDatabase) throw new Error("PostgreSQL is required");
    return;
  }
  client = createDb(shared.appUrl);
  app = new Hono();
  registerWorkspaceRoutes(app, {
    db: client.db,
    settings: testSettings({ productAccessMode: "managed" }),
    managedAuth: {
      api: {
        getSession: async (input: { headers: Headers }) => {
          const userId = /session=([^;]+)/.exec(input.headers.get("cookie") ?? "")?.[1];
          const session = userId ? sessions.get(userId) : undefined;
          return session
            ? {
                headers: new Headers(),
                response: {
                  session: { id: session.sessionId },
                  user: { id: userId, email: session.email, name: session.name },
                },
              }
            : { headers: new Headers(), response: null };
        },
      },
    } as never,
    schedulePromptPostCommit: () => undefined,
  } as ApiRouteDeps);
}, 180_000);

afterAll(async () => {
  if (shared) {
    for (const accountId of createdAccounts) {
      await shared.admin`delete from managed_accounts where id = ${accountId}`.catch(
        () => undefined,
      );
    }
    for (const userId of createdUsers) {
      await shared.admin`delete from auth_users where id = ${userId}`.catch(() => undefined);
    }
  }
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 60_000);

describe("workspace Members surface under organization authority", () => {
  test("an owner without a workspace grant lists, adds, changes, and removes members", async () => {
    if (!shared || !client || !app) return;
    const owner = await organizationOwner("Owner");
    const target = await organizationMember(owner.organizationId, "member");
    const tenant = await tenantWorkspace(owner.organizationId);
    const base = `/v1/workspaces/${tenant}`;

    const roster = await request(owner.cookie, "GET", `${base}/members`);
    expect(roster.status).toBe(200);

    const candidates = await request(owner.cookie, "GET", `${base}/member-candidates`);
    expect(candidates.status).toBe(200);
    const candidateBody = (await candidates.json()) as {
      members: Array<{ organizationMembershipId: string; subjectId: string }>;
    };
    expect(candidateBody.members.map((member) => member.subjectId)).toEqual(
      expect.arrayContaining([owner.subject, target.subject]),
    );

    const added = await request(owner.cookie, "POST", `${base}/members`, {
      organizationMembershipId: target.membershipId,
      role: "member",
      permissions: ["workspace:read", "sessions:read"],
    });
    expect(added.status).toBe(201);
    expect(await added.json()).toMatchObject({ subjectId: target.subject });

    const changed = await request(
      owner.cookie,
      "PATCH",
      `${base}/members/${encodeURIComponent(target.subject)}`,
      { role: "admin", permissions: ["workspace:admin"] },
    );
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({ permissions: ["workspace:admin"] });

    // This surface keeps its don't-orphan guards for everyone: the only
    // administering member can be neither removed nor demoted here.
    const lastAdmin = await request(
      owner.cookie,
      "DELETE",
      `${base}/members/${encodeURIComponent(target.subject)}`,
    );
    expect(lastAdmin.status).toBe(409);
    const demoted = await request(
      owner.cookie,
      "PATCH",
      `${base}/members/${encodeURIComponent(target.subject)}`,
      { role: "member", permissions: ["workspace:read"] },
    );
    expect(demoted.status).toBe(409);

    const second = await organizationMember(owner.organizationId, "member");
    expect(
      (
        await request(owner.cookie, "POST", `${base}/members`, {
          organizationMembershipId: second.membershipId,
          permissions: ["workspace:read"],
        })
      ).status,
    ).toBe(201);
    const removed = await request(
      owner.cookie,
      "DELETE",
      `${base}/members/${encodeURIComponent(second.subject)}`,
    );
    expect(removed.status).toBe(204);
    const remaining = await shared.admin<Array<{ subjectId: string }>>`
      select subject_id as "subjectId" from workspace_memberships where workspace_id = ${tenant}`;
    expect(remaining.map((row) => row.subjectId)).toEqual([target.subject]);
  }, 180_000);

  test("an organization admin with only a viewer grant manages members too", async () => {
    if (!shared || !client || !app) return;
    const owner = await organizationOwner("Owner");
    const admin = await organizationMember(owner.organizationId, "admin");
    const target = await organizationMember(owner.organizationId, "member");
    const tenant = await tenantWorkspace(owner.organizationId);
    await giveWorkspaceRow(owner.organizationId, tenant, admin.subject, ["workspace:read"]);

    const candidates = await request(
      admin.cookie,
      "GET",
      `/v1/workspaces/${tenant}/member-candidates`,
    );
    expect(candidates.status).toBe(200);
    const added = await request(admin.cookie, "POST", `/v1/workspaces/${tenant}/members`, {
      organizationMembershipId: target.membershipId,
      permissions: ["workspace:read"],
    });
    expect(added.status).toBe(201);
  }, 180_000);

  test("an ordinary member still needs members:manage on their own grant", async () => {
    if (!shared || !client || !app) return;
    const owner = await organizationOwner("Owner");
    const member = await organizationMember(owner.organizationId, "member");
    const target = await organizationMember(owner.organizationId, "member");
    const tenant = await tenantWorkspace(owner.organizationId);
    const base = `/v1/workspaces/${tenant}`;

    expect((await request(member.cookie, "GET", `${base}/member-candidates`)).status).toBe(403);
    await giveWorkspaceRow(owner.organizationId, tenant, member.subject, ["workspace:read"]);
    expect((await request(member.cookie, "GET", `${base}/member-candidates`)).status).toBe(403);
    expect(
      (
        await request(member.cookie, "POST", `${base}/members`, {
          organizationMembershipId: target.membershipId,
          permissions: ["workspace:read"],
        })
      ).status,
    ).toBe(403);
  }, 180_000);

  test("another organization's owner, Personal workspaces, and organization keys stay refused", async () => {
    if (!shared || !client || !app) return;
    const owner = await organizationOwner("Owner");
    const member = await organizationMember(owner.organizationId, "member");
    const foreign = await organizationOwner("Foreign owner");
    const tenant = await tenantWorkspace(owner.organizationId);

    expect(
      (await request(foreign.cookie, "GET", `/v1/workspaces/${tenant}/member-candidates`)).status,
    ).toBe(403);
    expect(
      (
        await request(foreign.cookie, "POST", `/v1/workspaces/${tenant}/members`, {
          organizationMembershipId: member.membershipId,
          permissions: ["workspace:read"],
        })
      ).status,
    ).toBe(403);

    for (const personal of [owner.personalWorkspaceId, member.personalWorkspaceId]) {
      expect(
        (await request(owner.cookie, "GET", `/v1/workspaces/${personal}/member-candidates`)).status,
      ).toBe(403);
      expect(
        (
          await request(owner.cookie, "POST", `/v1/workspaces/${personal}/members`, {
            organizationMembershipId: member.membershipId,
            permissions: ["workspace:read"],
          })
        ).status,
      ).toBe(403);
    }

    // An organization key keeps its existing answer: it cannot manage humans.
    const token = `ogk_${crypto.randomUUID().replaceAll("-", "")}`;
    await shared.admin`
      insert into api_keys (account_id, workspace_id, name, prefix, key_hash, permissions)
      values (
        ${owner.organizationId}, null, 'Organization key', ${token.slice(0, 14)},
        ${await sha256Hex(token)}, ${shared.admin.json(organizationApiKeyPermissions)}::jsonb
      )`;
    const keyCandidates = await request(
      `Bearer ${token}`,
      "GET",
      `/v1/workspaces/${tenant}/member-candidates`,
    );
    expect(keyCandidates.status).toBe(403);
    const keyAdd = await request(`Bearer ${token}`, "POST", `/v1/workspaces/${tenant}/members`, {
      organizationMembershipId: member.membershipId,
      permissions: ["workspace:read"],
    });
    expect(keyAdd.status).toBe(403);
    const [rows] = await shared.admin<Array<{ count: number }>>`
      select count(*)::int as count from workspace_memberships where workspace_id = ${tenant}`;
    expect(rows?.count).toBe(0);
  }, 180_000);
});
