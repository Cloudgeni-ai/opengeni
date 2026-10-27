import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  OPENGENI_CALLING_WORKSPACE_HEADER,
  organizationAccessPresetPermissions,
  signCallingWorkspaceProof,
  type AccessGrant,
  type Permission,
} from "@opengeni/contracts";
import type { ApiRouteDeps, SessionWorkflowClient } from "@opengeni/core";
import {
  claimSessionWorkForAttempt,
  createAdditionalManagedOrganization,
  createDb,
  createManagedOrganization,
  updateOrganizationInferenceResidency,
  withWorkspaceSessionActivityRls,
  type DbClient,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  grantDeferredRuntimeAccess,
  type SharedTestDatabase,
} from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { sql } from "drizzle-orm";

import { createApp } from "../src/app";
import { buildOpenGeniMcpServer } from "../src/mcp/server";

/* End to end through the real app and PostgreSQL. One person belongs to an
   EU-only organization and to one that isn't. An agent in the EU-only
   organization with full access reaches its other EU-only workspace through
   the registered tools, while the other organization's workspace reads as
   not reachable, exactly like one that doesn't exist. Opengeni's own MCP
   endpoints, added to a workspace as a remote MCP server, never give EU-only
   content to a workspace that isn't EU-only. */

const origin = "http://opengeni.test";
const delegationSecret = "workspace-content-flow-e2e-delegation-secret";
const AGENT_PERMISSIONS: Permission[] = [
  "workspace:read",
  "sessions:create",
  "sessions:read",
  "sessions:control",
];
const SESSION_TOOLS = [
  "session_get",
  "session_events",
  "session_wait",
  "session_send_message",
  "session_steer",
  "session_pause",
  "session_resume",
] as const;
const NOT_REACHABLE = "Session not found or access denied";

let shared: SharedTestDatabase;
let client: DbClient;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("workspace-content-flow-e2e");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  // As the runtime will once its migration grants the change function.
  await grantDeferredRuntimeAccess(shared.admin);
  client = createDb(shared.appUrl, { max: 8 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 60_000);

function sessionCookie(response: Response): string {
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.includes("better-auth.session_token="));
  if (!cookie) throw new Error("Better Auth response did not set a session cookie");
  return cookie.split(";", 1)[0]!;
}

function browser(cookie: string): Record<string, string> {
  return { cookie, origin, "sec-fetch-site": "same-origin", "content-type": "application/json" };
}

type ToolResult = { text: string; isError: boolean };

async function call(
  server: unknown,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const tool = (
    server as {
      _registeredTools?: Record<
        string,
        { handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown> }
      >;
    }
  )._registeredTools?.[name];
  if (!tool) throw new Error(`MCP tool not registered: ${name}`);
  try {
    const result = (await tool.handler(args, {})) as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    return {
      text: (result.content ?? []).map((block) => block.text ?? "").join("\n"),
      isError: result.isError === true,
    };
  } catch (error) {
    return { text: error instanceof Error ? error.message : String(error), isError: true };
  }
}

function dependencies(): ApiRouteDeps {
  const noop = async () => undefined;
  return {
    settings: testSettings({
      databaseUrl: shared.adminUrl,
      productAccessMode: "managed",
      betterAuthSecret: "workspace-content-flow-e2e-secret-32b",
      delegationSecret,
      publicBaseUrl: origin,
      sandboxBackend: "none",
      mcpServers: [
        { id: "opengeni", name: "Opengeni", url: `${origin}/mcp`, cacheToolsList: false },
      ],
    }),
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
    objectStorage: {} as never,
    githubStateSecret: "workspace-content-flow-e2e-state",
    documentIndexer: { indexDocument: noop },
    getDocumentServices: () => ({ embedder: undefined }) as never,
    resumeBoxById: async () => {
      throw new Error("sandbox resume is not used with backend=none");
    },
  } as unknown as ApiRouteDeps;
}

describe("EU-only content between workspaces, end to end", () => {
  test("registered tools and Opengeni's own MCP endpoints keep it in EU-only workspaces", async () => {
    const deps = dependencies();
    const app = createApp(deps);

    const email = `content-flow-${crypto.randomUUID()}@example.test`;
    const password = "password1234";
    await app.request("/v1/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Maja Berg", email, password }),
    });
    await shared.admin`update auth_users set email_verified = true where email = ${email}`;
    const cookie = sessionCookie(
      await app.request("/v1/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password, rememberMe: true }),
      }),
    );
    const [authUser] = await shared.admin<
      { id: string }[]
    >`select id from auth_users where email = ${email}`;
    const subjectId = `user:${authUser!.id}`;

    // The EU-only organization (turned on below) and one that isn't.
    const eu = await createManagedOrganization(client.db, {
      subjectId,
      subjectLabel: email,
      name: "Acme EU",
      operationId: crypto.randomUUID(),
    });
    const euOrg = eu.organization.id;
    const home = eu.workspaceId;
    const elsewhere = await createAdditionalManagedOrganization(client.db, {
      subjectId,
      subjectLabel: email,
      name: "Acme US",
      workspaceName: "US team",
      operationId: crypto.randomUUID(),
    });
    const otherOrg = elsewhere.organization.id;
    const otherWorkspace = elsewhere.workspaceId;

    // A second workspace of the EU-only organization.
    const research = crypto.randomUUID();
    await shared.admin`
      insert into workspaces (id, account_id, name) values (${research}, ${euOrg}, 'Research')`;
    await shared.admin`
      insert into workspace_inference_controls (workspace_id, account_id)
      values (${research}, ${euOrg})`;
    await shared.admin`
      insert into workspace_memberships (account_id, workspace_id, subject_id, subject_label, role, permissions)
      values (${euOrg}, ${research}, ${subjectId}, ${email}, 'member',
        ${shared.admin.json(["workspace:read", "sessions:create", "sessions:read", "sessions:control"])})`;
    const insertSession = async (accountId: string, workspaceId: string) => {
      const id = crypto.randomUUID();
      await withWorkspaceSessionActivityRls(client.db, workspaceId, async (scoped) => {
        await scoped.execute(sql`
          insert into sessions (id, account_id, workspace_id, initial_message, model,
            reasoning_effort, latency_mode, sandbox_backend, sandbox_group_id, tool_policy,
            root_session_id, status, created_by_kind, created_by_subject_id, metadata)
          values (${id}, ${accountId}, ${workspaceId}, 'fixture', 'scripted-model', 'medium',
            'standard', 'none', ${id},
            jsonb_build_object('mode', 'explicit', 'inheritedFromSessionId', null), ${id}, 'idle',
            'subject', ${subjectId}, '{}'::jsonb)`);
      });
      return id;
    };
    const researchChat = await insertSession(euOrg, research);
    const otherChat = await insertSession(otherOrg, otherWorkspace);

    // The agent's own session in the EU-only organization, with a live turn.
    const created = await app.request(`/v1/workspaces/${home}/sessions`, {
      method: "POST",
      headers: browser(cookie),
      body: JSON.stringify({ initialMessage: "look at the other chats", model: "scripted-model" }),
    });
    expect(created.status, await created.clone().text()).toBe(202);
    const own = ((await created.json()) as { id: string }).id;
    const attemptId = crypto.randomUUID();
    const claimed = await claimSessionWorkForAttempt(client.db, home, {
      sessionId: own,
      workflowId: `session-${own}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    if (claimed.action !== "claimed") throw new Error(`turn was not claimed: ${claimed.reason}`);
    expect(
      (
        await app.request(`/v1/organizations/${euOrg}/agent-admin-access`, {
          method: "PATCH",
          headers: browser(cookie),
          body: JSON.stringify({ sessionAdminAccessAllowed: true }),
        })
      ).status,
    ).toBe(200);
    const grantAccess = await app.request(`/v1/workspaces/${home}/sessions/${own}/admin-access`, {
      method: "PUT",
      headers: browser(cookie),
      body: "{}",
    });
    expect(grantAccess.status, await grantAccess.clone().text()).toBe(200);

    // Personal API keys, as a person would paste into a remote MCP server.
    const personalKey = async (organizationId: string) => {
      const response = await app.request(`/v1/organizations/${organizationId}/personal-api-keys`, {
        method: "POST",
        headers: browser(cookie),
        body: JSON.stringify({
          name: "Remote MCP",
          access: {
            preset: "full",
            permissions: organizationAccessPresetPermissions("full"),
            workspaceScope: { kind: "all" },
          },
        }),
      });
      expect(response.status, await response.clone().text()).toBe(201);
      return ((await response.json()) as { token: string }).token;
    };
    const euKey = await personalKey(euOrg);
    const otherKey = await personalKey(otherOrg);

    await updateOrganizationInferenceResidency(client.db, {
      organizationId: euOrg,
      actorSubjectId: subjectId,
      actorKind: "browser_person",
      euOnly: true,
      expectedVersion: 0,
      operationId: crypto.randomUUID(),
    });

    const agent: AccessGrant = {
      accountId: euOrg,
      workspaceId: home,
      subjectId: `worker:${own}`,
      permissions: AGENT_PERMISSIONS,
      principalKind: "agent_attempt",
      metadata: {
        sessionId: own,
        turnId: claimed.turn.id,
        attemptId,
        executionGeneration: claimed.turn.executionGeneration,
        firstPartyMcpTools: ["sessions_list", ...SESSION_TOOLS],
      },
    };
    const server = () =>
      buildOpenGeniMcpServer(deps, agent, {
        appActions: {
          access: { origin, dispatch: async (request: Request) => await app.fetch(request) },
          startedByPerson: true,
          fullAccess: true,
        },
      });

    // EU-only to EU-only in one organization: the chat is read.
    const read = await call(server(), "session_get", {
      sessionId: researchChat,
      workspaceId: research,
    });
    expect(read.isError, read.text).toBe(false);
    expect(read.text).toContain(researchChat);
    const members = await call(server(), "admin_action_call", {
      id: "listWorkspaceMembers",
      pathParameters: { workspaceId: research },
      query: {},
    });
    expect(JSON.parse(members.text), members.text).toMatchObject({ status: 200 });

    // The other organization's chat reads exactly like one that doesn't
    // exist: its route runs as the person here and denies it, so the answer
    // never says it exists or how it is set.
    const missing = await call(server(), "session_get", {
      sessionId: crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
    });
    expect(missing.text).toContain(NOT_REACHABLE);
    const arguments_ = {
      sessionId: otherChat,
      workspaceId: otherWorkspace,
      targets: [{ sessionId: otherChat, afterSequence: 0 }],
      maxWaitSeconds: 1,
      text: "Our EU launch plan",
      instruction: "Our EU launch plan",
      reason: "Our EU launch plan",
      idempotencyKey: crypto.randomUUID(),
    };
    for (const name of SESSION_TOOLS) {
      const reached = await call(server(), name, arguments_);
      expect(reached.isError, `${name}: ${reached.text}`).toBe(true);
      expect(reached.text, name).toContain(NOT_REACHABLE);
      expect(reached.text, name).not.toContain("EU-only");
    }
    const otherMembers = await call(server(), "admin_action_call", {
      id: "listWorkspaceMembers",
      pathParameters: { workspaceId: otherWorkspace },
      query: {},
    });
    expect(JSON.parse(otherMembers.text).status, otherMembers.text).toBeGreaterThanOrEqual(400);
    expect(otherMembers.text).not.toContain("EU-only");
    // Nothing reached the other organization's chat.
    const delivered = await shared.admin<Array<{ id: string }>>`
      select id from session_events where session_id = ${otherChat} and type = 'user.message'`;
    expect(delivered).toEqual([]);

    // Opengeni's own MCP endpoints as a remote MCP server of a workspace.
    const toolsList = async (path: string, key: string, calling?: string) =>
      await app.request(path, {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(calling ? { [OPENGENI_CALLING_WORKSPACE_HEADER]: calling } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
    const from = async (accountId: string, workspaceId: string) =>
      await signCallingWorkspaceProof(delegationSecret, { accountId, workspaceId });
    const fromOther = await from(otherOrg, otherWorkspace);
    const fromResearch = await from(euOrg, research);
    for (const path of ["/v1/mcp", `/v1/workspaces/${home}/mcp`]) {
      const plain = await toolsList(path, euKey);
      expect(plain.status, `${path}: ${await plain.clone().text()}`).toBe(200);
      // A workspace that isn't EU-only never reads the EU-only organization.
      const refused = await toolsList(path, euKey, fromOther);
      expect(refused.status, path).toBe(422);
      expect(await refused.json()).toMatchObject({ error: { code: "region_restricted" } });
      // An EU-only workspace does.
      expect((await toolsList(path, euKey, fromResearch)).status, path).toBe(200);
      // A proof Opengeni didn't sign is refused.
      expect((await toolsList(path, euKey, "ogcw_forged.signature")).status, path).toBe(403);
    }
    // Content that isn't EU-only may go to an EU-only workspace.
    expect((await toolsList("/v1/mcp", otherKey, await from(euOrg, home))).status).toBe(200);
  }, 240_000);
});
