import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import postgres from "postgres";
import {
  createApiKey,
  createDb,
  createSession,
  createSessionMcpServers,
  migrate,
  provisionRoles,
  revokeApiKey,
  type DbClient,
} from "@opengeni/db";
import {
  signDelegatedAccessToken,
  type Permission,
  type SessionAuthorizationPort,
} from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { registerSessionRoutes } from "../src/routes/sessions";

const externalAdminUrl = process.env.OPENGENI_TEST_THROWAWAY_DATABASE_ADMIN_URL?.trim();
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let available = true;
const key = Buffer.alloc(32, 7).toString("base64");
const permissions: Permission[] = ["sessions:read", "sessions:control", "mcp_servers:attach"];
const delegationSecret = "rotation-test-delegation-secret";

beforeAll(async () => {
  let appUrl: string;
  if (externalAdminUrl) {
    await migrate(externalAdminUrl);
    await provisionRoles(externalAdminUrl, {
      targetSchema: "public",
      rlsStrategy: "force",
      appRole: "opengeni_app",
      appPassword: "rotation_test_app",
    });
    admin = postgres(externalAdminUrl, { max: 4 });
    const url = new URL(externalAdminUrl);
    url.username = "opengeni_app";
    url.password = "rotation_test_app";
    appUrl = url.toString();
  } else {
    shared = await acquireSharedTestDatabase("api-session-mcp-credential-rotation");
    if (!shared) {
      if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("PostgreSQL required");
      available = false;
      return;
    }
    admin = shared.admin;
    appUrl = shared.appUrl;
  }
  client = createDb(appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  if (shared) await shared.release();
  else await admin?.end();
}, 180_000);

async function fixture(granted = permissions) {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('rotation HTTP test') returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, 'rotation HTTP') returning id`;
  await admin`insert into workspace_inference_controls (account_id, workspace_id)
    values (${account!.id}, ${workspace!.id})`;
  const token = `rotation-test-${crypto.randomUUID()}`;
  const credential = await createApiKey(client.db, {
    accountId: account!.id,
    workspaceId: workspace!.id,
    name: "rotation test",
    prefix: "rotation-test",
    keyHash: createHash("sha256").update(token).digest("hex"),
    permissions: granted,
  });
  const session = await createSession(client.db, {
    accountId: account!.id,
    workspaceId: workspace!.id,
    initialMessage: "",
    resources: [],
    tools: [{ kind: "mcp", id: "external" }],
    metadata: {},
    model: "test-model",
    reasoningEffort: "low",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  await createSessionMcpServers(client.db, {
    accountId: account!.id,
    workspaceId: workspace!.id,
    sessionId: session.id,
    servers: [
      { id: "external", url: "https://tools.example.test/mcp", requireApproval: ["write_record"] },
    ],
  });
  const request = {
    operationKey: crypto.randomUUID(),
    updates: [
      {
        id: "external",
        expectedCredentialVersion: 1,
        expectedServerUrl: "https://tools.example.test/mcp",
        headers: { Authorization: "Bearer synthetic-secret-never-in-output" },
      },
    ],
  };
  const url = `/v1/workspaces/${workspace!.id}/sessions/${session.id}/mcp-credentials/rotate`;
  return {
    accountId: account!.id,
    workspaceId: workspace!.id,
    session,
    credential,
    token,
    request,
    url,
  };
}

function appWith(port?: SessionAuthorizationPort, encryptionKey = key) {
  const app = new Hono();
  const workflowClient = new Proxy(
    {},
    {
      get() {
        throw new Error("rotation must not access workflow scheduling");
      },
    },
  );
  registerSessionRoutes(app, {
    settings: testSettings({
      productAccessMode: "managed",
      environmentsEncryptionKey: encryptionKey,
      delegationSecret,
    }),
    db: client.db,
    bus: new MemoryEventBus(),
    workflowClient,
    objectStorage: null,
    managedAuth: null,
    sessionAuthorization: port,
    getDocumentServices: () => ({}),
  } as unknown as ApiRouteDeps);
  return app;
}

function send(app: Hono, f: Awaited<ReturnType<typeof fixture>>, body: unknown = f.request) {
  return app.request(f.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${f.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("standalone credential rotation HTTP authority", () => {
  test("same API key rotating different sessions completes without a lock upgrade deadlock", async () => {
    if (!available) return;
    const f = await fixture();
    const session = await createSession(client.db, {
      accountId: f.accountId,
      workspaceId: f.workspaceId,
      initialMessage: "",
      resources: [],
      tools: [{ kind: "mcp", id: "external" }],
      metadata: {},
      model: "test-model",
      reasoningEffort: "low",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    await createSessionMcpServers(client.db, {
      accountId: f.accountId,
      workspaceId: f.workspaceId,
      sessionId: session.id,
      servers: [{ id: "external", url: f.request.updates[0]!.expectedServerUrl }],
    });
    const other = { ...f, session, url: f.url.replace(f.session.id, session.id) };
    const responses = await Promise.all([send(appWith(), f), send(appWith(), other)]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
  });

  test("service receipt uses the authenticated subject, not causal service provenance", async () => {
    if (!available) return;
    const f = await fixture();
    const subjectId = "host:rotation-service";
    f.token = await signDelegatedAccessToken(delegationSecret, {
      accountId: f.accountId,
      workspaceId: f.workspaceId,
      subjectId,
      permissions,
      principalKind: "service",
      exp: Math.floor(Date.now() / 1000) + 60,
      serviceInitiator: { kind: "service", subjectId: "host:causal-scheduler" },
    });
    expect((await send(appWith(), f)).status).toBe(200);
    const [receipt] = await admin`select actor_type, actor_subject_id from session_command_receipts
      where target_session_id = ${f.session.id}`;
    expect(receipt).toMatchObject({ actor_type: "service", actor_subject_id: subjectId });
    expect((await send(appWith(), f)).status).toBe(200);
  });

  test("delegated human authority cannot outlive current membership regardless of subject prefix", async () => {
    if (!available) return;
    const f = await fixture();
    // A signed principal kind, not a subject-name prefix, chooses human checks.
    const subjectId = "host:delegated-human";
    f.token = await signDelegatedAccessToken(delegationSecret, {
      accountId: f.accountId,
      workspaceId: f.workspaceId,
      subjectId,
      permissions,
      principalKind: "human_session",
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    expect((await send(appWith(), f)).status).toBe(403);
    await admin`insert into workspace_memberships (account_id, workspace_id, subject_id, permissions)
      values (${f.accountId}, ${f.workspaceId}, ${subjectId}, ${admin.json(permissions)})`;
    expect((await send(appWith(), f)).status).toBe(200);
    await admin`delete from workspace_memberships where workspace_id = ${f.workspaceId}
      and subject_id = ${subjectId}`;
    expect((await send(appWith(), f)).status).toBe(403);
    const [server] = await admin`select credential_version from session_mcp_servers
      where session_id = ${f.session.id}`;
    expect(server!.credential_version).toBe(2);
  });

  test("a delegated human cannot borrow the canonical cookie personal-owner exception", async () => {
    if (!available) return;
    const f = await fixture();
    const subjectId = `user:${crypto.randomUUID()}`;
    await admin`insert into organization_memberships
      (account_id, subject_id, status, personal_workspace_id)
      values (${f.accountId}, ${subjectId}, 'active', ${f.workspaceId})`;
    f.token = await signDelegatedAccessToken(delegationSecret, {
      accountId: f.accountId,
      workspaceId: f.workspaceId,
      subjectId,
      permissions,
      principalKind: "human_session",
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    expect((await send(appWith(), f)).status).toBe(403);
    expect(
      await admin`select id from session_command_receipts
      where target_session_id = ${f.session.id}`,
    ).toHaveLength(0);
  });

  test("returns one secret-safe receipt without message, event, queue, policy, or session mutation", async () => {
    if (!available) return;
    const f = await fixture();
    const before = await admin`select * from sessions where id = ${f.session.id}`;
    const app = appWith();
    const result = await send(app, f);
    expect(result.status).toBe(200);
    const receipt = await result.json();
    expect(receipt.servers).toEqual([{ id: "external", credentialVersion: 2 }]);
    expect(JSON.stringify(receipt)).not.toContain("synthetic-secret");
    expect(await (await send(app, f)).json()).toEqual(receipt);
    expect(
      await (
        await send(app, f, {
          ...f.request,
          updates: [
            {
              ...f.request.updates[0],
              headers: { " authorization ": f.request.updates[0]!.headers.Authorization },
            },
          ],
        })
      ).json(),
    ).toEqual(receipt);
    expect(await admin`select * from sessions where id = ${f.session.id}`).toEqual(before);
    for (const table of [
      "session_events",
      "session_turns",
      "session_system_updates",
      "session_history_items",
    ]) {
      expect(
        await admin`select id from ${admin(table)} where session_id = ${f.session.id}`,
      ).toHaveLength(0);
    }
    const [server] =
      await admin`select * from session_mcp_servers where session_id = ${f.session.id}`;
    expect(server!.require_approval).toEqual(["write_record"]);
    expect(server!.url).toBe(f.request.updates[0]!.expectedServerUrl);
    expect(server!.connection_ref).toBeNull();
    expect(JSON.stringify(server!.headers_encrypted)).not.toContain("synthetic-secret");
  });

  test("requires both ordinary permissions, without an attach or control bypass", async () => {
    if (!available) return;
    for (const granted of [["sessions:control"], ["mcp_servers:attach"]] as Permission[][]) {
      const f = await fixture(granted);
      expect((await send(appWith(), f)).status).toBe(403);
    }
  });

  test("a host may allow session.control while denying this exact action", async () => {
    if (!available) return;
    const f = await fixture();
    const operations: string[] = [];
    const app = appWith({
      authorizeSession: async ({ operation }) => {
        operations.push(operation);
        return operation === "session.mcp.credentials.rotate"
          ? { allowed: false, reason: "forbidden" }
          : { allowed: true, relatedSessionAccess: "target" };
      },
    });
    expect((await send(app, f)).status).toBe(404);
    expect(operations).toEqual(["session.mcp.credentials.rotate"]);
    expect(
      await admin`select id from session_command_receipts where target_session_id = ${f.session.id}`,
    ).toHaveLength(0);
  });

  test("revocation between preflight and mutation denies and does not save a receipt", async () => {
    if (!available) return;
    const f = await fixture();
    let calls = 0;
    const app = appWith({
      authorizeSession: async () => {
        if (++calls === 1) await revokeApiKey(client.db, f.workspaceId, f.credential.id);
        return { allowed: true, relatedSessionAccess: "target" };
      },
    });
    expect((await send(app, f)).status).toBe(403);
    expect(
      await admin`select id from session_command_receipts where target_session_id = ${f.session.id}`,
    ).toHaveLength(0);
  });

  test("replays retain live host authorization and key replacement reports explicit unavailability", async () => {
    if (!available) return;
    const f = await fixture();
    expect((await send(appWith(), f)).status).toBe(200);
    const denied = appWith({
      authorizeSession: async () => ({ allowed: false, reason: "revoked" }),
    });
    expect((await send(denied, f)).status).toBe(404);
    const changedKey = await send(appWith(undefined, Buffer.alloc(32, 9).toString("base64")), f);
    expect(changedKey.status).toBe(503);
    expect(await changedKey.text()).toContain("receipt_key_unavailable");
  });

  test("strict request validation and header failures never echo secret-bearing input", async () => {
    if (!available) return;
    const f = await fixture();
    for (const body of [
      { ...f.request, userMessage: "synthetic-secret-never-in-output" },
      {
        ...f.request,
        updates: [
          { ...f.request.updates[0], headers: { "synthetic-secret-never-in-output @": "value" } },
        ],
      },
      {
        ...f.request,
        updates: [
          {
            ...f.request.updates[0],
            headers: { Authorization: "synthetic-secret-never-in-output\n" },
          },
        ],
      },
    ]) {
      const response = await send(appWith(), f, body);
      expect(response.status).toBe(422);
      expect(await response.text()).not.toContain("synthetic-secret-never-in-output");
    }
  });
});
