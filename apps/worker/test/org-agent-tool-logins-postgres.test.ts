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
import {
  bootstrapWorkspace,
  createDb,
  decryptEnvironmentValue,
  encryptEnvironmentValue,
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
    ["team", "shared_key", encryptEnvironmentValue(key, JSON.stringify({ "X-Team-Key": "team-secret" })), null],
    ["open", "none", null, null],
  ];
  for (const [serverKey, authMode, sharedHeaders, oauthRefresh] of seeds) {
    const [row] = await shared.admin<{ id: string }[]>`
      insert into organization_tool_servers (account_id, server_key, name, url, auth_mode,
        shared_headers_encrypted, oauth_refresh)
      values (${accountId}, ${serverKey}, ${serverKey.toUpperCase()}, ${url(serverKey)}, ${authMode},
        ${sharedHeaders}, ${oauthRefresh === null ? null : JSON.stringify(oauthRefresh)}::jsonb)
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
      ${JSON.stringify({ toolServers: seeds.map(([server]) => ({ server })) })}::jsonb, '{}'::jsonb,
      'console', ${`sha256:${createHash("sha256").update(agentId).digest("hex")}`})`;
  async function storeLogin(
    serverKey: string,
    material: Record<string, unknown>,
    expiresAt: Date | null,
  ) {
    await shared.admin`insert into end_user_tool_credentials (account_id, workspace_id,
        end_user_subject_id, tool_server_id, kind, material_encrypted, expires_at)
      values (${accountId}, ${workspaceId}, ${END_USER}, ${servers[serverKey]!},
        ${String(material["kind"])}, ${encryptEnvironmentValue(key, JSON.stringify(material))},
        ${expiresAt})`;
  }
  return { accountId, workspaceId, agentId, servers, storeLogin };
}

const sessionServers = () => [
  ...["provider", "crm", "stored", "expired", "nologin", "team", "open"].map((id) => ({
    id,
    name: id.toUpperCase(),
    url: url(id),
    cacheToolsList: false,
  })),
  { id: "chatonly", name: "CHATONLY", url: url("chatonly"), cacheToolsList: false, headers: { "X-Chat": "chat-login" } },
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
    expect(orgAgentEndUserSubject("external_user:a", "user:b")).toBe("external_user:a");
    expect(orgAgentEndUserSubject(null, "external_user:b")).toBe("external_user:b");
    expect(orgAgentEndUserSubject("user:a", null)).toBeNull();
  }, 180_000);
});
