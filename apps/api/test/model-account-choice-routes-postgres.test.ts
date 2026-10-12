import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import type { SessionAuthorizationOperation, SessionAuthorizationPort } from "@opengeni/contracts";
import type { ApiRouteDeps, SessionWorkflowClient } from "@opengeni/core";
import {
  acceptOrganizationInvitation,
  appendSessionEvents,
  createDb,
  createOrganizationInvitation,
  createSession,
  ensureManagedAccessForUserWithOrganizationMemberships,
  withSessionRlsActorContext,
  type DbClient,
} from "@opengeni/db";
import { synchronizeCanonicalHumanLoginBindings } from "@opengeni/db/canonical-human-identities";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import type { Hono } from "hono";
import { sql } from "drizzle-orm";
import { createApp } from "../src/app";

// Explicit model-account choice and personal preference routes over real
// PostgreSQL as the application role, through the full application (managed
// browser sign-in, workspace access, the session authorization middleware and
// the error envelope). Which account a session may use is enforced by the
// database and covered by the shared subscription-core conformance suites;
// these cases cover the HTTP translation, scoping and validation.

const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const ORIGIN = "http://opengeni.test";
const settings = testSettings({
  productAccessMode: "managed",
  publicBaseUrl: ORIGIN,
  sandboxBackend: "none",
  betterAuthSecret: "model-account-choice-route-secret-at-least-32-bytes",
});

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
let app: Hono | null = null;

/** Signed-in browser sessions by cookie, as Better Auth would verify them. */
const signedIn = new Map<string, { authSessionId: string; userId: string; email: string }>();

function fullApp(sessionAuthorization?: SessionAuthorizationPort): Hono {
  const noop = async () => undefined;
  return createApp({
    db: client!.db,
    bus: new MemoryEventBus(),
    settings,
    ...(sessionAuthorization ? { sessionAuthorization } : {}),
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
    githubStateSecret: "model-account-choice-state-secret",
    objectStorage: null,
    documentIndexer: { indexDocument: noop },
    getDocumentServices: () => ({}) as never,
    managedAuth: {
      api: {
        getSession: async ({ headers }: { headers: Headers }) => {
          const record = signedIn.get(headers.get("cookie") ?? "");
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
  } as unknown as ApiRouteDeps) as unknown as Hono;
}

type Human = {
  userId: string;
  subjectId: string;
  email: string;
  cookie: string;
  defaultWorkspaceId: string;
  accountId: string;
};

/**
 * One real Better Auth login. `bootstrap` gives the person an organization of
 * their own; without it they join an existing one through an invitation.
 */
async function signIn(
  label: string,
  bootstrap: boolean,
): Promise<Omit<Human, "defaultWorkspaceId"> & { workspaceId: string }> {
  const userId = `model-account-choice-${label}-${crypto.randomUUID()}`;
  const email = `${userId}@example.test`;
  const authSessionId = `session-${crypto.randomUUID()}`;
  await shared!.admin`insert into auth_users (id, name, email, email_verified)
    values (${userId}, ${label}, ${email}, true)`;
  await shared!.admin`insert into auth_identities (id, user_id, provider_id, account_id)
    values (${crypto.randomUUID()}, ${userId}, 'credential', ${userId})`;
  let workspaceId = "";
  let accountId = "";
  if (bootstrap) {
    const access = await ensureManagedAccessForUserWithOrganizationMemberships(client!.db, {
      userId,
      email,
      name: label,
      emailVerified: true,
    });
    const grant = access.accessContext.workspaceGrants[0]!;
    workspaceId = grant.workspaceId;
    accountId = grant.accountId;
  }
  const identity = await synchronizeCanonicalHumanLoginBindings(client!.db, userId);
  await shared!.admin`insert into auth_sessions (
      id, user_id, token, expires_at, identity_id, identity_revision, auth_revision
    ) values (
      ${authSessionId}, ${userId}, ${crypto.randomUUID()}, now() + interval '1 hour',
      ${identity.identityId}, ${identity.identityRevision}, ${identity.authRevision}
    )`;
  const cookie = `session=${authSessionId}`;
  signedIn.set(cookie, { authSessionId, userId, email });
  return { userId, subjectId: `user:${userId}`, email, cookie, workspaceId, accountId };
}

async function human(label: string): Promise<Human> {
  const signed = await signIn(label, true);
  return { ...signed, defaultWorkspaceId: signed.workspaceId };
}

/**
 * A colleague: a member of `owner`'s organization (through the real
 * invitation lifecycle) and of the owner's default workspace.
 */
async function colleagueOf(owner: Human): Promise<Human> {
  const signed = await signIn("colleague", false);
  const invitation = await createOrganizationInvitation(client!.db, {
    organizationId: owner.accountId,
    actorSubjectId: owner.subjectId,
    operationId: crypto.randomUUID(),
    targetSubjectId: signed.subjectId,
    targetEmail: signed.email,
    role: "member",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  await acceptOrganizationInvitation(client!.db, {
    organizationId: owner.accountId,
    actorSubjectId: signed.subjectId,
    operationId: crypto.randomUUID(),
    invitationId: invitation.id,
    expectedRevision: invitation.revision,
  });
  await shared!.admin`insert into workspace_memberships (
      account_id, workspace_id, subject_id, role, permissions
    ) values (
      ${owner.accountId}, ${owner.defaultWorkspaceId}, ${signed.subjectId}, 'member',
      '["workspace:read","sessions:read","sessions:create","sessions:control"]'::jsonb
    )`;
  return { ...signed, accountId: owner.accountId, defaultWorkspaceId: owner.defaultWorkspaceId };
}

async function call(
  who: Human | null,
  method: "GET" | "PUT" | "PATCH" | "POST",
  path: string,
  body?: unknown,
  origin: string = ORIGIN,
  requestApp: Hono = app!,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await requestApp.request(`${ORIGIN}${path}`, {
    method,
    headers: {
      ...(who ? { cookie: who.cookie } : {}),
      "content-type": "application/json",
      origin,
      "sec-fetch-site": origin === ORIGIN ? "same-origin" : "cross-site",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

let owner: Human;
let stranger: Human;
let colleague: Human;
let sessionId = "";
let sharedSessionId = "";
const network = spyOn(globalThis, "fetch").mockImplementation((async () => {
  throw new Error("Model-account reads must not poll upstream providers");
}) as unknown as typeof fetch);

async function ownerSession(visibility: "user_private" | "workspace_shared"): Promise<string> {
  const session = await withSessionRlsActorContext({ subjectId: owner.subjectId }, () =>
    createSession(client!.db, {
      accountId: owner.accountId,
      workspaceId: owner.defaultWorkspaceId,
      initialMessage: "model account choice routes",
      resources: [],
      metadata: {},
      model: "gpt-5.5",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      visibility,
      subjectId: owner.subjectId,
      createdBy: { kind: "subject" as const, subjectId: owner.subjectId },
      createdByContext: {},
    }),
  );
  return session.id;
}

beforeAll(async () => {
  if (!realDb) return;
  shared = await acquireSharedTestDatabase("api-model-account-choice");
  if (!shared) throw new Error("Real PostgreSQL is required");
  client = createDb(shared.appUrl, { max: 4 });
  app = fullApp();
  owner = await human("owner");
  stranger = await human("stranger");
  colleague = await colleagueOf(owner);
  sessionId = await ownerSession("user_private");
  sharedSessionId = await ownerSession("workspace_shared");
}, 180_000);

afterAll(async () => {
  const networkCalls = network.mock.calls.length;
  network.mockRestore();
  await client?.close().catch(() => undefined);
  await shared?.release();
  expect(networkCalls).toBe(0);
}, 60_000);

describe.skipIf(!realDb)("model-account choice routes", () => {
  for (const route of [
    { method: "PUT", suffix: "model-account", body: { connectionId: null } },
    { method: "POST", suffix: "codex-account", body: { target: "auto" } },
  ] as const) {
    for (const host of [
      { name: "legacy", capabilities: undefined, operation: "session.codex_account.write" },
      {
        name: "explicit legacy",
        capabilities: { modelAccountOperation: false },
        operation: "session.codex_account.write",
      },
      {
        name: "opted-in neutral",
        capabilities: { modelAccountOperation: true },
        operation: "session.model_account.write",
      },
    ] as const) {
      for (const allowed of [false, true]) {
        test(`${route.method} ${route.suffix}: ${host.name} host ${allowed ? "allow-only" : "deny with otherwise-allow"} receives exactly one decision`, async () => {
          const operations: SessionAuthorizationOperation[] = [];
          const port: SessionAuthorizationPort = {
            ...(host.capabilities ? { capabilities: host.capabilities } : {}),
            authorizeSession: async ({ operation }) => {
              operations.push(operation);
              // These exact-literal policies catch both silent widening of an
              // old denial and breakage of an old allowlist during a rollout.
              return (operation === host.operation) === allowed
                ? { allowed: true }
                : { allowed: false, reason: "forbidden" };
            },
            resolveListScope: async () => ({ kind: "all" }),
          };
          const result = await call(
            owner,
            route.method,
            `/v1/workspaces/${owner.defaultWorkspaceId}/sessions/${sessionId}/${route.suffix}`,
            route.body,
            ORIGIN,
            fullApp(port),
          );
          expect(result.status).toBe(allowed ? 200 : 404);
          expect(operations).toEqual([host.operation]);
        });
      }
    }

    test(`${route.method} ${route.suffix}: standalone authorization without a host is unchanged`, async () => {
      const result = await call(
        owner,
        route.method,
        `/v1/workspaces/${owner.defaultWorkspaceId}/sessions/${sessionId}/${route.suffix}`,
        route.body,
      );
      expect(result.status).toBe(200);
    });
  }

  test("SUB-SEL-02: the owner reads the picker for their session; others cannot", async () => {
    const path = `/v1/workspaces/${owner.defaultWorkspaceId}/sessions/${sessionId}/model-account`;
    const read = await call(owner, "GET", path);
    expect(read.status).toBe(200);
    expect(read.json.binding).toBeNull();
    expect(read.json.bindings).toEqual([]);
    expect(read.json.accounts).toEqual([]);
    expect(read.json.personal).toMatchObject({ fallbackOptIn: false });

    // A person outside the organization has no grant on the workspace.
    expect([403, 404]).toContain((await call(stranger, "GET", path)).status);
    // An unknown session or a malformed id is not found.
    expect(
      (
        await call(
          owner,
          "GET",
          `/v1/workspaces/${owner.defaultWorkspaceId}/sessions/${crypto.randomUUID()}/model-account`,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await call(
          owner,
          "GET",
          `/v1/workspaces/${owner.defaultWorkspaceId}/sessions/x/model-account`,
        )
      ).status,
    ).toBe(404);
  });

  test("SUB-SEL-04: choosing validates the body, refuses unknown accounts and returns to automatic idempotently", async () => {
    const path = `/v1/workspaces/${owner.defaultWorkspaceId}/sessions/${sessionId}/model-account`;
    expect((await call(owner, "PUT", path, { connectionId: "nope" })).status).toBe(422);
    expect((await call(owner, "PUT", path, { connectionId: null, extra: 1 })).status).toBe(422);
    expect(
      (await call(owner, "PUT", path, { connectionId: null, provider: "INVALID" })).status,
    ).toBe(422);
    expect((await call(owner, "PUT", path, {})).status).toBe(422);
    expect((await call(owner, "PUT", path, { connectionId: crypto.randomUUID() })).status).toBe(
      404,
    );
    const automatic = await call(owner, "PUT", path, { connectionId: null });
    expect(automatic.status).toBe(200);
    expect(automatic.json).toMatchObject({ changed: false, choice: "automatic" });
    const scoped = await call(owner, "PUT", path, { connectionId: null, provider: "codex" });
    expect(scoped.status).toBe(200);
    expect(scoped.json).toMatchObject({ changed: false, choice: "automatic" });
    expect([403, 404]).toContain(
      (await call(stranger, "PUT", path, { connectionId: null })).status,
    );
  });

  test("SUB-FAIL-06 legacy or malformed selection payloads cannot manufacture a serving snapshot", async () => {
    const path = `/v1/workspaces/${owner.defaultWorkspaceId}/sessions/${sessionId}/model-account`;
    for (const payload of [
      { provider: "codex", connectionId: crypto.randomUUID(), modelId: "codex/legacy" },
      {
        turnId: crypto.randomUUID(),
        provider: "codex",
        connectionId: crypto.randomUUID(),
        modelId: "codex/uncommitted",
        preferredModelId: "codex/preferred",
        reasoningEffort: "high",
        latencyMode: "standard",
      },
    ]) {
      await appendSessionEvents(client!.db, owner.defaultWorkspaceId, sessionId, [
        {
          type: "subscription.account.selected",
          payload,
        },
      ]);
      const result = await call(owner, "GET", path);
      expect(result.status).toBe(200);
      expect(result.json.serving).toBeNull();
      expect((await call(colleague, "GET", path)).status).toBe(404);
    }
  });

  test("SUB-SEL-02: a person reads and changes only their own personal-fallback opt-in", async () => {
    const path = `/v1/organizations/${owner.accountId}/me/model-account-preferences`;
    const initial = await call(owner, "GET", path);
    expect(initial.status).toBe(200);
    expect(initial.json).toMatchObject({ personalFallbackOptIn: false, version: 0 });

    const on = await call(owner, "PATCH", path, {
      personalFallbackOptIn: true,
      expectedVersion: 0,
    });
    expect(on.status).toBe(200);
    expect(on.json).toMatchObject({ personalFallbackOptIn: true, version: 1 });

    const stale = await call(owner, "PATCH", path, {
      personalFallbackOptIn: false,
      expectedVersion: 0,
    });
    expect(stale.status).toBe(409);
    // The application's public error envelope.
    expect(stale.json.error).toMatchObject({
      details: { reason: "version_conflict", currentVersion: 1 },
    });

    expect((await call(owner, "PATCH", path, { personalFallbackOptIn: "yes" })).status).toBe(422);
    // A cross-site browser write is refused before anything is read.
    expect(
      (await call(owner, "PATCH", path, { personalFallbackOptIn: false }, "http://evil.test"))
        .status,
    ).toBe(403);

    // Another organization's member neither reads nor writes this person's row.
    expect((await call(stranger, "GET", path)).status).toBe(404);
    expect((await call(stranger, "PATCH", path, { personalFallbackOptIn: true })).status).toBe(404);
    const after = await call(owner, "GET", path);
    expect(after.json).toMatchObject({ personalFallbackOptIn: true, version: 1 });
    // The stranger's own preferences in their own organization are independent.
    const theirs = await call(
      stranger,
      "GET",
      `/v1/organizations/${stranger.accountId}/me/model-account-preferences`,
    );
    expect(theirs.json).toMatchObject({ personalFallbackOptIn: false, version: 0 });
  });

  test("the full app requires a sign-in before any choice route is reached", async () => {
    const path = `/v1/workspaces/${owner.defaultWorkspaceId}/sessions/${sessionId}/model-account`;
    expect((await call(null, "GET", path)).status).toBe(401);
    expect((await call(null, "PUT", path, { connectionId: null })).status).toBe(401);
    expect(
      (await call(null, "GET", `/v1/organizations/${owner.accountId}/me/model-account-preferences`))
        .status,
    ).toBe(401);
  });

  test("SUB-SEL-02: a colleague in the same workspace cannot see or change another member's private session", async () => {
    const path = `/v1/workspaces/${owner.defaultWorkspaceId}/sessions/${sessionId}/model-account`;
    // The colleague reaches the workspace (a shared session of the owner is
    // readable) but the session authorization middleware hides the owner's
    // private session as not found, before the route reads anything.
    const sharedRead = await call(
      colleague,
      "GET",
      `/v1/workspaces/${owner.defaultWorkspaceId}/sessions/${sharedSessionId}/model-account`,
    );
    expect(sharedRead.status).toBe(200);
    expect(sharedRead.json.binding).toBeNull();
    expect((await call(colleague, "GET", path)).status).toBe(404);
    expect((await call(colleague, "PUT", path, { connectionId: null })).status).toBe(404);
    // The owner still reads and controls it.
    expect((await call(owner, "GET", path)).status).toBe(200);
    // The colleague's own preferences are theirs alone.
    const preferences = await call(
      colleague,
      "GET",
      `/v1/organizations/${owner.accountId}/me/model-account-preferences`,
    );
    expect(preferences.status).toBe(200);
    expect(preferences.json).toMatchObject({ personalFallbackOptIn: false, version: 0 });
  });

  test("cached usage follows the existing full-app account visibility boundary without refresh or writes", async () => {
    const posture = await client!.db.execute(sql`
      select current_user, rolsuper, rolbypassrls,
        (select pg_get_userbyid(relowner) <> current_user from pg_class
          where oid = 'subscription_connections'::regclass) as non_owner
      from pg_roles where rolname = current_user`);
    expect(posture[0]).toMatchObject({ rolsuper: false, rolbypassrls: false, non_owner: true });

    const admin = shared!.admin;
    const observedAt = "2020-01-01T00:00:00.000Z";
    const quota = {
      windows: [
        { id: "primary", usedPercent: 100, resetsAt: Date.parse(observedAt), status: "exhausted" },
        { id: "secondary", usedPercent: null, resetsAt: null, status: "unknown" },
      ],
      modelCooldowns: { "private-model-marker": 123 },
      exhaustedUntil: Date.parse(observedAt),
      exhaustedKind: "quota",
      source: "response_headers",
    };
    async function connection(
      who: Human,
      label: string,
      personal: boolean,
      withQuota = true,
      hiddenScope = false,
    ) {
      const id = crypto.randomUUID();
      const [membership] = await admin`select id from organization_memberships
        where account_id = ${who.accountId} and subject_id = ${who.subjectId} and status = 'active'`;
      const authorityId = personal ? crypto.randomUUID() : null;
      if (personal)
        await admin`insert into organization_user_resource_authorities
        (id, account_id, organization_membership_id, resource_kind, resource_id, generation, status)
        values (${authorityId}, ${who.accountId}, ${membership!.id}, 'subscription_connection', ${id}, 1, 'active')`;
      await admin`insert into subscription_connections
        (id, account_id, provider, kind, credential_encrypted, ownership, scope_kind,
         owner_organization_membership_id, owner_subject_id, authority_id, authority_resource_kind,
         authority_generation, provider_account_id, provider_subject_id, label, provider_state, refresh_generation)
        values (${id}, ${who.accountId}, 'codex', 'subscription', 'private-credential-marker',
          ${personal ? "personal" : "shared"}, ${personal ? "people" : hiddenScope ? "workspaces" : "organization"},
          ${personal ? membership!.id : null}, ${personal ? who.subjectId : null}, ${authorityId},
          ${personal ? "subscription_connection" : null}, ${personal ? 1 : null},
          ${id}, ${id}, ${label}, ${admin.json({ secret: "private-provider-marker" })}, 9)`;
      if (withQuota)
        await admin`insert into subscription_connection_quota
        (account_id, connection_id, quota, observed_refresh_generation, revision, updated_at)
        values (${who.accountId}, ${id}, ${admin.json(quota)}, 1, 4, ${observedAt})`;
      return id;
    }
    await admin`insert into subscription_provider_cutovers (account_id, provider, enabled)
      values (${owner.accountId}, 'codex', true) on conflict (account_id, provider) do update set enabled = true`;
    const poolId = await connection(owner, "Shared cached", false);
    const unknownId = await connection(owner, "Shared unknown", false, false);
    const mineId = await connection(owner, "Owner personal cached", true);
    const theirsId = await connection(colleague, "Colleague personal cached", true);
    const hiddenId = await connection(owner, "Outside workspace scope", false, true, true);
    const foreignId = await connection(stranger, "Another organization", false);
    const before =
      await admin`select * from subscription_connection_quota where connection_id = ${poolId}`;
    const path = `/v1/workspaces/${owner.defaultWorkspaceId}/sessions/${sharedSessionId}/model-account`;
    const response = await app!.request(`${ORIGIN}${path}`, { headers: { cookie: owner.cookie } });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const result = (await response.json()) as {
      accounts: Array<{ connectionId: string; usage: unknown }>;
    };
    expect(result.accounts.map((a) => a.connectionId).sort()).toEqual(
      [poolId, unknownId, mineId].sort(),
    );
    expect(result.accounts.find((a) => a.connectionId === poolId)?.usage).toEqual({
      observedAt,
      source: "response_headers",
      exhaustedUntil: observedAt,
      exhaustedKind: "quota",
      windows: [
        { id: "primary", usedPercent: 100, resetsAt: observedAt, status: "exhausted" },
        { id: "secondary", usedPercent: null, resetsAt: null, status: "unknown" },
      ],
    });
    expect(result.accounts.find((a) => a.connectionId === unknownId)?.usage).toBeNull();
    expect(result.accounts.find((a) => a.connectionId === mineId)?.usage).not.toBeNull();
    const other = await call(colleague, "GET", path);
    expect(other.status).toBe(200);
    expect(
      (other.json.accounts as Array<{ connectionId: string }>).map((a) => a.connectionId).sort(),
    ).toEqual([poolId, unknownId, theirsId].sort());
    for (const value of [
      mineId,
      hiddenId,
      foreignId,
      "private-credential-marker",
      "private-provider-marker",
      "private-model-marker",
    ])
      expect(JSON.stringify(other.json)).not.toContain(value);
    expect((await call(null, "GET", path)).status).toBe(401);
    expect([403, 404]).toContain((await call(stranger, "GET", path)).status);
    const privatePath = `/v1/workspaces/${owner.defaultWorkspaceId}/sessions/${sessionId}/model-account`;
    expect((await call(colleague, "GET", privatePath)).status).toBe(404);
    const operations: SessionAuthorizationOperation[] = [];
    const denied = await call(
      owner,
      "GET",
      path,
      undefined,
      ORIGIN,
      fullApp({
        authorizeSession: async ({ operation }) => {
          operations.push(operation);
          return { allowed: false, reason: "forbidden" };
        },
        resolveListScope: async () => ({ kind: "all" }),
      }),
    );
    expect(denied.status).toBe(404);
    expect(operations).toEqual(["session.read"]);
    expect(JSON.stringify(denied.json)).not.toContain(poolId);

    // A once-visible binding does not reveal an account or its quota after
    // the existing provider visibility gate removes it from this caller's list.
    expect((await call(owner, "PUT", privatePath, { connectionId: poolId })).status).toBe(200);
    await admin`update subscription_provider_cutovers set enabled = false
      where account_id = ${owner.accountId} and provider = 'codex'`;
    const hiddenBinding = await call(owner, "GET", privatePath);
    expect(hiddenBinding.status).toBe(200);
    expect(hiddenBinding.json.accounts).toEqual([]);
    expect(hiddenBinding.json.binding).toEqual({
      provider: "codex",
      connectionId: null,
      choice: "explicit",
    });
    expect(JSON.stringify(hiddenBinding.json)).not.toContain(poolId);
    const after =
      await admin`select * from subscription_connection_quota where connection_id = ${poolId}`;
    expect(after).toEqual(before);
  });
});
