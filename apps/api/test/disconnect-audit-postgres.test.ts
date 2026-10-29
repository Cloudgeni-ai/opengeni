import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  organizationAccessPresetPermissions,
  signDelegatedAccessToken,
  type AccessGrant,
} from "@opengeni/contracts";
import {
  claimSessionWorkForAttempt,
  connectSubscriptionCoreClaudeConnection,
  connectSubscriptionCoreCodexConnection,
  createApiKey,
  createConnection,
  createDb,
  createManagedOrganization,
  createSession,
  encryptEnvironmentValue,
  initializeSessionStartAtomically,
  revokeConnection,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import type { Context } from "hono";
import { createApp } from "../src/app";
import {
  disconnectAuditActor,
  stampActionAuditProvenance,
} from "../src/http/disconnect-audit-actor";

/* Every successful disconnect of a model subscription or a connector writes
   one audit_events row naming who did it, when, what, where and through which
   surface (app, api or agent). Refused and repeated disconnects write none.
   Through the real app and PostgreSQL. */

const origin = "http://opengeni.test";
const redirectUri = "http://127.0.0.1:4567/callback";
const DELEGATION_SECRET = "disconnect-audit-delegation-secret";
const encryptionKey = randomBytes(32);
const SECRET_MARKERS = ["access-secret", "refresh-secret", "id-secret", "connector-secret"];
let shared: SharedTestDatabase;
let client: DbClient;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("disconnect-audit");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 8 });
  app = createApp({
    settings: testSettings({
      databaseUrl: shared.adminUrl,
      productAccessMode: "managed",
      betterAuthSecret: "disconnect-audit-better-auth-secret-32-bytes",
      publicBaseUrl: origin,
      delegationSecret: DELEGATION_SECRET,
      environmentsEncryptionKey: encryptionKey.toString("base64"),
      mcpOauthEnabled: true,
      codexSubscriptionEnabled: true,
      claudeSubscriptionEnabled: true,
      integrationsEnabled: true,
    }),
    db: client.db,
    bus: new MemoryEventBus(),
    workflowClient: {} as never,
  });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 60_000);

type Person = {
  cookie: string;
  subjectId: string;
  organizationId: string;
  workspaceId: string;
  workspaceAccountId: string;
};

function browser(cookie: string): Record<string, string> {
  return { cookie, origin, "sec-fetch-site": "same-origin", "content-type": "application/json" };
}

/** A person signed in to the app, with their own organization. */
async function signedInPerson(): Promise<Person> {
  const email = `disconnect-audit-${randomUUID()}@example.test`;
  const password = "password1234";
  await app.request("/v1/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Ada Admin", email, password }),
  });
  await shared.admin`update auth_users set email_verified = true where email = ${email}`;
  const signin = await app.request("/v1/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, rememberMe: true }),
  });
  const setCookie = signin.headers
    .getSetCookie()
    .find((value) => value.includes("better-auth.session_token="));
  if (!setCookie) throw new Error("sign-in did not set a session cookie");
  const cookie = setCookie.split(";", 1)[0]!;
  const [authUser] = await shared.admin<
    { id: string }[]
  >`select id from auth_users where email = ${email}`;
  await createManagedOrganization(client.db, {
    subjectId: `user:${authUser!.id}`,
    subjectLabel: email,
    name: "Audit Org",
    operationId: randomUUID(),
  });
  const me = await app.request("/v1/access/me", { headers: { cookie } });
  expect(me.status).toBe(200);
  const access = (await me.json()) as {
    subjectId: string;
    accountGrants: Array<{ accountId: string }>;
    workspaceGrants: Array<{ workspaceId: string }>;
  };
  const workspaceId = access.workspaceGrants[0]!.workspaceId;
  const [workspace] = await shared.admin<
    { account_id: string }[]
  >`select account_id from workspaces where id = ${workspaceId}`;
  return {
    cookie,
    subjectId: access.subjectId,
    organizationId: access.accountGrants[0]!.accountId,
    workspaceId,
    workspaceAccountId: workspace!.account_id,
  };
}

async function connectCodex(
  person: Person,
  scope: { accountId: string; workspaceId: string | null },
): Promise<string> {
  const providerAccountId = `audit-${randomUUID()}`;
  const result = await connectSubscriptionCoreCodexConnection(client.db, {
    ...scope,
    subjectId: person.subjectId,
    credentialEncrypted: encryptEnvironmentValue(
      encryptionKey,
      JSON.stringify({
        access_token: "access-secret",
        refresh_token: "refresh-secret",
        id_token: "id-secret",
      }),
    ),
    chatgptAccountId: providerAccountId,
    providerAccountId,
    providerSubjectId: `fixture:${randomUUID()}`,
    scopes: null,
    planType: "pro",
    isFedramp: false,
    expiresAt: new Date(Date.now() + 60 * 60_000),
    lastRefreshAt: new Date(),
    accountEmail: null,
    label: "Team Codex",
    connectedBySubjectId: person.subjectId,
  });
  if (result.kind !== "connected") throw new Error(`codex fixture refused: ${result.reason}`);
  return result.id;
}

async function connectClaude(
  person: Person,
  scope: { accountId: string; workspaceId: string | null },
): Promise<string> {
  const accountUuid = randomUUID();
  const result = await connectSubscriptionCoreClaudeConnection(client.db, {
    ...scope,
    subjectId: person.subjectId,
    encryptionKey,
    credential: {
      version: 1,
      token: "sk-ant-oat01-access-secret",
      identity: { accountUuid, deviceId: "d".repeat(64) },
      oauth: {
        refreshToken: "refresh-secret",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        scopes: ["user:inference", "user:profile"],
      },
    },
    providerAccountId: accountUuid,
    accountEmail: "person@example.test",
    planType: "claude_max",
    label: "Team Claude",
    connectedBySubjectId: person.subjectId,
  });
  if (result.kind !== "connected") throw new Error(`claude fixture refused: ${result.reason}`);
  return result.id;
}

/** A shared (non-personal) workspace of the person's organization. */
async function sharedWorkspace(person: Person): Promise<string> {
  const created = await app.request(`/v1/organizations/${person.organizationId}/workspaces`, {
    method: "POST",
    headers: browser(person.cookie),
    body: JSON.stringify({ name: "Shared audit workspace", operationId: randomUUID() }),
  });
  expect(created.status, await created.clone().text()).toBe(201);
  return ((await created.json()) as { id: string }).id;
}

type AuditRow = {
  account_id: string | null;
  workspace_id: string | null;
  subject_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  metadata: Record<string, unknown>;
  occurred_at: Date;
};

async function auditRows(targetId: string): Promise<AuditRow[]> {
  const rows = await shared.admin<AuditRow[]>`
    select account_id, workspace_id, subject_id, action, target_type, target_id, metadata,
      occurred_at
    from audit_events
    where target_id = ${targetId}
      and action in ('connection.disconnected', 'subscription_connection.disconnected')
    order by occurred_at`;
  for (const row of rows) {
    const serialized = JSON.stringify(row.metadata);
    for (const marker of SECRET_MARKERS) expect(serialized).not.toContain(marker);
  }
  return [...rows];
}

/** A live agent attempt in the person's workspace, and its own credential. */
async function agentAttemptToken(person: Person, workspaceId: string) {
  const session = await createSession(client.db, {
    accountId: person.organizationId,
    workspaceId,
    initialMessage: "tidy up connections",
    resources: [],
    metadata: {},
    model: "gpt-test",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    createdBy: { kind: "subject", subjectId: person.subjectId },
    subjectId: person.subjectId,
    visibility: "workspace_shared",
  });
  await initializeSessionStartAtomically(client.db, {
    accountId: person.organizationId,
    workspaceId,
    sessionId: session.id,
    reasoningEffortFallback: "medium",
    createdEventPayload: {},
  });
  const attemptId = randomUUID();
  const claimed = await claimSessionWorkForAttempt(client.db, workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: randomUUID(),
    attemptId,
    dispatchId: randomUUID(),
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error("test attempt was not claimed");
  const token = await signDelegatedAccessToken(DELEGATION_SECRET, {
    accountId: person.organizationId,
    workspaceId,
    subjectId: "worker:first-party-mcp",
    permissions: ["workspace:read", "connections:read", "connections:write"],
    principalKind: "agent_attempt",
    sessionId: session.id,
    turnId: claimed.turn.id,
    attemptId,
    executionGeneration: claimed.turn.executionGeneration,
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  return { token, sessionId: session.id, turnId: claimed.turn.id, attemptId };
}

/** An agent connected to the organization MCP server, with the access the person chose. */
async function connectedAgent(person: Person, preset: "full" | "read_only") {
  const registered = await app.request("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Audit Agent",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "none",
    }),
  });
  expect(registered.status).toBe(201);
  const { client_id: clientId } = (await registered.json()) as { client_id: string };
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorize = new URL("/oauth/authorize", origin);
  for (const [key, value] of Object.entries({
    response_type: "code",
    scope: "mcp:access",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${origin}/v1/mcp`,
    state: "fixture-state",
  }))
    authorize.searchParams.set(key, value);
  const started = await app.request(authorize.pathname + authorize.search, {
    headers: { cookie: person.cookie },
  });
  expect(started.status).toBe(302);
  const requestToken = new URL(started.headers.get("location")!).searchParams.get("request")!;
  const approved = await app.request(`/v1/mcp-connections/requests/${requestToken}`, {
    method: "POST",
    headers: browser(person.cookie),
    body: JSON.stringify({
      decision: "approve",
      organizationId: person.organizationId,
      access: {
        preset,
        permissions: organizationAccessPresetPermissions(preset),
        workspaceScope: { kind: "all" },
      },
    }),
  });
  expect(approved.status, await approved.clone().text()).toBe(200);
  const code = new URL(
    ((await approved.json()) as { redirectTo: string }).redirectTo,
  ).searchParams.get("code")!;
  const tokenResponse = await app.request("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      resource: `${origin}/v1/mcp`,
    }),
  });
  expect(tokenResponse.status).toBe(200);
  const { access_token: token } = (await tokenResponse.json()) as { access_token: string };
  const listed = await app.request(`/v1/organizations/${person.organizationId}/mcp-connections`, {
    headers: { cookie: person.cookie },
  });
  const { connections } = (await listed.json()) as {
    connections: Array<{ id: string; clientName: string }>;
  };
  const connection = connections.find((candidate) => candidate.clientName === "Audit Agent");
  if (!connection) throw new Error("connected agent was not listed");
  let id = 0;
  const call = async (action: string, pathParameters: Record<string, string>) => {
    const response = await app.request("/v1/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++id,
        method: "tools/call",
        params: { name: "opengeni_action_call", arguments: { id: action, pathParameters } },
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result: { isError?: boolean; content: Array<{ text: string }> };
    };
    return body.result.content[0]!.text;
  };
  return { connectionId: connection.id, call };
}

describe("model subscription disconnects are audited", () => {
  test("a person disconnecting a workspace subscription in the app writes one record", async () => {
    const person = await signedInPerson();
    const connectionId = await connectCodex(person, {
      accountId: person.workspaceAccountId,
      workspaceId: person.workspaceId,
    });
    const before = new Date(Date.now() - 1000);
    const removed = await app.request(
      `/v1/workspaces/${person.workspaceId}/codex/accounts/${connectionId}`,
      { method: "DELETE", headers: browser(person.cookie) },
    );
    expect(removed.status, await removed.clone().text()).toBe(200);
    const rows = await auditRows(connectionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      account_id: person.workspaceAccountId,
      workspace_id: person.workspaceId,
      subject_id: person.subjectId,
      action: "subscription_connection.disconnected",
      target_type: "subscription_connection",
      target_id: connectionId,
      metadata: {
        source: "app",
        principalKind: "human_session",
        scope: "workspace",
        provider: "codex",
        connectionKind: "subscription",
        ownership: "personal",
      },
    });
    expect(rows[0]!.occurred_at.getTime()).toBeGreaterThanOrEqual(before.getTime());

    // Disconnecting it again changes nothing and records nothing more (the
    // route's own reply to a repeat is unchanged by auditing).
    await app.request(`/v1/workspaces/${person.workspaceId}/codex/accounts/${connectionId}`, {
      method: "DELETE",
      headers: browser(person.cookie),
    });
    expect(await auditRows(connectionId)).toHaveLength(1);
  }, 120_000);

  test("a shared workspace subscription disconnect is recorded once, never on a repeat", async () => {
    const person = await signedInPerson();
    const workspaceId = await sharedWorkspace(person);
    const connectionId = await connectCodex(person, {
      accountId: person.organizationId,
      workspaceId,
    });
    const disconnect = () =>
      app.request(`/v1/workspaces/${workspaceId}/codex/accounts/${connectionId}`, {
        method: "DELETE",
        headers: browser(person.cookie),
      });
    const removed = await disconnect();
    expect(removed.status, await removed.clone().text()).toBe(200);
    expect(await removed.json()).toMatchObject({ disconnected: true });
    await disconnect();
    const rows = await auditRows(connectionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      account_id: person.organizationId,
      workspace_id: workspaceId,
      subject_id: person.subjectId,
      action: "subscription_connection.disconnected",
      metadata: {
        source: "app",
        principalKind: "human_session",
        scope: "workspace",
        ownership: "shared",
      },
    });

    // Two disconnects racing for one account: one ends it, one record.
    const raced = await connectCodex(person, { accountId: person.organizationId, workspaceId });
    const racing = await Promise.all(
      [0, 1].map(() =>
        app.request(`/v1/workspaces/${workspaceId}/codex/accounts/${raced}`, {
          method: "DELETE",
          headers: browser(person.cookie),
        }),
      ),
    );
    expect(racing.some((response) => response.status === 200)).toBe(true);
    expect(await auditRows(raced)).toHaveLength(1);
  }, 120_000);

  test("a person disconnecting an organization subscription writes one organization record", async () => {
    const person = await signedInPerson();
    const connectionId = await connectCodex(person, {
      accountId: person.organizationId,
      workspaceId: null,
    });
    // Disconnecting an unknown account changes nothing and records nothing.
    const unknown = randomUUID();
    const missing = await app.request(
      `/v1/organizations/${person.organizationId}/codex/accounts/${unknown}`,
      { method: "DELETE", headers: browser(person.cookie) },
    );
    expect(await missing.json()).toMatchObject({ disconnected: false });
    expect(await auditRows(unknown)).toHaveLength(0);

    const removed = await app.request(
      `/v1/organizations/${person.organizationId}/codex/accounts/${connectionId}`,
      { method: "DELETE", headers: browser(person.cookie) },
    );
    expect(removed.status, await removed.clone().text()).toBe(200);
    expect(await removed.json()).toMatchObject({ disconnected: true });
    // A repeated disconnect of the removed account records nothing more.
    await app.request(`/v1/organizations/${person.organizationId}/codex/accounts/${connectionId}`, {
      method: "DELETE",
      headers: browser(person.cookie),
    });
    const rows = await auditRows(connectionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      account_id: person.organizationId,
      workspace_id: null,
      subject_id: person.subjectId,
      action: "subscription_connection.disconnected",
      target_type: "subscription_connection",
      metadata: {
        source: "app",
        principalKind: "human_session",
        scope: "organization",
        provider: "codex",
        ownership: "shared",
      },
    });
  }, 120_000);

  test("an agent connected to the organization disconnecting its subscription is recorded as the agent", async () => {
    const person = await signedInPerson();
    const connectionId = await connectCodex(person, {
      accountId: person.organizationId,
      workspaceId: null,
    });
    const agent = await connectedAgent(person, "full");
    const text = await agent.call(
      "DELETE /v1/organizations/:organizationId/codex/accounts/:accountId",
      {
        organizationId: person.organizationId,
        accountId: connectionId,
      },
    );
    expect(text).toContain('"status":200');
    const rows = await auditRows(connectionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      account_id: person.organizationId,
      workspace_id: null,
      subject_id: person.subjectId,
      metadata: {
        source: "agent",
        principalKind: "organization_mcp_connection",
        via: "organization_mcp",
        organizationMcpConnectionId: agent.connectionId,
        scope: "organization",
      },
    });
  }, 120_000);
});

describe("subscription pool (Claude) disconnects are audited", () => {
  test("organization and workspace Claude account DELETEs each write one record", async () => {
    const person = await signedInPerson();
    const organizationAccount = await connectClaude(person, {
      accountId: person.organizationId,
      workspaceId: null,
    });
    const removed = await app.request(
      `/v1/organizations/${person.organizationId}/claude/accounts/${organizationAccount}`,
      { method: "DELETE", headers: browser(person.cookie) },
    );
    expect(removed.status, await removed.clone().text()).toBe(200);
    const organizationRows = await auditRows(organizationAccount);
    expect(organizationRows).toHaveLength(1);
    expect(organizationRows[0]).toMatchObject({
      account_id: person.organizationId,
      workspace_id: null,
      subject_id: person.subjectId,
      action: "subscription_connection.disconnected",
      target_type: "subscription_connection",
      metadata: { source: "app", scope: "organization", provider: "claude" },
    });

    const workspaceId = await sharedWorkspace(person);
    const workspaceAccount = await connectClaude(person, {
      accountId: person.organizationId,
      workspaceId,
    });
    const workspaceRemoved = await app.request(
      `/v1/workspaces/${workspaceId}/claude/accounts/${workspaceAccount}`,
      { method: "DELETE", headers: browser(person.cookie) },
    );
    expect(workspaceRemoved.status, await workspaceRemoved.clone().text()).toBe(200);
    const workspaceRows = await auditRows(workspaceAccount);
    expect(workspaceRows).toHaveLength(1);
    expect(workspaceRows[0]).toMatchObject({
      account_id: person.organizationId,
      workspace_id: workspaceId,
      subject_id: person.subjectId,
      metadata: { source: "app", scope: "workspace", provider: "claude", ownership: "shared" },
    });
  }, 120_000);
});

describe("connector disconnects are audited", () => {
  test("workspace connection DELETE records the person, an API key, and nothing on repeat", async () => {
    const person = await signedInPerson();
    const scope = { accountId: person.workspaceAccountId, workspaceId: person.workspaceId };
    const byPerson = await createConnection(client.db, {
      ...scope,
      subjectId: null,
      providerDomain: "mcp.audit.example",
      kind: "api_key",
      credentialEncrypted: encryptEnvironmentValue(
        encryptionKey,
        JSON.stringify({ apiKey: "connector-secret" }),
      ),
      createdBySubjectId: person.subjectId,
    });
    const removed = await app.request(
      `/v1/workspaces/${person.workspaceId}/connections/${byPerson.id}`,
      { method: "DELETE", headers: browser(person.cookie) },
    );
    expect(removed.status, await removed.clone().text()).toBe(200);
    const rows = await auditRows(byPerson.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      account_id: person.workspaceAccountId,
      workspace_id: person.workspaceId,
      subject_id: person.subjectId,
      action: "connection.disconnected",
      target_type: "connection",
      target_id: byPerson.id,
      metadata: {
        source: "app",
        principalKind: "human_session",
        scope: "workspace",
        providerDomain: "mcp.audit.example",
        connectionKind: "api_key",
        ownership: "workspace",
      },
    });
    const repeated = await app.request(
      `/v1/workspaces/${person.workspaceId}/connections/${byPerson.id}`,
      { method: "DELETE", headers: browser(person.cookie) },
    );
    expect(repeated.status).toBe(200);
    expect(await auditRows(byPerson.id)).toHaveLength(1);

    const byKey = await createConnection(client.db, {
      ...scope,
      subjectId: null,
      providerDomain: "mcp.audit.example",
      kind: "api_key",
      credentialEncrypted: encryptEnvironmentValue(
        encryptionKey,
        JSON.stringify({ apiKey: "connector-secret" }),
      ),
      createdBySubjectId: person.subjectId,
    });
    const token = `ogk_${randomUUID().replaceAll("-", "")}`;
    const apiKey = await createApiKey(client.db, {
      ...scope,
      name: "automation",
      prefix: token.slice(0, 14),
      keyHash: createHash("sha256").update(token).digest("hex"),
      permissions: ["connections:read", "connections:write", "workspace:read"],
    });
    const viaKey = await app.request(
      `/v1/workspaces/${person.workspaceId}/connections/${byKey.id}`,
      { method: "DELETE", headers: { authorization: `Bearer ${token}` } },
    );
    expect(viaKey.status, await viaKey.clone().text()).toBe(200);
    const keyRows = await auditRows(byKey.id);
    expect(keyRows).toHaveLength(1);
    expect(keyRows[0]!.subject_id).toContain(apiKey.id);
    expect(keyRows[0]!.metadata).toMatchObject({ source: "api", scope: "workspace" });
  }, 120_000);

  test("an agent attempt disconnecting a workspace connection is recorded with its session, turn and attempt", async () => {
    const person = await signedInPerson();
    const workspaceId = await sharedWorkspace(person);
    const connection = await createConnection(client.db, {
      accountId: person.organizationId,
      workspaceId,
      subjectId: null,
      providerDomain: "mcp.audit.example",
      kind: "api_key",
      credentialEncrypted: encryptEnvironmentValue(
        encryptionKey,
        JSON.stringify({ apiKey: "connector-secret" }),
      ),
      createdBySubjectId: person.subjectId,
    });
    const agent = await agentAttemptToken(person, workspaceId);
    const removed = await app.request(
      `/v1/workspaces/${workspaceId}/connections/${connection.id}`,
      { method: "DELETE", headers: { authorization: `Bearer ${agent.token}` } },
    );
    expect(removed.status, await removed.clone().text()).toBe(200);
    const rows = await auditRows(connection.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      account_id: person.organizationId,
      workspace_id: workspaceId,
      action: "connection.disconnected",
      target_type: "connection",
      metadata: {
        source: "agent",
        principalKind: "agent_attempt",
        scope: "workspace",
        sessionId: agent.sessionId,
        turnId: agent.turnId,
        attemptId: agent.attemptId,
      },
    });
  }, 120_000);

  test("organization connected-agent DELETE records the person and the organization, once", async () => {
    const person = await signedInPerson();
    const agent = await connectedAgent(person, "read_only");
    const removed = await app.request(
      `/v1/organizations/${person.organizationId}/mcp-connections/${agent.connectionId}`,
      { method: "DELETE", headers: browser(person.cookie) },
    );
    expect(removed.status, await removed.clone().text()).toBe(204);
    const rows = await auditRows(agent.connectionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      account_id: person.organizationId,
      workspace_id: null,
      subject_id: person.subjectId,
      action: "connection.disconnected",
      target_type: "organization_mcp_connection",
      target_id: agent.connectionId,
      metadata: {
        source: "app",
        principalKind: "human_session",
        scope: "organization",
        provider: "opengeni_mcp",
        clientName: "Audit Agent",
        connectedBySubjectId: person.subjectId,
      },
    });
    const repeated = await app.request(
      `/v1/organizations/${person.organizationId}/mcp-connections/${agent.connectionId}`,
      { method: "DELETE", headers: browser(person.cookie) },
    );
    expect([204, 404]).toContain(repeated.status);
    expect(await auditRows(agent.connectionId)).toHaveLength(1);
  }, 120_000);

  test("a failed audit write rolls the disconnect back", async () => {
    const person = await signedInPerson();
    const connection = await createConnection(client.db, {
      accountId: person.workspaceAccountId,
      workspaceId: person.workspaceId,
      subjectId: null,
      providerDomain: "mcp.audit.example",
      kind: "api_key",
      credentialEncrypted: encryptEnvironmentValue(
        encryptionKey,
        JSON.stringify({ apiKey: "connector-secret" }),
      ),
      createdBySubjectId: person.subjectId,
    });
    // An actor the audit writer refuses: the revocation must not commit alone.
    await expect(
      revokeConnection(
        client.db,
        person.workspaceId,
        connection.id,
        person.subjectId,
        connection.version,
        { audit: { subjectId: " ", source: "app", principalKind: "human_session" } },
      ),
    ).rejects.toThrow("disconnect audit requires an acting subject");
    const [row] = await shared.admin<
      { status: string }[]
    >`select status from connections where id = ${connection.id}`;
    expect(row!.status).toBe("active");
    expect(await auditRows(connection.id)).toHaveLength(0);
  }, 120_000);
});

describe("disconnect audit source", () => {
  const context = (request: Request) => ({ req: { raw: request } }) as unknown as Context;
  const grant = (overrides: Partial<AccessGrant>): AccessGrant =>
    ({
      accountId: randomUUID(),
      workspaceId: randomUUID(),
      subjectId: "subject",
      permissions: [],
      ...overrides,
    }) as AccessGrant;

  test("classifies people, keys, service principals and agents from authenticated provenance", () => {
    const plain = () => context(new Request("http://opengeni.test/x"));
    expect(disconnectAuditActor(plain(), { subjectId: "user:a" })).toEqual({
      subjectId: "user:a",
      source: "app",
      principalKind: "human_session",
    });
    expect(
      disconnectAuditActor(plain(), {
        subjectId: "user:a",
        grant: grant({ principalKind: "human_session" }),
      }),
    ).toMatchObject({ source: "app", principalKind: "human_session" });
    expect(
      disconnectAuditActor(plain(), {
        subjectId: "service:x",
        grant: grant({ principalKind: "service" }),
      }),
    ).toMatchObject({ source: "api", principalKind: "service" });
    expect(
      disconnectAuditActor(plain(), {
        subjectId: "user:a",
        grant: grant({
          principalKind: "human_session",
          metadata: { externalActor: { id: "ext" } },
        }),
      }),
    ).toMatchObject({ source: "api", via: "external_actor" });
    expect(
      disconnectAuditActor(plain(), {
        subjectId: "worker:first-party-mcp",
        grant: grant({
          principalKind: "agent_attempt",
          metadata: { sessionId: "s", turnId: "t", attemptId: "a" },
        }),
      }),
    ).toMatchObject({ source: "agent", sessionId: "s", turnId: "t", attemptId: "a" });
    // A trusted in-process stamp wins over the grant the dispatched request carries.
    const stampedRequest = new Request("http://opengeni.test/x");
    stampActionAuditProvenance(stampedRequest, {
      source: "agent",
      principalKind: "agent_attempt",
      via: "session_admin_access",
      sessionId: "s2",
    });
    expect(
      disconnectAuditActor(context(stampedRequest), {
        subjectId: "user:a",
        grant: grant({ principalKind: "human_session" }),
      }),
    ).toEqual({
      subjectId: "user:a",
      source: "agent",
      principalKind: "agent_attempt",
      via: "session_admin_access",
      sessionId: "s2",
    });
  });
});
