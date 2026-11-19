// Turn-time logins for an organization agent's tool servers against real
// PostgreSQL: per_user servers use the credential provider, then the end
// user's stored login (OAuth refreshed near expiry), then the chat's own
// headers, and never the shared key; shared_key servers use the
// organization's headers; a server left without a login is attached as
// unavailable (tools hidden, warning recorded) without leaking secrets.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import type { ToolRef } from "@opengeni/contracts";
import { resolveSessionCreateScope } from "@opengeni/core";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  decryptEnvironmentValue,
  encryptEnvironmentValue,
  refreshEndUserToolCredential,
  submitHumanPromptInTransaction,
  withWorkspaceSubjectSessionActivityRls,
} from "@opengeni/db";
import {
  orgAgentEndUserSubject,
  resolveOrgAgentToolLogins,
  type OrgToolServerUnavailable,
} from "../src/activities/agent-turn/org-agent-tool-logins";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const db = await acquireSharedTestDatabase("org-agent-tool-logins");
  if (!db) throw new Error("test postgres unavailable");
  shared = db;
  client = createDb(db.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

const keyBase64 = randomBytes(32).toString("base64");
const key = new Uint8Array(Buffer.from(keyBase64, "base64"));
const settings = testSettings({ environmentsEncryptionKey: keyBase64 });
const END_USER = "external_user:alice";
const url = (name: string) => `https://${name}.example.com/mcp`;

async function fixture() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "org agents",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "org agents",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const accountId = grant.accountId;
  const workspaceId = grant.workspaceId!;
  await shared.admin`insert into organization_managed_workspaces (account_id, workspace_id, source)
    values (${accountId}, ${workspaceId}, 'console')`;
  const servers: Record<string, string> = {};
  const seeds: [string, "per_user" | "shared_key" | "none", string | null, unknown][] = [
    ["provider", "per_user", null, null],
    [
      "crm",
      "per_user",
      null,
      {
        tokenUrl: "https://crm.example.com/token",
        clientId: "client",
        clientSecretEncrypted: encryptEnvironmentValue(key, "client-secret"),
      },
    ],
    ["stored", "per_user", null, null],
    ["chatonly", "per_user", null, null],
    ["expired", "per_user", null, null],
    ["nologin", "per_user", null, null],
    [
      "team",
      "shared_key",
      encryptEnvironmentValue(key, JSON.stringify({ "X-Team-Key": "team-secret" })),
      null,
    ],
    ["open", "none", null, null],
  ];
  for (const [serverKey, authMode, sharedHeaders, oauthRefresh] of seeds) {
    const [row] = await shared.admin<{ id: string }[]>`
      insert into organization_tool_servers (account_id, server_key, name, url, auth_mode,
        shared_headers_encrypted, oauth_refresh)
      values (${accountId}, ${serverKey}, ${serverKey.toUpperCase()}, ${url(serverKey)}, ${authMode},
        ${sharedHeaders}, ${oauthRefresh === null ? null : JSON.stringify(oauthRefresh)}::text::jsonb)
      returning id::text`;
    servers[serverKey] = row!.id;
  }
  const agentId = crypto.randomUUID();
  await shared.admin`insert into agents (id, account_id, workspace_id, scope, visibility, name,
      name_key, origin, current_revision, agent_key, managed_by, published_revision)
    values (${agentId}, ${accountId}, null, 'organization', 'workspace', 'Support', 'support', 'app',
      1, 'support', 'console', 1)`;
  await shared.admin`insert into agent_revisions (agent_id, account_id, workspace_id, revision, name,
      instructions, config, tool_catalog, source, config_hash)
    values (${agentId}, ${accountId}, null, 1, 'Support', '',
      ${JSON.stringify({ toolServers: seeds.map(([server]) => ({ server })) })}::text::jsonb, '{}'::jsonb,
      'console', ${`sha256:${createHash("sha256").update(agentId).digest("hex")}`})`;
  async function storeLogin(
    serverKey: string,
    material: Record<string, unknown>,
    expiresAt: Date | null,
    endUser: string = END_USER,
  ) {
    const [row] = await shared.admin<{ id: string }[]>`
      insert into end_user_tool_credentials (account_id, workspace_id,
        end_user_subject_id, tool_server_id, kind, material_encrypted, expires_at)
      values (${accountId}, ${workspaceId}, ${endUser}, ${servers[serverKey]!},
        ${String(material["kind"])}, ${encryptEnvironmentValue(key, JSON.stringify(material))},
        ${expiresAt})
      returning id::text`;
    return row!.id;
  }
  return { accountId, workspaceId, agentId, servers, storeLogin, subjectId: `subject-${suffix}` };
}

const sessionServers = () => [
  ...["provider", "crm", "stored", "expired", "nologin", "team", "open"].map((id) => ({
    id,
    name: id.toUpperCase(),
    url: url(id),
    cacheToolsList: false,
  })),
  {
    id: "chatonly",
    name: "CHATONLY",
    url: url("chatonly"),
    cacheToolsList: false,
    headers: { "X-Chat": "chat-login" },
  },
  // The chat replaced this agent server with its own URL: left alone.
  { id: "mine", url: "https://mine.example.com/mcp", cacheToolsList: false, headers: { k: "v" } },
];

describe("organization agent tool server logins", () => {
  test("login order, refresh, shared key, and unavailable servers", async () => {
    const f = await fixture();
    await f.storeLogin(
      "crm",
      { kind: "oauth", accessToken: "old-access", refreshToken: "refresh-1", tokenType: "Bearer" },
      new Date(Date.now() + 60_000),
    );
    await f.storeLogin("stored", { kind: "headers", headers: { "X-Api-Key": "stored-key" } }, null);
    await f.storeLogin(
      "expired",
      { kind: "headers", headers: { "X-Api-Key": "old" } },
      new Date(Date.now() - 60_000),
    );
    // The provider-managed server also has a stored login: the provider wins.
    await f.storeLogin("provider", { kind: "headers", headers: { "X-Api-Key": "not-used" } }, null);
    const refreshCalls: { url: string; body: string }[] = [];
    const published: OrgToolServerUnavailable[] = [];
    const turnTools: ToolRef[] = [
      ...sessionServers().map((server) => ({ kind: "mcp" as const, id: server.id })),
    ];
    const result = await resolveOrgAgentToolLogins({
      db: client.db,
      settings,
      accountId: f.accountId,
      workspaceId: f.workspaceId,
      orgAgent: { agentId: f.agentId, version: 1 },
      endUserSubjectId: END_USER,
      mcpServers: sessionServers(),
      turnTools,
      providerManaged: (id) => id === "provider",
      publishUnavailable: async (payload) => {
        published.push(payload);
      },
      fetchImpl: async (tokenUrl, init) => {
        refreshCalls.push({ url: tokenUrl, body: String(init.body) });
        return new Response(
          JSON.stringify({ access_token: "new-access", expires_in: 3600, token_type: "Bearer" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    expect(result).not.toBeNull();
    const byId = new Map(result!.mcpServers.map((server) => [server.id, server]));
    expect(byId.get("provider")?.headers).toBeUndefined();
    expect(byId.get("crm")?.headers).toEqual({ Authorization: "Bearer new-access" });
    expect(byId.get("stored")?.headers).toEqual({ "X-Api-Key": "stored-key" });
    expect(byId.get("chatonly")?.headers).toEqual({ "X-Chat": "chat-login" });
    expect(byId.get("team")?.headers).toEqual({ "X-Team-Key": "team-secret" });
    expect(byId.get("open")?.headers).toBeUndefined();
    expect(byId.get("mine")?.headers).toEqual({ k: "v" });
    expect(byId.has("nologin")).toBe(false);
    expect(byId.has("expired")).toBe(false);
    expect(result!.turnTools.map((tool) => tool.id).sort()).toEqual(
      ["chatonly", "crm", "mine", "open", "provider", "stored", "team"].sort(),
    );
    expect(result!.unavailable).toEqual([
      { serverKey: "expired", name: "EXPIRED", reason: "credentials_expired" },
      { serverKey: "nologin", name: "NOLOGIN", reason: "missing_credentials" },
    ]);
    expect(published).toEqual(result!.unavailable);
    expect(result!.unavailableMcpConnectors).toEqual([
      { id: "expired", name: "EXPIRED", reason: "no_account" },
      { id: "nologin", name: "NOLOGIN", reason: "no_account" },
    ]);
    // No secret reaches the warning payloads.
    expect(JSON.stringify(published)).not.toMatch(/secret|access|key-/i);

    // One OAuth refresh with the stored refresh token and client secret; written back encrypted.
    expect(refreshCalls).toHaveLength(1);
    expect(refreshCalls[0]!.url).toBe("https://crm.example.com/token");
    const body = new URLSearchParams(refreshCalls[0]!.body);
    expect(Object.fromEntries(body)).toEqual({
      grant_type: "refresh_token",
      refresh_token: "refresh-1",
      client_id: "client",
      client_secret: "client-secret",
    });
    const [stored] = await shared.admin<
      { material_encrypted: string; expires_at: Date; version: number; last_used_at: Date | null }[]
    >`select material_encrypted, expires_at, version, last_used_at from end_user_tool_credentials
      where tool_server_id = ${f.servers["crm"]!}`;
    expect(stored!.material_encrypted).not.toContain("new-access");
    expect(JSON.parse(decryptEnvironmentValue(key, stored!.material_encrypted))).toEqual({
      kind: "oauth",
      accessToken: "new-access",
      refreshToken: "refresh-1",
      tokenType: "Bearer",
    });
    expect(stored!.expires_at.getTime()).toBeGreaterThan(Date.now() + 3_000_000);
    expect(stored!.version).toBe(2);
    expect(stored!.last_used_at).toBeInstanceOf(Date);
    const [unusedProvider] = await shared.admin<{ last_used_at: Date | null }[]>`
      select last_used_at from end_user_tool_credentials where tool_server_id = ${f.servers["provider"]!}`;
    expect(unusedProvider!.last_used_at).toBeNull();
  }, 180_000);

  test("a refused refresh marks the login and the server is unavailable", async () => {
    const f = await fixture();
    await f.storeLogin(
      "crm",
      { kind: "oauth", accessToken: "old-access", refreshToken: "refresh-1" },
      new Date(Date.now() - 1_000),
    );
    const published: OrgToolServerUnavailable[] = [];
    const result = await resolveOrgAgentToolLogins({
      db: client.db,
      settings,
      accountId: f.accountId,
      workspaceId: f.workspaceId,
      orgAgent: { agentId: f.agentId, version: 1 },
      endUserSubjectId: END_USER,
      mcpServers: [{ id: "crm", name: "CRM", url: url("crm"), cacheToolsList: false }],
      turnTools: [{ kind: "mcp", id: "crm" }],
      providerManaged: () => false,
      publishUnavailable: async (payload) => {
        published.push(payload);
      },
      fetchImpl: async () => new Response("denied", { status: 400 }),
    });
    expect(result!.mcpServers).toEqual([]);
    expect(result!.turnTools).toEqual([]);
    expect(published).toEqual([{ serverKey: "crm", name: "CRM", reason: "credentials_expired" }]);
    const [row] = await shared.admin<{ refresh_failed_at: Date | null }[]>`
      select refresh_failed_at from end_user_tool_credentials where tool_server_id = ${f.servers["crm"]!}`;
    expect(row!.refresh_failed_at).toBeInstanceOf(Date);
  }, 180_000);

  test("without an end user, per_user servers use only the chat's headers", async () => {
    const f = await fixture();
    await f.storeLogin("stored", { kind: "headers", headers: { "X-Api-Key": "stored-key" } }, null);
    const result = await resolveOrgAgentToolLogins({
      db: client.db,
      settings,
      accountId: f.accountId,
      workspaceId: f.workspaceId,
      orgAgent: { agentId: f.agentId, version: 1 },
      endUserSubjectId: null,
      mcpServers: [
        { id: "stored", name: "STORED", url: url("stored"), cacheToolsList: false },
        { id: "chatonly", url: url("chatonly"), cacheToolsList: false, headers: { a: "b" } },
      ],
      turnTools: [],
      providerManaged: () => false,
      publishUnavailable: async () => undefined,
    });
    expect(result!.mcpServers.map((server) => server.id)).toEqual(["chatonly"]);
    expect(result!.unavailable).toEqual([
      { serverKey: "stored", name: "STORED", reason: "missing_credentials" },
    ]);
  }, 180_000);

  test("chats without an organization agent are untouched", async () => {
    const f = await fixture();
    expect(
      await resolveOrgAgentToolLogins({
        db: client.db,
        settings,
        accountId: f.accountId,
        workspaceId: f.workspaceId,
        orgAgent: null,
        endUserSubjectId: END_USER,
        mcpServers: sessionServers(),
        turnTools: [],
        providerManaged: () => false,
        publishUnavailable: async () => {
          throw new Error("must not publish");
        },
      }),
    ).toBeNull();
    expect(orgAgentEndUserSubject(null, "external_user:b")).toBe("external_user:b");
    expect(orgAgentEndUserSubject("user:a", null)).toBeNull();
  }, 180_000);
  test("removing access or archiving the agent stops existing chats using organization secrets", async () => {
    const f = await fixture();
    await f.storeLogin("stored", { kind: "headers", headers: { "X-Api-Key": "stored-key" } }, null);
    const servers = () =>
      sessionServers().filter((server) =>
        ["stored", "team", "open", "chatonly", "provider"].includes(server.id),
      );
    const resolve = async () => {
      const published: OrgToolServerUnavailable[] = [];
      const result = await resolveOrgAgentToolLogins({
        db: client.db,
        settings,
        accountId: f.accountId,
        workspaceId: f.workspaceId,
        orgAgent: { agentId: f.agentId, version: 1 },
        endUserSubjectId: END_USER,
        mcpServers: servers(),
        turnTools: servers().map((server) => ({ kind: "mcp" as const, id: server.id })),
        providerManaged: (id) => id === "provider",
        publishUnavailable: async (payload) => {
          published.push(payload);
        },
      });
      const byId = new Map(result!.mcpServers.map((server) => [server.id, server.headers]));
      return { byId, unavailable: result!.unavailable, published };
    };
    const cutOff = [
      { serverKey: "stored", name: "STORED", reason: "missing_credentials" },
      { serverKey: "team", name: "TEAM", reason: "missing_credentials" },
    ];

    // The agent reaches the workspace (managed): both organization secrets run.
    const before = await resolve();
    expect(before.byId.get("stored")).toEqual({ "X-Api-Key": "stored-key" });
    expect(before.byId.get("team")).toEqual({ "X-Team-Key": "team-secret" });
    expect(before.unavailable).toEqual([]);

    // Access removed: the workspace is no longer managed and has no access row.
    await shared.admin`delete from organization_managed_workspaces
      where account_id = ${f.accountId} and workspace_id = ${f.workspaceId}`;
    const removed = await resolve();
    expect(removed.byId.has("stored")).toBe(false);
    expect(removed.byId.has("team")).toBe(false);
    expect(removed.unavailable).toEqual(cutOff);
    expect(removed.published).toEqual(cutOff);
    // The end user's own provider, the chat's own headers and servers without a login still run.
    expect(removed.byId.has("provider")).toBe(true);
    expect(removed.byId.get("chatonly")).toEqual({ "X-Chat": "chat-login" });
    expect(removed.byId.has("open")).toBe(true);
    expect(JSON.stringify(removed.published)).not.toMatch(/secret|stored-key/);

    // Added to the workspace by an access row: the shared key runs again
    // (stored logins live only in managed workspaces and went with the marker).
    await shared.admin`insert into agent_workspace_access (agent_id, account_id, workspace_id)
      values (${f.agentId}, ${f.accountId}, ${f.workspaceId})`;
    const granted = await resolve();
    expect(granted.byId.get("team")).toEqual({ "X-Team-Key": "team-secret" });
    expect(granted.unavailable).toEqual([cutOff[0]]);

    // Managed again with a stored login, then archived: cut off although it
    // still reaches the workspace and the login is still stored.
    await shared.admin`insert into organization_managed_workspaces (account_id, workspace_id, source)
      values (${f.accountId}, ${f.workspaceId}, 'console')`;
    await f.storeLogin("stored", { kind: "headers", headers: { "X-Api-Key": "stored-key" } }, null);
    const restored = await resolve();
    expect(restored.byId.get("stored")).toEqual({ "X-Api-Key": "stored-key" });
    expect(restored.unavailable).toEqual([]);
    await shared.admin`update agents set archived_at = now() where id = ${f.agentId}`;
    const archived = await resolve();
    expect(archived.byId.has("stored")).toBe(false);
    expect(archived.byId.has("team")).toBe(false);
    expect(archived.unavailable).toEqual(cutOff);
    expect(archived.byId.get("chatonly")).toEqual({ "X-Chat": "chat-login" });
  }, 180_000);
  test("stored logins are the person's who started the turn, never another person's", () => {
    // The person who sent the message: their own login.
    expect(orgAgentEndUserSubject("external_user:a", "external_user:a")).toBe("external_user:a");
    expect(orgAgentEndUserSubject("external_user:a", "external_user:b")).toBe("external_user:b");
    // Another person (an Opengeni member) in an end user's chat: no stored login.
    expect(orgAgentEndUserSubject("external_user:a", "user:b")).toBeNull();
    // No person started the turn (an API key, a schedule, a worker): the chat's end user.
    expect(orgAgentEndUserSubject("external_user:a", null)).toBe("external_user:a");
    expect(orgAgentEndUserSubject("external_user:a", "api_key:k")).toBe("external_user:a");
    expect(orgAgentEndUserSubject("external_user:a", "worker:model-access")).toBe(
      "external_user:a",
    );
  });

  test("end user B's message in A's chat never runs A's stored login", async () => {
    const f = await fixture();
    const BOB = "external_user:bob";
    await f.storeLogin("stored", { kind: "headers", headers: { "X-Api-Key": "alice-key" } }, null);
    const resolve = async (endUserSubjectId: string | null) => {
      const published: OrgToolServerUnavailable[] = [];
      const result = await resolveOrgAgentToolLogins({
        db: client.db,
        settings,
        accountId: f.accountId,
        workspaceId: f.workspaceId,
        orgAgent: { agentId: f.agentId, version: 1 },
        endUserSubjectId,
        mcpServers: [{ id: "stored", name: "STORED", url: url("stored"), cacheToolsList: false }],
        turnTools: [{ kind: "mcp", id: "stored" }],
        providerManaged: () => false,
        publishUnavailable: async (payload) => {
          published.push(payload);
        },
      });
      return { result: result!, published };
    };
    // Bob started the turn in Alice's chat: Bob has no login, so the server is unavailable.
    const bob = await resolve(orgAgentEndUserSubject(END_USER, BOB));
    expect(bob.result.mcpServers).toEqual([]);
    expect(bob.published).toEqual([
      { serverKey: "stored", name: "STORED", reason: "missing_credentials" },
    ]);
    // Bob's own login is used once he has one; Alice's never.
    await f.storeLogin(
      "stored",
      { kind: "headers", headers: { "X-Api-Key": "bob-key" } },
      null,
      BOB,
    );
    const bobAgain = await resolve(orgAgentEndUserSubject(END_USER, BOB));
    expect(bobAgain.result.mcpServers[0]?.headers).toEqual({ "X-Api-Key": "bob-key" });
    const alice = await resolve(orgAgentEndUserSubject(END_USER, END_USER));
    expect(alice.result.mcpServers[0]?.headers).toEqual({ "X-Api-Key": "alice-key" });
  }, 180_000);

  test("a worker chat's per-user login is its parent's end user's", async () => {
    const f = await fixture();
    await f.storeLogin("stored", { kind: "headers", headers: { "X-Api-Key": "alice-key" } }, null);
    const base = {
      accountId: f.accountId,
      workspaceId: f.workspaceId,
      initialMessage: "",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "low" as const,
      latencyMode: "standard" as const,
      sandboxBackend: "none" as const,
    };
    // Alice's chat runs the agent; a turn of it starts a worker chat.
    const parent = await createSession(client.db, {
      ...base,
      scopeSubjectId: END_USER,
      orgAgent: { agentId: f.agentId, version: 1, promptVersion: 1, overrides: null },
    });
    await withWorkspaceSubjectSessionActivityRls(client.db, f.workspaceId, f.subjectId, (db) =>
      submitHumanPromptInTransaction(db, {
        accountId: f.accountId,
        workspaceId: f.workspaceId,
        sessionId: parent.id,
        subjectId: f.subjectId,
        actor: { type: "human", subjectId: f.subjectId },
        operationKey: crypto.randomUUID(),
        delivery: "send",
        text: "work",
        resources: [],
        reasoningEffort: "low",
        reasoningEffortFallback: "low",
        source: "user",
      }),
    );
    const claimed = await claimSessionWorkForAttempt(client.db, f.workspaceId, {
      sessionId: parent.id,
      workflowId: `session-${parent.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
      agentInstructionsProtocol: 1,
      orgAgentProtocol: 1,
    });
    if (claimed.action !== "claimed") throw new Error(`not claimed: ${claimed.action}`);
    // The child's scope as session create resolves it: the parent's end user.
    const childScope = resolveSessionCreateScope({
      requested: {
        agentAccess: "workspace",
        agentAccessProvided: false,
        scopeSubjectId: null,
        endUserProvided: false,
        memoryScope: "workspace",
        memoryScopeProvided: false,
      },
      parent: { agentAccess: "workspace", scopeSubjectId: END_USER, memoryScope: "workspace" },
    });
    const child = await createSession(client.db, {
      ...base,
      parentSessionId: parent.id,
      scopeSubjectId: childScope.scopeSubjectId,
      createdByActor: {
        type: "agent_attempt",
        attemptId: claimed.turn.activeAttemptId!,
        sessionId: parent.id,
        turnId: claimed.turn.id,
        executionGeneration: claimed.turn.executionGeneration,
      },
    });
    const [row] = await shared.admin<
      { scope_subject_id: string | null; agent_id: string | null; agent_version: number | null }[]
    >`select scope_subject_id, agent_id::text, agent_version from sessions where id = ${child.id}`;
    expect(row).toEqual({ scope_subject_id: END_USER, agent_id: f.agentId, agent_version: 1 });
    // A worker turn has no person behind it (or the parent's caller, not an
    // end user): the login is the chat's end user's, Alice's.
    for (const initiator of [null, f.subjectId]) {
      const result = await resolveOrgAgentToolLogins({
        db: client.db,
        settings,
        accountId: f.accountId,
        workspaceId: f.workspaceId,
        orgAgent: { agentId: f.agentId, version: row!.agent_version! },
        endUserSubjectId: orgAgentEndUserSubject(row!.scope_subject_id, initiator),
        mcpServers: [{ id: "stored", name: "STORED", url: url("stored"), cacheToolsList: false }],
        turnTools: [{ kind: "mcp", id: "stored" }],
        providerManaged: () => false,
        publishUnavailable: async () => {
          throw new Error("unexpected unavailable server");
        },
      });
      expect(result!.mcpServers[0]?.headers).toEqual({ "X-Api-Key": "alice-key" });
    }
  }, 180_000);

  test("a chat's own login headers run only for its creator, its end user, or no person", async () => {
    const f = await fixture();
    const chat = await createSession(client.db, {
      accountId: f.accountId,
      workspaceId: f.workspaceId,
      initialMessage: "",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "low",
      latencyMode: "standard",
      sandboxBackend: "none",
      scopeSubjectId: END_USER,
      createdBy: { kind: "subject", subjectId: "user:creator" },
      orgAgent: { agentId: f.agentId, version: 1, promptVersion: 1, overrides: null },
    });
    const resolve = async (turnStarterSubjectId: string | null) => {
      const published: OrgToolServerUnavailable[] = [];
      const result = await resolveOrgAgentToolLogins({
        db: client.db,
        settings,
        accountId: f.accountId,
        workspaceId: f.workspaceId,
        orgAgent: { agentId: f.agentId, version: 1 },
        // No stored login applies: only the chat's headers are in question.
        endUserSubjectId: null,
        chat: { sessionId: chat.id, turnStarterSubjectId },
        mcpServers: [
          {
            id: "chatonly",
            name: "CHATONLY",
            url: url("chatonly"),
            cacheToolsList: false,
            headers: { "X-Chat": "creator-login" },
          },
        ],
        turnTools: [{ kind: "mcp", id: "chatonly" }],
        providerManaged: () => false,
        publishUnavailable: async (payload) => {
          published.push(payload);
        },
      });
      return { headers: result!.mcpServers[0]?.headers ?? null, published };
    };
    for (const starter of [null, "api_key:backend", "user:creator", END_USER]) {
      expect(await resolve(starter)).toEqual({
        headers: { "X-Chat": "creator-login" },
        published: [],
      });
    }
    // Another person's turn: the server needs their own login.
    for (const starter of ["external_user:bob", "user:someone-else"]) {
      expect(await resolve(starter)).toEqual({
        headers: null,
        published: [{ serverKey: "chatonly", name: "CHATONLY", reason: "missing_credentials" }],
      });
    }
  }, 180_000);

  test("OAuth refresh holds a lease, not a row lock, during the token request", async () => {
    const f = await fixture();
    const credentialId = await f.storeLogin(
      "crm",
      { kind: "oauth", accessToken: "old-access", refreshToken: "refresh-1" },
      new Date(Date.now() - 1_000),
    );
    const scope = { accountId: f.accountId, workspaceId: f.workspaceId, credentialId };
    const refreshBefore = new Date(Date.now() + 5 * 60_000);
    const fresh = {
      materialEncrypted: encryptEnvironmentValue(
        key,
        JSON.stringify({ kind: "oauth", accessToken: "new-access", refreshToken: "refresh-2" }),
      ),
      expiresAt: new Date(Date.now() + 3_600_000),
    };
    const during: { lease?: Date | null; lockedNowait?: boolean; concurrent?: string } = {};
    const outcome = await refreshEndUserToolCredential(client.db, {
      ...scope,
      refreshBefore,
      refresh: async () => {
        // No transaction holds the row: another connection locks it at once.
        const locked = await shared.admin.begin(async (tx) => {
          const rows = await tx<{ refresh_lease_until: Date | null }[]>`
            select refresh_lease_until from end_user_tool_credentials
            where id = ${credentialId} for update nowait`;
          return rows[0]!;
        });
        // A second worker sees the lease and does not refresh.
        const second = await refreshEndUserToolCredential(client.db, {
          ...scope,
          refreshBefore,
          refresh: async () => {
            throw new Error("must not refresh twice");
          },
        });
        during.lease = locked.refresh_lease_until;
        during.lockedNowait = true;
        during.concurrent = second.outcome;
        return fresh;
      },
    });
    expect(during.lockedNowait).toBe(true);
    expect(during.lease!.getTime()).toBeGreaterThan(Date.now());
    expect(during.concurrent).toBe("locked");
    expect(outcome.outcome).toBe("refreshed");
    const [row] = await shared.admin<
      { refresh_lease_until: Date | null; version: number; material_encrypted: string }[]
    >`select refresh_lease_until, version, material_encrypted from end_user_tool_credentials
      where id = ${credentialId}`;
    expect(row!.refresh_lease_until).toBeNull();
    expect(row!.version).toBe(2);
    expect(row!.material_encrypted).toBe(fresh.materialEncrypted);
    // Fresh now: nothing to refresh.
    const current = await refreshEndUserToolCredential(client.db, {
      ...scope,
      refreshBefore,
      refresh: async () => {
        throw new Error("must not refresh a current login");
      },
    });
    expect(current.outcome).toBe("current");
  }, 180_000);

  test("a login changed during the token request wins over the refresh (compare-and-set)", async () => {
    const f = await fixture();
    const credentialId = await f.storeLogin(
      "crm",
      { kind: "oauth", accessToken: "old-access", refreshToken: "refresh-1" },
      new Date(Date.now() - 1_000),
    );
    const scope = { accountId: f.accountId, workspaceId: f.workspaceId, credentialId };
    const relogin = encryptEnvironmentValue(
      key,
      JSON.stringify({ kind: "oauth", accessToken: "signed-in-again", refreshToken: "r" }),
    );
    const outcome = await refreshEndUserToolCredential(client.db, {
      ...scope,
      refreshBefore: new Date(Date.now() + 5 * 60_000),
      refresh: async () => {
        // The end user signs in again while the token request runs.
        await shared.admin`update end_user_tool_credentials
          set material_encrypted = ${relogin}, expires_at = now() + interval '1 hour',
            version = version + 1
          where id = ${credentialId}`;
        return {
          materialEncrypted: encryptEnvironmentValue(key, JSON.stringify({ kind: "oauth" })),
          expiresAt: new Date(Date.now() + 3_600_000),
        };
      },
    });
    expect(outcome.outcome).toBe("current");
    if (outcome.outcome !== "current") throw new Error("unreachable");
    expect(outcome.credential.materialEncrypted).toBe(relogin);
    const [row] = await shared.admin<
      { material_encrypted: string; version: number; refresh_lease_until: Date | null }[]
    >`select material_encrypted, version, refresh_lease_until from end_user_tool_credentials
      where id = ${credentialId}`;
    // The new login stays, and the lease is given back.
    expect(row).toEqual({ material_encrypted: relogin, version: 2, refresh_lease_until: null });

    // A refused refresh marks the login and clears its lease.
    await shared.admin`update end_user_tool_credentials set expires_at = now() - interval '1 second'
      where id = ${credentialId}`;
    const refused = await refreshEndUserToolCredential(client.db, {
      ...scope,
      refreshBefore: new Date(Date.now() + 5 * 60_000),
      refresh: async () => null,
    });
    expect(refused.outcome).toBe("failed");
    const [failed] = await shared.admin<
      { refresh_failed_at: Date | null; refresh_lease_until: Date | null }[]
    >`select refresh_failed_at, refresh_lease_until from end_user_tool_credentials
      where id = ${credentialId}`;
    expect(failed!.refresh_failed_at).toBeInstanceOf(Date);
    expect(failed!.refresh_lease_until).toBeNull();
  }, 180_000);
});
