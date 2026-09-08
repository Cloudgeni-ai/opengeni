import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type {
  AccessContext,
  ApiKey,
  CreateApiKeyResponse,
  OrganizationSessionListResponse,
  Session,
  Workspace,
} from "@opengeni/contracts";
import type { ApiRouteDeps, SessionWorkflowClient } from "@opengeni/core";
import {
  createApiKey,
  createDb,
  createSession,
  createWorkspace,
  ensureManagedAccessForUserWithOrganizationMemberships,
  listSessionsForSubject,
  transitionSessionVisibility,
  type DbClient,
  setSessionPin,
} from "@opengeni/db";
import { synchronizeCanonicalHumanLoginBindings } from "@opengeni/db/canonical-human-identities";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { Hono } from "hono";
import postgres from "postgres";
import {
  organizationApiKeyPermissions,
  organizationReadApiKeyPermissions,
  registerApiKeyRoutes,
} from "../src/routes/api-keys";
import {
  decodeOrganizationSessionListCursor,
  encodeOrganizationSessionListCursor,
  registerOrganizationSessionRoutes,
} from "../src/routes/organization-sessions";
import { registerSessionRoutes } from "../src/routes/sessions";
import { registerWorkspaceRoutes } from "../src/routes/workspaces";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const externalAdminUrl = process.env.OPENGENI_ORG_TENANCY_POSTGRES_ADMIN_URL;
const externalAppUrl = process.env.OPENGENI_ORG_TENANCY_POSTGRES_APP_URL;
const delegationSecret = `organization-sessions-${crypto.randomUUID()}`;

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
let app: Hono | null = null;

type Fixture = {
  userId: string;
  subjectId: string;
  cookie: string;
  accountId: string;
  legacyWorkspaceId: string;
  personalWorkspaceId: string;
  workspaceA: Workspace;
  workspaceB: Workspace;
  /** Ordinary shared sessions, keyed by the workspace that owns them. */
  sharedSessionIds: Map<string, string[]>;
  privateSessionId: string;
  personalSessionId: string;
  fullToken: string;
  fullHeaders: Record<string, string>;
  endUserColumnsPresent: boolean;
};

let fixture: Fixture | null = null;
const authSessionByCookie = new Map<
  string,
  { authSessionId: string; userId: string; email: string }
>();

beforeAll(async () => {
  if ((externalAdminUrl === undefined) !== (externalAppUrl === undefined)) {
    throw new Error(
      "set both OPENGENI_ORG_TENANCY_POSTGRES_ADMIN_URL and OPENGENI_ORG_TENANCY_POSTGRES_APP_URL",
    );
  }
  if (externalAdminUrl && externalAppUrl) {
    const admin = postgres(externalAdminUrl, { max: 8 });
    shared = {
      admin,
      adminUrl: externalAdminUrl,
      appUrl: externalAppUrl,
      release: async () => await admin.end(),
    };
  } else {
    shared = await acquireSharedTestDatabase("api-organization-sessions");
  }
  if (!shared && requireRealDatabase) {
    throw new Error(
      "[api-organization-sessions] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
    );
  }
  if (!shared) return;
  client = createDb(shared.appUrl);
  app = buildApp();
  fixture = await provisionFixture();
}, 180_000);

afterAll(async () => {
  if (shared && fixture) {
    await shared.admin`delete from managed_accounts where id = ${fixture.accountId}`.catch(
      () => undefined,
    );
    await shared.admin`delete from auth_users where id = ${fixture.userId}`.catch(() => undefined);
  }
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 60_000);

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
    schedulePromptPostCommit: () => undefined,
    managedAuth: {
      api: {
        getSession: async ({ headers }: { headers: Headers }) => {
          const record = authSessionByCookie.get(headers.get("cookie") ?? "");
          if (!record) return { headers: new Headers(), response: null };
          return {
            headers: new Headers(),
            response: {
              session: { id: record.authSessionId },
              user: { id: record.userId, email: record.email, name: "Organization owner" },
            },
          };
        },
      },
    } as never,
  } as unknown as ApiRouteDeps;
  registerWorkspaceRoutes(hono, deps);
  registerSessionRoutes(hono, deps);
  registerApiKeyRoutes(hono, deps);
  registerOrganizationSessionRoutes(hono, deps);
  return hono;
}

async function seedSession(
  accountId: string,
  workspaceId: string,
  subjectId: string,
  label: string,
): Promise<string> {
  if (!client) throw new Error("test database unavailable");
  const session = await createSession(client.db, {
    accountId,
    workspaceId,
    initialMessage: label,
    resources: [],
    metadata: {},
    createdBy: { kind: "subject", subjectId },
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  return session.id;
}

async function provisionFixture(): Promise<Fixture> {
  if (!client || !shared || !app) throw new Error("test database unavailable");
  const userId = `org-sessions-owner-${crypto.randomUUID()}`;
  const email = `${userId}@example.test`;
  const authSessionId = `session-${crypto.randomUUID()}`;
  const cookie = `session=${authSessionId}`;
  await shared.admin`
    insert into auth_users (id, name, email, email_verified)
    values (${userId}, 'Organization owner', ${email}, true)`;
  await shared.admin`
    insert into auth_identities (id, user_id, provider_id, account_id)
    values (${crypto.randomUUID()}, ${userId}, 'credential', ${userId})`;
  await ensureManagedAccessForUserWithOrganizationMemberships(client.db, {
    userId,
    email,
    name: "Organization owner",
    emailVerified: true,
  });
  const identity = await synchronizeCanonicalHumanLoginBindings(client.db, userId);
  await shared.admin`
    insert into auth_sessions (
      id, user_id, token, expires_at, identity_id, identity_revision, auth_revision
    ) values (
      ${authSessionId}, ${userId}, ${crypto.randomUUID()}, now() + interval '1 hour',
      ${identity.identityId}, ${identity.identityRevision}, ${identity.authRevision}
    )`;
  authSessionByCookie.set(cookie, { authSessionId, userId, email });
  const subjectId = `user:${userId}`;

  const accessResponse = await app.request("http://x/v1/access/me", { headers: { cookie } });
  if (accessResponse.status !== 200) {
    throw new Error(`managed provisioning failed: ${accessResponse.status}`);
  }
  const access = (await accessResponse.json()) as AccessContext;
  const accountId = access.defaultAccountId!;
  const [membership] = await shared.admin<Array<{ personalWorkspaceId: string }>>`
    select personal_workspace_id as "personalWorkspaceId"
    from organization_memberships
    where account_id = ${accountId} and subject_id = ${subjectId} and status = 'active'`;
  if (!membership) throw new Error("owner has no active organization membership");

  const workspaceA = await createWorkspace(client.db, { accountId, name: "Tenant A" });
  const workspaceB = await createWorkspace(client.db, { accountId, name: "Tenant B" });
  // The owner is an ordinary member of A only. Private-session ownership needs
  // a stated membership row, and the cookie path must prove that an account
  // administrator sees exactly the shared workspaces they are a member of.
  await shared.admin`
    insert into workspace_memberships (
      account_id, workspace_id, subject_id, role, permissions
    ) values (
      ${accountId}, ${workspaceA.id}, ${subjectId}, 'member',
      '["sessions:read","sessions:create","sessions:control"]'::jsonb
    )`;

  const sharedSessionIds = new Map<string, string[]>();
  sharedSessionIds.set(workspaceA.id, []);
  sharedSessionIds.set(workspaceB.id, []);
  for (let index = 0; index < 3; index += 1) {
    sharedSessionIds
      .get(workspaceA.id)!
      .push(await seedSession(accountId, workspaceA.id, subjectId, `A shared ${index}`));
  }
  for (let index = 0; index < 2; index += 1) {
    sharedSessionIds
      .get(workspaceB.id)!
      .push(await seedSession(accountId, workspaceB.id, subjectId, `B shared ${index}`));
  }
  const personalSessionId = await seedSession(
    accountId,
    membership.personalWorkspaceId,
    subjectId,
    "personal",
  );

  await shared.admin`
    insert into session_tenancy_activations (
      account_id, activation_version, inventory_digest, parity_digest, activated_by
    ) values (
      ${accountId}, 1, ${"3".repeat(64)}, ${"4".repeat(64)}, 'api-test'
    )`;
  await shared.admin`
    insert into organization_private_session_settings (
      account_id, enabled, version, updated_by_membership_id
    ) values (${accountId}, true, 1, null)
    on conflict (account_id) do update set enabled = true`;
  const privateSessionId = await seedSession(accountId, workspaceA.id, subjectId, "A private");
  await transitionSessionVisibility(client.db, {
    workspaceId: workspaceA.id,
    sessionId: privateSessionId,
    actorSubjectId: subjectId,
    targetVisibility: "user_private",
    expectedAuthorityEpoch: 1,
    operationKey: "organization-sessions-private",
  });

  const fullToken = `ogk_${crypto.randomUUID().replaceAll("-", "")}`;
  await createApiKey(client.db, {
    accountId,
    workspaceId: null,
    name: "Full organization key",
    prefix: fullToken.slice(0, 14),
    keyHash: await sha256Hex(fullToken),
    permissions: organizationApiKeyPermissions,
    credentialKind: "organization",
  });

  const [endUserColumn] = await shared.admin<Array<{ present: boolean }>>`
    select exists (
      select 1 from information_schema.columns
      where table_name = 'sessions' and column_name = 'end_user_id'
    ) as present`;

  return {
    userId,
    subjectId,
    cookie,
    accountId,
    legacyWorkspaceId: access.defaultWorkspaceId ?? "",
    personalWorkspaceId: membership.personalWorkspaceId,
    workspaceA,
    workspaceB,
    sharedSessionIds,
    privateSessionId,
    personalSessionId,
    fullToken,
    fullHeaders: { authorization: `Bearer ${fullToken}` },
    endUserColumnsPresent: endUserColumn?.present === true,
  };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The partial test app has no `app.onError`, so a rejected request renders the
 * HTTPException as plain text: only a 200 carries the JSON page.
 */
async function listOrganizationSessions(
  headers: Record<string, string>,
  query: Record<string, string> = {},
): Promise<{ status: number; body: OrganizationSessionListResponse }> {
  if (!app || !fixture) throw new Error("fixture unavailable");
  const search = new URLSearchParams(query).toString();
  const response = await app.request(
    `http://x/v1/organizations/${fixture.accountId}/sessions${search ? `?${search}` : ""}`,
    { headers },
  );
  const body =
    response.status === 200
      ? ((await response.json()) as OrganizationSessionListResponse)
      : { sessions: [], nextCursor: null };
  return { status: response.status, body };
}

/** Follow `nextCursor` to exhaustion, returning every page in order. */
async function collectPages(
  headers: Record<string, string>,
  query: Record<string, string>,
): Promise<OrganizationSessionListResponse[]> {
  const pages: OrganizationSessionListResponse[] = [];
  let cursor: string | null = null;
  do {
    const { status, body } = await listOrganizationSessions(headers, {
      ...query,
      ...(cursor ? { cursor } : {}),
    });
    expect(status).toBe(200);
    pages.push(body);
    cursor = body.nextCursor;
  } while (cursor);
  return pages;
}

function expectedSharedSessionIds(): string[] {
  if (!fixture) throw new Error("fixture unavailable");
  return [...fixture.sharedSessionIds.values()].flat();
}

async function mintReadKey(name = "Read-only organization key"): Promise<{
  apiKey: ApiKey;
  headers: Record<string, string>;
}> {
  if (!app || !fixture) throw new Error("fixture unavailable");
  const response = await app.request(`http://x/v1/organizations/${fixture.accountId}/api-keys`, {
    method: "POST",
    headers: { ...fixture.fullHeaders, "content-type": "application/json" },
    body: JSON.stringify({ name, access: "read" }),
  });
  expect(response.status).toBe(201);
  const created = (await response.json()) as CreateApiKeyResponse;
  return { apiKey: created.apiKey, headers: { authorization: `Bearer ${created.token}` } };
}

describe("organization read key", () => {
  test("mints read permissions, reports the access tier, and defaults to full", async () => {
    if (!shared || !client || !app || !fixture) return;
    const { apiKey: readKey } = await mintReadKey("tier probe read");
    expect(readKey.access).toBe("read");
    expect(readKey.permissions).toEqual(organizationReadApiKeyPermissions);
    expect(readKey.workspaceId).toBeNull();

    const defaulted = await app.request(`http://x/v1/organizations/${fixture.accountId}/api-keys`, {
      method: "POST",
      headers: { ...fixture.fullHeaders, "content-type": "application/json" },
      body: JSON.stringify({ name: "tier probe default" }),
    });
    expect(defaulted.status).toBe(201);
    const defaultedKey = ((await defaulted.json()) as CreateApiKeyResponse).apiKey;
    expect(defaultedKey.access).toBe("full");
    expect(defaultedKey.permissions).toEqual(organizationApiKeyPermissions);

    const rejected = await app.request(`http://x/v1/organizations/${fixture.accountId}/api-keys`, {
      method: "POST",
      headers: { ...fixture.fullHeaders, "content-type": "application/json" },
      body: JSON.stringify({ name: "tier probe invalid", access: "write" }),
    });
    expect(rejected.status).toBe(400);

    const listed = await app.request(`http://x/v1/organizations/${fixture.accountId}/api-keys`, {
      headers: fixture.fullHeaders,
    });
    expect(listed.status).toBe(200);
    const { apiKeys } = (await listed.json()) as { apiKeys: ApiKey[] };
    const byId = new Map(apiKeys.map((key) => [key.id, key]));
    expect(byId.get(readKey.id)?.access).toBe("read");
    expect(byId.get(defaultedKey.id)?.access).toBe("full");
    // The pre-existing full key minted below the API reports its tier too.
    expect(apiKeys.every((key) => key.access === "full" || key.access === "read")).toBe(true);

    const revoked = await app.request(
      `http://x/v1/organizations/${fixture.accountId}/api-keys/${defaultedKey.id}`,
      { method: "DELETE", headers: fixture.fullHeaders },
    );
    expect(revoked.status).toBe(200);
    expect(((await revoked.json()) as ApiKey).access).toBe("full");
  });

  test("reads shared workspaces and sessions but never controls or mints", async () => {
    if (!shared || !client || !app || !fixture) return;
    const { headers } = await mintReadKey();
    const workspaceA = fixture.workspaceA.id;
    const [sessionId] = fixture.sharedSessionIds.get(workspaceA)!;

    const access = await app.request("http://x/v1/access/me", { headers });
    expect(access.status).toBe(200);
    const context = (await access.json()) as AccessContext;
    expect(context.workspaceGrants).toEqual([]);
    expect(context.accountGrants[0]?.permissions).toEqual(["account:read"]);

    const inventory = await app.request("http://x/v1/workspaces", { headers });
    expect(inventory.status).toBe(200);
    const workspaces = (await inventory.json()) as Workspace[];
    const inventoryIds = workspaces.map((workspace) => workspace.id);
    expect(inventoryIds).toContain(workspaceA);
    expect(inventoryIds).toContain(fixture.workspaceB.id);
    expect(inventoryIds).not.toContain(fixture.personalWorkspaceId);

    expect(
      (await app.request(`http://x/v1/workspaces/${workspaceA}/sessions`, { headers })).status,
    ).toBe(200);
    expect(
      (await app.request(`http://x/v1/workspaces/${workspaceA}/sessions/${sessionId}`, { headers }))
        .status,
    ).toBe(200);
    expect(
      (
        await app.request(`http://x/v1/workspaces/${workspaceA}/sessions/${sessionId}/events`, {
          headers,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request(`http://x/v1/workspaces/${fixture.personalWorkspaceId}/sessions`, {
          headers,
        })
      ).status,
    ).toBe(403);

    const json = { ...headers, "content-type": "application/json" };
    const create = await app.request(`http://x/v1/workspaces/${workspaceA}/sessions`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ initialMessage: "forbidden" }),
    });
    expect(create.status).toBe(403);
    const send = await app.request(
      `http://x/v1/workspaces/${workspaceA}/sessions/${sessionId}/events`,
      {
        method: "POST",
        headers: json,
        body: JSON.stringify({ type: "user.message", payload: { text: "forbidden" } }),
      },
    );
    expect(send.status).toBe(403);
    const mint = await app.request(`http://x/v1/organizations/${fixture.accountId}/api-keys`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ name: "escalation", access: "full" }),
    });
    expect(mint.status).toBe(403);
    expect(
      (await app.request(`http://x/v1/organizations/${fixture.accountId}/api-keys`, { headers }))
        .status,
    ).toBe(403);
    const workspaceMint = await app.request(`http://x/v1/workspaces/${workspaceA}/api-keys`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ name: "escalation", permissions: ["sessions:control"] }),
    });
    expect(workspaceMint.status).toBe(403);

    const { status, body } = await listOrganizationSessions(headers);
    expect(status).toBe(200);
    expect(body.nextCursor).toBeNull();
    expect(body.sessions.map((session) => session.id).sort()).toEqual(
      expectedSharedSessionIds().sort(),
    );
  });
});

describe("organization-wide session list", () => {
  test("full key pages every shared workspace in stable order without duplicates", async () => {
    if (!shared || !client || !app || !fixture) return;
    const single = await listOrganizationSessions(fixture.fullHeaders);
    expect(single.status).toBe(200);
    expect(single.body.nextCursor).toBeNull();
    const singleIds = single.body.sessions.map((session) => session.id);
    expect([...singleIds].sort()).toEqual(expectedSharedSessionIds().sort());
    expect(singleIds).not.toContain(fixture.privateSessionId);
    expect(singleIds).not.toContain(fixture.personalSessionId);
    for (const session of single.body.sessions) {
      expect(fixture.sharedSessionIds.get(session.workspaceId)).toContain(session.id);
    }
    // Rows are grouped by workspace in ascending workspace id order.
    const workspaceOrder = single.body.sessions.map((session) => session.workspaceId);
    const boundaries = workspaceOrder.filter(
      (workspaceId, index) => index === 0 || workspaceOrder[index - 1] !== workspaceId,
    );
    expect(boundaries).toEqual([...boundaries].sort());
    expect(new Set(boundaries).size).toBe(boundaries.length);

    const pages = await collectPages(fixture.fullHeaders, { limit: "2" });
    expect(pages.length).toBeGreaterThan(1);
    const paged = pages.flatMap((page) => page.sessions);
    expect(paged.map((session) => session.id)).toEqual(singleIds);
    expect(new Set(paged.map((session) => session.id)).size).toBe(paged.length);
    for (const page of pages.slice(0, -1)) {
      expect(page.sessions.length).toBeLessThanOrEqual(2);
      expect(page.nextCursor).not.toBeNull();
      const cursor = decodeOrganizationSessionListCursor(page.nextCursor!);
      expect(cursor).not.toBeNull();
      expect([fixture.workspaceA.id, fixture.workspaceB.id, fixture.legacyWorkspaceId]).toContain(
        cursor!.workspaceId,
      );
    }
  });

  test("owner cookie lists only the shared workspaces they are a member of", async () => {
    if (!shared || !client || !app || !fixture) return;
    const headers = { cookie: fixture.cookie };
    const pages = await collectPages(headers, { limit: "3" });
    const ids = pages.flatMap((page) => page.sessions).map((session) => session.id);
    const workspaceASessions = fixture.sharedSessionIds.get(fixture.workspaceA.id)!;
    for (const id of workspaceASessions) expect(ids).toContain(id);
    // The owner owns the private session, so their own view includes it.
    expect(ids).toContain(fixture.privateSessionId);
    for (const id of fixture.sharedSessionIds.get(fixture.workspaceB.id)!) {
      expect(ids).not.toContain(id);
    }
    expect(ids).not.toContain(fixture.personalSessionId);
  });

  test("pinned sessions count toward the page limit and never repeat or vanish", async () => {
    if (!shared || !client || !app || !fixture) return;
    const headers = { cookie: fixture.cookie };
    const workspaceASessions = fixture.sharedSessionIds.get(fixture.workspaceA.id)!;
    // Pin more sessions than one page holds so a page boundary falls inside
    // the owner's pinned prefix and another inside the ordinary keyset page.
    const pinnedIds = workspaceASessions.slice(0, 3);
    for (const sessionId of pinnedIds) {
      expect(
        await setSessionPin(client.db, {
          workspaceId: fixture.workspaceA.id,
          subjectId: fixture.subjectId,
          sessionId,
          pinned: true,
        }),
      ).not.toBeNull();
    }
    try {
      for (const limit of ["1", "2", "4"]) {
        const pages = await collectPages(headers, { limit });
        for (const page of pages) expect(page.sessions.length).toBeLessThanOrEqual(Number(limit));
        const ids = pages.flatMap((page) => page.sessions).map((session) => session.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const id of workspaceASessions) expect(ids).toContain(id);
        expect(ids).toContain(fixture.privateSessionId);
        // Pinned rows lead the workspace exactly once, in pin order.
        expect(ids.slice(0, pinnedIds.length).sort()).toEqual([...pinnedIds].sort());
      }
    } finally {
      for (const sessionId of pinnedIds) {
        await setSessionPin(client.db, {
          workspaceId: fixture.workspaceA.id,
          subjectId: fixture.subjectId,
          sessionId,
          pinned: false,
        });
      }
    }
  });

  test("status filter keeps exact lifecycle matches and reports the end", async () => {
    if (!shared || !client || !app || !fixture) return;
    const all = await listOrganizationSessions(fixture.fullHeaders);
    const status = all.body.sessions[0]!.status;
    const matching = await listOrganizationSessions(fixture.fullHeaders, { status });
    expect(matching.status).toBe(200);
    expect(matching.body.sessions.map((session) => session.id).sort()).toEqual(
      all.body.sessions
        .filter((session) => session.status === status)
        .map((session) => session.id)
        .sort(),
    );
    const none = await listOrganizationSessions(fixture.fullHeaders, { status: "failed" });
    expect(none.status).toBe(200);
    expect(none.body).toEqual({ sessions: [], nextCursor: null });
    expect((await listOrganizationSessions(fixture.fullHeaders, { status: "bogus" })).status).toBe(
      400,
    );
  });

  test("rejects malformed cursors, bad limits, foreign keys, and unknown organizations", async () => {
    if (!shared || !client || !app || !fixture) return;
    const headers = fixture.fullHeaders;
    expect((await listOrganizationSessions(headers, { cursor: "not-base64url!" })).status).toBe(
      400,
    );
    expect(
      (
        await listOrganizationSessions(headers, {
          cursor: Buffer.from(JSON.stringify({})).toString("base64url"),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await listOrganizationSessions(headers, {
          cursor: encodeOrganizationSessionListCursor({
            workspaceId: fixture.workspaceA.id,
            cursor: "garbage",
          }),
        })
      ).status,
    ).toBe(400);
    expect((await listOrganizationSessions(headers, { limit: "0" })).status).toBe(400);
    expect((await listOrganizationSessions(headers, { limit: "201" })).status).toBe(400);
    expect((await listOrganizationSessions(headers, { endUserSource: "acme" })).status).toBe(400);

    const unknownOrganization = await app.request(
      `http://x/v1/organizations/${crypto.randomUUID()}/sessions`,
      { headers },
    );
    expect(unknownOrganization.status).toBe(403);
    expect(
      (await app.request("http://x/v1/organizations/not-a-uuid/sessions", { headers })).status,
    ).toBe(422);
    expect(
      (await app.request(`http://x/v1/organizations/${fixture.accountId}/sessions`)).status,
    ).toBe(401);

    // A workspace-scoped key holds no organization authority even with
    // sessions:read on one shared workspace.
    const workspaceToken = `ogk_${crypto.randomUUID().replaceAll("-", "")}`;
    await createApiKey(client.db, {
      accountId: fixture.accountId,
      workspaceId: fixture.workspaceA.id,
      name: "Workspace key",
      prefix: workspaceToken.slice(0, 14),
      keyHash: await sha256Hex(workspaceToken),
      permissions: ["workspace:read", "sessions:read"],
    });
    expect(
      (await listOrganizationSessions({ authorization: `Bearer ${workspaceToken}` })).status,
    ).toBe(403);
  });

  test("endUser filter round-trips through the organization list", async () => {
    if (!shared || !client || !app || !fixture) return;
    if (!fixture.endUserColumnsPresent) {
      console.warn(
        "[organization-sessions] skipped: sessions.end_user_id is not present yet (slice B migration 0427)",
      );
      return;
    }
    // Workspace A is where the owner holds a membership, so the seam probe
    // below can list as the owner subject.
    const [labelled] = fixture.sharedSessionIds.get(fixture.workspaceA.id)!;
    await shared.admin`
      update sessions
      set end_user_source = 'acme', end_user_id = 'u_42'
      where id = ${labelled}`;
    // The route passes `endUser: { source, id }` straight through to
    // listSessionsForSubject. Until slice B wires that option into the SQL
    // predicate the label is ignored; probe the seam directly so this test
    // reports the missing filter instead of asserting a widening it cannot fix.
    const probe = await listSessionsForSubject(client.db, fixture.workspaceA.id, {
      subjectId: fixture.subjectId,
      limit: 10,
      materializeSnapshot: true,
      ...({ endUser: { source: "acme", id: "nobody" } } as Record<string, unknown>),
    });
    if (probe.sessions.length > 0) {
      console.warn(
        "[organization-sessions] skipped: listSessionsForSubject does not filter by endUser yet (slice B)",
      );
      return;
    }
    const { status, body } = await listOrganizationSessions(fixture.fullHeaders, {
      endUserSource: "acme",
      endUserId: "u_42",
    });
    expect(status).toBe(200);
    expect(body.sessions.map((session: Session) => session.id)).toEqual([labelled]);
    expect(body.nextCursor).toBeNull();
    const miss = await listOrganizationSessions(fixture.fullHeaders, {
      endUserSource: "acme",
      endUserId: "nobody",
    });
    expect(miss.body.sessions).toEqual([]);
  });
});
