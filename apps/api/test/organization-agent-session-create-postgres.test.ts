// Session create with an organization (Console) agent through the HTTP API
// against a real database, as an organization API key: `agent` as a key, as
// `{ ref }`, `agentOverrides`, and the Console test chat route, which goes
// through the same session create. The route's early body check must read an
// organization agent's `agent` field as such, not as today's agent object.
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
  return {
    userId,
    accountId,
    managedWorkspaceId: managed.id,
    key: { authorization: `Bearer ${token}` },
  };
}

type Reply = { status: number; body: Record<string, any> };

async function call(method: string, path: string, body?: unknown): Promise<Reply> {
  if (!app || !fixture) throw new Error("app unavailable");
  const response = await app.request(`http://x${path}`, {
    method,
    headers: {
      ...fixture.key,
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
    // An unknown key is refused, never a plain chat.
    const unknown = await call("POST", sessions(), { initialMessage: "hi", agent: "missing" });
    expect([unknown.status, unknown.body.code]).toEqual([404, "agent_not_found"]);
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
    expect([refused.status, refused.body.code]).toEqual([422, "agent_override_rejected"]);
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
    // The draft does not run outside the test workspace.
    const outside = await call("POST", sessions(), {
      initialMessage: "hi",
      agent: { ref: agentId, version: 2 },
    });
    expect([outside.status, outside.body.code]).toEqual([409, "agent_not_published"]);
  }, 120_000);
});
