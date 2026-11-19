// Console roles (docs/opengeni-console.md, "Roles") against a real database:
// the authorization matrix of EVERY Console route and every organization
// agent route for people (owner, admin, member without a Console role,
// Viewer, Editor), a full organization API key and narrow keys each missing
// agents:read, agents:manage or tool_credentials:write. The routes are
// enumerated from the router, so a new Console or organization agent route
// without a row in the matrix (and so without a decided role check) fails
// this test, and every refused call is checked to have changed nothing. Also:
// the invitation that carries a Console role, setting roles, the audit rows a
// Viewer's session reads leave, Editors and code-managed agents, the reset
// when a member's organization role changes, and Console test chats: nobody
// becomes a member of the test workspace, a test chat is its tester's alone
// (another Editor or the owner can't read or continue it through Console or
// the app), and losing Editor access takes test chats away at once.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Settings } from "@opengeni/config";
import {
  OPEN_SUFFIX_RUN_STATE_BLOB,
  signDelegatedAccessToken,
  type AccessContext,
  type AccessGrant,
  type Permission,
} from "@opengeni/contracts";
import { hasPermission } from "@opengeni/core";
import type {
  ApiRouteDeps,
  ManagedEmailDeliveryResult,
  ManagedEmailMessage,
  SessionWorkflowClient,
} from "@opengeni/core";
import {
  applySessionTurnSettlement,
  claimSessionWorkForAttempt,
  createApiKey,
  createDb,
  createOrganizationApiKey,
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
import { organizationApiKeyPermissions, registerApiKeyRoutes } from "../src/routes/api-keys";
import { buildOpenGeniMcpServer } from "../src/mcp/server";
import { registerConsoleRoutes } from "../src/routes/console";
import {
  CONSOLE_TEST_CHAT_PERMISSIONS,
  consoleTestChatSubjectId,
  registerOrganizationAgentRoutes,
} from "../src/routes/organization-agents";
import { registerOrganizationMembershipRoutes } from "../src/routes/organization-memberships";
import { registerSessionRoutes } from "../src/routes/sessions";
import { registerWorkspaceRoutes } from "../src/routes/workspaces";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
let app: Hono | null = null;
let settings: Settings | null = null;
let routeDeps: ApiRouteDeps | null = null;

type Person = {
  userId: string;
  subjectId: string;
  email: string;
  headers: Record<string, string>;
};
type CallerName = "owner" | "admin" | "none" | "viewer" | "editor" | "key";
/** Organization keys in explicit permission mode, each missing something. */
const NARROW_KEYS = {
  "key without agents:manage": ["agents:read", "sessions:read", "workspace:read"],
  "key without agents:read": ["agents:manage", "tool_credentials:write", "workspace:read"],
  "key without tool_credentials:write": [
    "agents:read",
    "agents:manage",
    "sessions:read",
    "sessions:create",
    "workspace:read",
  ],
} as const satisfies Record<string, readonly Permission[]>;
type NarrowKeyName = keyof typeof NARROW_KEYS;
type Fixture = {
  accountId: string;
  managedWorkspaceId: string;
  teamWorkspaceId: string;
  agentId: string;
  people: Record<Exclude<CallerName, "key">, Person>;
  key: Record<string, string>;
  narrowKeys: Record<NarrowKeyName, Record<string, string>>;
  /** Each caller's own test chat of the agent, for those who may test (others: none). */
  testChats: Partial<Record<CallerName | NarrowKeyName, string>>;
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
  routeDeps = deps;
  registerWorkspaceRoutes(hono, deps);
  registerApiKeyRoutes(hono, deps);
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
  const narrowKeys = {} as Record<NarrowKeyName, Record<string, string>>;
  for (const [name, permissions] of Object.entries(NARROW_KEYS) as [
    NarrowKeyName,
    readonly Permission[],
  ][]) {
    const narrow = `ogk_${crypto.randomUUID().replaceAll("-", "")}`;
    await createOrganizationApiKey(client.db, {
      accountId,
      name,
      prefix: narrow.slice(0, 14),
      keyHash: await sha256Hex(narrow),
      permissions: [...permissions],
      policy: { preset: "custom", permissions: [...permissions], workspaceScope: { kind: "all" } },
    });
    narrowKeys[name] = { authorization: `Bearer ${narrow}` };
  }
  const agent = await call("POST", `/v1/organizations/${accountId}/agents`, owner.headers, {
    key: "matrix",
    name: "Matrix",
    instructions: "Be brief.",
  });
  if (agent.status !== 201) {
    throw new Error(`agent create failed: ${agent.status} ${JSON.stringify(agent.body)}`);
  }
  const agentId = agent.body.agent.id as string;
  // Everyone who may test starts one test chat of their own.
  const testers: [CallerName | NarrowKeyName, Record<string, string>][] = [
    ["owner", owner.headers],
    ["admin", admin.headers],
    ["editor", editor.headers],
    ["key", { authorization: `Bearer ${token}` }],
    ["key without agents:read", narrowKeys["key without agents:read"]],
    ["key without tool_credentials:write", narrowKeys["key without tool_credentials:write"]],
  ];
  const testChats: Fixture["testChats"] = {};
  for (const [name, headers] of testers) {
    const started = await call(
      "POST",
      `/v1/organizations/${accountId}/agents/${agentId}/test-chats`,
      headers,
      {
        version: 1,
        message: `hi from ${name}`,
      },
    );
    if (started.status !== 201) {
      throw new Error(
        `test chat failed for ${name}: ${started.status} ${JSON.stringify(started.body)}`,
      );
    }
    testChats[name] = started.body.sessionId as string;
  }
  // The matrix's end user exists (only an organization key provisions one), so
  // everyone allowed to write a stored login reaches the body check.
  const provisioned = await call(
    "PUT",
    `/v1/workspaces/${managed.id}/end-users/matrix-user/tool-credentials/missing-server`,
    { authorization: `Bearer ${token}` },
    {},
  );
  if (provisioned.status !== 422) {
    throw new Error(`end user provisioning failed: ${provisioned.status}`);
  }
  return {
    accountId,
    managedWorkspaceId: managed.id,
    teamWorkspaceId: team.id,
    agentId,
    people: { owner, admin, none, viewer, editor },
    key: { authorization: `Bearer ${token}` },
    narrowKeys,
    testChats,
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
/** `workspace`: an app workspace route for its members, never reached through Console access. */
type Need = "any" | "viewer" | "editor" | "full" | "owner" | "workspace";
type KeyOutcome = "allowed" | "people_only" | "owner_only";
type RouteCase = {
  need: Need;
  key: KeyOutcome;
  /**
   * The concrete request for a caller: chosen so an allowed call changes
   * nothing (a refused body or a missing record) or only reads.
   */
  path: (f: Fixture, caller: string) => string;
  body?: unknown;
  /** The exact status an allowed caller gets (any of them, when a list). */
  ok: number | readonly number[];
};

const C = "/v1/organizations/:organizationId/console";
const A = "/v1/organizations/:organizationId/agents";
const CREDENTIALS =
  "/v1/workspaces/:workspaceId/end-users/:externalUserId/tool-credentials/:toolServerKey";
const WORKSPACE_AGENTS = "/v1/workspaces/:workspaceId/organization-agents";
const missingId = "99999999-9999-4999-8999-999999999999";
const console_ = (f: Fixture) => `/v1/organizations/${f.accountId}/console`;
const agents = (f: Fixture) => `/v1/organizations/${f.accountId}/agents`;
/** The caller's own test chat, or a missing one for callers who may not test. */
const testChatPath = (f: Fixture, caller: string) =>
  `${agents(f)}/${f.agentId}/test-chats/${f.testChats[caller as CallerName] ?? missingId}`;
const credentials = (f: Fixture) =>
  `/v1/workspaces/${f.managedWorkspaceId}/end-users/matrix-user/tool-credentials/missing-server`;

const MATRIX: Record<string, RouteCase> = {
  // Console (src/routes/console.ts, console-roles.ts): people only.
  [`GET ${C}/access`]: {
    need: "any",
    key: "people_only",
    ok: 200,
    path: (f) => `${console_(f)}/access`,
  },
  [`GET ${C}/summary`]: {
    need: "viewer",
    key: "people_only",
    ok: 200,
    path: (f) => `${console_(f)}/summary`,
  },
  [`GET ${C}/workspaces`]: {
    need: "viewer",
    key: "people_only",
    ok: 200,
    path: (f) => `${console_(f)}/workspaces`,
  },
  [`PUT ${C}/workspaces/:workspaceId`]: {
    need: "full",
    key: "people_only",
    ok: 422,
    path: (f) => `${console_(f)}/workspaces/${f.teamWorkspaceId}`,
    body: {},
  },
  [`GET ${C}/sessions`]: {
    need: "viewer",
    key: "people_only",
    ok: 200,
    path: (f) => `${console_(f)}/sessions`,
  },
  [`GET ${C}/workspaces/:workspaceId/sessions/:sessionId`]: {
    need: "viewer",
    key: "people_only",
    ok: 404,
    path: (f) => `${console_(f)}/workspaces/${f.managedWorkspaceId}/sessions/${missingId}`,
  },
  [`GET ${C}/workspaces/:workspaceId/sessions/:sessionId/events`]: {
    need: "viewer",
    key: "people_only",
    ok: 404,
    path: (f) => `${console_(f)}/workspaces/${f.managedWorkspaceId}/sessions/${missingId}/events`,
  },
  [`GET ${C}/settings`]: {
    need: "full",
    key: "people_only",
    ok: 200,
    path: (f) => `${console_(f)}/settings`,
  },
  [`PUT ${C}/settings`]: {
    need: "full",
    key: "people_only",
    ok: 422,
    path: (f) => `${console_(f)}/settings`,
    body: {},
  },
  [`GET ${C}/audit-log`]: {
    need: "full",
    key: "people_only",
    ok: 200,
    path: (f) => `${console_(f)}/audit-log`,
  },
  [`GET ${C}/api-keys`]: {
    need: "full",
    key: "people_only",
    ok: 200,
    path: (f) => `${console_(f)}/api-keys`,
  },
  [`GET ${C}/member-roles`]: {
    need: "full",
    key: "people_only",
    ok: 200,
    path: (f) => `${console_(f)}/member-roles`,
  },
  [`PUT ${C}/member-roles`]: {
    need: "full",
    key: "people_only",
    ok: 422,
    path: (f) => `${console_(f)}/member-roles`,
    body: {},
  },

  // Organization agents (src/routes/organization-agents.ts): keys by permission.
  [`GET ${A}/tool-servers`]: {
    need: "viewer",
    key: "allowed",
    ok: 200,
    path: (f) => `${agents(f)}/tool-servers`,
  },
  [`POST ${A}/tool-servers`]: {
    need: "full",
    key: "allowed",
    ok: 422,
    path: (f) => `${agents(f)}/tool-servers`,
    body: {},
  },
  [`GET ${A}/tool-servers/:key`]: {
    need: "viewer",
    key: "allowed",
    ok: 404,
    path: (f) => `${agents(f)}/tool-servers/missing-server`,
  },
  [`PATCH ${A}/tool-servers/:key`]: {
    need: "full",
    key: "allowed",
    ok: 422,
    path: (f) => `${agents(f)}/tool-servers/missing-server`,
    body: {},
  },
  [`DELETE ${A}/tool-servers/:key`]: {
    need: "full",
    key: "allowed",
    ok: 404,
    path: (f) => `${agents(f)}/tool-servers/missing-server`,
  },
  [`GET ${A}/tool-servers/:key/tools`]: {
    need: "viewer",
    key: "allowed",
    ok: 404,
    path: (f) => `${agents(f)}/tool-servers/missing-server/tools`,
  },
  [`POST ${A}/test-workspace`]: {
    need: "editor",
    key: "allowed",
    ok: [200, 201],
    path: (f) => `${agents(f)}/test-workspace`,
  },
  [`GET ${A}`]: { need: "viewer", key: "allowed", ok: 200, path: (f) => agents(f) },
  [`GET ${A}/compute`]: {
    need: "viewer",
    key: "allowed",
    ok: 200,
    path: (f) => `${agents(f)}/compute`,
  },
  [`POST ${A}`]: { need: "editor", key: "allowed", ok: 422, path: (f) => agents(f), body: {} },
  [`GET ${A}/by-key/:key`]: {
    need: "viewer",
    key: "allowed",
    ok: 200,
    path: (f) => `${agents(f)}/by-key/matrix`,
  },
  [`PUT ${A}/by-key/:key/apply`]: {
    need: "full",
    key: "allowed",
    ok: 422,
    path: (f) => `${agents(f)}/by-key/matrix/apply`,
    body: {},
  },
  [`GET ${A}/:agentId`]: {
    need: "viewer",
    key: "allowed",
    ok: 200,
    path: (f) => `${agents(f)}/${f.agentId}`,
  },
  [`PATCH ${A}/:agentId`]: {
    need: "full",
    key: "allowed",
    ok: 422,
    path: (f) => `${agents(f)}/${f.agentId}`,
    body: {},
  },
  [`PUT ${A}/:agentId/draft`]: {
    need: "editor",
    key: "allowed",
    ok: 422,
    path: (f) => `${agents(f)}/${f.agentId}/draft`,
    body: {},
  },
  [`GET ${A}/:agentId/versions`]: {
    need: "viewer",
    key: "allowed",
    ok: 200,
    path: (f) => `${agents(f)}/${f.agentId}/versions`,
  },
  [`GET ${A}/:agentId/versions/:version`]: {
    need: "viewer",
    key: "allowed",
    ok: 200,
    path: (f) => `${agents(f)}/${f.agentId}/versions/1`,
  },
  [`POST ${A}/:agentId/publish`]: {
    need: "editor",
    key: "allowed",
    ok: 422,
    path: (f) => `${agents(f)}/${f.agentId}/publish`,
    body: {},
  },
  [`GET ${A}/:agentId/publish-operations`]: {
    need: "viewer",
    key: "allowed",
    ok: 200,
    path: (f) => `${agents(f)}/${f.agentId}/publish-operations`,
  },
  [`GET ${A}/:agentId/movable-chats`]: {
    need: "editor",
    key: "allowed",
    ok: 200,
    path: (f) => `${agents(f)}/${f.agentId}/movable-chats?version=1`,
  },
  [`POST ${A}/:agentId/management`]: {
    need: "owner",
    key: "owner_only",
    ok: 422,
    path: (f) => `${agents(f)}/${f.agentId}/management`,
    body: {},
  },
  [`POST ${A}/:agentId/archive`]: {
    need: "full",
    key: "allowed",
    ok: 422,
    path: (f) => `${agents(f)}/${f.agentId}/archive`,
    body: {},
  },
  [`GET ${A}/:agentId/sessions`]: {
    need: "viewer",
    key: "allowed",
    ok: 200,
    path: (f) => `${agents(f)}/${f.agentId}/sessions`,
  },
  [`GET ${A}/:agentId/usage`]: {
    need: "viewer",
    key: "allowed",
    ok: 200,
    path: (f) => `${agents(f)}/${f.agentId}/usage`,
  },
  [`POST ${A}/:agentId/test-chats`]: {
    need: "editor",
    key: "allowed",
    ok: 422,
    path: (f) => `${agents(f)}/${f.agentId}/test-chats`,
    body: {},
  },
  // A tester's own test chat: Editors and up (keys by agents:manage), each
  // on their own chat; someone else's is 404 (see the test chat tests).
  [`GET ${A}/:agentId/test-chats/:sessionId`]: {
    need: "editor",
    key: "allowed",
    ok: 200,
    path: (f, caller) => testChatPath(f, caller),
  },
  [`GET ${A}/:agentId/test-chats/:sessionId/events`]: {
    need: "editor",
    key: "allowed",
    ok: 200,
    path: (f, caller) => `${testChatPath(f, caller)}/events`,
  },
  [`POST ${A}/:agentId/test-chats/:sessionId/messages`]: {
    need: "editor",
    key: "allowed",
    ok: 422,
    path: (f, caller) => `${testChatPath(f, caller)}/messages`,
    body: {},
  },
  [`POST ${A}/:agentId/test-chats/:sessionId/approvals/:approvalId`]: {
    need: "editor",
    key: "allowed",
    ok: 422,
    path: (f, caller) => `${testChatPath(f, caller)}/approvals/call-matrix`,
    body: {},
  },
  [`POST ${A}/:agentId/test-chats/:sessionId/control`]: {
    need: "editor",
    key: "allowed",
    ok: 422,
    path: (f, caller) => `${testChatPath(f, caller)}/control`,
    body: {},
  },
  // End users' stored tool logins: owners and admins among people.
  [`PUT ${CREDENTIALS}`]: { need: "full", key: "allowed", ok: 422, path: credentials, body: {} },
  [`GET ${CREDENTIALS}`]: { need: "full", key: "allowed", ok: 404, path: credentials },
  [`DELETE ${CREDENTIALS}`]: { need: "full", key: "allowed", ok: 404, path: credentials },
  // The agents a workspace can use: workspace access, never a Console role.
  [`GET ${WORKSPACE_AGENTS}`]: {
    need: "workspace",
    key: "allowed",
    ok: 200,
    path: (f) => `/v1/workspaces/${f.managedWorkspaceId}/organization-agents`,
  },
};

/**
 * What an organization key needs for a route: reads `agents:read` (and
 * `sessions:read` for an agent's chats), writes `agents:manage`, stored
 * end-user logins `tool_credentials:write` to change, and the workspace list
 * `workspace:read`.
 */
function keyNeeds(route: string): Permission[] {
  const [method, path] = route.split(" ") as [string, string];
  if (path === WORKSPACE_AGENTS) return ["workspace:read"];
  // Test chats are for whoever may test: agents:manage, reads included.
  if (path.includes("/test-chats")) return ["agents:manage"];
  // Counting the chats a publish would move is for publishing.
  if (path.endsWith("/movable-chats")) return ["agents:read", "agents:manage"];
  if (path === CREDENTIALS) {
    return method === "GET" ? ["agents:read"] : ["tool_credentials:write"];
  }
  if (method !== "GET") return ["agents:manage"];
  if (path.endsWith("/sessions") || path.endsWith("/usage")) {
    return ["agents:read", "sessions:read"];
  }
  return ["agents:read"];
}

/** Routes under Console's prefixes that are deliberately not Console routes. */
const NOT_CONSOLE = new Set<string>([]);

const RANK: Record<Exclude<CallerName, "key">, number> = {
  none: 0,
  viewer: 1,
  editor: 2,
  admin: 3,
  owner: 4,
};
const NEED_RANK: Record<Exclude<Need, "workspace">, number> = {
  any: 0,
  viewer: 1,
  editor: 2,
  full: 3,
  owner: 4,
};

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
            route.path.includes("/tool-credentials/") ||
            route.path === WORKSPACE_AGENTS,
        )
        .map((route) => `${route.method} ${route.path}`)
        .filter((key) => !NOT_CONSOLE.has(key)),
    ),
  ].sort();
}

/** Everything a Console or organization agent route could change in the organization. */
const FINGERPRINT_TABLES = [
  "agents",
  "agent_revisions",
  "agent_publish_operations",
  "agent_workspace_access",
  "organization_tool_servers",
  "end_user_tool_credentials",
  "organization_console_roles",
  "organization_console_audit_events",
  "organization_managed_workspaces",
  "workspace_memberships",
  "api_keys",
  "sessions",
] as const;

async function stateFingerprint(accountId: string): Promise<string> {
  const parts: string[] = [];
  for (const table of FINGERPRINT_TABLES) {
    // A key's last use is bookkeeping of the call itself, not a change.
    const [row] = await shared!.admin.unsafe<{ hash: string }[]>(
      `select md5(coalesce(string_agg(r, ',' order by r), '')) as hash
        from (select (to_jsonb(t) - 'last_used_at')::text as r from ${table} t
          where account_id = $1) rows`,
      [accountId],
    );
    parts.push(`${table}=${row!.hash}`);
  }
  return parts.join(" ");
}

function changedTables(before: string, after: string): string {
  const was = new Set(before.split(" "));
  return after
    .split(" ")
    .filter((part) => !was.has(part))
    .map((part) => part.split("=")[0])
    .join(", ");
}

describe("Console roles: authorization matrix", () => {
  test("every Console and organization agent route has a decided role check", () => {
    if (!fixture) return;
    expect(consoleRouteKeys()).toEqual(Object.keys(MATRIX).sort());
  });

  test("people get exactly their Console role's routes; keys keep their permissions", async () => {
    if (!fixture) return;
    const failures: string[] = [];
    const callers = [
      "owner",
      "admin",
      "none",
      "viewer",
      "editor",
      "key",
      ...(Object.keys(NARROW_KEYS) as NarrowKeyName[]),
    ] as const;
    for (const [route, spec] of Object.entries(MATRIX)) {
      const method = route.split(" ")[0]!;
      for (const caller of callers) {
        const narrow = caller in NARROW_KEYS ? (caller as NarrowKeyName) : null;
        const headers = narrow ? fixture.narrowKeys[narrow] : headersOf(caller as CallerName);
        const before = await stateFingerprint(fixture.accountId);
        const reply = await call(method, spec.path(fixture, caller), headers, spec.body);
        const code = reply.body.details?.code;
        const okStatuses: readonly number[] = typeof spec.ok === "number" ? [spec.ok] : spec.ok;
        const allowed = () => okStatuses.includes(reply.status);
        let ok: boolean;
        let expected: string;
        if (narrow || caller === "key") {
          const held: readonly Permission[] = narrow ? NARROW_KEYS[narrow] : ["agents:manage"];
          const missing = narrow
            ? keyNeeds(route).filter((permission) => !held.includes(permission))
            : [];
          if (spec.key === "people_only") {
            expected = "403 console_role_required";
            ok = reply.status === 403 && code === "console_role_required";
          } else if (missing.length > 0) {
            expected = `403 (missing ${missing.join(", ")})`;
            ok = reply.status === 403;
          } else if (spec.key === "owner_only") {
            expected = "403 agent_management_requires_owner";
            ok = reply.status === 403 && code === "agent_management_requires_owner";
          } else {
            expected = `allowed (${okStatuses.join("/")})`;
            ok = allowed();
          }
        } else if (spec.need === "workspace") {
          // Workspace members only: nobody here is one of the managed
          // workspace, and no Console level (Full included) stands in for it.
          expected = "403/404 (no workspace access)";
          ok = reply.status === 403 || reply.status === 404;
        } else if (
          spec.need === "any" ||
          (spec.need === "owner"
            ? caller === "owner"
            : RANK[caller as Exclude<CallerName, "key">] >= NEED_RANK[spec.need])
        ) {
          expected = `allowed (${okStatuses.join("/")})`;
          ok = allowed();
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
        // A refused call changes nothing.
        if (reply.status === 401 || reply.status === 403 || reply.status === 404) {
          const after = await stateFingerprint(fixture.accountId);
          if (after !== before) {
            failures.push(
              `${route} as ${caller}: refused, but changed ${changedTables(before, after)}`,
            );
          }
        }
      }
    }
    expect(failures).toEqual([]);
  }, 600_000);

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

  test("an invitation's Console role is chosen when inviting and can't change", async () => {
    if (!fixture) return;
    const { accountId, people } = fixture;
    const invited = await call(
      "POST",
      `/v1/organizations/${accountId}/invitations`,
      people.owner.headers,
      {
        email: `console-roles-${crypto.randomUUID()}@example.test`,
        role: "member",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        operationId: crypto.randomUUID(),
      },
    );
    expect(invited.status).toBe(201);
    const before = await stateFingerprint(accountId);
    // PUT member-roles names a member; an invitation id alone is refused.
    const put = await call("PUT", `${console_(fixture)}/member-roles`, people.owner.headers, {
      invitationId: invited.body.id,
      role: "viewer",
    });
    expect(put.status).toBe(422);
    expect(await stateFingerprint(accountId)).toBe(before);
  }, 120_000);

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

  test("Editors don't change or publish an agent available in team workspaces", async () => {
    if (!fixture) return;
    const { people, teamWorkspaceId } = fixture;
    const created = await call("POST", agents(fixture), people.editor.headers, {
      key: "editor-team",
      name: "Editor team",
      instructions: "One.",
    });
    expect(created.status).toBe(201);
    const agentId = created.body.agent.id as string;
    let rowVersion = created.body.agent.rowVersion as number;
    // Without team workspaces an Editor saves and publishes it.
    const draft = await call("PUT", `${agents(fixture)}/${agentId}/draft`, people.editor.headers, {
      name: "Editor team",
      instructions: "Two.",
      expectedVersion: rowVersion,
    });
    expect(draft.status).toBe(201);
    rowVersion = draft.body.agent.rowVersion;
    const published = await call(
      "POST",
      `${agents(fixture)}/${agentId}/publish`,
      people.editor.headers,
      { version: 2, expectedVersion: rowVersion },
    );
    expect(published.status).toBe(200);
    rowVersion = published.body.agent.rowVersion;

    // An admin makes it available in a team workspace.
    const shared = await call("PATCH", `${agents(fixture)}/${agentId}`, people.admin.headers, {
      workspaceIds: [teamWorkspaceId],
      expectedVersion: rowVersion,
    });
    expect(shared.status).toBe(200);
    rowVersion = shared.body.agent.rowVersion;
    const refused = (reply: { status: number; body: Record<string, any> }) => [
      reply.status,
      reply.body.details?.code,
    ];
    const inTeam = [403, "agent_in_team_workspaces"];
    expect(
      refused(
        await call("PUT", `${agents(fixture)}/${agentId}/draft`, people.editor.headers, {
          name: "Editor team",
          instructions: "Three.",
          expectedVersion: rowVersion,
        }),
      ),
    ).toEqual(inTeam);
    // Neither a rollback nor a move.
    expect(
      refused(
        await call("POST", `${agents(fixture)}/${agentId}/publish`, people.editor.headers, {
          version: 1,
          expectedVersion: rowVersion,
        }),
      ),
    ).toEqual(inTeam);
    expect(
      refused(
        await call("POST", `${agents(fixture)}/${agentId}/publish`, people.editor.headers, {
          version: 2,
          moveRunningChats: true,
          expectedVersion: rowVersion,
        }),
      ),
    ).toEqual(inTeam);
    const unchanged = await call("GET", `${agents(fixture)}/${agentId}`, people.admin.headers);
    expect(unchanged.body.agent).toMatchObject({
      publishedVersion: 2,
      latestVersion: 2,
      rowVersion,
    });

    // Owners and admins (Full) still do.
    const adminDraft = await call(
      "PUT",
      `${agents(fixture)}/${agentId}/draft`,
      people.admin.headers,
      { name: "Editor team", instructions: "Three.", expectedVersion: rowVersion },
    );
    expect(adminDraft.status).toBe(201);
    const rollback = await call(
      "POST",
      `${agents(fixture)}/${agentId}/publish`,
      people.owner.headers,
      { version: 1, expectedVersion: adminDraft.body.agent.rowVersion },
    );
    expect(rollback.status).toBe(200);
  }, 60_000);

  test("a new organization role resets the Console role", async () => {
    if (!fixture || !client) return;
    const { people, accountId } = fixture;
    const temp = await person("temp");
    const membership = await inviteAndAccept(accountId, people.owner, temp, "member", "editor");
    expect(await getConsoleMemberRole(client.db, accountId, temp.subjectId)).toBe("editor");
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

  test("an invitation and its Console role are one write, and a replay adds neither", async () => {
    if (!fixture) return;
    const { accountId, people } = fixture;
    const body = {
      email: `console-roles-${crypto.randomUUID()}@example.test`,
      role: "member",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      operationId: crypto.randomUUID(),
      consoleRole: "editor",
    };
    const first = await call(
      "POST",
      `/v1/organizations/${accountId}/invitations`,
      people.owner.headers,
      body,
    );
    expect(first.status).toBe(201);
    const replay = await call(
      "POST",
      `/v1/organizations/${accountId}/invitations`,
      people.owner.headers,
      body,
    );
    expect([replay.status, replay.body.id]).toEqual([201, first.body.id]);
    const listed = await call("GET", `${console_(fixture)}/member-roles`, people.owner.headers);
    expect(
      (listed.body.roles as { invitationId: string | null; role: string }[])
        .filter((entry) => entry.invitationId === first.body.id)
        .map((entry) => entry.role),
    ).toEqual(["editor"]);
    const audited = (await auditRows("member.console_role_changed")).filter(
      (row) => row.detail.invitationId === first.body.id,
    );
    expect(audited).toHaveLength(1);
  }, 60_000);
});

describe("Console roles: Console test chats", () => {
  const testChatUrl = (agentId: string, sessionId: string) =>
    `${agents(fixture!)}/${agentId}/test-chats/${sessionId}`;

  const startTestChat = (who: Record<string, string>, message = "hi") =>
    call("POST", `${agents(fixture!)}/${fixture!.agentId}/test-chats`, who, {
      version: 1,
      message,
    });

  async function testWorkspaceId(): Promise<string> {
    const workspaceId = await findOrgAgentTestWorkspace(client!.db, fixture!.accountId);
    if (!workspaceId) throw new Error("no Console test workspace");
    return workspaceId;
  }

  /** Every way into someone's test chat: the test chat routes and the app's session routes. */
  async function probeTestChat(who: Record<string, string>, sessionId: string) {
    const workspaceId = await testWorkspaceId();
    const appPath = `/v1/workspaces/${workspaceId}/sessions/${sessionId}`;
    const consolePath = testChatUrl(fixture!.agentId, sessionId);
    return {
      consoleRead: (await call("GET", consolePath, who)).status,
      consoleEvents: (await call("GET", `${consolePath}/events`, who)).status,
      consoleSend: (await call("POST", `${consolePath}/messages`, who, { message: "mine now" }))
        .status,
      consoleApprove: (
        await call("POST", `${consolePath}/approvals/call-probe`, who, { decision: "approve" })
      ).status,
      consoleStop: (await call("POST", `${consolePath}/control`, who, { action: "pause" })).status,
      appRead: (await call("GET", appPath, who)).status,
      appEvents: (await call("GET", `${appPath}/events`, who)).status,
      appSend: (
        await call("POST", `${appPath}/events`, who, {
          type: "user.message",
          payload: { text: "mine now" },
        })
      ).status,
    };
  }

  test("nobody becomes a member of the test workspace; each chat is started by its tester's principal", async () => {
    if (!fixture || !shared) return;
    const workspaceId = await testWorkspaceId();
    const [{ count }] = await shared.admin<{ count: number }[]>`
      select count(*)::int as count from workspace_memberships where workspace_id = ${workspaceId}`;
    expect(count).toBe(0);
    for (const name of ["owner", "admin", "editor"] as const) {
      const sessionId = fixture.testChats[name]!;
      const [row] = await shared.admin<
        {
          created_by_kind: string;
          created_by_subject_id: string;
          owner_subject_id: string | null;
        }[]
      >`
        select created_by_kind, created_by_subject_id, owner_subject_id
        from sessions where id = ${sessionId}`;
      expect([
        name,
        row?.created_by_kind,
        row?.created_by_subject_id,
        row?.owner_subject_id,
      ]).toEqual([name, "service", consoleTestChatSubjectId(fixture.people[name].subjectId), null]);
    }
    // The principal holds its own chats and nothing that administers anything.
    for (const mode of ["legacy", "explicit", undefined] as const) {
      const held = [...CONSOLE_TEST_CHAT_PERMISSIONS];
      expect(hasPermission(held, "agents:manage", mode)).toBe(false);
      expect(hasPermission(held, "workspace:admin", mode)).toBe(false);
      expect(hasPermission(held, "api_keys:manage", mode)).toBe(false);
      expect(hasPermission(held, "members:manage", mode)).toBe(false);
    }
  }, 60_000);

  test("a tester reads and continues their own test chat", async () => {
    if (!fixture) return;
    const { people, agentId, testChats } = fixture;
    const url = testChatUrl(agentId, testChats.editor!);
    const read = await call("GET", url, people.editor.headers);
    expect([read.status, read.body.sessionId, read.body.agentId]).toEqual([
      200,
      testChats.editor,
      agentId,
    ]);
    const events = await call("GET", `${url}/events`, people.editor.headers);
    expect(events.status).toBe(200);
    expect(
      (events.body.events as { type: string; payload: { text?: string } }[]).find(
        (event) => event.type === "user.message",
      )?.payload.text,
    ).toBe("hi from editor");
    const sent = await call("POST", `${url}/messages`, people.editor.headers, {
      message: "and again",
    });
    expect(sent.status).toBe(202);
  }, 60_000);

  test("nobody else reads or continues a test chat, through Console or the app", async () => {
    if (!fixture) return;
    const { accountId, people, testChats } = fixture;
    const otherEditor = await person("other-editor");
    await inviteAndAccept(accountId, people.owner, otherEditor, "member", "editor");
    const refused = {
      consoleRead: 404,
      consoleEvents: 404,
      consoleSend: 404,
      consoleApprove: 404,
      consoleStop: 404,
      appRead: 403,
      appEvents: 403,
      appSend: 403,
    };
    // Another Editor and the owner on the Editor's chat; the Editor on the owner's.
    for (const [who, sessionId] of [
      [otherEditor.headers, testChats.editor!],
      [people.owner.headers, testChats.editor!],
      [people.admin.headers, testChats.owner!],
      [people.editor.headers, testChats.owner!],
      [people.editor.headers, testChats.key!],
    ] as const) {
      const before = await stateFingerprint(accountId);
      expect(await probeTestChat(who, sessionId)).toEqual(refused);
      expect(await stateFingerprint(accountId)).toBe(before);
    }
    // A chat of another agent isn't this agent's test chat either.
    const other = await call("POST", agents(fixture), people.owner.headers, {
      key: `other-${crypto.randomUUID().slice(0, 8)}`,
      name: "Other",
      instructions: "Hi.",
    });
    expect(other.status).toBe(201);
    const elsewhere = await call(
      "GET",
      testChatUrl(other.body.agent.id, testChats.editor!),
      people.editor.headers,
    );
    expect(elsewhere.status).toBe(404);
  }, 300_000);

  test("Editors get nothing else in the test workspace: no keys, members or other chats", async () => {
    if (!fixture) return;
    const { people, accountId } = fixture;
    const bystander = await person("bystander");
    const bystanderMembership = await inviteAndAccept(accountId, people.owner, bystander, "member");
    const workspaceId = await testWorkspaceId();
    const before = await stateFingerprint(accountId);
    const minted = await call(
      "POST",
      `/v1/workspaces/${workspaceId}/api-keys`,
      people.editor.headers,
      {
        name: "probe",
        permissions: ["workspace:read"],
      },
    );
    expect(minted.status).toBe(403);
    const added = await call(
      "POST",
      `/v1/workspaces/${workspaceId}/members`,
      people.editor.headers,
      {
        organizationMembershipId: bystanderMembership.membershipId,
        role: "owner",
        permissions: ["workspace:admin"],
      },
    );
    expect(added.status).toBe(403);
    const plain = await call(
      "POST",
      `/v1/workspaces/${workspaceId}/sessions`,
      people.editor.headers,
      {
        initialMessage: "hi",
      },
    );
    expect(plain.status).toBe(403);
    const listed = await call(
      "GET",
      `/v1/workspaces/${workspaceId}/sessions`,
      people.editor.headers,
    );
    expect(listed.status).toBe(403);
    expect(await stateFingerprint(accountId)).toBe(before);
  }, 120_000);

  test("a demoted admin and a demoted Editor lose test chats at once", async () => {
    if (!fixture) return;
    const { accountId, people } = fixture;
    const exAdmin = await person("ex-admin");
    const adminMembership = await inviteAndAccept(accountId, people.owner, exAdmin, "admin");
    const exEditor = await person("ex-editor");
    await inviteAndAccept(accountId, people.owner, exEditor, "member", "editor");
    const chats = new Map<Person, string>();
    for (const who of [exAdmin, exEditor]) {
      const started = await startTestChat(who.headers);
      expect(started.status).toBe(201);
      chats.set(who, started.body.sessionId as string);
      const own = await call(
        "GET",
        testChatUrl(fixture.agentId, started.body.sessionId),
        who.headers,
      );
      expect(own.status).toBe(200);
    }

    const demoted = await call(
      "PATCH",
      `/v1/organizations/${accountId}/members/${adminMembership.membershipId}`,
      people.owner.headers,
      {
        kind: "change_role",
        role: "member",
        expectedAuthorizationRevision: adminMembership.authorizationRevision,
        operationId: crypto.randomUUID(),
      },
    );
    expect(demoted.status).toBe(200);
    const lowered = await call("PUT", `${console_(fixture)}/member-roles`, people.owner.headers, {
      subjectId: exEditor.subjectId,
      role: "viewer",
    });
    expect(lowered.status).toBe(200);

    for (const who of [exAdmin, exEditor]) {
      const sessionId = chats.get(who)!;
      const before = await stateFingerprint(accountId);
      const again = await startTestChat(who.headers);
      expect([again.status, again.body.details?.code]).toEqual([403, "console_role_required"]);
      expect(await probeTestChat(who.headers, sessionId)).toEqual({
        consoleRead: 403,
        consoleEvents: 403,
        consoleSend: 403,
        consoleApprove: 403,
        consoleStop: 403,
        appRead: 403,
        appEvents: 403,
        appSend: 403,
      });
      expect(await stateFingerprint(accountId)).toBe(before);
    }
  }, 300_000);

  test("a tester answers an approval in their own test chat, and stops and resumes it", async () => {
    if (!fixture) return;
    const { people, agentId } = fixture;
    const started = await startTestChat(people.editor.headers, "Refund invoice 1042");
    expect(started.status).toBe(201);
    const sessionId = started.body.sessionId as string;
    const url = testChatUrl(agentId, sessionId);
    // The turn waits on an "Ask first" tool call, as the worker leaves it.
    const workspaceId = await testWorkspaceId();
    const attemptId = crypto.randomUUID();
    const claimed = await claimSessionWorkForAttempt(client!.db, workspaceId, {
      sessionId,
      workflowId: `session-${sessionId}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
      agentInstructionsProtocol: 1,
      orgAgentProtocol: 1,
    });
    if (claimed.action !== "claimed") throw new Error(`turn not claimed: ${claimed.reason}`);
    await applySessionTurnSettlement(client!.db, workspaceId, {
      sessionId,
      turnId: claimed.turn.id,
      triggerEventId: claimed.turn.triggerEventId,
      attemptId,
      turnStatus: "requires_action",
      sessionStatus: "requires_action",
      activeTurnId: claimed.turn.id,
      runState: {
        serializedRunState: OPEN_SUFFIX_RUN_STATE_BLOB,
        pendingApprovals: [{ id: "call-refund" }],
        humanInputRequests: [],
      },
      events: [{ type: "session.status.changed", payload: { status: "requires_action" } }],
    });
    // Nobody else answers or stops it.
    const before = await stateFingerprint(fixture.accountId);
    expect(
      (
        await call("POST", `${url}/approvals/call-refund`, people.owner.headers, {
          decision: "approve",
        })
      ).status,
    ).toBe(404);
    expect(
      (await call("POST", `${url}/control`, people.owner.headers, { action: "pause" })).status,
    ).toBe(404);
    expect(await stateFingerprint(fixture.accountId)).toBe(before);

    const unknown = await call("POST", `${url}/approvals/call-other`, people.editor.headers, {
      decision: "approve",
    });
    expect(unknown.status).toBe(409);
    const approved = await call("POST", `${url}/approvals/call-refund`, people.editor.headers, {
      decision: "approve",
      clientEventId: "approve-refund",
    });
    expect([approved.status, approved.body.type, approved.body.payload?.approvalId]).toEqual([
      202,
      "user.approvalDecision",
      "call-refund",
    ]);
    // The same decision again is the same answer.
    const replayed = await call("POST", `${url}/approvals/call-refund`, people.editor.headers, {
      decision: "approve",
      clientEventId: "approve-refund",
    });
    expect([replayed.status, replayed.body.id]).toEqual([202, approved.body.id]);
    const events = await call("GET", `${url}/events`, people.editor.headers);
    expect(
      (events.body.events as { type: string }[]).filter(
        (event) => event.type === "user.approvalDecision",
      ),
    ).toHaveLength(1);

    const stopped = await call("POST", `${url}/control`, people.editor.headers, {
      action: "pause",
    });
    expect([stopped.status, stopped.body.paused]).toEqual([200, true]);
    expect((await call("GET", url, people.editor.headers)).body.paused).toBe(true);
    const resumed = await call("POST", `${url}/control`, people.editor.headers, {
      action: "resume",
    });
    expect([resumed.status, resumed.body.paused]).toEqual([200, false]);
    expect((await call("GET", url, people.editor.headers)).body.paused).toBe(false);
  }, 120_000);

  test("starting a test chat again with the same key returns the same chat", async () => {
    if (!fixture) return;
    const { people, agentId } = fixture;
    const idempotencyKey = crypto.randomUUID();
    const start = (who: Record<string, string>, message = "Twice?") =>
      call("POST", `${agents(fixture!)}/${agentId}/test-chats`, who, {
        version: 1,
        message,
        idempotencyKey,
      });
    const first = await start(people.editor.headers);
    expect(first.status).toBe(201);
    const again = await start(people.editor.headers);
    expect([again.status, again.body.sessionId]).toEqual([200, first.body.sessionId]);
    // Another tester's key is their own: a new chat of theirs, never this one.
    const other = await start(people.owner.headers);
    expect(other.status).toBe(201);
    expect(other.body.sessionId).not.toBe(first.body.sessionId);
    // The key names one start: the same key never starts a second chat.
    const changed = await start(people.editor.headers, "Something else");
    expect([changed.status, changed.body.sessionId]).toEqual([200, first.body.sessionId]);
  }, 120_000);

  /** A live agent attempt on a test chat, as the worker runs it: its token and its tools. */
  async function testChatAgent(sessionId: string) {
    const workspaceId = await testWorkspaceId();
    const [row] = await shared!.admin<{ permissions: Permission[] }[]>`
      select first_party_mcp_permissions as permissions from sessions where id = ${sessionId}`;
    const permissions = row!.permissions;
    const attemptId = crypto.randomUUID();
    const claimed = await claimSessionWorkForAttempt(client!.db, workspaceId, {
      sessionId,
      workflowId: `session-${sessionId}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
      // As the worker build that runs organization agents declares.
      agentInstructionsProtocol: 1,
      orgAgentProtocol: 1,
    });
    if (claimed.action !== "claimed") throw new Error(`turn not claimed: ${claimed.reason}`);
    const tools = ["session_get", "session_events", "sessions_list", "session_queue_message"];
    const claims = {
      sessionId,
      turnId: claimed.turn.id,
      attemptId,
      executionGeneration: claimed.turn.executionGeneration,
      firstPartyMcpTools: tools,
    };
    const grant: AccessGrant = {
      accountId: fixture!.accountId,
      workspaceId,
      subjectId: `worker:${sessionId}`,
      permissions,
      principalKind: "agent_attempt",
      metadata: claims,
    };
    const bearer = `Bearer ${await signDelegatedAccessToken(settings!.delegationSecret!, {
      accountId: fixture!.accountId,
      workspaceId,
      subjectId: `worker:${sessionId}`,
      permissions,
      principalKind: "agent_attempt",
      ...claims,
      exp: Math.floor(Date.now() / 1000) + 3_600,
    } as Parameters<typeof signDelegatedAccessToken>[1])}`;
    const server = await buildOpenGeniMcpServer(routeDeps!, grant, {
      workspaceMemoryEnabled: false,
    });
    const tool = async (name: string, args: Record<string, unknown>) => {
      const handler = (
        server as unknown as {
          _registeredTools?: Record<
            string,
            { handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown> }
          >;
        }
      )._registeredTools?.[name]?.handler;
      if (!handler) throw new Error(`tool not registered: ${name}`);
      try {
        const result = (await handler(args, {})) as {
          isError?: boolean;
          content?: { text?: string }[];
        };
        return { ok: result.isError !== true, text: result.content?.[0]?.text ?? "" };
      } catch (error) {
        return { ok: false, text: String(error) };
      }
    };
    return { workspaceId, permissions, bearer, tool };
  }

  test("test chats reach only their own tree, so one tester's agent never reaches another's", async () => {
    if (!fixture || !shared) return;
    const { testChats } = fixture;
    for (const name of ["owner", "admin", "editor", "key"] as const) {
      const [row] = await shared.admin<{ agent_access: string; memory_scope: string }[]>`
        select agent_access, memory_scope from sessions where id = ${testChats[name]!}`;
      expect([name, row?.agent_access, row?.memory_scope]).toEqual([name, "session", "off"]);
    }
    // The admin's test chat's agent goes after the Editor's test chat.
    const mine = testChats.admin!;
    const theirs = testChats.editor!;
    const agent = await testChatAgent(mine);
    // It holds no more than the test chat principal does.
    expect([...agent.permissions].sort()).toEqual([...CONSOLE_TEST_CHAT_PERMISSIONS].sort());
    const eventsOf = async (sessionId: string) =>
      (
        await shared!.admin<{ count: number }[]>`
          select count(*)::int as count from session_events where session_id = ${sessionId}`
      )[0]!.count;
    const before = {
      events: await eventsOf(theirs),
      state: await stateFingerprint(fixture.accountId),
    };
    const viaApp = (method: string, suffix: string, body?: unknown) =>
      call(
        method,
        `/v1/workspaces/${agent.workspaceId}/sessions${suffix}`,
        { authorization: agent.bearer },
        body,
      );
    // Its own chat works; the other tester's chat is not there, through HTTP...
    expect((await viaApp("GET", `/${mine}`)).status).toBe(200);
    expect((await viaApp("GET", `/${theirs}`)).status).toBe(404);
    expect((await viaApp("GET", `/${theirs}/events`)).status).toBe(404);
    expect(
      (
        await viaApp("POST", `/${theirs}/events`, {
          type: "user.message",
          payload: { text: "from another tester's agent" },
        })
      ).status,
    ).toBe(404);
    const listed = await viaApp("GET", "");
    expect(listed.status).toBe(200);
    expect((listed.body as unknown as { id: string }[]).map((row) => row.id)).not.toContain(theirs);
    // ...and through its session tools.
    expect((await agent.tool("session_get", { sessionId: mine })).ok).toBe(true);
    for (const [name, args] of [
      ["session_get", { sessionId: theirs }],
      ["session_events", { sessionId: theirs }],
      [
        "session_queue_message",
        {
          sessionId: theirs,
          text: "from another tester's agent",
          idempotencyKey: crypto.randomUUID(),
        },
      ],
    ] as const) {
      expect([name, (await agent.tool(name, args)).ok]).toEqual([name, false]);
    }
    const page = await agent.tool("sessions_list", { limit: 100 });
    expect(page.ok).toBe(true);
    expect(page.text).not.toContain(theirs);
    expect({
      events: await eventsOf(theirs),
      state: await stateFingerprint(fixture.accountId),
    }).toEqual(before);
  }, 120_000);

  test("nobody can name a test chat principal as a service initiator to plant a test chat", async () => {
    if (!fixture) return;
    const workspaceId = await testWorkspaceId();
    const before = await stateFingerprint(fixture.accountId);
    const planted = await call(
      "POST",
      `/v1/workspaces/${workspaceId}/sessions`,
      {
        ...fixture.key,
        // Any name under the prefix (a real tester's, when short enough).
        "x-opengeni-service-initiator": consoleTestChatSubjectId("user:planted"),
      },
      { initialMessage: "hi", agent: { ref: fixture.agentId, version: 1 } },
    );
    expect(planted.status).toBe(422);
    expect(planted.body.message).toContain("reserved console-test: prefix");
    expect(await stateFingerprint(fixture.accountId)).toBe(before);
  }, 60_000);

  test("an offboarded Editor loses test chats", async () => {
    if (!fixture) return;
    const { accountId, people } = fixture;
    const leaving = await person("leaving");
    const membership = await inviteAndAccept(accountId, people.owner, leaving, "member", "editor");
    const started = await startTestChat(leaving.headers);
    expect(started.status).toBe(201);
    const offboarded = await call(
      "PATCH",
      `/v1/organizations/${accountId}/members/${membership.membershipId}`,
      people.owner.headers,
      {
        kind: "offboard",
        expectedAuthorizationRevision: membership.authorizationRevision,
        operationId: crypto.randomUUID(),
      },
    );
    expect(offboarded.status).toBe(200);
    expect(await getConsoleMemberRole(client!.db, accountId, leaving.subjectId)).toBe("none");
    const url = testChatUrl(fixture.agentId, started.body.sessionId);
    for (const reply of [
      await call("GET", url, leaving.headers),
      await call("POST", `${url}/messages`, leaving.headers, { message: "still here?" }),
      await startTestChat(leaving.headers),
    ]) {
      expect([401, 403]).toContain(reply.status);
    }
  }, 120_000);
});
