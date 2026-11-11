// Credential profile REST routes through the composed app: reading needs
// secrets:list; changing needs secrets:write plus workspace:admin (workspace)
// or sessions:control and tool-policy access (chat); invalid profiles answer
// 422; a child chat's view shows what it inherits. References only.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { signDelegatedAccessToken, type AccessGrant, type Permission } from "@opengeni/contracts";
import {
  createDb,
  createSession,
  createWorkspace,
  ensureManagedAccessForUser,
  type DbClient,
} from "@opengeni/db";
import type { ApiRouteDeps, SessionWorkflowClient } from "@opengeni/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { Hono } from "hono";
import { createApp } from "../src/app";
import { registerSecretTools } from "../src/mcp/secret-tools";

const SECRET = "credential-profile-routes-test-secret";
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const settings = testSettings({ productAccessMode: "managed", delegationSecret: SECRET });
/** A secret reference, assembled so no tool on the way resolves it early. */
const ref = (path: string) => ["{", "{secret:", path, "}}"].join("");

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;

setDefaultTimeout(120_000);

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api-credential-profile-routes");
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error("PostgreSQL test database unavailable while OPENGENI_REQUIRE_REAL_DB=1");
    }
    available = false;
    return;
  }
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  // Dropping the database waits for a checkpoint, which is slow on a busy cluster.
  await shared?.release();
}, 180_000);

let cachedApp: Hono | null = null;
function app(): Hono {
  const noop = async () => undefined;
  cachedApp ??= createApp({
    settings,
    db: client.db,
    bus: new MemoryEventBus(),
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
  });
  return cachedApp;
}

type Grant = { accountId: string; workspaceId: string; subjectId: string };

async function bearer(grant: Grant, permissions: Permission[]): Promise<string> {
  return `Bearer ${await signDelegatedAccessToken(SECRET, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: grant.subjectId,
    permissions,
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1000) + 3_600,
  })}`;
}

const MEMBER: Permission[] = ["sessions:read", "sessions:control", "secrets:list", "secrets:write"];
const ADMIN: Permission[] = [...MEMBER, "workspace:admin"];

async function fixture() {
  const admin = shared!.admin;
  const userId = `credential-profile-routes-${crypto.randomUUID()}`;
  const access = await ensureManagedAccessForUser(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Credential profile routes",
  });
  const accountId = access.workspaceGrants[0]!.accountId;
  const workspace = await createWorkspace(client.db, { accountId, name: "Credential profiles" });
  const workspaceId = workspace.id;
  const person = async (label: string, role: "member" | "admin", permissions: Permission[]) => {
    const subjectId = `user:credential-profile-${label}-${crypto.randomUUID()}`;
    const [personal] = await admin<{ id: string }[]>`
      insert into workspaces (account_id, name) values (${accountId}::uuid, 'Personal')
      returning id::text as id`;
    await admin`
      insert into organization_memberships (account_id, subject_id, status, role, personal_workspace_id)
      values (${accountId}::uuid, ${subjectId}, 'active', ${role}, ${personal!.id}::uuid)`;
    await admin`
      insert into workspace_memberships (account_id, workspace_id, subject_id, role, permissions)
      values (${accountId}::uuid, ${workspaceId}::uuid, ${subjectId}, ${role === "admin" ? "admin" : "member"},
        ${JSON.stringify(permissions)}::text::jsonb)`;
    return { accountId, workspaceId, subjectId };
  };
  return {
    accountId,
    workspaceId,
    member: await person("member", "member", MEMBER),
    otherMember: await person("other", "member", MEMBER),
    viewer: await person("viewer", "member", ["sessions:read", "secrets:list"]),
    workspaceAdmin: await person("admin", "admin", ADMIN),
  };
}

async function call(
  method: string,
  path: string,
  authorization: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const response = await app().request(path, {
    method,
    headers: {
      Authorization: authorization,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

describe("credential profile routes", () => {
  test("workspace and chat profiles: permissions, validation and inheritance", async () => {
    if (!available) return;
    const f = await fixture();
    const base = `/v1/workspaces/${f.workspaceId}`;
    const asAdmin = await bearer(f.workspaceAdmin, ADMIN);
    const asMember = await bearer(f.member, MEMBER);
    const asViewer = await bearer(f.viewer, ["sessions:read", "secrets:list"]);
    const workspaceProfile = {
      entries: [
        { name: "GH_TOKEN", reference: ref("cloud-auth/CLOUDGENI_GITHUB_TOKEN/value") },
        { name: "AZURE_CLIENT_ID", reference: ref("cloud-auth/AZURE_CLIENT_ID/value") },
      ],
      gitHelper: true,
    };

    expect((await call("GET", `${base}/credential-profile`, asViewer)).json).toEqual({
      profile: null,
    });
    // Changing the workspace profile needs workspace admin and secrets:write.
    expect(
      (await call("PUT", `${base}/credential-profile`, asMember, workspaceProfile)).status,
    ).toBe(403);
    expect(
      (await call("PUT", `${base}/credential-profile`, asViewer, workspaceProfile)).status,
    ).toBe(403);
    const saved = await call("PUT", `${base}/credential-profile`, asAdmin, workspaceProfile);
    expect(saved.status).toBe(200);
    expect(saved.json.profile).toMatchObject({
      scope: "workspace",
      sessionId: null,
      entries: workspaceProfile.entries,
      gitHelper: true,
    });
    const read = await call("GET", `${base}/credential-profile`, asViewer);
    expect(read.json.profile.entries).toEqual(workspaceProfile.entries);

    const invalid = await call("PUT", `${base}/credential-profile`, asAdmin, {
      entries: [{ name: "OPENGENI_X", reference: "plain-value" }],
    });
    expect(invalid.status).toBe(422);
    expect(invalid.json.error).toBe("credential_profile_invalid");
    expect(JSON.stringify(invalid.json)).not.toContain("plain-value");

    const session = (parentSessionId?: string, visibility?: "user_private") =>
      createSession(client.db, {
        accountId: f.accountId,
        workspaceId: f.workspaceId,
        initialMessage: "credential profile",
        resources: [],
        metadata: {},
        model: "scripted-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
        createdBy: { kind: "subject", subjectId: f.member.subjectId },
        subjectId: f.member.subjectId,
        ...(parentSessionId ? { parentSessionId } : {}),
        ...(visibility ? { visibility } : {}),
      });
    const parent = await session();
    const child = await session(parent.id);
    const chatProfile = {
      entries: [{ name: "AZURE_CLIENT_ID", reference: ref("other/AZURE_CLIENT_ID/value") }],
    };
    // A viewer cannot change a chat's profile.
    expect(
      (await call("PUT", `${base}/sessions/${parent.id}/credential-profile`, asViewer, chatProfile))
        .status,
    ).toBe(403);
    const chat = await call(
      "PUT",
      `${base}/sessions/${parent.id}/credential-profile`,
      asMember,
      chatProfile,
    );
    expect(chat.status).toBe(200);
    expect(chat.json.profile).toMatchObject({ scope: "session", sessionId: parent.id });

    const inherited = await call(
      "GET",
      `${base}/sessions/${child.id}/credential-profile`,
      asMember,
    );
    expect(inherited.status).toBe(200);
    expect(inherited.json.profile).toBeNull();
    expect(inherited.json.effective).toEqual({
      entries: [
        {
          ...workspaceProfile.entries[0],
          source: { scope: "workspace", sessionId: null },
        },
        { ...chatProfile.entries[0], source: { scope: "session", sessionId: parent.id } },
      ],
      gitHelper: true,
    });

    const missing = await call(
      "GET",
      `${base}/sessions/${crypto.randomUUID()}/credential-profile`,
      asMember,
    );
    expect(missing.status).toBe(404);

    // A member who cannot see a private chat cannot read or change its profile.
    const privateChat = await session(undefined, "user_private");
    const asOther = await bearer(f.otherMember, MEMBER);
    const hidden = `${base}/sessions/${privateChat.id}/credential-profile`;
    expect((await call("GET", hidden, asOther)).status).toBe(404);
    expect((await call("PUT", hidden, asOther, chatProfile)).status).toBe(404);
    expect((await call("GET", hidden, asMember)).status).toBe(200);

    // An empty profile clears the level.
    const cleared = await call(
      "PUT",
      `${base}/sessions/${parent.id}/credential-profile`,
      asMember,
      {
        entries: [],
      },
    );
    expect(cleared.status).toBe(200);
    expect(cleared.json.profile).toBeNull();
    expect(cleared.json.effective.entries).toHaveLength(2);
  });
});

describe("credential profile agent tools", () => {
  /** A running turn and attempt for the session, as the worker's first-party MCP sees it. */
  async function liveAgentGrant(
    f: Awaited<ReturnType<typeof fixture>>,
    sessionId: string,
    permissions: Permission[],
  ): Promise<AccessGrant> {
    const admin = shared!.admin;
    const [turn] = await admin<{ id: string }[]>`
      insert into session_turns (
        account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
        status, position, prompt, model, reasoning_effort, sandbox_backend,
        execution_generation, initiator_kind, initiator_subject_id, initiator_context, surface
      ) values (
        ${f.accountId}, ${f.workspaceId}, ${sessionId}, gen_random_uuid(),
        ${`profile-wf-${crypto.randomUUID()}`}, 'running',
        (select coalesce(max(position), 0) + 1 from session_turns where session_id = ${sessionId}),
        'Agent work', 'scripted-model', 'medium', 'none', 1, 'subject', ${f.member.subjectId},
        '{"accepted":true}'::jsonb, 'web'
      ) returning id`;
    const attemptId = crypto.randomUUID();
    await admin.begin(async (tx) => {
      await tx`update sessions set active_turn_id = ${turn!.id} where id = ${sessionId}`;
      await tx`update session_turns set active_attempt_id = ${attemptId} where id = ${turn!.id}`;
      await tx`insert into session_turn_attempts (
          id, account_id, workspace_id, session_id, turn_id, execution_generation,
          state, temporal_workflow_id, temporal_workflow_run_id, temporal_activity_id,
          verified_control_revision, mcp_approval_policies
        ) values (
          ${attemptId}, ${f.accountId}, ${f.workspaceId}, ${sessionId}, ${turn!.id}, 1,
          'running', 'profile-wf', ${`run-${attemptId}`}, ${`activity-${attemptId}`}, 0,
          '{}'::jsonb
        )`;
    });
    return {
      accountId: f.accountId,
      workspaceId: f.workspaceId,
      subjectId: f.member.subjectId,
      permissions,
      permissionMode: "explicit",
      principalKind: "agent_attempt",
      metadata: { sessionId, turnId: turn!.id, attemptId, executionGeneration: 1 },
    };
  }

  async function tools(grant: AccessGrant, sessionId: string) {
    const server = new McpServer({ name: "credential-profile-tools", version: "1" });
    registerSecretTools(
      server,
      { db: client.db, settings } as unknown as ApiRouteDeps,
      grant,
      sessionId,
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: "credential-profile-tools", version: "1" });
    await server.connect(serverTransport);
    await mcp.connect(clientTransport);
    return mcp;
  }

  const body = (result: Awaited<ReturnType<Client["callTool"]>>) =>
    JSON.parse((result.content as Array<{ text: string }>)[0]!.text);

  test("set and get keep references; workspace scope needs workspace admin", async () => {
    if (!available) return;
    const f = await fixture();
    const parent = await createSession(client.db, {
      accountId: f.accountId,
      workspaceId: f.workspaceId,
      initialMessage: "credential profile tools",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      createdBy: { kind: "subject", subjectId: f.member.subjectId },
      subjectId: f.member.subjectId,
    });
    const child = await createSession(client.db, {
      accountId: f.accountId,
      workspaceId: f.workspaceId,
      initialMessage: "credential profile child",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      createdBy: { kind: "subject", subjectId: f.member.subjectId },
      subjectId: f.member.subjectId,
      parentSessionId: parent.id,
    });
    const agentPermissions: Permission[] = ["secrets:list", "secrets:write", "sessions:control"];
    const parentGrant = await liveAgentGrant(f, parent.id, agentPermissions);
    const agent = await tools(parentGrant, parent.id);
    try {
      const reference = ref("cloud-auth/CLOUDGENI_GITHUB_TOKEN/value");
      const set = await agent.callTool({
        name: "secret_profile_set",
        arguments: { entries: [{ name: "GH_TOKEN", reference }], gitHelper: true },
      });
      expect(set.isError).toBeFalsy();
      expect(body(set).profile).toMatchObject({
        scope: "session",
        sessionId: parent.id,
        entries: [{ name: "GH_TOKEN", reference }],
        gitHelper: true,
      });
      const got = body(await agent.callTool({ name: "secret_profile_get", arguments: {} }));
      expect(got.effective.entries).toEqual([
        { name: "GH_TOKEN", reference, source: { scope: "session", sessionId: parent.id } },
      ]);

      // The workspace profile needs workspace admin.
      const denied = await agent.callTool({
        name: "secret_profile_set",
        arguments: { scope: "workspace", entries: [{ name: "GH_TOKEN", reference }] },
      });
      expect(denied.isError).toBe(true);
      expect(body(denied).error.code).toBe("permission_denied");

      const invalid = await agent.callTool({
        name: "secret_profile_set",
        arguments: { entries: [{ name: "GH_TOKEN", reference: "ghp_notAReference" }] },
      });
      expect(invalid.isError).toBe(true);
      expect(body(invalid).error.code).toBe("credential_profile_invalid");
      expect(JSON.stringify(body(invalid))).not.toContain("ghp_notAReference");
    } finally {
      await agent.close();
    }

    // The child chat's agent sees what it inherits from its parent.
    const childAgent = await tools(await liveAgentGrant(f, child.id, agentPermissions), child.id);
    try {
      const inherited = body(
        await childAgent.callTool({ name: "secret_profile_get", arguments: {} }),
      );
      expect(inherited.profile).toBeNull();
      expect(inherited.effective).toMatchObject({
        entries: [{ name: "GH_TOKEN", source: { scope: "session", sessionId: parent.id } }],
        gitHelper: true,
      });
    } finally {
      await childAgent.close();
    }

    const adminAgent = await tools(
      { ...parentGrant, permissions: [...agentPermissions, "workspace:admin"] },
      parent.id,
    );
    try {
      const saved = await adminAgent.callTool({
        name: "secret_profile_set",
        arguments: {
          scope: "workspace",
          entries: [{ name: "AZURE_TENANT_ID", reference: ref("T") }],
        },
      });
      expect(saved.isError).toBeFalsy();
      const workspace = body(
        await adminAgent.callTool({
          name: "secret_profile_get",
          arguments: { scope: "workspace" },
        }),
      );
      expect(workspace.profile.entries).toEqual([{ name: "AZURE_TENANT_ID", reference: ref("T") }]);
    } finally {
      await adminAgent.close();
    }
  });
});
