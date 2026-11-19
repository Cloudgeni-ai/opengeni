// Console agents API routes (src/routes/organization-agents.ts) against a real
// database: who may call each route (organization owners, organization keys
// with and without the new permissions), the per-organization flag, secrets
// never in responses, and the Console audit rows the writes leave.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Settings } from "@opengeni/config";
import type { AccessContext, Permission } from "@opengeni/contracts";
import type { ApiRouteDeps, SessionWorkflowClient } from "@opengeni/core";
import {
  createApiKey,
  createDb,
  createWorkspace,
  ensureManagedAccessForUserWithOrganizationMemberships,
  type DbClient,
} from "@opengeni/db";
import { synchronizeCanonicalHumanLoginBindings } from "@opengeni/db/canonical-human-identities";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { sha256Hex } from "@opengeni/contracts/values";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { ApiHttpError } from "../src/http/api-error";
import {
  organizationApiKeyPermissions,
  organizationReadApiKeyPermissions,
} from "../src/routes/api-keys";
import { registerOrganizationAgentRoutes } from "../src/routes/organization-agents";
import { registerSessionRoutes } from "../src/routes/sessions";
import { registerWorkspaceRoutes } from "../src/routes/workspaces";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const delegationSecret = `organization-agents-${crypto.randomUUID()}`;

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
let app: Hono | null = null;
let settings: Settings | null = null;
/** The routes' dependencies, to swap the publish move starter per test. */
let routeDeps: { orgAgentPublishMoveStarter?: ApiRouteDeps["orgAgentPublishMoveStarter"] } | null =
  null;

type Fixture = {
  userId: string;
  accountId: string;
  cookie: Record<string, string>;
  managedWorkspaceId: string;
  teamWorkspaceId: string;
  keys: Record<
    | "full"
    | "read"
    | "agentsRead"
    | "agentsManage"
    | "agentsManageLimited"
    | "credentials"
    | "sessionsOnly",
    Record<string, string>
  >;
};
let fixture: Fixture | null = null;
const authSessionByCookie = new Map<
  string,
  { authSessionId: string; userId: string; email: string }
>();

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api-organization-agents");
  if (!shared && requireRealDatabase) {
    throw new Error(
      "[api-organization-agents] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
    );
  }
  if (!shared) return;
  client = createDb(shared.appUrl);
  app = buildApp();
  fixture = await provisionFixture();
  settings!.orgAgentsAccountIds = [fixture.accountId];
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
  settings = testSettings({
    productAccessMode: "managed",
    delegationSecret,
    sandboxBackend: "none",
    environmentsEncryptionKey: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
      "base64",
    ),
  });
  const hono = new Hono();
  // The partial app renders errors the way the API's onError does: the
  // public envelope with `details.code`.
  hono.onError((error, c) => {
    if (error instanceof ApiHttpError) {
      return c.json(
        { code: error.code, message: error.message, details: error.details ?? {} },
        error.status,
      );
    }
    if (error instanceof HTTPException) {
      const details = (error as { details?: unknown }).details ?? {};
      return c.json({ code: "forbidden", message: error.message, details }, error.status);
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
  registerOrganizationAgentRoutes(hono, deps);
  routeDeps = deps;
  return hono;
}

async function provisionFixture(): Promise<Fixture> {
  if (!client || !shared || !app) throw new Error("test database unavailable");
  const userId = `org-agents-owner-${crypto.randomUUID()}`;
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
  const accessResponse = await app.request("http://x/v1/access/me", { headers: { cookie } });
  if (accessResponse.status !== 200)
    throw new Error(`managed provisioning failed: ${accessResponse.status}`);
  const access = (await accessResponse.json()) as AccessContext;
  const accountId = access.defaultAccountId!;

  const managed = await createWorkspace(client.db, { accountId, name: "Managed tenant" });
  const team = await createWorkspace(client.db, { accountId, name: "Team" });
  await shared.admin`insert into organization_managed_workspaces (account_id, workspace_id, source)
    values (${accountId}, ${managed.id}, 'console')`;

  const key = async (
    name: string,
    permissions: Permission[],
    explicit: Permission[] | null,
    onlyWorkspaces: string[] | null = null,
  ) => {
    const token = `ogk_${crypto.randomUUID().replaceAll("-", "")}`;
    const created = await createApiKey(client!.db, {
      accountId,
      workspaceId: null,
      name,
      prefix: token.slice(0, 14),
      keyHash: await sha256Hex(token),
      permissions,
      credentialKind: "organization",
    });
    if (explicit) {
      await shared!.admin`update api_keys set permission_mode = 'explicit',
        permissions = ${JSON.stringify(explicit)}::jsonb where id = ${created.id}`;
    }
    if (onlyWorkspaces) {
      await shared!
        .admin`update api_keys set workspace_scope = 'selected' where id = ${created.id}`;
      for (const workspaceId of onlyWorkspaces) {
        await shared!
          .admin`insert into organization_api_key_workspaces (api_key_id, workspace_id, account_id)
          values (${created.id}, ${workspaceId}, ${accountId})`;
      }
    }
    return { authorization: `Bearer ${token}` };
  };
  return {
    userId,
    accountId,
    cookie: { cookie },
    managedWorkspaceId: managed.id,
    teamWorkspaceId: team.id,
    keys: {
      full: await key("Full", organizationApiKeyPermissions, null),
      read: await key("Read", organizationReadApiKeyPermissions, null),
      agentsRead: await key("Agents read", [], ["account:read", "agents:read", "workspace:read"]),
      agentsManage: await key(
        "Agents manage",
        [],
        ["account:read", "agents:read", "agents:manage"],
      ),
      agentsManageLimited: await key(
        "Agents manage, one workspace",
        [],
        ["account:read", "agents:read", "agents:manage"],
        [managed.id],
      ),
      credentials: await key("Logins", [], ["account:read", "tool_credentials:write"]),
      sessionsOnly: await key("Sessions", [], ["account:read", "agents:read", "sessions:read"]),
    },
  };
}

type Reply = { status: number; body: Record<string, any> };

async function call(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<Reply> {
  if (!app) throw new Error("app unavailable");
  const response = await app.request(`http://x${path}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
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

const org = () => `/v1/organizations/${fixture!.accountId}/agents`;

async function auditRows(action: string) {
  return await shared!.admin<
    { actor_subject_id: string; actor_label: string | null; detail: unknown }[]
  >`
    select actor_subject_id, actor_label, detail from organization_console_audit_events
    where account_id = ${fixture!.accountId} and action = ${action} order by created_at`;
}

describe("Console agents routes", () => {
  test("the per-organization flag hides every route", async () => {
    if (!fixture) return;
    settings!.orgAgentsAccountIds = [];
    try {
      for (const [method, path] of [
        ["GET", org()],
        ["GET", `${org()}/tool-servers`],
        ["POST", `${org()}/test-workspace`],
        ["PUT", `${org()}/by-key/x/apply`],
        ["GET", `/v1/workspaces/${fixture.managedWorkspaceId}/end-users/u1/tool-credentials/crm`],
      ] as const) {
        const reply = await call(
          method,
          path,
          fixture.keys.full,
          method === "PUT" ? { name: "X" } : undefined,
        );
        expect([path, reply.status, reply.body.details?.code]).toEqual([
          path,
          404,
          "agent_not_found",
        ]);
      }
      const workspaceList = await call(
        "GET",
        `/v1/workspaces/${fixture.managedWorkspaceId}/organization-agents`,
        fixture.keys.full,
      );
      expect(workspaceList).toEqual({ status: 200, body: { agents: [] } });
    } finally {
      settings!.orgAgentsAccountIds = [fixture.accountId];
    }
  }, 60_000);

  test("permissions: full keys and owners manage, read keys need agents:read, others are refused", async () => {
    if (!fixture) return;
    const { keys, cookie } = fixture;
    expect((await call("GET", org(), keys.full)).status).toBe(200);
    expect((await call("GET", org(), cookie)).status).toBe(200);
    expect((await call("GET", org(), keys.agentsRead)).status).toBe(200);
    // The legacy read preset has no agents:read.
    const read = await call("GET", org(), keys.read);
    expect([read.status, read.body.details]).toEqual([
      403,
      { code: "missing_permission", permission: "agents:read" },
    ]);
    const credentialsOnly = await call("GET", org(), keys.credentials);
    expect(credentialsOnly.status).toBe(403);

    const create = (headers: Record<string, string>, key: string) =>
      call("POST", org(), headers, { key, name: "Support", instructions: "Be kind." });
    const refused = await create(keys.agentsRead, "nope");
    expect([refused.status, refused.body.details]).toEqual([
      403,
      { code: "missing_permission", permission: "agents:manage" },
    ]);
    const byKey = await create(keys.agentsManage, "by-key");
    expect(byKey.status).toBe(201);
    const byOwner = await create(cookie, "by-owner");
    expect(byOwner.status).toBe(201);
    expect(byOwner.body.agent).toMatchObject({
      key: "by-owner",
      managedBy: "console",
      publishedVersion: null,
    });
    const duplicate = await create(keys.full, "by-owner");
    expect([duplicate.status, duplicate.body.details?.code]).toEqual([409, "agent_key_taken"]);

    // Another organization's id is refused for a key of this one.
    const other = await call("GET", `/v1/organizations/${crypto.randomUUID()}/agents`, keys.full);
    expect(other.status).toBe(404);

    // Chats and usage also need sessions:read.
    const agentId = byOwner.body.agent.id as string;
    const sessions = await call("GET", `${org()}/${agentId}/sessions`, keys.agentsRead);
    expect([sessions.status, sessions.body.details?.permission]).toEqual([403, "sessions:read"]);
    const usage = await call("GET", `${org()}/${agentId}/usage`, keys.sessionsOnly);
    expect(usage.status).toBe(200);
    expect(usage.body).toMatchObject({ sessions: 0, costMicros: 0, byVersion: [] });

    // Audit rows name the actor: the person, or the key.
    const created = await auditRows("agent.created");
    expect(created.length).toBe(2);
    expect(created[0]!.actor_subject_id).toMatch(/^api_key:/);
    expect(created[1]!.actor_subject_id).toBe(`user:${fixture.userId}`);
  }, 120_000);

  test("Runs on choices: the organization's machines and environments, with agents:read", async () => {
    if (!fixture) return;
    const listed = await call("GET", `${org()}/compute`, fixture.keys.agentsRead);
    expect(listed).toEqual({ status: 200, body: { machines: [], environments: [] } });
    const refused = await call("GET", `${org()}/compute`, fixture.keys.read);
    expect([refused.status, refused.body.details?.permission]).toEqual([403, "agents:read"]);
    // Not an agent id.
    expect((await call("GET", `${org()}/compute`, fixture.cookie)).status).toBe(200);
    // A Runs on that names no organization machine is refused on save.
    const missing = await call("POST", org(), fixture.keys.full, {
      key: "on-missing-box",
      name: "On a missing box",
      config: { runsOn: { kind: "machine", machine: "Missing box" } },
    });
    expect([missing.status, missing.body.details?.code]).toEqual([422, "machine_not_found"]);
  }, 60_000);

  test("versions, publish and the owner-only management switch", async () => {
    if (!fixture) return;
    const { keys, cookie } = fixture;
    const created = await call("POST", org(), keys.full, {
      key: "flow",
      name: "Flow",
      instructions: "One.",
    });
    const agentId = created.body.agent.id as string;
    let rowVersion = created.body.agent.rowVersion as number;

    const draft = await call("PUT", `${org()}/${agentId}/draft`, keys.full, {
      name: "Flow",
      instructions: "Two.",
      expectedVersion: rowVersion,
    });
    expect([draft.status, draft.body.created, draft.body.version.version]).toEqual([201, true, 2]);
    rowVersion = draft.body.agent.rowVersion;
    const stale = await call("PUT", `${org()}/${agentId}/draft`, keys.full, {
      name: "Flow",
      instructions: "Three.",
      expectedVersion: 1,
    });
    expect([stale.status, stale.body.details]).toEqual([
      409,
      { code: "agent_version_conflict", currentVersion: rowVersion },
    ]);

    const publish = await call("POST", `${org()}/${agentId}/publish`, keys.full, {
      version: 2,
      expectedVersion: rowVersion,
    });
    expect(publish.status).toBe(200);
    expect(publish.body.operation).toMatchObject({ toVersion: 2, status: "succeeded" });
    rowVersion = publish.body.agent.rowVersion;
    const versions = await call("GET", `${org()}/${agentId}/versions`, keys.agentsRead);
    expect(versions.body.versions.map((version: { version: number }) => version.version)).toEqual([
      2, 1,
    ]);
    const one = await call("GET", `${org()}/${agentId}/versions/1`, keys.agentsRead);
    expect(one.body.version.instructions).toBe("One.");
    expect((await call("GET", `${org()}/${agentId}/versions/9`, keys.agentsRead)).status).toBe(404);
    const movable = await call(
      "GET",
      `${org()}/${agentId}/movable-chats?version=1`,
      keys.agentsRead,
    );
    expect(movable).toEqual({ status: 200, body: { count: 0 } });
    const operations = await call("GET", `${org()}/${agentId}/publish-operations`, keys.agentsRead);
    expect(operations.body.operations.length).toBe(1);

    // Keys never switch management, even full ones; the owner can.
    const byKey = await call("POST", `${org()}/${agentId}/management`, keys.full, {
      managedBy: "code",
      expectedVersion: rowVersion,
    });
    expect([byKey.status, byKey.body.details?.code]).toEqual([
      403,
      "agent_management_requires_owner",
    ]);
    const byOwner = await call("POST", `${org()}/${agentId}/management`, cookie, {
      managedBy: "code",
      expectedVersion: rowVersion,
    });
    expect([byOwner.status, byOwner.body.agent.managedBy]).toEqual([200, "code"]);
    rowVersion = byOwner.body.agent.rowVersion;
    // Now Console edits are refused and deploys go through.
    const consoleEdit = await call("PUT", `${org()}/${agentId}/draft`, keys.full, {
      name: "Flow",
      instructions: "Edited",
      expectedVersion: rowVersion,
    });
    expect([consoleEdit.status, consoleEdit.body.details?.code]).toEqual([
      409,
      "agent_managed_by_code",
    ]);
    const deploy = await call("PUT", `${org()}/by-key/flow/apply`, keys.agentsManage, {
      name: "Flow",
      instructions: "Deployed.",
      publish: true,
    });
    expect(deploy.body).toMatchObject({ outcome: "updated", version: 3, published: true });
    const management = await auditRows("agent.management_changed");
    expect(management.length).toBe(1);
    expect(management[0]!.detail).toMatchObject({ from: "console", to: "code" });

    const archived = await call("POST", `${org()}/${agentId}/archive`, keys.full, {
      expectedVersion: deploy.body.agent.rowVersion,
    });
    expect(archived.status).toBe(200);
    expect((await call("GET", `${org()}/${agentId}`, keys.full)).status).toBe(404);
    expect((await call("GET", `${org()}/by-key/flow?includeArchived=true`, keys.full)).status).toBe(
      200,
    );
  }, 120_000);

  test("apply by key: dry run, create, unchanged, and a Console agent is refused", async () => {
    if (!fixture) return;
    const { keys } = fixture;
    const definition = { name: "Deployed", instructions: "Hello." };
    const dry = await call("PUT", `${org()}/by-key/deployed/apply`, keys.full, {
      ...definition,
      dryRun: true,
    });
    expect(dry.body).toMatchObject({ outcome: "created", dryRun: true, agent: null });
    expect((await call("GET", `${org()}/by-key/deployed`, keys.full)).status).toBe(404);
    const created = await call("PUT", `${org()}/by-key/deployed/apply`, keys.full, {
      ...definition,
      publish: true,
    });
    expect(created.body).toMatchObject({ outcome: "created", version: 1, published: true });
    expect(created.body.configHash).toBe(dry.body.configHash);
    const again = await call("PUT", `${org()}/by-key/deployed/apply`, keys.full, {
      ...definition,
      publish: true,
    });
    expect(again.body).toMatchObject({ outcome: "unchanged", version: 1 });
    const unknownServer = await call("PUT", `${org()}/by-key/deployed/apply`, keys.full, {
      ...definition,
      config: { toolServers: [{ server: "missing" }] },
    });
    expect([unknownServer.status, unknownServer.body.details]).toEqual([
      422,
      { code: "tool_server_not_found", missing: ["missing"] },
    ]);
    await call("POST", org(), keys.full, { key: "console-made", name: "Console made" });
    const inConsole = await call(
      "PUT",
      `${org()}/by-key/console-made/apply`,
      keys.full,
      definition,
    );
    expect([inConsole.status, inConsole.body.details?.code]).toEqual([
      409,
      "agent_managed_in_console",
    ]);
    const invalid = await call("PUT", `${org()}/by-key/Not_A_Key!/apply`, keys.full, definition);
    expect(invalid.status).toBe(404);
  }, 120_000);

  test("tool servers keep secrets write-only; end users' logins are metadata only", async () => {
    if (!fixture) return;
    const { keys } = fixture;
    const created = await call("POST", `${org()}/tool-servers`, keys.full, {
      key: "crm",
      name: "CRM",
      // Nothing listens here: the live tool list must answer with an error, not fail.
      url: "https://127.0.0.1:9/mcp",
      authMode: "shared_key",
      sharedHeaders: { Authorization: "Bearer route-shared-secret" },
    });
    expect(created.status).toBe(201);
    expect(created.body.toolServer).toMatchObject({
      hasSharedKey: true,
      sharedHeaderNames: ["Authorization"],
    });
    const listed = await call("GET", `${org()}/tool-servers`, keys.agentsRead);
    const one = await call("GET", `${org()}/tool-servers/crm`, keys.agentsRead);
    for (const reply of [created, listed, one]) {
      expect(JSON.stringify(reply.body)).not.toContain("route-shared-secret");
    }
    const tools = await call("GET", `${org()}/tool-servers/crm/tools`, keys.agentsRead);
    expect(tools.status).toBe(200);
    expect(tools.body.tools).toEqual([]);
    expect(typeof tools.body.error).toBe("string");
    expect(JSON.stringify(tools.body)).not.toContain("route-shared-secret");
    const readKeyWrite = await call("PATCH", `${org()}/tool-servers/crm`, keys.agentsRead, {
      expectedVersion: 1,
      name: "X",
    });
    expect(readKeyWrite.status).toBe(403);
    const perUser = await call("PATCH", `${org()}/tool-servers/crm`, keys.full, {
      expectedVersion: created.body.toolServer.rowVersion,
      authMode: "per_user",
    });
    expect(perUser.body.toolServer).toMatchObject({ authMode: "per_user", hasSharedKey: false });

    const credentialPath = (workspaceId: string, user = "customer-42") =>
      `/v1/workspaces/${workspaceId}/end-users/${user}/tool-credentials/crm`;
    const login = { kind: "headers", headers: { Authorization: "Bearer end-user-route-secret" } };
    // Needs tool_credentials:write.
    const refused = await call(
      "PUT",
      credentialPath(fixture.managedWorkspaceId),
      keys.agentsManage,
      login,
    );
    expect([refused.status, refused.body.details?.permission]).toEqual([
      403,
      "tool_credentials:write",
    ]);
    // Only in managed workspaces.
    const unmanaged = await call(
      "PUT",
      credentialPath(fixture.teamWorkspaceId),
      keys.credentials,
      login,
    );
    expect([unmanaged.status, unmanaged.body.details?.code]).toEqual([
      409,
      "workspace_not_managed",
    ]);
    const stored = await call(
      "PUT",
      credentialPath(fixture.managedWorkspaceId),
      keys.credentials,
      login,
    );
    expect(stored.status).toBe(200);
    expect(stored.body.credential).toMatchObject({ toolServerKey: "crm", kind: "headers" });
    const read = await call("GET", credentialPath(fixture.managedWorkspaceId), keys.agentsRead);
    expect(read.status).toBe(200);
    for (const reply of [stored, read]) {
      expect(JSON.stringify(reply.body)).not.toContain("end-user-route-secret");
    }
    // Unknown end users are not created by reads.
    const unknownUser = await call(
      "GET",
      credentialPath(fixture.managedWorkspaceId, "nobody"),
      keys.agentsRead,
    );
    expect(unknownUser.status).toBe(404);
    // A workspace of no organization the caller belongs to is simply not found.
    const foreign = await call("GET", credentialPath(crypto.randomUUID()), keys.agentsRead);
    expect(foreign.status).toBe(404);
    const deleted = await call(
      "DELETE",
      credentialPath(fixture.managedWorkspaceId),
      keys.credentials,
    );
    expect(deleted.status).toBe(204);
    expect(
      (await call("GET", credentialPath(fixture.managedWorkspaceId), keys.agentsRead)).status,
    ).toBe(404);

    expect((await auditRows("tool_credential.written")).length).toBe(1);
    expect((await auditRows("tool_credential.deleted")).length).toBe(1);
    const written = await auditRows("tool_server.created");
    expect(JSON.stringify(written)).not.toContain("route-shared-secret");
    const [material] = await shared!.admin<{ material: string }[]>`
      select material_encrypted as material from end_user_tool_credentials
      where account_id = ${fixture.accountId}`;
    expect(material).toBeUndefined();

    expect((await call("DELETE", `${org()}/tool-servers/crm`, keys.full)).status).toBe(204);
    expect((await call("GET", `${org()}/tool-servers/crm`, keys.full)).status).toBe(404);
  }, 120_000);

  test("a key limited to some workspaces cannot write tool servers or move running chats", async () => {
    if (!fixture) return;
    const { keys } = fixture;
    const limited = keys.agentsManageLimited;
    const refused = (reply: Reply) => [reply.status, reply.body.details?.code];
    const workspaceLimited = [403, "organization_key_workspace_limited"];
    const server = { key: "limited-crm", name: "CRM", url: "https://crm.example.com/mcp" };

    expect(
      refused(
        await call("POST", `${org()}/tool-servers`, limited, { ...server, authMode: "none" }),
      ),
    ).toEqual(workspaceLimited);
    const created = await call("POST", `${org()}/tool-servers`, keys.agentsManage, {
      ...server,
      authMode: "none",
    });
    expect(created.status).toBe(201);
    expect(
      refused(
        await call("PATCH", `${org()}/tool-servers/limited-crm`, limited, {
          expectedVersion: created.body.toolServer.rowVersion,
          url: "https://elsewhere.example/mcp",
        }),
      ),
    ).toEqual(workspaceLimited);
    expect(refused(await call("DELETE", `${org()}/tool-servers/limited-crm`, limited))).toEqual(
      workspaceLimited,
    );
    // Reading stays allowed.
    expect((await call("GET", `${org()}/tool-servers/limited-crm`, limited)).status).toBe(200);

    // Agents: publishing is allowed; moving running chats is not.
    const agent = await call("POST", org(), limited, { key: "limited", name: "Limited" });
    expect(agent.status).toBe(201);
    const agentId = agent.body.agent.id as string;
    const move = await call("POST", `${org()}/${agentId}/publish`, limited, {
      version: 1,
      moveRunningChats: true,
      expectedVersion: agent.body.agent.rowVersion,
    });
    expect(refused(move)).toEqual(workspaceLimited);
    const publish = await call("POST", `${org()}/${agentId}/publish`, limited, {
      version: 1,
      moveRunningChats: false,
      expectedVersion: agent.body.agent.rowVersion,
    });
    expect(publish.status).toBe(200);
    const definition = { name: "Limited deploy", instructions: "Hi." };
    const applyMove = await call("PUT", `${org()}/by-key/limited-deploy/apply`, limited, {
      ...definition,
      publish: true,
      moveRunningChats: true,
    });
    expect(refused(applyMove)).toEqual(workspaceLimited);
    const dryRun = await call("PUT", `${org()}/by-key/limited-deploy/apply`, limited, {
      ...definition,
      publish: true,
      moveRunningChats: true,
      dryRun: true,
    });
    expect(dryRun.status).toBe(200);
    const applied = await call("PUT", `${org()}/by-key/limited-deploy/apply`, limited, {
      ...definition,
      publish: true,
    });
    expect(applied.status).toBe(201);
    // A key for all workspaces moves chats.
    const fullMove = await call("POST", `${org()}/${agentId}/publish`, keys.agentsManage, {
      version: 1,
      moveRunningChats: true,
      expectedVersion: publish.body.agent.rowVersion,
    });
    expect(fullMove.status).toBe(200);
    expect((await call("DELETE", `${org()}/tool-servers/limited-crm`, keys.full)).status).toBe(204);
  }, 120_000);

  test("a key limited to some workspaces sees and changes only those in an agent's workspaces", async () => {
    if (!fixture) return;
    const { keys, managedWorkspaceId: inside, teamWorkspaceId: outside } = fixture;
    const limited = keys.agentsManageLimited;
    const sorted = (ids: string[]) => [...ids].sort();
    const created = await call("POST", org(), keys.full, {
      key: "scoped-access",
      name: "Scoped access",
      workspaceIds: [outside],
    });
    expect(created.status).toBe(201);
    const agentId = created.body.agent.id as string;
    const published = await call("POST", `${org()}/${agentId}/publish`, limited, {
      version: 1,
      expectedVersion: created.body.agent.rowVersion,
    });
    expect(published.status).toBe(200);
    expect(published.body.agent.workspaceIds).toEqual([]);

    // Reads by the limited key hide the workspace outside its scope.
    const read = await call("GET", `${org()}/${agentId}`, limited);
    expect(read.body.agent.workspaceIds).toEqual([]);
    const byKey = await call("GET", `${org()}/by-key/scoped-access`, limited);
    expect(byKey.body.agent.workspaceIds).toEqual([]);
    const listed = await call("GET", org(), limited);
    expect(
      listed.body.agents.find((agent: Record<string, unknown>) => agent.id === agentId)
        .workspaceIds,
    ).toEqual([]);
    const draft = await call("PUT", `${org()}/${agentId}/draft`, limited, {
      name: "Scoped access",
      instructions: "Two.",
      expectedVersion: read.body.agent.rowVersion,
    });
    expect(draft.status).toBe(201);
    expect(draft.body.agent.workspaceIds).toEqual([]);

    // Adding its own workspace keeps the other one.
    const added = await call("PATCH", `${org()}/${agentId}`, limited, {
      workspaceIds: [inside],
      expectedVersion: draft.body.agent.rowVersion,
    });
    expect(added.status).toBe(200);
    expect(added.body.agent.workspaceIds).toEqual([inside]);
    let full = await call("GET", `${org()}/${agentId}`, keys.full);
    expect(sorted(full.body.agent.workspaceIds)).toEqual(sorted([inside, outside]));

    // Clearing the list removes only its own workspace.
    const cleared = await call("PATCH", `${org()}/${agentId}`, limited, {
      workspaceIds: [],
      expectedVersion: added.body.agent.rowVersion,
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body.agent.workspaceIds).toEqual([]);
    full = await call("GET", `${org()}/${agentId}`, keys.full);
    expect(full.body.agent.workspaceIds).toEqual([outside]);
    // Naming the other workspace is still refused.
    const outsideRefused = await call("PATCH", `${org()}/${agentId}`, limited, {
      workspaceIds: [outside],
      expectedVersion: full.body.agent.rowVersion,
    });
    expect(outsideRefused.status).toBe(403);

    // A key for all workspaces replaces the whole list.
    const replaced = await call("PATCH", `${org()}/${agentId}`, keys.agentsManage, {
      workspaceIds: [inside],
      expectedVersion: full.body.agent.rowVersion,
    });
    expect(replaced.status).toBe(200);
    expect(replaced.body.agent.workspaceIds).toEqual([inside]);
  }, 120_000);

  test("a publish that moves running chats fails clearly when the move cannot start", async () => {
    if (!fixture || !routeDeps) return;
    const deps = routeDeps;
    const { keys } = fixture;
    const created = await call("POST", org(), keys.full, {
      key: "mover",
      name: "Mover",
      instructions: "One.",
    });
    const agentId = created.body.agent.id as string;
    let rowVersion = created.body.agent.rowVersion as number;
    const publish = async () => {
      const reply = await call("POST", `${org()}/${agentId}/publish`, keys.full, {
        version: 1,
        moveRunningChats: true,
        expectedVersion: rowVersion,
      });
      expect(reply.status).toBe(200);
      expect(reply.body.agent.publishedVersion).toBe(1);
      rowVersion = reply.body.agent.rowVersion;
      return reply.body.operation as Record<string, unknown>;
    };

    // No move workflow in this deployment.
    expect(await publish()).toMatchObject({ status: "failed", failureReason: "move_unavailable" });
    const started: string[] = [];
    try {
      deps.orgAgentPublishMoveStarter = async () => {
        throw new Error("workflow service unavailable");
      };
      expect(await publish()).toMatchObject({
        status: "failed",
        failureReason: "move_start_failed",
      });
      deps.orgAgentPublishMoveStarter = async (input) => {
        started.push(input.operationId);
      };
      const ok = await publish();
      expect(ok).toMatchObject({ status: "pending", failureReason: null });
      expect(started).toEqual([ok.id as string]);
    } finally {
      delete deps.orgAgentPublishMoveStarter;
    }
    const operations = await call("GET", `${org()}/${agentId}/publish-operations`, keys.agentsRead);
    expect(
      operations.body.operations.map((operation: Record<string, unknown>) => [
        operation.status,
        operation.failureReason,
      ]),
    ).toEqual([
      ["pending", null],
      ["failed", "move_start_failed"],
      ["failed", "move_unavailable"],
    ]);

    // The API stopped between the publish and starting its move: listing
    // re-drives a stale pending move, and fails it when it cannot start.
    const pendingId = operations.body.operations[0].id as string;
    await shared!.admin`update agent_publish_operations
      set created_at = now() - interval '5 minutes' where id = ${pendingId}`;
    const byId = (body: { operations: Array<Record<string, unknown>> }) =>
      body.operations.find((operation) => operation.id === pendingId);
    const restarted: string[] = [];
    try {
      deps.orgAgentPublishMoveStarter = async (input) => {
        restarted.push(input.operationId);
      };
      const listed = await call("GET", `${org()}/${agentId}/publish-operations`, keys.agentsRead);
      expect(byId(listed.body)).toMatchObject({ status: "pending", failureReason: null });
      expect(restarted).toEqual([pendingId]);
    } finally {
      delete deps.orgAgentPublishMoveStarter;
    }
    const swept = await call("GET", `${org()}/${agentId}/publish-operations`, keys.agentsRead);
    expect(byId(swept.body)).toMatchObject({
      status: "failed",
      failureReason: "move_unavailable",
    });
  }, 120_000);

  test("workspaces list their published organization agents; the test workspace is created once", async () => {
    if (!fixture) return;
    const { keys, cookie } = fixture;
    const created = await call("POST", org(), keys.full, {
      key: "listed",
      name: "Listed",
      workspaceIds: [fixture.teamWorkspaceId],
    });
    const agentId = created.body.agent.id as string;
    await call("POST", `${org()}/${agentId}/publish`, keys.full, {
      version: 1,
      expectedVersion: created.body.agent.rowVersion,
    });
    for (const workspaceId of [fixture.managedWorkspaceId, fixture.teamWorkspaceId]) {
      const listed = await call(
        "GET",
        `/v1/workspaces/${workspaceId}/organization-agents`,
        keys.full,
      );
      expect(listed.status).toBe(200);
      expect(listed.body.agents.map((agent: { key: string }) => agent.key)).toContain("listed");
    }

    const first = await call("POST", `${org()}/test-workspace`, cookie);
    expect([first.status, first.body.created]).toEqual([201, true]);
    const again = await call("POST", `${org()}/test-workspace`, keys.full);
    expect([again.status, again.body]).toEqual([
      200,
      { workspaceId: first.body.workspaceId, created: false },
    ]);
    const [marker] = await shared!.admin<{ source: string }[]>`
      select source from organization_managed_workspaces where workspace_id = ${first.body.workspaceId}`;
    expect(marker!.source).toBe("console_test");
    // The test workspace lists drafts' agents too, as a managed workspace.
    const testList = await call(
      "GET",
      `/v1/workspaces/${first.body.workspaceId}/organization-agents`,
      cookie,
    );
    expect(testList.status).toBe(200);

    const missingVersion = await call("POST", `${org()}/${agentId}/test-chats`, keys.full, {
      version: 7,
      message: "hi",
    });
    expect([missingVersion.status, missingVersion.body.details?.code]).toEqual([
      404,
      "agent_version_not_found",
    ]);
  }, 120_000);
});
