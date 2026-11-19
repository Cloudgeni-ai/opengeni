// Session create with an organization (Console) agent through the HTTP API
// against a real database, as an organization API key: `agent` as a key, as
// `{ ref }`, `agentOverrides`, and the Console test chat route, which goes
// through the same session create. The route's early body check must read an
// organization agent's `agent` field as such, not as today's agent object.
// Saving an inline config and widening the agent's tool servers need
// organization-level agents:manage; workspace keys and roles never count.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Settings } from "@opengeni/config";
import type { AccessContext } from "@opengeni/contracts";
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
import { organizationApiKeyPermissions } from "../src/routes/api-keys";
import { registerOrganizationAgentRoutes } from "../src/routes/organization-agents";
import { registerSessionRoutes } from "../src/routes/sessions";
import { registerWorkspaceRoutes } from "../src/routes/workspaces";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
let app: Hono | null = null;
let settings: Settings | null = null;
let fixture: {
  userId: string;
  accountId: string;
  managedWorkspaceId: string;
  key: Record<string, string>;
  /** An organization key that may create chats but holds no agents:manage. */
  limitedKey: Record<string, string>;
  /** A workspace key with workspace:admin on the managed workspace. */
  workspaceKey: Record<string, string>;
} | null = null;
const authSessionByCookie = new Map<
  string,
  { authSessionId: string; userId: string; email: string }
>();

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api-org-agent-session-create");
  if (!shared && requireRealDatabase) {
    throw new Error(
      "[api-org-agent-session-create] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
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
    delegationSecret: `org-agent-session-create-${crypto.randomUUID()}`,
    sandboxBackend: "none",
    environmentsEncryptionKey: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
      "base64",
    ),
  });
  const hono = new Hono();
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
  return hono;
}

async function provisionFixture() {
  if (!client || !shared || !app) throw new Error("test database unavailable");
  const userId = `org-agent-chats-${crypto.randomUUID()}`;
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
  const mint = async (
    name: string,
    permissions: Parameters<typeof createApiKey>[1]["permissions"],
    workspaceId: string | null,
  ) => {
    const minted = `ogk_${crypto.randomUUID().replaceAll("-", "")}`;
    await createApiKey(client!.db, {
      accountId,
      workspaceId,
      name,
      prefix: minted.slice(0, 14),
      keyHash: await sha256Hex(minted),
      permissions,
      credentialKind: workspaceId ? "workspace" : "organization",
    });
    return { authorization: `Bearer ${minted}` };
  };
  return {
    userId,
    accountId,
    managedWorkspaceId: managed.id,
    key: { authorization: `Bearer ${token}` },
    limitedKey: await mint("Chats only", ["sessions:create", "sessions:read"], null),
    controlKey: await mint(
      "Chats control",
      ["workspace:read", "sessions:create", "sessions:read", "sessions:control"],
      null,
    ),
    workspaceKey: await mint("Workspace admin", ["workspace:admin"], managed.id),
  };
}

type Reply = { status: number; body: Record<string, any> };

async function call(
  method: string,
  path: string,
  body?: unknown,
  key?: Record<string, string>,
): Promise<Reply> {
  if (!app || !fixture) throw new Error("app unavailable");
  const response = await app.request(`http://x${path}`, {
    method,
    headers: {
      ...(key ?? fixture.key),
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

const agents = () => `/v1/organizations/${fixture!.accountId}/agents`;
const sessions = () => `/v1/workspaces/${fixture!.managedWorkspaceId}/sessions`;

async function binding(sessionId: string) {
  const [row] = await shared!.admin<
    {
      workspace_id: string;
      agent_id: string | null;
      agent_version: number | null;
      agent_prompt_version: number | null;
      agent_prompt_revision: number | null;
      agent_overrides: unknown;
      instructions: string | null;
      model: string;
    }[]
  >`select workspace_id::text, agent_id::text, agent_version, agent_prompt_version,
      agent_prompt_revision, agent_overrides, instructions, model
    from sessions where id = ${sessionId}`;
  return row!;
}

/** A published Console agent `key` (version 1). */
async function publishedAgent(key: string) {
  const created = await call("POST", agents(), {
    key,
    name: key,
    instructions: `You are ${key}.`,
    config: { model: "scripted-model" },
  });
  expect(created.status).toBe(201);
  const agentId = created.body.agent.id as string;
  const published = await call("POST", `${agents()}/${agentId}/publish`, {
    version: 1,
    expectedVersion: created.body.agent.rowVersion,
  });
  expect(published.status).toBe(200);
  return { agentId, rowVersion: published.body.agent.rowVersion as number };
}

describe("session create with an organization agent over HTTP", () => {
  test("agent as a key string runs the published version", async () => {
    if (!fixture) return;
    const { agentId } = await publishedAgent("by-key");
    const created = await call("POST", sessions(), { initialMessage: "hi", agent: "by-key" });
    expect([created.status, created.body.code]).toEqual([202, undefined]);
    expect(created.body.orgAgent).toEqual({
      id: agentId,
      key: "by-key",
      name: "by-key",
      version: 1,
      overrides: null,
    });
    expect(await binding(created.body.id)).toMatchObject({
      agent_id: agentId,
      agent_version: 1,
      agent_prompt_version: 1,
      agent_prompt_revision: null,
      agent_overrides: null,
      instructions: null,
    });
    // The agent's id names it too.
    const byId = await call("POST", sessions(), { initialMessage: "hi", agent: agentId });
    expect([byId.status, byId.body.orgAgent?.id]).toEqual([202, agentId]);
    // Listing the agent's chats at the full review level returns their content,
    // so the read is audited before it is returned.
    const listed = await call("GET", `${agents()}/${agentId}/sessions`);
    expect(listed.status).toBe(200);
    const listedIds = (listed.body.sessions as { id: string }[]).map((session) => session.id);
    expect(listedIds).toContain(created.body.id);
    const [viewed] = await shared!.admin<{ detail: { agentId: string; sessionIds: string[] } }[]>`
      select detail from organization_console_audit_events
      where account_id = ${fixture.accountId} and action = 'agent.sessions_viewed'
        and detail->>'agentId' = ${agentId}`;
    expect(viewed?.detail.sessionIds).toEqual(listedIds);
    // An unknown key is refused, never a plain chat.
    const unknown = await call("POST", sessions(), { initialMessage: "hi", agent: "missing" });
    expect([unknown.status, unknown.body.code, unknown.body.details?.code]).toEqual([
      404,
      "SESSION_CREATE_REJECTED",
      "agent_not_found",
    ]);
    // An agent with no published version yet.
    const unpublished = await call("POST", agents(), { key: "unpublished", name: "unpublished" });
    expect(unpublished.status).toBe(201);
    const refused = await call("POST", sessions(), { initialMessage: "hi", agent: "unpublished" });
    expect([refused.status, refused.body.code, refused.body.details?.code]).toEqual([
      409,
      "SESSION_CREATE_REJECTED",
      "agent_not_published",
    ]);
  }, 120_000);

  test("agent as { ref } with this chat's own instructions and settings", async () => {
    if (!fixture) return;
    const { agentId } = await publishedAgent("by-ref");
    const created = await call("POST", sessions(), {
      initialMessage: "hi",
      agent: { ref: "by-ref", instructions: "Answer in French." },
    });
    expect(created.status).toBe(202);
    const row = await binding(created.body.id);
    expect(row).toMatchObject({ agent_id: agentId, agent_version: 1, agent_prompt_version: 1 });
    // The chat's instructions are added after the agent's, as the session's own.
    expect(row.instructions).toBe("Answer in French.");
    expect(created.body.orgAgent).toMatchObject({ id: agentId, key: "by-ref", version: 1 });
    // A request field the agent fixes is a recorded override.
    const model = await call("POST", sessions(), {
      initialMessage: "hi",
      agent: { ref: "by-ref" },
      model: "gpt-5.6-luna",
    });
    expect(model.status).toBe(202);
    expect((await binding(model.body.id)).agent_overrides).toEqual({
      model: { agent: "scripted-model", chat: "gpt-5.6-luna" },
    });
    expect(model.body.orgAgent.overrides).toEqual({
      model: { agent: "scripted-model", chat: "gpt-5.6-luna" },
    });
    // Today's agent object and agentId keep their meaning beside it.
    const plain = await call("POST", sessions(), {
      initialMessage: "hi",
      agent: { capabilities: { from: "all", subagents: false } },
    });
    expect([plain.status, plain.body.orgAgent ?? null]).toEqual([202, null]);
    expect(await binding(plain.body.id)).toMatchObject({ agent_id: null, agent_version: null });
  }, 120_000);

  test("agentOverrides: reject refuses a changed setting and allows an unchanged one", async () => {
    if (!fixture) return;
    await publishedAgent("strict");
    const refused = await call("POST", sessions(), {
      initialMessage: "hi",
      agent: "strict",
      model: "gpt-5.6-luna",
      agentOverrides: "reject",
    });
    expect([refused.status, refused.body.code, refused.body.details?.code]).toEqual([
      422,
      "SESSION_CREATE_REJECTED",
      "agent_override_rejected",
    ]);
    const accepted = await call("POST", sessions(), {
      initialMessage: "hi",
      agent: { ref: "strict" },
      agentOverrides: "reject",
    });
    expect(accepted.status).toBe(202);
    expect((await binding(accepted.body.id)).agent_overrides).toBeNull();
    const allowed = await call("POST", sessions(), {
      initialMessage: "hi",
      agent: "strict",
      model: "gpt-5.6-luna",
      agentOverrides: "allow",
    });
    expect(allowed.status).toBe(202);
    expect((await binding(allowed.body.id)).agent_overrides).toEqual({
      model: { agent: "scripted-model", chat: "gpt-5.6-luna" },
    });
  }, 120_000);

  test("a Console test chat runs a draft in the test workspace", async () => {
    if (!fixture) return;
    const { agentId, rowVersion } = await publishedAgent("tested");
    const draft = await call("PUT", `${agents()}/${agentId}/draft`, {
      name: "tested",
      instructions: "Draft instructions.",
      expectedVersion: rowVersion,
    });
    expect([draft.status, draft.body.version?.version]).toEqual([201, 2]);
    const chat = await call("POST", `${agents()}/${agentId}/test-chats`, {
      version: 2,
      message: "Try the draft",
      toolLogins: {},
    });
    expect(chat.status).toBe(201);
    const row = await binding(chat.body.sessionId);
    expect(row).toMatchObject({
      workspace_id: chat.body.workspaceId,
      agent_id: agentId,
      agent_version: 2,
      agent_prompt_version: 2,
    });
    const [marker] = await shared!.admin<{ source: string }[]>`
      select source from organization_managed_workspaces
      where workspace_id = ${chat.body.workspaceId}`;
    expect(marker!.source).toBe("console_test");
    // The draft is out of reach outside the test workspace.
    const outside = await call("POST", sessions(), {
      initialMessage: "hi",
      agent: { ref: agentId, version: 2 },
    });
    expect([outside.status, outside.body.code, outside.body.details?.code]).toEqual([
      404,
      "SESSION_CREATE_REJECTED",
      "agent_not_found",
    ]);
  }, 120_000);

  test("a keyed retry returns the original chat after a publish or archive", async () => {
    if (!fixture) return;
    const { agentId } = await publishedAgent("replayed");
    const rowVersion = async () =>
      (await call("GET", `${agents()}/${agentId}`)).body.agent.rowVersion as number;
    const idempotencyKey = `replay-${crypto.randomUUID()}`;
    const body = { initialMessage: "hi", agent: "replayed", idempotencyKey };
    const first = await call("POST", sessions(), body);
    expect([first.status, first.body.orgAgent?.version]).toEqual([202, 1]);

    // Version 2 is published: the retry still returns the chat on version 1.
    const draft = await call("PUT", `${agents()}/${agentId}/draft`, {
      name: "replayed",
      instructions: "Version two.",
      expectedVersion: await rowVersion(),
    });
    expect(draft.status).toBe(201);
    const published = await call("POST", `${agents()}/${agentId}/publish`, {
      version: 2,
      expectedVersion: await rowVersion(),
    });
    expect(published.status).toBe(200);
    const afterPublish = await call("POST", sessions(), body);
    expect(afterPublish.status).toBeLessThan(300);
    expect([afterPublish.body.id, afterPublish.body.orgAgent?.version]).toEqual([first.body.id, 1]);
    expect((await binding(first.body.id)).agent_version).toBe(1);
    // A new create gets version 2.
    const fresh = await call("POST", sessions(), { initialMessage: "hi", agent: "replayed" });
    expect([fresh.status, fresh.body.orgAgent?.version]).toEqual([202, 2]);
    // The same key naming another version is a different request.
    const otherVersion = await call("POST", sessions(), {
      ...body,
      agent: { ref: "replayed", version: 2 },
    });
    expect(otherVersion.status).toBe(409);

    // Archived: the retry still returns the original chat; a new create is refused.
    const archived = await call("POST", `${agents()}/${agentId}/archive`, {
      expectedVersion: await rowVersion(),
    });
    expect(archived.status).toBe(200);
    const afterArchive = await call("POST", sessions(), body);
    expect(afterArchive.status).toBeLessThan(300);
    expect(afterArchive.body.id).toBe(first.body.id);
    const refused = await call("POST", sessions(), { initialMessage: "hi", agent: "replayed" });
    expect([refused.status, refused.body.details?.code]).toEqual([404, "agent_not_found"]);
  }, 120_000);

  test("a keyed retry of an inline config create writes nothing again", async () => {
    if (!fixture) return;
    const config = {
      name: "Inline replay",
      instructions: "Write code.",
      config: { model: "scripted-model" },
    };
    const idempotencyKey = `inline-${crypto.randomUUID()}`;
    const body = { initialMessage: "hi", agent: { ref: "inline-replay", config }, idempotencyKey };
    const first = await call("POST", sessions(), body);
    expect([first.status, first.body.orgAgent?.version]).toEqual([202, 1]);
    const writes = async () => {
      const [row] = await shared!.admin<{ versions: number; audit: number }[]>`
        select
          (select count(*)::int from agent_revisions r join agents a on a.id = r.agent_id
            where a.account_id = ${fixture!.accountId} and a.agent_key = 'inline-replay') as versions,
          (select count(*)::int from organization_console_audit_events
            where account_id = ${fixture!.accountId} and detail->>'key' = 'inline-replay') as audit`;
      return row!;
    };
    expect(await writes()).toEqual({ versions: 1, audit: 1 });
    const retry = await call("POST", sessions(), body);
    expect(retry.status).toBeLessThan(300);
    expect(retry.body.id).toBe(first.body.id);
    expect(await writes()).toEqual({ versions: 1, audit: 1 });
    // The same key with another config is a different request, and saves nothing.
    const changed = await call("POST", sessions(), {
      ...body,
      agent: { ref: "inline-replay", config: { ...config, instructions: "Write tests." } },
    });
    expect(changed.status).toBe(409);
    expect(await writes()).toEqual({ versions: 1, audit: 1 });
  }, 120_000);

  test("inline config saves an agent only with organization-level agents:manage", async () => {
    if (!fixture) return;
    const config = {
      name: "Inline coder",
      instructions: "Write code.",
      config: { model: "scripted-model" },
    };
    // A workspace key with workspace:admin, and an organization key without
    // agents:manage, may not save agents from config.
    for (const key of [fixture.workspaceKey, fixture.limitedKey]) {
      const refused = await call(
        "POST",
        sessions(),
        { initialMessage: "hi", agent: { ref: "inline-coder", config } },
        key,
      );
      // The session create route's envelope; the specific code is in details.
      expect([refused.status, refused.body.code, refused.body.details?.code]).toEqual([
        403,
        "SESSION_CREATE_FORBIDDEN",
        "agents_manage_required",
      ]);
    }
    const [none] = await shared!.admin<{ count: number }[]>`
      select count(*)::int as count from agents
      where account_id = ${fixture.accountId} and agent_key = 'inline-coder'`;
    expect(none!.count).toBe(0);
    // An organization key holding agents:manage saves it, with Console audit rows.
    const created = await call("POST", sessions(), {
      initialMessage: "hi",
      agent: { ref: "inline-coder", config },
    });
    expect([created.status, created.body.orgAgent?.key]).toEqual([202, "inline-coder"]);
    const changed = await call("POST", sessions(), {
      initialMessage: "hi",
      agent: { ref: "inline-coder", config: { ...config, instructions: "Write tests." } },
    });
    expect([changed.status, changed.body.orgAgent?.version]).toEqual([202, 2]);
    // Without agents:manage a saved config runs only as the published version.
    await shared!.admin`update agents set published_revision = 1
      where account_id = ${fixture.accountId} and agent_key = 'inline-coder'`;
    const reused = await call(
      "POST",
      sessions(),
      { initialMessage: "hi", agent: { ref: "inline-coder", config } },
      fixture.limitedKey,
    );
    expect([reused.status, reused.body.orgAgent?.version]).toEqual([202, 1]);
    // Version 2's exact config does not run it for them: it is not published.
    const unpublished = await call(
      "POST",
      sessions(),
      {
        initialMessage: "hi",
        agent: { ref: "inline-coder", config: { ...config, instructions: "Write tests." } },
      },
      fixture.limitedKey,
    );
    expect([unpublished.status, unpublished.body.details?.code]).toEqual([404, "agent_not_found"]);
    // With agents:manage it does.
    const managed = await call("POST", sessions(), {
      initialMessage: "hi",
      agent: { ref: "inline-coder", config: { ...config, instructions: "Write tests." } },
    });
    expect([managed.status, managed.body.orgAgent?.version]).toEqual([202, 2]);
    const audit = await shared!.admin<{ action: string; actor: string; detail: any }[]>`
      select action, actor_subject_id as actor, detail from organization_console_audit_events
      where account_id = ${fixture.accountId} and detail->>'key' = 'inline-coder'
      order by created_at`;
    expect(audit.map((row) => [row.action, row.detail.version, row.detail.source])).toEqual([
      ["agent.created", 1, "inline"],
      ["agent.version_saved", 2, "inline"],
    ]);
    expect(audit.every((row) => row.actor.startsWith("api_key:"))).toBe(true);
  }, 120_000);

  test("without agents:manage a chat may only narrow the agent's tool servers", async () => {
    if (!fixture) return;
    await shared!
      .admin`insert into organization_tool_servers (account_id, server_key, name, url, auth_mode)
      values (${fixture.accountId}, 'notes', 'Notes', 'https://notes.example.com/mcp', 'none')
      on conflict do nothing`;
    const created = await call("POST", agents(), {
      key: "noted",
      name: "noted",
      instructions: "Take notes.",
      config: {
        model: "scripted-model",
        toolServers: [
          {
            server: "notes",
            tools: { mode: "selected", enabled: ["read", "write"] },
            approval: { ask: ["write"] },
          },
        ],
      },
    });
    expect(created.status).toBe(201);
    const published = await call("POST", `${agents()}/${created.body.agent.id}/publish`, {
      version: 1,
      expectedVersion: created.body.agent.rowVersion,
    });
    expect(published.status).toBe(200);
    const asLimited = (body: Record<string, unknown>) =>
      call("POST", sessions(), { initialMessage: "hi", ...body }, fixture!.limitedKey);
    // Narrowing: fewer tools, more "Ask first".
    const narrowed = await asLimited({
      agent: {
        ref: "noted",
        toolServers: [
          {
            server: "notes",
            tools: { mode: "selected", enabled: ["read"] },
            approval: { ask: ["write", "read"] },
          },
        ],
      },
    });
    expect(narrowed.status).toBe(202);
    const [server] = await shared!.admin<
      { allowed_tools: string[] | null; require_approval: unknown }[]
    >`select allowed_tools, require_approval from session_mcp_servers
      where session_id = ${narrowed.body.id} and server_id = 'notes'`;
    expect(server!.allowed_tools).toEqual(["read"]);
    // Widening: a tool the agent left off, every tool, or "Ask first" removed.
    for (const change of [
      { tools: { mode: "selected", enabled: ["read", "delete"] } },
      { tools: { mode: "all" } },
      { approval: { ask: [] } },
    ]) {
      const refused = await asLimited({
        agent: { ref: "noted", toolServers: [{ server: "notes", ...change }] },
      });
      expect([refused.status, refused.body.details?.code]).toEqual([403, "agents_manage_required"]);
    }
    // Replacing the agent's server through mcpServers widens too.
    const replaced = await asLimited({
      agent: "noted",
      mcpServers: [{ id: "notes", url: "https://notes.example.com/mcp" }],
    });
    expect([replaced.status, replaced.body.details?.code]).toEqual([403, "agents_manage_required"]);
    // A server of the chat's own under a new id needs mcp_servers:attach, as for any chat.
    const added = await asLimited({
      agent: "noted",
      mcpServers: [{ id: "mine", url: "https://mine.example.com/mcp" }],
    });
    expect(added.status).toBe(403);
    expect(JSON.stringify(added.body)).toContain("mcp_servers:attach");
    // An organization key holding agents:manage may widen; it is recorded.
    const widened = await call("POST", sessions(), {
      initialMessage: "hi",
      agent: { ref: "noted", toolServers: [{ server: "notes", tools: { mode: "all" } }] },
      mcpServers: [{ id: "mine", url: "https://mine.example.com/mcp" }],
    });
    expect(widened.status).toBe(202);
    expect(Object.keys(widened.body.orgAgent.overrides).sort()).toEqual([
      "mcpServers.mine",
      "toolServers.notes",
    ]);
  }, 120_000);

  test("after create a chat may only ask first for more of the agent's tools", async () => {
    if (!fixture) return;
    await shared!
      .admin`insert into organization_tool_servers (account_id, server_key, name, url, auth_mode)
      values (${fixture.accountId}, 'notes', 'Notes', 'https://notes.example.com/mcp', 'none')
      on conflict do nothing`;
    const created = await call("POST", agents(), {
      key: "asked",
      name: "asked",
      instructions: "Take notes.",
      config: {
        model: "scripted-model",
        toolServers: [
          {
            server: "notes",
            tools: { mode: "selected", enabled: ["read", "write"] },
            approval: { ask: ["write"] },
          },
        ],
      },
    });
    expect(created.status).toBe(201);
    const published = await call("POST", `${agents()}/${created.body.agent.id}/publish`, {
      version: 1,
      expectedVersion: created.body.agent.rowVersion,
    });
    expect(published.status).toBe(200);
    const chat = await call(
      "POST",
      sessions(),
      { initialMessage: "hi", agent: "asked" },
      fixture.controlKey,
    );
    expect(chat.status).toBe(202);
    const policy = (serverId: string, requireApproval: unknown, key = fixture!.controlKey) =>
      call(
        "PATCH",
        `${sessions()}/${chat.body.id}/mcp-servers/${serverId}/approval-policy`,
        { requireApproval },
        key,
      );
    // More "Ask first" is allowed.
    expect((await policy("notes", ["write", "read"])).status).toBe(200);
    expect((await policy("notes", true)).status).toBe(200);
    // Back to the agent's own level is allowed too.
    expect((await policy("notes", ["write"])).status).toBe(200);
    // Taking the agent's "Ask first" away needs agents:manage for the organization.
    for (const requireApproval of [false, ["read"]]) {
      const refused = await policy("notes", requireApproval);
      expect([refused.status, refused.body.code, refused.body.details?.code]).toEqual([
        403,
        "forbidden",
        "agents_manage_required",
      ]);
    }
    const [row] = await shared!.admin<{ require_approval: unknown }[]>`
      select require_approval from session_mcp_servers
      where session_id = ${chat.body.id} and server_id = 'notes'`;
    expect(row!.require_approval).toEqual(["write"]);
    // An organization key holding agents:manage may.
    expect((await policy("notes", false, fixture.key)).status).toBe(200);
  }, 120_000);

  test("an end user acting through a full organization key never inherits its agents:manage", async () => {
    if (!fixture) return;
    await shared!
      .admin`insert into organization_tool_servers (account_id, server_key, name, url, auth_mode)
      values (${fixture.accountId}, 'notes', 'Notes', 'https://notes.example.com/mcp', 'none')
      on conflict do nothing`;
    const created = await call("POST", agents(), {
      key: "asked-end-user",
      name: "asked-end-user",
      instructions: "Take notes.",
      config: {
        model: "scripted-model",
        toolServers: [
          {
            server: "notes",
            tools: { mode: "selected", enabled: ["read", "write"] },
            approval: { ask: ["write"] },
          },
        ],
      },
    });
    expect(created.status).toBe(201);
    const published = await call("POST", `${agents()}/${created.body.agent.id}/publish`, {
      version: 1,
      expectedVersion: created.body.agent.rowVersion,
    });
    expect(published.status).toBe(200);
    // The browser's end user, as the session proxy forwards it: the full key with an actor.
    const endUser = {
      ...fixture.key,
      "x-opengeni-external-actor": encodeURIComponent(
        JSON.stringify({
          mode: "external",
          identity: { source: "product", externalId: `end-user-${crypto.randomUUID()}` },
          membership: {
            permissions: ["workspace:read", "sessions:create", "sessions:read", "sessions:control"],
          },
        }),
      ),
    };
    const chat = await call(
      "POST",
      sessions(),
      { initialMessage: "hi", agent: "asked-end-user", visibility: "workspace" },
      endUser,
    );
    expect(chat.status, JSON.stringify(chat.body)).toBe(202);
    const policy = (requireApproval: unknown, key: Record<string, string>) =>
      call(
        "PATCH",
        `${sessions()}/${chat.body.id}/mcp-servers/notes/approval-policy`,
        { requireApproval },
        key,
      );
    // The end user may ask first for more, but never turn the agent's "Ask first" off.
    expect((await policy(true, endUser)).status).toBe(200);
    expect((await policy(["write"], endUser)).status).toBe(200);
    for (const requireApproval of [false, ["read"]]) {
      const refused = await policy(requireApproval, endUser);
      expect([refused.status, refused.body.code, refused.body.details?.code]).toEqual([
        403,
        "forbidden",
        "agents_manage_required",
      ]);
    }
    const [row] = await shared!.admin<{ require_approval: unknown }[]>`
      select require_approval from session_mcp_servers
      where session_id = ${chat.body.id} and server_id = 'notes'`;
    expect(row!.require_approval).toEqual(["write"]);
    // The product's server (the same key without an actor) still may.
    expect((await policy(false, fixture.key)).status).toBe(200);
  }, 120_000);
});
