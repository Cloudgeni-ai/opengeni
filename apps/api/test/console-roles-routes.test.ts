// Console roles (docs/opengeni-console.md, "Roles") against a real database:
// the authorization matrix of EVERY Console route and every organization
// agent route for people (owner, admin, member without a Console role,
// Viewer, Editor) and an organization API key. The routes are enumerated from
// the router, so a new Console or organization agent route without a row in
// the matrix (and so without a decided role check) fails this test. Also: the
// invitation that carries a Console role, setting roles, the audit rows a
// Viewer's session reads leave, Editors and code-managed agents, and the
// reset when a member's organization role changes.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Settings } from "@opengeni/config";
import type { AccessContext } from "@opengeni/contracts";
import type {
  ApiRouteDeps,
  ManagedEmailDeliveryResult,
  ManagedEmailMessage,
  SessionWorkflowClient,
} from "@opengeni/core";
import {
  createApiKey,
  createDb,
  createSession,
  createWorkspace,
  ensureManagedAccessForUserWithOrganizationMemberships,
  findOrgAgentTestWorkspace,
  getConsoleMemberRole,
  setConsoleReviewLevel,
  type DbClient,
} from "@opengeni/db";
import { synchronizeCanonicalHumanLoginBindings } from "@opengeni/db/canonical-human-identities";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { sha256Hex } from "@opengeni/contracts/values";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { ApiHttpError } from "../src/http/api-error";
import { organizationApiKeyPermissions } from "../src/routes/api-keys";
import { registerConsoleRoutes } from "../src/routes/console";
import { registerOrganizationAgentRoutes } from "../src/routes/organization-agents";
import { registerOrganizationMembershipRoutes } from "../src/routes/organization-memberships";
import { registerSessionRoutes } from "../src/routes/sessions";
import { registerWorkspaceRoutes } from "../src/routes/workspaces";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
let app: Hono | null = null;
let settings: Settings | null = null;

type Person = {
  userId: string;
  subjectId: string;
  email: string;
  headers: Record<string, string>;
};
type CallerName = "owner" | "admin" | "none" | "viewer" | "editor" | "key";
type Fixture = {
  accountId: string;
  managedWorkspaceId: string;
  teamWorkspaceId: string;
  agentId: string;
  people: Record<Exclude<CallerName, "key">, Person>;
  key: Record<string, string>;
};
let fixture: Fixture | null = null;
const users = new Map<string, { authSessionId: string; userId: string; email: string }>();
const createdUserIds: string[] = [];

const managedEmailTransport = {
  sender: "Opengeni <auth@mail.opengeni.ai>",
  idempotency: { scope: "test-provider-v1:console-roles", retentionSeconds: 86_400 },
  send: async (_message: ManagedEmailMessage): Promise<ManagedEmailDeliveryResult> => ({
    status: "sent",
    providerMessageId: `console-roles-${crypto.randomUUID()}`,
  }),
};

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api-console-roles");
  if (!shared && requireRealDatabase) {
    throw new Error("[api-console-roles] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable");
  }
  if (!shared) return;
  client = createDb(shared.appUrl);
  app = buildApp();
  fixture = await provisionFixture();
}, 300_000);

afterAll(async () => {
  if (shared && fixture) {
    await shared.admin`delete from managed_accounts where id = ${fixture.accountId}`.catch(
      () => undefined,
    );
  }
  for (const userId of createdUserIds) {
    if (!shared) break;
    await shared.admin`delete from auth_users where id = ${userId}`.catch(() => undefined);
  }
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 60_000);

function buildApp(): Hono {
  if (!client) throw new Error("test database unavailable");
  const noop = async () => undefined;
  settings = testSettings({
    productAccessMode: "managed",
    publicBaseUrl: "http://opengeni.test",
    betterAuthSecret: "console-roles-route-secret-at-least-32-bytes-long",
    organizationUserSetupEmailTokenTransport: "query",
    organizationUserSetupQueryEdgeSanitizationConfirmed: true,
    delegationSecret: `console-roles-${crypto.randomUUID()}`,
    sandboxBackend: "none",
    environmentsEncryptionKey: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
      "base64",
    ),
  });
  const hono = new Hono();
  // The partial app renders errors the way the API's onError does.
  hono.onError((error, c) => {
    if (error instanceof ApiHttpError) {
      return c.json(
        { code: error.code, message: error.message, details: error.details ?? {} },
        error.status,
      );
    }
    if (error instanceof HTTPException) {
      const details = (error as { details?: unknown }).details ?? {};
      return c.json({ code: "http_error", message: error.message, details }, error.status);
    }
    // As the API's onError: a request the contract refuses is 422.
    if (error instanceof z.ZodError) {
      return c.json({ code: "validation_failed", message: "invalid request", details: {} }, 422);
    }
    return c.json({ code: "internal_error", message: String(error) }, 500);
  });
  const deps = {
    db: client.db,
    bus: new MemoryEventBus(),
    settings,
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
    managedEmailTransport,
    managedAuth: {
      api: {
        getSession: async ({ headers }: { headers: Headers }) => {
          const record = users.get(headers.get("cookie") ?? "");
          if (!record) return { headers: new Headers(), response: null };
          return {
            headers: new Headers(),
            response: {
              session: { id: record.authSessionId },
              user: {
                id: record.userId,
                email: record.email,
                name: record.userId,
                emailVerified: true,
              },
            },
          };
        },
      },
    } as never,
  } as unknown as ApiRouteDeps;
  registerWorkspaceRoutes(hono, deps);
  registerSessionRoutes(hono, deps);
  registerOrganizationAgentRoutes(hono, deps);
  registerConsoleRoutes(hono, deps);
  registerOrganizationMembershipRoutes(hono, deps);
  return hono;
}

async function person(label: string): Promise<Person> {
  if (!client || !shared) throw new Error("test database unavailable");
  const userId = `console-roles-${label}-${crypto.randomUUID()}`;
  createdUserIds.push(userId);
  const email = `${userId}@example.test`;
  const authSessionId = `session-${crypto.randomUUID()}`;
  const cookie = `session=${authSessionId}`;
  await shared.admin`
    insert into auth_users (id, name, email, email_verified)
    values (${userId}, ${label}, ${email}, true)`;
  await shared.admin`
    insert into auth_identities (id, user_id, provider_id, account_id)
    values (${crypto.randomUUID()}, ${userId}, 'credential', ${userId})`;
  await ensureManagedAccessForUserWithOrganizationMemberships(client.db, {
    userId,
    email,
    name: label,
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
  users.set(cookie, { authSessionId, userId, email });
  return { userId, subjectId: `user:${userId}`, email, headers: { cookie } };
}

type Reply = { status: number; body: Record<string, any> };

async function call(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<Reply> {
  if (!app) throw new Error("app unavailable");
  const response = await app.request(`http://opengeni.test${path}`, {
    method,
    headers: {
      ...headers,
      origin: "http://opengeni.test",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed: Record<string, any> = {};
  try {
    parsed = text ? (JSON.parse(text) as Record<string, any>) : {};
  } catch {
    parsed = { text };
  }
  return { status: response.status, body: parsed };
}

/** Invites `invitee` as the owner and accepts it as them. */
async function inviteAndAccept(
  accountId: string,
  owner: Person,
  invitee: Person,
  role: "member" | "admin",
  consoleRole?: "viewer" | "editor",
): Promise<{ membershipId: string; authorizationRevision: number }> {
  const invited = await call("POST", `/v1/organizations/${accountId}/invitations`, owner.headers, {
    email: invitee.email,
    role,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    operationId: crypto.randomUUID(),
    ...(consoleRole ? { consoleRole } : {}),
  });
  if (invited.status !== 201) {
    throw new Error(`invite failed: ${invited.status} ${JSON.stringify(invited.body)}`);
  }
  const mine = await call("GET", "/v1/organization-invitations", invitee.headers);
  const invitation = (mine.body.invitations as { id: string; revision: number }[]).find(
    (candidate) => candidate.id === invited.body.id,
  );
  if (!invitation) throw new Error(`invitation not listed: ${JSON.stringify(mine.body)}`);
  const accepted = await call(
    "POST",
    `/v1/organization-invitations/${invitation.id}/accept`,
    invitee.headers,
    { expectedRevision: invitation.revision, operationId: crypto.randomUUID() },
  );
  if (accepted.status !== 200) {
    throw new Error(`accept failed: ${accepted.status} ${JSON.stringify(accepted.body)}`);
  }
  return {
    membershipId: accepted.body.membership.id,
    authorizationRevision: accepted.body.membership.authorizationRevision,
  };
}

async function provisionFixture(): Promise<Fixture> {
  if (!client || !shared || !app) throw new Error("test database unavailable");
  const owner = await person("owner");
  const access = await call("GET", "/v1/access/me", owner.headers);
  if (access.status !== 200) throw new Error(`managed provisioning failed: ${access.status}`);
  const accountId = (access.body as AccessContext).defaultAccountId!;
  settings!.orgAgentsAccountIds = [accountId];

  const admin = await person("admin");
  const none = await person("none");
  const viewer = await person("viewer");
  const editor = await person("editor");
  await inviteAndAccept(accountId, owner, admin, "admin");
  await inviteAndAccept(accountId, owner, none, "member");
  await inviteAndAccept(accountId, owner, viewer, "member", "viewer");
  await inviteAndAccept(accountId, owner, editor, "member", "editor");

  const managed = await createWorkspace(client.db, { accountId, name: "Managed tenant" });
  const team = await createWorkspace(client.db, { accountId, name: "Team" });
  await shared.admin`insert into organization_managed_workspaces (account_id, workspace_id, source)
    values (${accountId}, ${managed.id}, 'console')`;

  const token = `ogk_${crypto.randomUUID().replaceAll("-", "")}`;
  await createApiKey(client.db, {
    accountId,
    workspaceId: null,
    name: "Full",
    prefix: token.slice(0, 14),
    keyHash: await sha256Hex(token),
    permissions: organizationApiKeyPermissions,
    credentialKind: "organization",
  });
  const agent = await call("POST", `/v1/organizations/${accountId}/agents`, owner.headers, {
    key: "matrix",
    name: "Matrix",
    instructions: "Be brief.",
  });
  if (agent.status !== 201) {
    throw new Error(`agent create failed: ${agent.status} ${JSON.stringify(agent.body)}`);
  }
  return {
    accountId,
    managedWorkspaceId: managed.id,
    teamWorkspaceId: team.id,
    agentId: agent.body.id,
    people: { owner, admin, none, viewer, editor },
    key: { authorization: `Bearer ${token}` },
  };
}

function headersOf(name: CallerName): Record<string, string> {
  return name === "key" ? fixture!.key : fixture!.people[name].headers;
}

async function auditRows(action: string, actorSubjectId?: string) {
  const rows = await shared!.admin<
    { actor_subject_id: string; session_id: string | null; detail: Record<string, unknown> }[]
  >`
    select actor_subject_id, session_id::text as session_id, detail
    from organization_console_audit_events
    where account_id = ${fixture!.accountId} and action = ${action} order by created_at`;
  return actorSubjectId ? rows.filter((row) => row.actor_subject_id === actorSubjectId) : rows;
}

/* ------------------------------------------------------------------ matrix */

/**
 * Who may call each route, by the least access a person needs: `any` (every
 * person in the organization), `viewer`, `editor`, `full` (owners and
 * admins) or `owner`. `key` is what an organization API key with every
 * permission gets: `allowed`, or refused because the route is for people
 * (`people_only`) or for the owner (`owner_only`).
 */
type Need = "any" | "viewer" | "editor" | "full" | "owner";
type KeyOutcome = "allowed" | "people_only" | "owner_only";
type RouteCase = {
  need: Need;
  key: KeyOutcome;
  /** The concrete request: chosen so an allowed call changes nothing (422/404) or only reads. */
  path: (f: Fixture) => string;
  body?: unknown;
};

const C = "/v1/organizations/:organizationId/console";
const A = "/v1/organizations/:organizationId/agents";
const CREDENTIALS =
  "/v1/workspaces/:workspaceId/end-users/:externalUserId/tool-credentials/:toolServerKey";
const missingId = "99999999-9999-4999-8999-999999999999";
const console_ = (f: Fixture) => `/v1/organizations/${f.accountId}/console`;
const agents = (f: Fixture) => `/v1/organizations/${f.accountId}/agents`;
const credentials = (f: Fixture) =>
  `/v1/workspaces/${f.managedWorkspaceId}/end-users/matrix-user/tool-credentials/missing-server`;

const MATRIX: Record<string, RouteCase> = {
  // Console (src/routes/console.ts, console-roles.ts): people only.
  [`GET ${C}/access`]: { need: "any", key: "people_only", path: (f) => `${console_(f)}/access` },
  [`GET ${C}/summary`]: {
    need: "viewer",
    key: "people_only",
    path: (f) => `${console_(f)}/summary`,
  },
  [`GET ${C}/workspaces`]: {
    need: "viewer",
    key: "people_only",
    path: (f) => `${console_(f)}/workspaces`,
  },
  [`PUT ${C}/workspaces/:workspaceId`]: {
    need: "full",
    key: "people_only",
    path: (f) => `${console_(f)}/workspaces/${f.teamWorkspaceId}`,
    body: {},
  },
  [`GET ${C}/sessions`]: {
    need: "viewer",
    key: "people_only",
    path: (f) => `${console_(f)}/sessions`,
  },
  [`GET ${C}/workspaces/:workspaceId/sessions/:sessionId`]: {
    need: "viewer",
    key: "people_only",
    path: (f) => `${console_(f)}/workspaces/${f.managedWorkspaceId}/sessions/${missingId}`,
  },
  [`GET ${C}/workspaces/:workspaceId/sessions/:sessionId/events`]: {
    need: "viewer",
    key: "people_only",
    path: (f) => `${console_(f)}/workspaces/${f.managedWorkspaceId}/sessions/${missingId}/events`,
  },
  [`GET ${C}/settings`]: {
    need: "full",
    key: "people_only",
    path: (f) => `${console_(f)}/settings`,
  },
  [`PUT ${C}/settings`]: {
    need: "full",
    key: "people_only",
    path: (f) => `${console_(f)}/settings`,
    body: {},
  },
  [`GET ${C}/audit-log`]: {
    need: "full",
    key: "people_only",
    path: (f) => `${console_(f)}/audit-log`,
  },
  [`GET ${C}/api-keys`]: {
    need: "full",
    key: "people_only",
    path: (f) => `${console_(f)}/api-keys`,
  },
  [`GET ${C}/member-roles`]: {
    need: "full",
    key: "people_only",
    path: (f) => `${console_(f)}/member-roles`,
  },
  [`PUT ${C}/member-roles`]: {
    need: "full",
    key: "people_only",
    path: (f) => `${console_(f)}/member-roles`,
    body: {},
  },

  // Organization agents (src/routes/organization-agents.ts): keys by permission.
  [`GET ${A}/tool-servers`]: {
    need: "viewer",
    key: "allowed",
    path: (f) => `${agents(f)}/tool-servers`,
  },
  [`POST ${A}/tool-servers`]: {
    need: "full",
    key: "allowed",
    path: (f) => `${agents(f)}/tool-servers`,
    body: {},
  },
  [`GET ${A}/tool-servers/:key`]: {
    need: "viewer",
    key: "allowed",
    path: (f) => `${agents(f)}/tool-servers/missing-server`,
  },
  [`PATCH ${A}/tool-servers/:key`]: {
    need: "full",
    key: "allowed",
    path: (f) => `${agents(f)}/tool-servers/missing-server`,
    body: {},
  },
  [`DELETE ${A}/tool-servers/:key`]: {
    need: "full",
    key: "allowed",
    path: (f) => `${agents(f)}/tool-servers/missing-server`,
  },
  [`GET ${A}/tool-servers/:key/tools`]: {
    need: "viewer",
    key: "allowed",
    path: (f) => `${agents(f)}/tool-servers/missing-server/tools`,
  },
  [`POST ${A}/test-workspace`]: {
    need: "editor",
    key: "allowed",
    path: (f) => `${agents(f)}/test-workspace`,
  },
  [`GET ${A}`]: { need: "viewer", key: "allowed", path: (f) => agents(f) },
  [`POST ${A}`]: { need: "editor", key: "allowed", path: (f) => agents(f), body: {} },
  [`GET ${A}/by-key/:key`]: {
    need: "viewer",
    key: "allowed",
    path: (f) => `${agents(f)}/by-key/matrix`,
  },
  [`PUT ${A}/by-key/:key/apply`]: {
    need: "full",
    key: "allowed",
    path: (f) => `${agents(f)}/by-key/matrix/apply`,
    body: {},
  },
  [`GET ${A}/:agentId`]: {
    need: "viewer",
    key: "allowed",
    path: (f) => `${agents(f)}/${f.agentId}`,
  },
  [`PATCH ${A}/:agentId`]: {
    need: "full",
    key: "allowed",
    path: (f) => `${agents(f)}/${f.agentId}`,
    body: {},
  },
  [`PUT ${A}/:agentId/draft`]: {
    need: "editor",
    key: "allowed",
    path: (f) => `${agents(f)}/${f.agentId}/draft`,
    body: {},
  },
  [`GET ${A}/:agentId/versions`]: {
    need: "viewer",
    key: "allowed",
    path: (f) => `${agents(f)}/${f.agentId}/versions`,
  },
  [`GET ${A}/:agentId/versions/:version`]: {
    need: "viewer",
    key: "allowed",
    path: (f) => `${agents(f)}/${f.agentId}/versions/1`,
  },
  [`POST ${A}/:agentId/publish`]: {
    need: "editor",
    key: "allowed",
    path: (f) => `${agents(f)}/${f.agentId}/publish`,
    body: {},
  },
  [`GET ${A}/:agentId/publish-operations`]: {
    need: "viewer",
    key: "allowed",
    path: (f) => `${agents(f)}/${f.agentId}/publish-operations`,
  },
  [`GET ${A}/:agentId/movable-chats`]: {
    need: "viewer",
    key: "allowed",
    path: (f) => `${agents(f)}/${f.agentId}/movable-chats`,
  },
  [`POST ${A}/:agentId/management`]: {
    need: "owner",
    key: "owner_only",
    path: (f) => `${agents(f)}/${f.agentId}/management`,
    body: {},
  },
  [`POST ${A}/:agentId/archive`]: {
    need: "full",
    key: "allowed",
    path: (f) => `${agents(f)}/${f.agentId}/archive`,
    body: {},
  },
  [`GET ${A}/:agentId/sessions`]: {
    need: "viewer",
    key: "allowed",
    path: (f) => `${agents(f)}/${f.agentId}/sessions`,
  },
  [`GET ${A}/:agentId/usage`]: {
    need: "viewer",
    key: "allowed",
    path: (f) => `${agents(f)}/${f.agentId}/usage`,
  },
  [`POST ${A}/:agentId/test-chats`]: {
    need: "editor",
    key: "allowed",
    path: (f) => `${agents(f)}/${f.agentId}/test-chats`,
    body: {},
  },
  // End users' stored tool logins: owners and admins among people.
  [`PUT ${CREDENTIALS}`]: { need: "full", key: "allowed", path: credentials, body: {} },
  [`GET ${CREDENTIALS}`]: { need: "full", key: "allowed", path: credentials },
  [`DELETE ${CREDENTIALS}`]: { need: "full", key: "allowed", path: credentials },
};

/** Routes under Console's prefixes that are deliberately not Console routes. */
const NOT_CONSOLE = new Set<string>([]);

const RANK: Record<Exclude<CallerName, "key">, number> = {
  none: 0,
  viewer: 1,
  editor: 2,
  admin: 3,
  owner: 4,
};
const NEED_RANK: Record<Need, number> = { any: 0, viewer: 1, editor: 2, full: 3, owner: 4 };

function consoleRouteKeys(): string[] {
  return [
    ...new Set(
      app!.routes
        .filter((route) => route.method !== "ALL")
        .filter(
          (route) =>
            route.path.startsWith(C) ||
            route.path === A ||
            route.path.startsWith(`${A}/`) ||
            route.path.includes("/tool-credentials/"),
        )
        .map((route) => `${route.method} ${route.path}`)
        .filter((key) => !NOT_CONSOLE.has(key)),
    ),
  ].sort();
}

describe("Console roles: authorization matrix", () => {
  test("every Console and organization agent route has a decided role check", () => {
    if (!fixture) return;
    expect(consoleRouteKeys()).toEqual(Object.keys(MATRIX).sort());
  });

  test("people get exactly their Console role's routes; keys keep their permissions", async () => {
    if (!fixture) return;
    const failures: string[] = [];
    for (const [route, spec] of Object.entries(MATRIX)) {
      const method = route.split(" ")[0]!;
      for (const caller of ["owner", "admin", "none", "viewer", "editor", "key"] as const) {
        const reply = await call(method, spec.path(fixture), headersOf(caller), spec.body);
        const code = reply.body.details?.code;
        let ok: boolean;
        let expected: string;
        if (caller === "key") {
          if (spec.key === "allowed") {
            expected = "allowed";
            ok = reply.status !== 401 && reply.status !== 403 && reply.status < 500;
          } else if (spec.key === "owner_only") {
            expected = "403 agent_management_requires_owner";
            ok = reply.status === 403 && code === "agent_management_requires_owner";
          } else {
            expected = "403 console_role_required";
            ok = reply.status === 403 && code === "console_role_required";
          }
        } else if (
          spec.need === "any" ||
          (spec.need === "owner" ? caller === "owner" : RANK[caller] >= NEED_RANK[spec.need])
        ) {
          expected = "allowed";
          ok = reply.status !== 401 && reply.status !== 403 && reply.status < 500;
        } else if (spec.need === "owner" && caller === "admin") {
          expected = "403 agent_management_requires_owner";
          ok = reply.status === 403 && code === "agent_management_requires_owner";
        } else {
          expected = "403 console_role_required";
          ok = reply.status === 403 && code === "console_role_required";
        }
        if (!ok) {
          failures.push(
            `${route} as ${caller}: expected ${expected}, got ${reply.status} ${JSON.stringify(reply.body).slice(0, 200)}`,
          );
        }
      }
    }
    expect(failures).toEqual([]);
  }, 300_000);

  test("Console access says what each person has", async () => {
    if (!fixture) return;
    const expected = {
      owner: "full",
      admin: "full",
      none: "none",
      viewer: "viewer",
      editor: "editor",
    } as const;
    for (const [name, access] of Object.entries(expected)) {
      const reply = await call("GET", `${console_(fixture)}/access`, headersOf(name as CallerName));
      expect([name, reply.status, reply.body.access]).toEqual([name, 200, access]);
    }
  }, 60_000);

  test("a Console role never reaches another organization", async () => {
    if (!fixture) return;
    const other = await person("outsider");
    const access = await call("GET", "/v1/access/me", other.headers);
    const otherAccountId = (access.body as AccessContext).defaultAccountId!;
    for (const caller of ["viewer", "editor", "admin"] as const) {
      const reply = await call(
        "GET",
        `/v1/organizations/${otherAccountId}/console/sessions`,
        headersOf(caller),
      );
      expect([caller, reply.status, reply.body.details?.code]).toEqual([
        caller,
        403,
        "console_role_required",
      ]);
    }
  }, 60_000);
});

describe("Console roles: reads, writes and lifecycle", () => {
  test("a Viewer's transcript and metadata reads are audit-logged as theirs", async () => {
    if (!fixture || !client) return;
    const { people, accountId, managedWorkspaceId } = fixture;
    const session = await createSession(client.db, {
      accountId,
      workspaceId: managedWorkspaceId,
      initialMessage: "",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "low",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    const detail = `${console_(fixture)}/workspaces/${managedWorkspaceId}/sessions/${session.id}`;
    await setConsoleReviewLevel(client.db, {
      accountId,
      reviewLevel: "full",
      actorSubjectId: people.owner.subjectId,
      actorLabel: null,
    });
    expect((await call("GET", detail, people.viewer.headers)).status).toBe(200);
    expect((await call("GET", `${detail}/events`, people.viewer.headers)).status).toBe(200);
    const transcript = await auditRows("session.transcript_viewed", people.viewer.subjectId);
    expect(transcript.map((row) => row.session_id)).toContain(session.id);

    await setConsoleReviewLevel(client.db, {
      accountId,
      reviewLevel: "metadata",
      actorSubjectId: people.owner.subjectId,
      actorLabel: null,
    });
    try {
      expect((await call("GET", detail, people.viewer.headers)).status).toBe(200);
      const metadata = await auditRows("session.metadata_viewed", people.viewer.subjectId);
      expect(metadata.map((row) => row.session_id)).toContain(session.id);
      // Transcripts stay closed at the metadata level, for Viewers as for admins.
      expect((await call("GET", `${detail}/events`, people.viewer.headers)).status).toBe(403);
      // The member without a Console role reads nothing and leaves no row.
      expect((await call("GET", detail, people.none.headers)).status).toBe(403);
      expect(await auditRows("session.metadata_viewed", people.none.subjectId)).toEqual([]);
    } finally {
      await setConsoleReviewLevel(client.db, {
        accountId,
        reviewLevel: "full",
        actorSubjectId: people.owner.subjectId,
        actorLabel: null,
      });
    }
  }, 60_000);

  test("an invitation's Console role became the member's, with its audit rows", async () => {
    if (!fixture) return;
    const { people } = fixture;
    const changes = await auditRows("member.console_role_changed");
    const applied = changes.filter(
      (row) => row.detail.subjectId === people.viewer.subjectId && row.detail.to === "viewer",
    );
    expect(applied).toHaveLength(1);
    expect(applied[0]!.detail.reason).toBe("invitation_accepted");
    expect(changes.some((row) => row.detail.invitationId && row.detail.to === "editor")).toBe(true);
    const listed = await call("GET", `${console_(fixture)}/member-roles`, people.admin.headers);
    expect(listed.status).toBe(200);
    const roles = listed.body.roles as { subjectId: string | null; role: string }[];
    expect(roles.find((entry) => entry.subjectId === people.viewer.subjectId)?.role).toBe("viewer");
    expect(roles.find((entry) => entry.subjectId === people.editor.subjectId)?.role).toBe("editor");
    expect(roles.some((entry) => entry.subjectId === people.none.subjectId)).toBe(false);
  }, 60_000);

  test("only owners and admins put a Console role on an invitation, and only for members", async () => {
    if (!fixture) return;
    const { people, accountId } = fixture;
    const invite = (headers: Record<string, string>, role: string) =>
      call("POST", `/v1/organizations/${accountId}/invitations`, headers, {
        email: `console-roles-${crypto.randomUUID()}@example.test`,
        role,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        operationId: crypto.randomUUID(),
        consoleRole: "viewer",
      });
    for (const caller of ["none", "viewer", "editor"] as const) {
      expect([caller, (await invite(headersOf(caller), "member")).status]).toEqual([caller, 403]);
    }
    expect((await invite(fixture.key, "member")).status).toBeGreaterThanOrEqual(401);
    expect((await invite(fixture.key, "member")).status).toBeLessThan(500);
    const forAdmin = await invite(people.owner.headers, "admin");
    expect([forAdmin.status, forAdmin.body.details?.code]).toEqual([
      422,
      "console_role_not_applicable",
    ]);
    const byAdmin = await invite(people.admin.headers, "member");
    expect(byAdmin.status).toBe(201);
    const listed = await call("GET", `${console_(fixture)}/member-roles`, people.owner.headers);
    expect(
      (listed.body.roles as { invitationId: string | null; role: string }[]).find(
        (entry) => entry.invitationId === byAdmin.body.id,
      )?.role,
    ).toBe("viewer");
  }, 60_000);

  test("owners and admins set members' Console roles, never owners' or admins'", async () => {
    if (!fixture) return;
    const { people } = fixture;
    const put = (headers: Record<string, string>, body: unknown) =>
      call("PUT", `${console_(fixture!)}/member-roles`, headers, body);
    const set = await put(people.admin.headers, {
      subjectId: people.none.subjectId,
      role: "viewer",
    });
    expect([set.status, set.body.role]).toEqual([200, "viewer"]);
    expect((await call("GET", `${console_(fixture)}/sessions`, people.none.headers)).status).toBe(
      200,
    );
    const cleared = await put(people.owner.headers, {
      subjectId: people.none.subjectId,
      role: "none",
    });
    expect([cleared.status, cleared.body.role]).toEqual([200, "none"]);
    expect((await call("GET", `${console_(fixture)}/sessions`, people.none.headers)).status).toBe(
      403,
    );
    const changes = (await auditRows("member.console_role_changed")).filter(
      (row) => row.detail.subjectId === people.none.subjectId,
    );
    expect(changes.map((row) => [row.actor_subject_id, row.detail.from, row.detail.to])).toEqual([
      [people.admin.subjectId, "none", "viewer"],
      [people.owner.subjectId, "viewer", "none"],
    ]);

    const onAdmin = await put(people.owner.headers, {
      subjectId: people.admin.subjectId,
      role: "viewer",
    });
    expect([onAdmin.status, onAdmin.body.details?.code]).toEqual([
      422,
      "console_role_not_applicable",
    ]);
    const stranger = await put(people.owner.headers, {
      subjectId: "user:not-a-member",
      role: "viewer",
    });
    expect([stranger.status, stranger.body.details?.code]).toEqual([404, "member_not_found"]);
    const badInvitation = await put(people.owner.headers, {
      invitationId: missingId,
      role: "viewer",
    });
    expect([badInvitation.status, badInvitation.body.details?.code]).toEqual([
      404,
      "invitation_not_found",
    ]);
    // An Editor can't raise anyone, themselves included.
    const selfRaise = await put(people.editor.headers, {
      subjectId: people.viewer.subjectId,
      role: "editor",
    });
    expect([selfRaise.status, selfRaise.body.details?.code]).toEqual([
      403,
      "console_role_required",
    ]);
  }, 60_000);

  test("Editors change Console-managed agents only, without team workspace availability", async () => {
    if (!fixture) return;
    const { people, key, teamWorkspaceId } = fixture;
    const deployed = await call("PUT", `${agents(fixture)}/by-key/from-code/apply`, key, {
      name: "From code",
      instructions: "Deployed.",
    });
    expect(deployed.status).toBeLessThan(300);
    const codeAgentId = (deployed.body.agent?.id ?? deployed.body.id) as string;
    const draft = await call(
      "PUT",
      `${agents(fixture)}/${codeAgentId}/draft`,
      people.editor.headers,
      {
        name: "Edited",
        instructions: "Edited.",
        expectedVersion: 1,
      },
    );
    expect([draft.status, draft.body.details?.code]).toEqual([403, "console_role_required"]);
    const publish = await call(
      "POST",
      `${agents(fixture)}/${codeAgentId}/publish`,
      people.editor.headers,
      { version: 1, expectedVersion: 1 },
    );
    expect([publish.status, publish.body.details?.code]).toEqual([403, "console_role_required"]);

    const created = await call("POST", agents(fixture), people.editor.headers, {
      key: "editor-made",
      name: "Editor made",
      instructions: "Hi.",
    });
    expect(created.status).toBe(201);
    const reach = await call("POST", agents(fixture), people.editor.headers, {
      key: "editor-reach",
      name: "Editor reach",
      instructions: "Hi.",
      workspaceIds: [teamWorkspaceId],
    });
    expect([reach.status, reach.body.details?.code]).toEqual([403, "console_role_required"]);
  }, 60_000);

  test("leaving Editor removes the Console test workspace access; a new organization role resets the Console role", async () => {
    if (!fixture || !client || !shared) return;
    const { people, accountId } = fixture;
    const temp = await person("temp");
    const membership = await inviteAndAccept(accountId, people.owner, temp, "member", "editor");
    expect(await getConsoleMemberRole(client.db, accountId, temp.subjectId)).toBe("editor");
    const testWorkspace = await call("POST", `${agents(fixture)}/test-workspace`, temp.headers);
    expect(testWorkspace.status).toBeLessThan(300);
    const workspaceId = await findOrgAgentTestWorkspace(client.db, accountId);
    const memberships = async () =>
      (
        await shared!.admin<{ count: number }[]>`
          select count(*)::int as count from workspace_memberships
          where workspace_id = ${workspaceId} and subject_id = ${temp.subjectId}`
      )[0]!.count;
    expect(await memberships()).toBe(1);
    const lowered = await call("PUT", `${console_(fixture)}/member-roles`, people.owner.headers, {
      subjectId: temp.subjectId,
      role: "viewer",
    });
    expect(lowered.status).toBe(200);
    expect(await memberships()).toBe(0);

    const promoted = await call(
      "PATCH",
      `/v1/organizations/${accountId}/members/${membership.membershipId}`,
      people.owner.headers,
      {
        kind: "change_role",
        role: "admin",
        expectedAuthorizationRevision: membership.authorizationRevision,
        operationId: crypto.randomUUID(),
      },
    );
    expect(promoted.status).toBe(200);
    expect(await getConsoleMemberRole(client.db, accountId, temp.subjectId)).toBe("none");
    const reset = (await auditRows("member.console_role_changed")).filter(
      (row) => row.detail.subjectId === temp.subjectId && row.detail.to === "none",
    );
    expect(reset.map((row) => row.detail.reason)).toEqual(["organization_role_changed"]);
  }, 120_000);
});
