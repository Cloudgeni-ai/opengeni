import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AccessGrant, Permission } from "@opengeni/contracts";
import type { ApiRouteDeps, SessionWorkflowClient } from "@opengeni/core";
import {
  claimSessionWorkForAttempt,
  createDb,
  createManagedOrganization,
  withWorkspaceSessionActivityRls,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { sql } from "drizzle-orm";

import { createApp } from "../src/app";
import { buildOpenGeniMcpServer } from "../src/mcp/server";
import { errorMessage } from "@opengeni/contracts/values";

/* End to end through the real app and PostgreSQL: an agent whose session has
   full access uses the ordinary session tools on a chat in another workspace
   of the person who gave that access, as that person. Without full access,
   or for a chat that person can't open, the answer says so plainly and never
   whether the chat exists. */

const origin = "http://opengeni.test";
const link = (workspaceId: string, sessionId: string) =>
  `${origin}/workspaces/${workspaceId}/sessions/${sessionId}`;
const AGENT_PERMISSIONS: Permission[] = [
  "workspace:read",
  "sessions:create",
  "sessions:read",
  "sessions:control",
];
const SESSION_TOOLS = [
  "sessions_list",
  "session_get",
  "session_events",
  "session_wait",
  "session_send_message",
  "session_steer",
  "session_pause",
  "session_resume",
] as const;

let shared: SharedTestDatabase;
let client: DbClient;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-tools-other-workspace");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
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
    return { text: errorMessage(error), isError: true };
  }
}

function dependencies(): ApiRouteDeps {
  const noop = async () => undefined;
  return {
    settings: testSettings({
      databaseUrl: shared.adminUrl,
      productAccessMode: "managed",
      betterAuthSecret: "session-tools-other-workspace-secret-32b",
      publicBaseUrl: origin,
      sandboxBackend: "none",
      // Every deployment lists its own first-party server; the workspace tool
      // gateway runs it in process.
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
    githubStateSecret: "session-tools-other-workspace-state",
    documentIndexer: { indexDocument: noop },
    getDocumentServices: () => ({ embedder: undefined }) as never,
    resumeBoxById: async () => {
      throw new Error("sandbox resume is not used with backend=none");
    },
  } as unknown as ApiRouteDeps;
}

describe("session tools on a chat in another workspace", () => {
  test("full access reaches it as the person; otherwise a plain, non-revealing refusal", async () => {
    const deps = dependencies();
    const app = createApp(deps);

    const email = `other-workspace-${crypto.randomUUID()}@example.test`;
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
    await createManagedOrganization(client.db, {
      subjectId,
      subjectLabel: email,
      name: "Acme Robotics",
      operationId: crypto.randomUUID(),
    });
    const access = (await (await app.request("/v1/access/me", { headers: { cookie } })).json()) as {
      accountGrants: Array<{ accountId: string }>;
      workspaceGrants: Array<{ workspaceId: string }>;
    };
    const organizationId = access.accountGrants[0]!.accountId;
    const home = access.workspaceGrants[0]!.workspaceId;

    // A second workspace of the same person, with a chat in it.
    const other = crypto.randomUUID();
    await shared.admin`
      insert into workspaces (id, account_id, name) values (${other}, ${organizationId}, 'Research')`;
    await shared.admin`
      insert into workspace_inference_controls (workspace_id, account_id)
      values (${other}, ${organizationId})`;
    await shared.admin`
      insert into workspace_memberships (account_id, workspace_id, subject_id, subject_label, role, permissions)
      values (${organizationId}, ${other}, ${subjectId}, ${email}, 'member',
        ${shared.admin.json(["workspace:read", "sessions:create", "sessions:read", "sessions:control"])})`;
    const insertSession = async (workspaceId: string) => {
      const id = crypto.randomUUID();
      await withWorkspaceSessionActivityRls(client.db, workspaceId, async (scoped) => {
        await scoped.execute(sql`
          insert into sessions (id, account_id, workspace_id, initial_message, model,
            reasoning_effort, latency_mode, sandbox_backend, sandbox_group_id, tool_policy,
            root_session_id, status, created_by_kind, created_by_subject_id, metadata)
          values (${id}, ${organizationId}, ${workspaceId}, 'fixture', 'scripted-model', 'medium',
            'standard', 'none', ${id},
            jsonb_build_object('mode', 'explicit', 'inheritedFromSessionId', null), ${id}, 'idle',
            'subject', ${subjectId}, '{}'::jsonb)`);
      });
      return id;
    };
    const target = await insertSession(other);
    // A chat in this workspace the agent's tools reach without workspaceId.
    const local = await insertSession(home);

    // The agent's own session in the home workspace, with a live turn.
    const created = await app.request(`/v1/workspaces/${home}/sessions`, {
      method: "POST",
      headers: browser(cookie),
      body: JSON.stringify({ initialMessage: "look at the other chat", model: "scripted-model" }),
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
    const agent: AccessGrant = {
      accountId: organizationId,
      workspaceId: home,
      subjectId: `worker:${own}`,
      permissions: AGENT_PERMISSIONS,
      principalKind: "agent_attempt",
      metadata: {
        sessionId: own,
        turnId: claimed.turn.id,
        attemptId,
        executionGeneration: claimed.turn.executionGeneration,
        firstPartyMcpTools: [...SESSION_TOOLS],
      },
    };
    // As the API builds it for a chat a person started: app actions always,
    // with the live full-access fact. Without full access the chat still acts
    // for its sender in this workspace, but never reaches another one.
    const appActions = (fullAccess: boolean) => ({
      access: { origin, dispatch: async (request: Request) => await app.fetch(request) },
      startedByPerson: true,
      fullAccess,
    });
    const withFullAccess = () =>
      buildOpenGeniMcpServer(deps, agent, { appActions: appActions(true) });
    const withoutFullAccess = () =>
      buildOpenGeniMcpServer(deps, agent, { appActions: appActions(false) });

    // Every session tool offers workspaceId, with or without full access.
    for (const name of SESSION_TOOLS.filter((tool) => tool !== "sessions_list")) {
      const tools = (
        withoutFullAccess() as unknown as {
          _registeredTools: Record<string, { inputSchema?: unknown }>;
        }
      )._registeredTools;
      expect(JSON.stringify(tools[name]?.inputSchema ?? {}), name).toContain("workspaceId");
    }

    // Without full access: session tools reach only this workspace, said
    // plainly, whether or not the chat exists.
    const refusedReal = await call(withoutFullAccess(), "session_get", {
      sessionId: target,
      workspaceId: other,
    });
    const refusedMissing = await call(withoutFullAccess(), "session_get", {
      sessionId: crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
    });
    expect(refusedReal.isError).toBe(true);
    expect(refusedReal.text).toContain("Session tools reach only chats in this workspace");
    expect(refusedMissing).toEqual(refusedReal);
    // A miss here, without workspaceId, explains how another workspace's chat
    // is reached, without saying whether it exists.
    const localMiss = await call(withoutFullAccess(), "session_events", { sessionId: target });
    expect(localMiss.isError).toBe(true);
    expect(localMiss.text).toContain("Session not found or access denied");
    expect(localMiss.text).toContain("needs this session to have full access");
    const localMissSend = await call(withoutFullAccess(), "session_send_message", {
      sessionId: target,
      text: "hello",
      idempotencyKey: crypto.randomUUID(),
    });
    expect(localMissSend.isError).toBe(true);
    expect(localMissSend.text).toContain("session_send_message_not_found_or_denied");
    expect(localMissSend.text).toContain("needs this session to have full access");
    expect((await call(withoutFullAccess(), "session_get", { sessionId: local })).isError).toBe(
      false,
    );

    // Each chat comes with its canonical link: its own (a self read), and
    // every listed row.
    const self = await call(withoutFullAccess(), "session_get", {});
    expect(self.isError, self.text).toBe(false);
    expect(JSON.parse(self.text)).toMatchObject({ id: own, chatUrl: link(home, own) });
    for (const detail of ["compact", "full"] as const) {
      const listed = await call(withoutFullAccess(), "sessions_list", { limit: 50, detail });
      expect(listed.isError, listed.text).toBe(false);
      const rows = (
        JSON.parse(listed.text) as { sessions: Array<{ id: string; chatUrl?: string }> }
      ).sessions;
      expect(rows.find((row) => row.id === local)?.chatUrl, detail).toBe(link(home, local));
    }

    // The person allows full access and gives it to this session.
    expect(
      (
        await app.request(`/v1/organizations/${organizationId}/agent-admin-access`, {
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

    // Read it.
    const read = await call(withFullAccess(), "session_get", {
      sessionId: target,
      workspaceId: other,
    });
    expect(read.isError, read.text).toBe(false);
    expect(read.text).toContain(target);
    // Its link is in its own workspace.
    expect(JSON.parse(read.text)).toMatchObject({ id: target, chatUrl: link(other, target) });

    // Message it: the person's prompt, sent by this session for them.
    const idempotencyKey = crypto.randomUUID();
    const sent = await call(withFullAccess(), "session_send_message", {
      sessionId: target,
      workspaceId: other,
      text: "What went wrong here?",
      idempotencyKey,
    });
    expect(sent.isError, sent.text).toBe(false);
    const receipt = JSON.parse(sent.text) as {
      committed: boolean;
      nextAction?: { tool: string; arguments: Record<string, unknown> };
    };
    expect(receipt.committed).toBe(true);
    // Follow-ups name the chat's workspace so they keep reaching it.
    expect(receipt.nextAction).toEqual({
      tool: "session_get",
      arguments: { sessionId: target, workspaceId: other },
    });
    // The person's prompt, as with every other action this session's full
    // access takes for them.
    const [message] = await shared.admin<
      Array<{ workspace_id: string; payload: Record<string, unknown> }>
    >`select workspace_id, payload from session_events
      where session_id = ${target} and type = 'user.message'`;
    expect(message).toMatchObject({
      workspace_id: other,
      payload: { text: "What went wrong here?", initiator: { kind: "subject", subjectId } },
    });
    const turns = await shared.admin<
      Array<{ initiator_subject_id: string; source: string }>
    >`select initiator_subject_id, source from session_turns
      where session_id = ${target}`;
    expect(turns).toEqual([{ initiator_subject_id: subjectId, source: "api" }]);
    // It wasn't sent from the app's own sign-in, so the turn it starts there
    // can never confirm app-action changes in that chat.
    const turnGrants = await shared.admin<Array<{ changes: string }>>`
      select g.changes from session_turn_app_action_grants g
      join session_turns t on t.id = g.turn_id
      where t.session_id = ${target}`;
    expect(turnGrants.filter((grant) => grant.changes === "confirm")).toEqual([]);
    // Retrying with the same key replays, never duplicates.
    const replayed = await call(withFullAccess(), "session_send_message", {
      sessionId: target,
      workspaceId: other,
      text: "What went wrong here?",
      idempotencyKey,
    });
    expect(replayed.isError, replayed.text).toBe(false);
    expect(JSON.parse(replayed.text)).toMatchObject({ outcome: "replayed" });

    // Its history, and a bounded wait on it.
    const events = await call(withFullAccess(), "session_events", {
      sessionId: target,
      workspaceId: other,
      view: "debug",
    });
    expect(events.isError, events.text).toBe(false);
    expect(events.text).toContain('"turn.queued"');
    expect(events.text).toContain(subjectId);
    const waited = await call(withFullAccess(), "session_wait", {
      targets: [{ sessionId: target, afterSequence: 1_000_000 }],
      workspaceId: other,
      maxWaitSeconds: 1,
    });
    expect(waited.isError, waited.text).toBe(false);

    // Steer, pause and resume it, as the person.
    const steered = await call(withFullAccess(), "session_steer", {
      sessionId: target,
      workspaceId: other,
      instruction: "Stop and summarize instead.",
      idempotencyKey: crypto.randomUUID(),
    });
    expect(steered.isError, steered.text).toBe(false);
    expect(JSON.parse(steered.text)).toMatchObject({ committed: true });
    for (const name of ["session_pause", "session_resume"] as const) {
      const controlled = await call(withFullAccess(), name, {
        sessionId: target,
        workspaceId: other,
        idempotencyKey: crypto.randomUUID(),
      });
      expect(controlled.isError, `${name}: ${controlled.text}`).toBe(false);
    }

    // A chat that doesn't exist there, and a workspace the person can't use,
    // read exactly alike.
    const missingChat = await call(withFullAccess(), "session_get", {
      sessionId: crypto.randomUUID(),
      workspaceId: other,
    });
    const missingWorkspace = await call(withFullAccess(), "session_get", {
      sessionId: target,
      workspaceId: crypto.randomUUID(),
    });
    expect(missingChat.isError).toBe(true);
    expect(missingChat.text).toContain("Session not found or access denied");
    expect(missingWorkspace).toEqual(missingChat);
    const missingMessage = await call(withFullAccess(), "session_send_message", {
      sessionId: crypto.randomUUID(),
      workspaceId: other,
      text: "hello",
      idempotencyKey: crypto.randomUUID(),
    });
    expect(missingMessage).toEqual(missingChat);

    // With full access, a miss here says how to reach another workspace.
    const hinted = await call(withFullAccess(), "session_events", { sessionId: target });
    expect(hinted.isError).toBe(true);
    expect(hinted.text).toContain("pass the workspaceId from its link");

    // Once the person ends full access, the next call says so.
    expect(
      (
        await app.request(`/v1/workspaces/${home}/sessions/${own}/admin-access`, {
          method: "DELETE",
          headers: browser(cookie),
        })
      ).status,
    ).toBeLessThan(300);
    const ended = await call(withFullAccess(), "session_get", {
      sessionId: target,
      workspaceId: other,
    });
    expect(ended.isError).toBe(true);
    expect(ended.text).toContain("no longer has full access");

    // Without full access the chat still acts for the person who sent its
    // message, but only in this workspace: a read here runs, the same read in
    // the other workspace is refused, and session tools stay out of it.
    const readHere = await call(withFullAccess(), "admin_action_call", {
      id: "listWorkspaceMembers",
      pathParameters: { workspaceId: home },
      query: {},
    });
    expect(readHere.isError, readHere.text).toBe(false);
    expect(JSON.parse(readHere.text)).toMatchObject({ status: 200 });
    const readThere = await call(withFullAccess(), "admin_action_call", {
      id: "listWorkspaceMembers",
      pathParameters: { workspaceId: other },
      query: {},
    });
    expect(JSON.parse(readThere.text).status, readThere.text).toBeGreaterThanOrEqual(400);
  }, 180_000);
});
