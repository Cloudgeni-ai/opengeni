import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type {
  AccessContext,
  SessionAuthorizationOperation,
  SessionAuthorizationPort,
} from "@opengeni/contracts";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import type { ApiRouteDeps, SessionWorkflowClient } from "@opengeni/core";
import {
  acceptOrganizationInvitation,
  createApiKey,
  createDb,
  createOrganizationInvitation,
  createSession,
  listSessionsForSubject,
  managedPersonalWorkspacePermissions,
  namedSubjectHasLiveWorkspaceAuthority,
  rlsSubjectIdOrEmpty,
  NewSessionDraftAccessError,
  saveNewSessionDraftInTransaction,
  SessionListAccessError,
  SessionPinAccessError,
  setSessionPin,
  subjectHasLiveWorkspaceAuthorityInScope,
  transitionSessionVisibility,
  withRlsContext,
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
import { createApp } from "../src/app";
import { registerApiKeyRoutes } from "../src/routes/api-keys";
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

function buildApp(sessionAuthorization?: SessionAuthorizationPort, full = false): Hono {
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
    ...(sessionAuthorization ? { sessionAuthorization } : {}),
  } as unknown as ApiRouteDeps;
  if (full) return createApp(deps);
  registerWorkspaceRoutes(hono, deps);
  registerSessionRoutes(hono, deps);
  registerApiKeyRoutes(hono, deps);
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
 * Assert that a principal reaches NONE of the three seams inside `owner`'s
 * personal workspace. Applied to every non-owner principal so a widening at one
 * seam cannot hide behind another seam's denial.
 */
async function expectAllThreeSeamsDenied(
  owner: ManagedHuman,
  headers: Record<string, string>,
): Promise<void> {
  const sessionId = await seedSession(owner, owner.personalWorkspaceId);
  const json = { ...headers, "content-type": "application/json" };

  const list = await owner.app.request(
    `http://x/v1/workspaces/${owner.personalWorkspaceId}/sessions`,
    { headers },
  );
  expect(list.status).toBe(403);

  const pin = await owner.app.request(
    `http://x/v1/workspaces/${owner.personalWorkspaceId}/sessions/${sessionId}/pin`,
    { method: "PUT", headers: json, body: JSON.stringify({ pinned: true }) },
  );
  expect(pin.status).toBe(403);

  const draft = await owner.app.request(
    `http://x/v1/workspaces/${owner.personalWorkspaceId}/new-session-draft`,
    { method: "PUT", headers: json, body: JSON.stringify(draftBody) },
  );
  expect(draft.status).toBe(403);
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

/**
 * Drive the composer-draft seam directly, below the route, with the exception
 * asserted — the same shape `saveActorNewSessionDraft` uses.
 */
async function saveDraftDirectly(
  workspaceId: string,
  accountId: string,
  subjectId: string,
): Promise<{ revision: number }> {
  if (!client) throw new Error("test database unavailable");
  return await withWorkspaceSubjectRls(client.db, workspaceId, subjectId, async (scoped) =>
    scoped.transaction(async (tx) =>
      saveNewSessionDraftInTransaction(tx as unknown as typeof scoped, {
        accountId,
        workspaceId,
        subjectId,
        expectedRevision: 0,
        text: "direct seam draft",
        resources: [],
        tools: [],
        toolsProvided: true,
        model: "scripted-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        options: {},
        requireWorkspaceMembership: true,
        personalWorkspaceOwnerException: true,
      }),
    ),
  );
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

async function activateSessionTenancy(human: ManagedHuman): Promise<void> {
  if (!shared) throw new Error("test database unavailable");
  await shared.admin`
    insert into session_tenancy_activations (
      account_id, activation_version, inventory_digest, parity_digest, activated_by
    ) values (
      ${human.accountId}, 1, ${"3".repeat(64)}, ${"4".repeat(64)}, 'api-test'
    )`;
}

async function addOrdinaryWorkspaceMember(
  owner: ManagedHuman,
  member: ManagedHuman,
): Promise<void> {
  if (!shared) throw new Error("test database unavailable");
  await shared.admin`
    insert into workspace_memberships (
      account_id, workspace_id, subject_id, role, permissions
    ) values (
      ${owner.accountId}, ${owner.legacyWorkspaceId}, ${member.subjectId},
      'member',
      '["sessions:read","sessions:create","sessions:control"]'::jsonb
    )`;
}

async function tenancyErrorFact(response: Response): Promise<unknown> {
  const payload = (await response.json()) as {
    error: Record<string, unknown> & { requestId?: string };
  };
  const { requestId: _, ...error } = payload.error;
  return { status: response.status, error };
}

async function requestTenancyOperation(
  app: Hono,
  workspaceId: string,
  sessionId: string,
  headers: Record<string, string>,
  operation: "visibility" | "fork",
  suffix: string,
): Promise<Response> {
  return await app.request(
    `http://x/v1/workspaces/${workspaceId}/sessions/${sessionId}/${operation === "fork" ? "forks" : "visibility"}`,
    {
      method: operation === "fork" ? "POST" : "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(
        operation === "fork"
          ? { idempotencyKey: `matrix-fork-${suffix}` }
          : {
              visibility: "private",
              expectedAuthorityEpoch: 1,
              idempotencyKey: `matrix-visibility-${suffix}`,
            },
      ),
    },
  );
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
  test("PUT visibility and POST private fork activate only for the canonical owner cookie", async () => {
    if (!shared || !client) return;
    const human = await provisionManagedHuman();
    await activateSessionTenancy(human);
    const sessionId = await seedSession(human, human.personalWorkspaceId);
    const headers = { cookie: human.cookie, "content-type": "application/json" };
    const hostOperations: SessionAuthorizationOperation[] = [];
    const app = buildApp(
      {
        authorizeSession: async (input) => {
          hostOperations.push(input.operation);
          return { allowed: true, relatedSessionAccess: "root" };
        },
        resolveListScope: async () => ({ kind: "all" }),
      },
      true,
    );

    const visibility = await app.request(
      `http://x/v1/workspaces/${human.personalWorkspaceId}/sessions/${sessionId}/visibility`,
      {
        method: "PUT",
        headers,
        body: JSON.stringify({
          visibility: "private",
          expectedAuthorityEpoch: 1,
          idempotencyKey: "api-personal-visibility",
        }),
      },
    );
    expect(visibility.status).toBe(200);
    expect(await visibility.json()).toMatchObject({
      visibility: "private",
      authorityEpoch: 2,
      changed: true,
      replay: false,
    });

    const fork = await app.request(
      `http://x/v1/workspaces/${human.personalWorkspaceId}/sessions/${sessionId}/forks`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ idempotencyKey: "api-personal-fork" }),
      },
    );
    expect(fork.status).toBe(201);
    const created = (await fork.json()) as { sessionId: string; eventId: string };
    expect(created).toMatchObject({ visibility: "private", authorityEpoch: 1, replay: false });

    const replay = await app.request(
      `http://x/v1/workspaces/${human.personalWorkspaceId}/sessions/${sessionId}/forks`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ idempotencyKey: "api-personal-fork" }),
      },
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      replay: true,
      sessionId: created.sessionId,
      eventId: created.eventId,
    });
    expect(hostOperations).toEqual([
      "session.visibility.write",
      "session.fork.create",
      "session.fork.create",
    ]);
  }, 180_000);

  test("tenancy pre-gates are target-blind and each allowed request host-authorizes once", async () => {
    if (!shared || !client) return;
    const caller = await provisionManagedHuman();
    const sessionOwner = await inviteIntoOrganization(caller, "member");
    await addOrdinaryWorkspaceMember(caller, sessionOwner);
    await activateSessionTenancy(caller);

    const sharedSessionId = await seedSession(sessionOwner, caller.legacyWorkspaceId);
    const privateSessionId = await seedSession(sessionOwner, caller.legacyWorkspaceId);
    await transitionSessionVisibility(client.db, {
      workspaceId: caller.legacyWorkspaceId,
      sessionId: privateSessionId,
      actorSubjectId: sessionOwner.subjectId,
      targetVisibility: "user_private",
      expectedAuthorityEpoch: 1,
      operationKey: "matrix-private-owner-transition",
    });
    const targetIds = [crypto.randomUUID(), sharedSessionId, privateSessionId];
    const hostOperations: SessionAuthorizationOperation[] = [];
    const app = buildApp(
      {
        authorizeSession: async (input) => {
          hostOperations.push(input.operation);
          return { allowed: true, relatedSessionAccess: "root" };
        },
        resolveListScope: async () => ({ kind: "all" }),
      },
      true,
    );

    for (const operation of ["visibility", "fork"] as const) {
      const facts = [];
      for (const [index, targetId] of targetIds.entries()) {
        facts.push(
          await tenancyErrorFact(
            await requestTenancyOperation(
              app,
              caller.legacyWorkspaceId,
              targetId,
              { cookie: caller.cookie },
              operation,
              `canonical-${operation}-${index}`,
            ),
          ),
        );
      }
      expect(facts).toEqual([
        {
          status: 404,
          error: {
            status: 404,
            code: "not_found",
            message: "Session not found.",
            retryable: false,
          },
        },
        facts[0],
        facts[0],
      ]);
    }
    // Only each shared-session request reaches the host. The missing and
    // another-owner private targets are denied by durable target resolution.
    expect(hostOperations).toEqual(["session.visibility.write", "session.fork.create"]);

    const token = `ogk_${crypto.randomUUID().replaceAll("-", "")}`;
    await createApiKey(client.db, {
      accountId: caller.accountId,
      workspaceId: caller.legacyWorkspaceId,
      name: "session tenancy matrix key",
      prefix: token.slice(0, 14),
      keyHash: await sha256Hex(token),
      permissions: ["sessions:read", "sessions:create", "sessions:control"],
    });
    for (const operation of ["visibility", "fork"] as const) {
      const facts = [];
      for (const [index, targetId] of targetIds.entries()) {
        facts.push(
          await tenancyErrorFact(
            await requestTenancyOperation(
              app,
              caller.legacyWorkspaceId,
              targetId,
              { authorization: `Bearer ${token}` },
              operation,
              `noncanonical-${operation}-${index}`,
            ),
          ),
        );
      }
      expect(facts[1]).toEqual(facts[0]);
      expect(facts[2]).toEqual(facts[0]);
      expect(facts[0]).toMatchObject({
        status: 403,
        error: { status: 403, code: "forbidden", retryable: false },
      });
    }
    expect(hostOperations).toEqual(["session.visibility.write", "session.fork.create"]);

    await shared.admin`
      delete from session_tenancy_activations where account_id = ${caller.accountId}`;
    for (const operation of ["visibility", "fork"] as const) {
      const facts = [];
      for (const [index, targetId] of targetIds.entries()) {
        facts.push(
          await tenancyErrorFact(
            await requestTenancyOperation(
              app,
              caller.legacyWorkspaceId,
              targetId,
              { cookie: caller.cookie },
              operation,
              `unactivated-${operation}-${index}`,
            ),
          ),
        );
      }
      expect(facts[1]).toEqual(facts[0]);
      expect(facts[2]).toEqual(facts[0]);
      expect(facts[0]).toMatchObject({
        status: 409,
        error: {
          status: 409,
          code: "conflict",
          retryable: false,
          details: { reason: "not_activated" },
        },
      });
    }
    expect(hostOperations).toEqual(["session.visibility.write", "session.fork.create"]);
  }, 180_000);

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

    await expectAllThreeSeamsDenied(owner, { cookie: intruder.cookie });
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

  test("the organization OWNER never reaches a member's personal workspace", async () => {
    if (!shared || !client) return;
    // `owner` bootstraps the organization, so their membership role is `owner`.
    const organizationOwner = await provisionManagedHuman();
    const member = await inviteIntoOrganization(organizationOwner, "member");
    const [role] = await shared.admin<Array<{ role: string }>>`
      select role from organization_memberships
      where account_id = ${organizationOwner.accountId}
        and subject_id = ${organizationOwner.subjectId}`;
    expect(role).toEqual({ role: "owner" });

    // Denied at the route on all three seams ...
    await expectAllThreeSeamsDenied(member, { cookie: organizationOwner.cookie });

    // ... and still denied below the route with the exception forced on, so
    // owning the organization is not authority over a member's private
    // workspace at either layer.
    const sessionId = await seedSession(member, member.personalWorkspaceId);
    await expect(
      listSessionsForSubject(client.db, member.personalWorkspaceId, {
        subjectId: organizationOwner.subjectId,
        personalWorkspaceOwnerException: true,
      }),
    ).rejects.toBeInstanceOf(SessionListAccessError);
    await expect(
      setSessionPin(client.db, {
        workspaceId: member.personalWorkspaceId,
        subjectId: organizationOwner.subjectId,
        sessionId,
        pinned: true,
        personalWorkspaceOwnerException: true,
      }),
    ).rejects.toBeInstanceOf(SessionPinAccessError);
    await expect(
      saveDraftDirectly(member.personalWorkspaceId, member.accountId, organizationOwner.subjectId),
    ).rejects.toBeInstanceOf(NewSessionDraftAccessError);
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

  /**
   * A workspace-scoped API key minted ON the personal workspace returns
   * 200 / 403 / 200 on pristine `origin/main`, and this change does not alter
   * that. What makes it SAFE is not those statuses — it is that **the principal
   * cannot be constructed in production at all**.
   *
   * `POST /v1/workspaces/:id/api-keys` (the only production caller of
   * `createApiKey`) requires `api_keys:manage`, and
   * `managedPersonalWorkspacePermissions` does NOT include it. So the owner's own
   * cookie session cannot mint a key on their personal workspace. The test below
   * mints one BELOW the route, via `createApiKey` directly — something no
   * production path does.
   *
   * The unreachability is therefore the property worth pinning, and it is
   * asserted first. If the route ever grants `api_keys:manage` there, that
   * assertion fails and this comment becomes the explanation, instead of a green
   * 200 quietly becoming a real hole.
   */
  test("the route REFUSES to mint an API key on a personal workspace (the property that makes the next case safe)", async () => {
    if (!shared || !client) return;
    const owner = await provisionManagedHuman();

    const minted = await owner.app.request(
      `http://x/v1/workspaces/${owner.personalWorkspaceId}/api-keys`,
      {
        method: "PUT",
        headers: { cookie: owner.cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "k", permissions: ["sessions:read"] }),
      },
    );
    // PUT is not registered; the real verb is POST. Assert the real one.
    expect([404, 405]).toContain(minted.status);

    const posted = await owner.app.request(
      `http://x/v1/workspaces/${owner.personalWorkspaceId}/api-keys`,
      {
        method: "POST",
        headers: { cookie: owner.cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "k", permissions: ["sessions:read"] }),
      },
    );
    expect(posted.status).toBe(403);
    expect(await posted.text()).toContain("api_keys:manage");
    expect(managedPersonalWorkspacePermissions).not.toContain("api_keys:manage");
  }, 180_000);

  /**
   * Reachable only BELOW the route (see above). Pinned so any drift in the
   * seams' treatment of an `api_key:` subject is visible, NOT as an endorsement
   * of the 200s: those are safe only because the route denies minting.
   *
   * Recorded while pinning this: such a key also OUTLIVES the authority that
   * would have created it — suspending the organization membership takes the
   * owner's cookie to 403 while the key keeps working. One more reason the
   * unreachability above is the real guard.
   */
  test("a DB-layer-minted workspace API key behaves exactly as it did before the fix, and outlives the membership", async () => {
    if (!shared || !client) return;
    const owner = await provisionManagedHuman();
    const token = `ogk_${crypto.randomUUID().replaceAll("-", "")}`;
    await createApiKey(client.db, {
      accountId: owner.accountId,
      workspaceId: owner.personalWorkspaceId,
      name: "personal workspace api key",
      prefix: token.slice(0, 14),
      keyHash: await sha256Hex(token),
      permissions: ["sessions:read", "sessions:create", "sessions:control"],
    });
    const sessionId = await seedSession(owner, owner.personalWorkspaceId);
    const headers = { authorization: `Bearer ${token}` };
    const json = { ...headers, "content-type": "application/json" };
    const listUrl = `http://x/v1/workspaces/${owner.personalWorkspaceId}/sessions`;

    expect((await owner.app.request(listUrl, { headers })).status).toBe(200);
    expect(
      (
        await owner.app.request(
          `http://x/v1/workspaces/${owner.personalWorkspaceId}/sessions/${sessionId}/pin`,
          { method: "PUT", headers: json, body: JSON.stringify({ pinned: true }) },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await owner.app.request(
          `http://x/v1/workspaces/${owner.personalWorkspaceId}/new-session-draft`,
          { method: "PUT", headers: json, body: JSON.stringify(draftBody) },
        )
      ).status,
    ).toBe(200);

    // The key is an `api_key:` subject, so the exception's resolver can never
    // answer for it: it short-circuits to the plain membership answer, which is
    // false in a workspace that has no membership rows at all.
    expect(
      await withWorkspaceSubjectRls(
        client.db,
        owner.personalWorkspaceId,
        "api_key:probe",
        async (scoped) =>
          await subjectHasLiveWorkspaceAuthorityInScope(scoped, {
            accountId: owner.accountId,
            workspaceId: owner.personalWorkspaceId,
            subjectId: "api_key:probe",
          }),
      ),
    ).toBe(false);

    // Outlives the authority: the owner loses access, the key does not.
    //
    // The owner's cookie surfaces suspension as a 500, not a clean 403 — the
    // lifecycle seam raises `assert_active_managed_human_organization_membership`
    // and nothing converts it. Verified pre-existing on pristine `origin/main`
    // (6f61d6ee) with the same probe, so it is recorded here rather than fixed;
    // it fails closed either way. The point of this assertion is the contrast:
    // whatever the owner gets, the key still gets 200.
    await shared.admin`
      update organization_memberships set status = 'suspended'
      where account_id = ${owner.accountId} and subject_id = ${owner.subjectId}`;
    const ownerAfterSuspension = await owner.app.request(listUrl, {
      headers: { cookie: owner.cookie },
    });
    expect(ownerAfterSuspension.status).toBe(500);
    expect(ownerAfterSuspension.status).not.toBe(200);
    expect((await owner.app.request(listUrl, { headers })).status).toBe(200);
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

    await expectAllThreeSeamsDenied(owner, { authorization: `Bearer ${token}` });
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

    await expectAllThreeSeamsDenied(owner, { authorization: `Bearer ${token}` });
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

    await expectAllThreeSeamsDenied(owner, { authorization: `Bearer ${token}` });
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
  for (const role of ["admin", "member"] as const) {
    test(`a same-organization ${role.toUpperCase()} is denied at all three seams even when the caller asserts the exception`, async () => {
      if (!shared || !client) return;
      const owner = await provisionManagedHuman();
      const other = await inviteIntoOrganization(owner, role);
      const sessionId = await seedSession(owner, owner.personalWorkspaceId);

      await expect(
        listSessionsForSubject(client.db, owner.personalWorkspaceId, {
          subjectId: other.subjectId,
          personalWorkspaceOwnerException: true,
        }),
      ).rejects.toBeInstanceOf(SessionListAccessError);

      await expect(
        setSessionPin(client.db, {
          workspaceId: owner.personalWorkspaceId,
          subjectId: other.subjectId,
          sessionId,
          pinned: true,
          personalWorkspaceOwnerException: true,
        }),
      ).rejects.toBeInstanceOf(SessionPinAccessError);

      await expect(
        saveDraftDirectly(owner.personalWorkspaceId, owner.accountId, other.subjectId),
      ).rejects.toBeInstanceOf(NewSessionDraftAccessError);

      // The same assertions for the OWNER resolve, so each denial is about whose
      // pointer names this workspace, not about the flag being inert.
      const ownerPage = await listSessionsForSubject(client.db, owner.personalWorkspaceId, {
        subjectId: owner.subjectId,
        personalWorkspaceOwnerException: true,
      });
      expect(ownerPage.sessions).toHaveLength(1);
      expect(
        await setSessionPin(client.db, {
          workspaceId: owner.personalWorkspaceId,
          subjectId: owner.subjectId,
          sessionId,
          pinned: true,
          personalWorkspaceOwnerException: true,
        }),
      ).toMatchObject({ id: sessionId, pinned: true });
      expect(
        await saveDraftDirectly(owner.personalWorkspaceId, owner.accountId, owner.subjectId),
      ).toMatchObject({ revision: 1 });
    }, 180_000);
  }

  test("a SUSPENDED organization membership loses the exception at every seam", async () => {
    if (!shared || !client) return;
    const owner = await provisionManagedHuman();
    const suspended = await inviteIntoOrganization(owner, "member");
    const sessionId = await seedSession(suspended, suspended.personalWorkspaceId);

    // Their own personal workspace works while the membership is active ...
    expect(
      (
        await listSessionsForSubject(client.db, suspended.personalWorkspaceId, {
          subjectId: suspended.subjectId,
          personalWorkspaceOwnerException: true,
        })
      ).sessions,
    ).toHaveLength(1);

    await shared.admin`
      update organization_memberships set status = 'suspended'
      where account_id = ${owner.accountId} and subject_id = ${suspended.subjectId}`;

    // ... and stops the moment the membership is no longer active. The pointer
    // alone is not authority; the membership carrying it must be live.
    await expect(
      listSessionsForSubject(client.db, suspended.personalWorkspaceId, {
        subjectId: suspended.subjectId,
        personalWorkspaceOwnerException: true,
      }),
    ).rejects.toBeInstanceOf(SessionListAccessError);
    await expect(
      setSessionPin(client.db, {
        workspaceId: suspended.personalWorkspaceId,
        subjectId: suspended.subjectId,
        sessionId,
        pinned: true,
        personalWorkspaceOwnerException: true,
      }),
    ).rejects.toBeInstanceOf(SessionPinAccessError);
    await expect(
      saveDraftDirectly(suspended.personalWorkspaceId, suspended.accountId, suspended.subjectId),
    ).rejects.toBeInstanceOf(NewSessionDraftAccessError);
  }, 180_000);
});

describe("namedSubjectHasLiveWorkspaceAuthority does not leak its probed subject", () => {
  test("the caller's subject GUC survives the probe, and an unset one stays unset", async () => {
    if (!shared || !client) return;
    const caller = await provisionManagedHuman();
    const probed = await provisionManagedHuman();

    // `withRlsContext` restores account_id/workspace_id when unwinding a nested
    // scope but NOT subject_id, so without an explicit restore the probed
    // subject would leak out of the savepoint and silently re-scope every
    // remaining statement in the caller's transaction to whoever was probed.
    const observed = await withWorkspaceSubjectRls(
      client.db,
      caller.personalWorkspaceId,
      caller.subjectId,
      async (scoped) => {
        await namedSubjectHasLiveWorkspaceAuthority(scoped, {
          accountId: probed.accountId,
          workspaceId: probed.personalWorkspaceId,
          subjectId: probed.subjectId,
        });
        return await rlsSubjectIdOrEmpty(scoped);
      },
    );
    expect(observed).toBe(caller.subjectId);
    expect(observed).not.toBe(probed.subjectId);

    // A transaction that never had a subject must end with it still unset, not
    // pinned to the probed one. "" is the canonical unset for this GUC.
    const fromUnset = await withRlsContext(
      client.db,
      { accountId: caller.accountId, workspaceId: null },
      async (scoped) => {
        await namedSubjectHasLiveWorkspaceAuthority(scoped, {
          accountId: probed.accountId,
          workspaceId: probed.personalWorkspaceId,
          subjectId: probed.subjectId,
        });
        return await rlsSubjectIdOrEmpty(scoped);
      },
    );
    expect(fromUnset).toBe("");
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
