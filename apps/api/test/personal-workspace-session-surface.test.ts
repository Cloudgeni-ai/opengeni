import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AccessContext } from "@opengeni/contracts";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import type { ApiRouteDeps, SessionWorkflowClient } from "@opengeni/core";
import {
  acceptOrganizationInvitation,
  createApiKey,
  createDb,
  createOrganizationInvitation,
  createSession,
  listSessionsForSubject,
  SessionListAccessError,
  subjectHasLiveWorkspaceAuthorityInScope,
  withWorkspaceSubjectRls,
  type DbClient,
} from "@opengeni/db";
import { synchronizeCanonicalHumanLoginBindings } from "@opengeni/db/canonical-human-identities";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { Hono } from "hono";
import { registerSessionRoutes } from "../src/routes/sessions";
import { registerWorkspaceRoutes } from "../src/routes/workspaces";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const delegationSecret = `personal-ws-session-surface-${crypto.randomUUID()}`;

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

type ManagedHuman = {
  userId: string;
  subjectId: string;
  accountId: string;
  cookie: string;
  legacyWorkspaceId: string;
  personalWorkspaceId: string;
  app: Hono;
};

const authSessionBySessionCookie = new Map<
  string,
  { authSessionId: string; userId: string; email: string }
>();

function buildApp(): Hono {
  if (!client) throw new Error("test database unavailable");
  const noop = async () => undefined;
  const hono = new Hono();
  const deps = {
    db: client.db,
    bus: new MemoryEventBus(),
    settings: testSettings({
      productAccessMode: "managed",
      delegationSecret,
      sandboxBackend: "none",
    }),
    workflowClient: {
      signalUserMessage: noop,
      wakeSessionWorkflow: noop,
      requestSessionWorkflowWakeDispatch: noop,
      signalApprovalDecision: noop,
      signalSessionControl: noop,
      syncScheduledTask: noop,
      deleteScheduledTaskSchedule: noop,
      triggerScheduledTask: noop,
    } as unknown as SessionWorkflowClient,
    githubStateSecret: "test",
    objectStorage: null,
    documentIndexer: { indexDocument: noop },
    getDocumentServices: () => ({}) as never,
    managedAuth: {
      api: {
        getSession: async ({ headers }: { headers: Headers }) => {
          const cookie = headers.get("cookie") ?? "";
          const record = authSessionBySessionCookie.get(cookie);
          // Better Auth always returns the envelope; only `response` is null
          // when no session was verified. Mirror that so the unauthenticated
          // path exercises the real branch instead of throwing.
          if (!record) return { headers: new Headers(), response: null };
          return {
            headers: new Headers(),
            response: {
              session: { id: record.authSessionId },
              user: { id: record.userId, email: record.email, name: "Managed human" },
            },
          };
        },
      },
    } as never,
  } as unknown as ApiRouteDeps;
  registerWorkspaceRoutes(hono, deps);
  registerSessionRoutes(hono, deps);
  return hono;
}

type AuthHuman = { userId: string; subjectId: string; email: string; cookie: string; app: Hono };

/**
 * Create one real Better Auth login — an `auth_users`/`auth_identities`/
 * `auth_sessions` triple plus the canonical human identity binding — WITHOUT
 * yet resolving an access context. Splitting this out lets an invited human be
 * placed into an existing organization by the real 0263 lifecycle before their
 * first request, so they end up as a genuine same-organization co-member rather
 * than the owner of a freshly bootstrapped account of their own.
 */
async function createAuthHuman(): Promise<AuthHuman> {
  if (!client || !shared) throw new Error("test database unavailable");
  const userId = `pw-session-${crypto.randomUUID()}`;
  const email = `${userId}@example.test`;
  const authSessionId = `session-${crypto.randomUUID()}`;
  const cookie = `session=${authSessionId}`;

  await shared.admin`
    insert into auth_users (id, name, email, email_verified)
    values (${userId}, 'Managed human', ${email}, true)`;
  await shared.admin`
    insert into auth_identities (id, user_id, provider_id, account_id)
    values (${crypto.randomUUID()}, ${userId}, 'credential', ${userId})`;
  const identity = await synchronizeCanonicalHumanLoginBindings(client.db, userId);
  await shared.admin`
    insert into auth_sessions (
      id, user_id, token, expires_at, identity_id, identity_revision, auth_revision
    ) values (
      ${authSessionId}, ${userId}, ${crypto.randomUUID()}, now() + interval '1 hour',
      ${identity.identityId}, ${identity.identityRevision}, ${identity.authRevision}
    )`;
  authSessionBySessionCookie.set(cookie, { authSessionId, userId, email });
  return { userId, subjectId: `user:${userId}`, email, cookie, app: buildApp() };
}

/**
 * Resolve the human's access context through the real managed provisioning
 * lifecycle. Their personal workspace deliberately has NO `workspace_memberships`
 * row (migration 0219 raises on one).
 */
async function resolveManagedHuman(
  auth: AuthHuman,
  expectedAccountId?: string,
): Promise<ManagedHuman> {
  if (!shared) throw new Error("test database unavailable");
  const { app, cookie, userId } = auth;
  const accessResponse = await app.request("http://x/v1/access/me", { headers: { cookie } });
  if (accessResponse.status !== 200) {
    throw new Error(`managed provisioning failed: ${accessResponse.status}`);
  }
  const access = (await accessResponse.json()) as AccessContext;
  const accountId = expectedAccountId ?? access.defaultAccountId!;
  // Read the pointer from the membership row itself rather than inferring it
  // from grant ordering: an invited co-member has no legacy Better Auth
  // workspace at all, so "the grant that is not the default" does not identify
  // it. The membership's own `personal_workspace_id` is the stated authority.
  const [membership] = await shared.admin<Array<{ personalWorkspaceId: string }>>`
    select personal_workspace_id as "personalWorkspaceId"
    from organization_memberships
    where account_id = ${accountId} and subject_id = ${auth.subjectId} and status = 'active'`;
  if (!membership) throw new Error("managed human has no active organization membership");

  return {
    userId,
    subjectId: access.subjectId!,
    accountId,
    cookie,
    legacyWorkspaceId: access.defaultWorkspaceId ?? "",
    personalWorkspaceId: membership.personalWorkspaceId,
    app,
  };
}

/** Provision a human who owns a freshly bootstrapped organization of their own. */
async function provisionManagedHuman(): Promise<ManagedHuman> {
  return await resolveManagedHuman(await createAuthHuman());
}

/**
 * Place a brand-new human inside an EXISTING organization through the real 0263
 * invitation lifecycle, so they are a genuine same-organization co-member with
 * their own personal workspace under the same account.
 */
async function inviteIntoOrganization(
  owner: ManagedHuman,
  role: "member" | "admin",
): Promise<ManagedHuman> {
  if (!client) throw new Error("test database unavailable");
  const auth = await createAuthHuman();
  const invitation = await createOrganizationInvitation(client.db, {
    organizationId: owner.accountId,
    actorSubjectId: owner.subjectId,
    operationId: crypto.randomUUID(),
    targetSubjectId: auth.subjectId,
    targetEmail: auth.email,
    role,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  await acceptOrganizationInvitation(client.db, {
    organizationId: owner.accountId,
    actorSubjectId: auth.subjectId,
    operationId: crypto.randomUUID(),
    invitationId: invitation.id,
    expectedRevision: invitation.revision,
  });
  return await resolveManagedHuman(auth, owner.accountId);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function seedSession(human: ManagedHuman, workspaceId: string): Promise<string> {
  if (!client) throw new Error("test database unavailable");
  const session = await createSession(client.db, {
    accountId: human.accountId,
    workspaceId,
    initialMessage: "personal workspace session",
    resources: [],
    metadata: {},
    createdBy: { kind: "subject", subjectId: human.subjectId },
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  return session.id;
}

const draftBody = {
  expectedRevision: 0,
  text: "draft in my own personal workspace",
  resources: [],
  tools: [],
  toolsProvided: true,
  model: "scripted-model",
  reasoningEffort: "medium",
  latencyMode: "standard",
  options: {},
};

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api-personal-workspace-session-surface");
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error(
        "[api-personal-workspace-session-surface] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
      );
    }
    return;
  }
  client = createDb(shared.appUrl, { max: 8 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

describe("managed-human session surface inside their own personal workspace", () => {
  test("the premise: the personal workspace has no workspace_memberships row", async () => {
    if (!shared || !client) return;
    const human = await provisionManagedHuman();
    const [count] = await shared.admin<Array<{ count: number }>>`
      select count(*)::int as count from workspace_memberships
      where workspace_id = ${human.personalWorkspaceId}`;
    expect(count).toEqual({ count: 0 });
    const [legacyCount] = await shared.admin<Array<{ count: number }>>`
      select count(*)::int as count from workspace_memberships
      where workspace_id = ${human.legacyWorkspaceId} and subject_id = ${human.subjectId}`;
    expect(legacyCount).toEqual({ count: 1 });
  }, 180_000);

  test("GET /v1/workspaces/:id/sessions works in the owner's own personal workspace", async () => {
    if (!shared || !client) return;
    const human = await provisionManagedHuman();
    const sessionId = await seedSession(human, human.personalWorkspaceId);

    const legacy = await human.app.request(
      `http://x/v1/workspaces/${human.legacyWorkspaceId}/sessions`,
      { headers: { cookie: human.cookie } },
    );
    expect(legacy.status).toBe(200);

    const response = await human.app.request(
      `http://x/v1/workspaces/${human.personalWorkspaceId}/sessions`,
      { headers: { cookie: human.cookie } },
    );
    expect(response.status).toBe(200);
    const sessions = (await response.json()) as Array<{ id: string }>;
    expect(sessions.map(({ id }) => id)).toContain(sessionId);
  }, 180_000);

  test("PUT /v1/workspaces/:id/sessions/:sessionId/pin works in the owner's own personal workspace", async () => {
    if (!shared || !client) return;
    const human = await provisionManagedHuman();
    const sessionId = await seedSession(human, human.personalWorkspaceId);

    const response = await human.app.request(
      `http://x/v1/workspaces/${human.personalWorkspaceId}/sessions/${sessionId}/pin`,
      {
        method: "PUT",
        headers: { cookie: human.cookie, "content-type": "application/json" },
        body: JSON.stringify({ pinned: true }),
      },
    );
    expect(response.status).toBe(200);
    expect((await response.json()) as { id: string; pinned: boolean }).toMatchObject({
      id: sessionId,
      pinned: true,
    });
  }, 180_000);

  test("PUT /v1/workspaces/:id/new-session-draft works in the owner's own personal workspace", async () => {
    if (!shared || !client) return;
    const human = await provisionManagedHuman();

    const response = await human.app.request(
      `http://x/v1/workspaces/${human.personalWorkspaceId}/new-session-draft`,
      {
        method: "PUT",
        headers: { cookie: human.cookie, "content-type": "application/json" },
        body: JSON.stringify(draftBody),
      },
    );
    expect(response.status).toBe(200);
    expect((await response.json()) as { revision: number }).toMatchObject({ revision: 1 });
  }, 180_000);
});

describe("the personal-workspace exception stays owner-only", () => {
  test("a human in a DIFFERENT organization never reaches someone else's personal workspace", async () => {
    if (!shared || !client) return;
    const owner = await provisionManagedHuman();
    const intruder = await provisionManagedHuman();
    await seedSession(owner, owner.personalWorkspaceId);

    const response = await intruder.app.request(
      `http://x/v1/workspaces/${owner.personalWorkspaceId}/sessions`,
      { headers: { cookie: intruder.cookie } },
    );
    expect(response.status).toBe(403);
  }, 180_000);

  test("a SAME-organization co-member never reaches another member's personal workspace", async () => {
    if (!shared || !client) return;
    const owner = await provisionManagedHuman();
    const coMember = await inviteIntoOrganization(owner, "member");
    expect(coMember.accountId).toBe(owner.accountId);
    expect(coMember.personalWorkspaceId).not.toBe(owner.personalWorkspaceId);
    const sessionId = await seedSession(owner, owner.personalWorkspaceId);

    const list = await coMember.app.request(
      `http://x/v1/workspaces/${owner.personalWorkspaceId}/sessions`,
      { headers: { cookie: coMember.cookie } },
    );
    expect(list.status).toBe(403);

    const pin = await coMember.app.request(
      `http://x/v1/workspaces/${owner.personalWorkspaceId}/sessions/${sessionId}/pin`,
      {
        method: "PUT",
        headers: { cookie: coMember.cookie, "content-type": "application/json" },
        body: JSON.stringify({ pinned: true }),
      },
    );
    expect(pin.status).toBe(403);

    const draft = await coMember.app.request(
      `http://x/v1/workspaces/${owner.personalWorkspaceId}/new-session-draft`,
      {
        method: "PUT",
        headers: { cookie: coMember.cookie, "content-type": "application/json" },
        body: JSON.stringify(draftBody),
      },
    );
    expect(draft.status).toBe(403);

    // ...while their OWN personal workspace still works, so this is the
    // exception being owner-scoped rather than the co-member being broken.
    const own = await coMember.app.request(
      `http://x/v1/workspaces/${coMember.personalWorkspaceId}/sessions`,
      { headers: { cookie: coMember.cookie } },
    );
    expect(own.status).toBe(200);
  }, 180_000);

  test("a SAME-organization ADMIN never reaches another member's personal workspace", async () => {
    if (!shared || !client) return;
    const owner = await provisionManagedHuman();
    const administrator = await inviteIntoOrganization(owner, "admin");
    expect(administrator.accountId).toBe(owner.accountId);
    const [role] = await shared.admin<Array<{ role: string }>>`
      select role from organization_memberships
      where account_id = ${owner.accountId} and subject_id = ${administrator.subjectId}`;
    expect(role).toEqual({ role: "admin" });
    const sessionId = await seedSession(owner, owner.personalWorkspaceId);

    const list = await administrator.app.request(
      `http://x/v1/workspaces/${owner.personalWorkspaceId}/sessions`,
      { headers: { cookie: administrator.cookie } },
    );
    expect(list.status).toBe(403);

    const pin = await administrator.app.request(
      `http://x/v1/workspaces/${owner.personalWorkspaceId}/sessions/${sessionId}/pin`,
      {
        method: "PUT",
        headers: { cookie: administrator.cookie, "content-type": "application/json" },
        body: JSON.stringify({ pinned: true }),
      },
    );
    expect(pin.status).toBe(403);

    const draft = await administrator.app.request(
      `http://x/v1/workspaces/${owner.personalWorkspaceId}/new-session-draft`,
      {
        method: "PUT",
        headers: { cookie: administrator.cookie, "content-type": "application/json" },
        body: JSON.stringify(draftBody),
      },
    );
    expect(draft.status).toBe(403);
  }, 180_000);

  test("a workspace-scoped API key never reaches a personal workspace's session surface", async () => {
    if (!shared || !client) return;
    const owner = await provisionManagedHuman();
    const token = `ogk_${crypto.randomUUID().replaceAll("-", "")}`;
    await createApiKey(client.db, {
      accountId: owner.accountId,
      workspaceId: owner.personalWorkspaceId,
      name: "personal workspace api key",
      prefix: token.slice(0, 14),
      keyHash: await sha256Hex(token),
      permissions: ["sessions:read", "sessions:control"],
    });
    const sessionId = await seedSession(owner, owner.personalWorkspaceId);

    const pin = await owner.app.request(
      `http://x/v1/workspaces/${owner.personalWorkspaceId}/sessions/${sessionId}/pin`,
      {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ pinned: true }),
      },
    );
    expect(pin.status).toBe(403);
  }, 180_000);

  test("an account-admin API key never reaches a personal workspace's session surface", async () => {
    if (!shared || !client) return;
    const owner = await provisionManagedHuman();
    const token = `ogk_${crypto.randomUUID().replaceAll("-", "")}`;
    await createApiKey(client.db, {
      accountId: owner.accountId,
      workspaceId: null,
      name: "account admin",
      prefix: token.slice(0, 14),
      keyHash: await sha256Hex(token),
      permissions: ["account:read", "account:admin"],
    });

    const list = await owner.app.request(
      `http://x/v1/workspaces/${owner.personalWorkspaceId}/sessions`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(list.status).toBe(403);
  }, 180_000);

  test("a delegated service initiator never reaches the personal workspace", async () => {
    if (!shared || !client) return;
    const owner = await provisionManagedHuman();
    await seedSession(owner, owner.personalWorkspaceId);
    const token = await signDelegatedAccessToken(delegationSecret, {
      accountId: owner.accountId,
      workspaceId: owner.personalWorkspaceId,
      subjectId: owner.subjectId,
      permissions: ["sessions:read", "sessions:control"],
      principalKind: "service",
      serviceInitiator: { kind: "service", subjectId: "service:embedding-host" },
      exp: Math.floor(Date.now() / 1_000) + 3_600,
    });

    const list = await owner.app.request(
      `http://x/v1/workspaces/${owner.personalWorkspaceId}/sessions`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(list.status).toBe(403);
  }, 180_000);

  test("a delegated bearer with a substituted user: subject never reaches the personal workspace", async () => {
    if (!shared || !client) return;
    const owner = await provisionManagedHuman();
    await seedSession(owner, owner.personalWorkspaceId);
    const token = await signDelegatedAccessToken(delegationSecret, {
      accountId: owner.accountId,
      workspaceId: owner.personalWorkspaceId,
      subjectId: owner.subjectId,
      subjectLabel: "substituted owner",
      permissions: ["sessions:read", "sessions:control"],
      principalKind: "human_session",
      exp: Math.floor(Date.now() / 1_000) + 3_600,
    });

    const list = await owner.app.request(
      `http://x/v1/workspaces/${owner.personalWorkspaceId}/sessions`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(list.status).toBe(403);
  }, 180_000);

  test("an unauthenticated request fails closed rather than defaulting to the exception", async () => {
    if (!shared || !client) return;
    const owner = await provisionManagedHuman();

    // No cookie, no bearer: `resolveAccessContext` returns null, so no context is
    // ever stamped and there is nothing for the exception to key off.
    const list = await owner.app.request(
      `http://x/v1/workspaces/${owner.personalWorkspaceId}/sessions`,
    );
    expect(list.status).toBe(401);
  }, 180_000);
});

/**
 * Defence in depth. In today's routes a same-organization co-member or admin is
 * denied by `accessGrantAuthorization` before the exception is ever consulted —
 * they hold no grant on another member's personal workspace. These tests call
 * the database seams DIRECTLY with `personalWorkspaceOwnerException: true`, the
 * strongest thing the API layer could ever assert, to prove the exception is
 * still owner-scoped if that outer layer is widened later.
 */
describe("the exception is owner-scoped at the database seam, not only at the route", () => {
  test("a same-organization ADMIN is denied even when the caller asserts the exception", async () => {
    if (!shared || !client) return;
    const owner = await provisionManagedHuman();
    const administrator = await inviteIntoOrganization(owner, "admin");
    await seedSession(owner, owner.personalWorkspaceId);

    await expect(
      listSessionsForSubject(client.db, owner.personalWorkspaceId, {
        subjectId: administrator.subjectId,
        personalWorkspaceOwnerException: true,
      }),
    ).rejects.toBeInstanceOf(SessionListAccessError);

    // The same assertion for the owner themselves resolves, so the denial is
    // about whose pointer names this workspace, not about the flag being inert.
    const ownerPage = await listSessionsForSubject(client.db, owner.personalWorkspaceId, {
      subjectId: owner.subjectId,
      personalWorkspaceOwnerException: true,
    });
    expect(ownerPage.sessions).toHaveLength(1);
  }, 180_000);

  test("a same-organization co-member is denied even when the caller asserts the exception", async () => {
    if (!shared || !client) return;
    const owner = await provisionManagedHuman();
    const coMember = await inviteIntoOrganization(owner, "member");
    await seedSession(owner, owner.personalWorkspaceId);

    await expect(
      listSessionsForSubject(client.db, owner.personalWorkspaceId, {
        subjectId: coMember.subjectId,
        personalWorkspaceOwnerException: true,
      }),
    ).rejects.toBeInstanceOf(SessionListAccessError);
  }, 180_000);
});

describe("the in-scope resolver refuses to be an arbitrary-subject oracle", () => {
  test("naming a subject other than the transaction's own scope throws", async () => {
    if (!shared || !client) return;
    const owner = await provisionManagedHuman();
    const intruder = await provisionManagedHuman();

    // The owner's own subject, under the owner's own scope, resolves true.
    expect(
      await withWorkspaceSubjectRls(
        client.db,
        owner.personalWorkspaceId,
        owner.subjectId,
        async (scoped) =>
          await subjectHasLiveWorkspaceAuthorityInScope(scoped, {
            accountId: owner.accountId,
            workspaceId: owner.personalWorkspaceId,
            subjectId: owner.subjectId,
          }),
      ),
    ).toBe(true);

    // Substituting the owner's subject while the transaction is scoped to the
    // intruder must not answer the question at all — not even `false`, because a
    // caller must never be able to ask about a subject it did not authenticate.
    await expect(
      withWorkspaceSubjectRls(
        client.db,
        owner.personalWorkspaceId,
        intruder.subjectId,
        async (scoped) =>
          await subjectHasLiveWorkspaceAuthorityInScope(scoped, {
            accountId: owner.accountId,
            workspaceId: owner.personalWorkspaceId,
            subjectId: owner.subjectId,
          }),
      ),
    ).rejects.toThrow(/does not match the applied RLS scope/);
  }, 180_000);
});
