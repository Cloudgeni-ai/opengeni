import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { signDelegatedAccessToken, type AccessGrant } from "@opengeni/contracts";
import type { ApiRouteDeps, SessionWorkflowClient } from "@opengeni/core";
import {
  beginConnectorActionExecution,
  claimSessionWorkForAttempt,
  createDb,
  ensureManagedAccessForUserWithOrganizationMemberships,
  managedPersonalWorkspacePermissions,
  prepareConnectorActionApproval,
  resolveSessionAppActionAuthority,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";

import { createApp } from "../src/app";
import {
  createSessionAdminReach,
  registerSessionAdminAccessTools,
} from "../src/mcp/session-admin-access-tools";

/* End to end through the real app and PostgreSQL: the owner of a Personal
   workspace changes its settings in the browser without holding an admin
   grant there. Their own chat, signed in to the app, can now do the same,
   each change after they confirm it; nothing else widens, and an embed token,
   another member or an unattended turn gets nothing extra. */

setDefaultTimeout(180_000);
const origin = "http://opengeni.test";
const delegationSecret = "personal-owner-chat-settings-delegation-32b";
let shared: SharedTestDatabase;
let client: DbClient;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("personal-owner-chat-settings");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 8 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 60_000);

type Handler = (args: Record<string, unknown>) => Promise<CallToolResult>;

function textOf(result: CallToolResult): string {
  return (result.content[0] as { text: string }).text;
}

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

function dependencies(): ApiRouteDeps {
  const noop = async () => undefined;
  return {
    settings: testSettings({
      databaseUrl: shared.adminUrl,
      productAccessMode: "managed",
      betterAuthSecret: "personal-owner-chat-settings-secret-32b",
      delegationSecret,
      publicBaseUrl: origin,
      sandboxBackend: "none",
    }),
    db: client.db,
    bus: new MemoryEventBus(),
    workflowClient: {
      signalUserMessage: noop,
      wakeSessionWorkflow: noop,
      requestSessionWorkflowWakeDispatch: noop,
      signalApprovalDecision: noop,
      signalSessionControl: noop,
    } as unknown as SessionWorkflowClient,
    objectStorage: {} as never,
    githubStateSecret: "personal-owner-chat-settings-state",
    documentIndexer: { indexDocument: noop },
    getDocumentServices: () => ({ embedder: undefined }) as never,
    resumeBoxById: async () => {
      throw new Error("sandbox resume is not used with backend=none");
    },
  } as unknown as ApiRouteDeps;
}

describe("a Personal workspace owner's own chat", () => {
  test("changes that workspace's settings after confirming, and nothing more", async () => {
    const deps = dependencies();
    const app = createApp(deps);
    const db = client.db;

    const email = `personal-owner-${crypto.randomUUID()}@example.test`;
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
    const userId = authUser!.id;
    const subjectId = `user:${userId}`;
    await ensureManagedAccessForUserWithOrganizationMemberships(db, {
      userId,
      email,
      name: "Maja Berg",
      emailVerified: true,
    });
    const [membership] = await shared.admin<{ accountId: string; personal: string }[]>`
      select account_id as "accountId", personal_workspace_id as personal
      from organization_memberships where subject_id = ${subjectId}`;
    const organizationId = membership!.accountId;
    const personal = membership!.personal;
    // The premise: no admin grant in their own Personal workspace.
    const access = (await (await app.request("/v1/access/me", { headers: { cookie } })).json()) as {
      workspaceGrants: AccessGrant[];
    };
    const personalGrant = access.workspaceGrants.find((grant) => grant.workspaceId === personal);
    expect(personalGrant?.permissions).toEqual(managedPersonalWorkspacePermissions);
    expect(personalGrant?.permissions).not.toContain("workspace:admin");
    const teamGrant = access.workspaceGrants.find((grant) => grant.workspaceId !== personal)!;

    const frozen = async (turnId: string) =>
      (
        await shared.admin<{ changes: string; permissions: string[] }[]>`
          select changes, permissions from session_turn_app_action_grants where turn_id = ${turnId}`
      )[0];
    const latestTurn = async (sessionId: string) =>
      (
        await shared.admin<{ id: string }[]>`
          select id from session_turns where session_id = ${sessionId}
          order by created_at desc, id desc limit 1`
      )[0]!.id;
    const finishTurns = async (sessionId: string) => {
      await shared.admin`update session_turns set status = 'completed' where session_id = ${sessionId}`;
      await shared.admin`update sessions set status = 'idle', active_turn_id = null where id = ${sessionId}`;
    };
    const start = async (workspaceId: string, headers: Record<string, string>) => {
      const created = await app.request(`/v1/workspaces/${workspaceId}/sessions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ initialMessage: "turn video on", model: "scripted-model" }),
      });
      expect(created.status, await created.clone().text()).toBe(202);
      const sessionId = ((await created.json()) as { id: string }).id;
      return { sessionId, turnId: await latestTurn(sessionId) };
    };
    const send = async (
      workspaceId: string,
      sessionId: string,
      headers: Record<string, string>,
    ) => {
      await finishTurns(sessionId);
      const sent = await app.request(`/v1/workspaces/${workspaceId}/sessions/${sessionId}/events`, {
        method: "POST",
        headers,
        body: JSON.stringify({ type: "user.message", payload: { text: "and voice input off" } }),
      });
      expect(sent.status, await sent.clone().text()).toBe(202);
      return await latestTurn(sessionId);
    };

    // Signed in to the app: both ways a message is accepted record the
    // settings permission, and changes need the owner's confirmation.
    const first = await start(personal, browser(cookie));
    expect(await frozen(first.turnId)).toMatchObject({ changes: "confirm" });
    expect((await frozen(first.turnId))!.permissions).toContain("workspace:admin");
    const followUp = await send(personal, first.sessionId, browser(cookie));
    expect((await frozen(followUp))!.permissions).toContain("workspace:admin");

    // The chat's app-action tools for that turn, as the API builds them.
    await finishTurns(first.sessionId);
    const resent = await send(personal, first.sessionId, browser(cookie));
    const attemptId = crypto.randomUUID();
    const claim = await claimSessionWorkForAttempt(db, personal, {
      sessionId: first.sessionId,
      workflowId: `session-${first.sessionId}`,
      workflowRunId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      attemptId,
      trigger: { kind: "next" },
    });
    if (claim.action !== "claimed") throw new Error(`claim failed: ${claim.reason}`);
    expect(claim.turn.id).toBe(resent);
    const identity = {
      accountId: organizationId,
      workspaceId: personal,
      sessionId: first.sessionId,
      turnId: claim.turn.id,
      attemptId,
      executionGeneration: claim.turn.executionGeneration,
      initiator: claim.turn.initiator,
    };
    const handlers = new Map<string, Handler>();
    const grant = { accountId: organizationId, workspaceId: personal } as AccessGrant;
    registerSessionAdminAccessTools({
      server: {
        registerTool: (name: string, _config: unknown, handler: Handler) => {
          handlers.set(name, handler);
        },
      } as never,
      db,
      grant,
      sessionId: first.sessionId,
      attempt: { turnId: claim.turn.id, attemptId },
      reach: createSessionAdminReach({
        db,
        grant,
        sessionId: first.sessionId,
        turnId: claim.turn.id,
        access: { origin, dispatch: async (request) => await app.fetch(request) },
        authorize: async () => undefined,
      }),
    });
    const call = handlers.get("admin_action_call")!;
    let approvals = 0;
    /** The owner allows exactly `args` in the chat, and the attempt starts running it. */
    const allow = async (args: unknown) => {
      const ledgerCall = {
        approvalId: `call-${++approvals}`,
        connectionId: `session-mcp:opengeni:${"0".repeat(64)}`,
        serverId: "opengeni",
        toolName: "admin_action_call",
        arguments: args,
        approvalMode: "session_mcp" as const,
        defaultDecision: "ask" as const,
        reviewContext: { kind: "generic" as const, title: "Make this change?" },
      };
      expect(await prepareConnectorActionApproval(db, identity, ledgerCall)).toMatchObject({
        decision: "ask",
      });
      const [event] = await shared.admin<{ id: string }[]>`
        select id from session_events where session_id = ${first.sessionId}
        order by sequence desc limit 1`;
      await shared.admin`
        update connector_action_requests
        set status = 'approved', decision = 'approve', decision_by_subject_id = ${subjectId},
          decision_by_kind = 'human', decision_by_signed_in_person = true,
          decision_event_id = ${event!.id}, decided_at = now(), updated_at = now()
        where turn_id = ${claim.turn.id} and approval_id = ${ledgerCall.approvalId}`;
      expect(await beginConnectorActionExecution(db, identity, ledgerCall)).toMatchObject({
        allowed: true,
      });
    };
    const settingsRow = async () =>
      (
        await shared.admin<{ settings: { voiceInput?: { enabled?: boolean } } }[]>`
          select settings from workspaces where id = ${personal}`
      )[0]!.settings;

    // Unconfirmed, nothing runs.
    const voiceOff = {
      id: "updateWorkspaceSettings",
      pathParameters: { workspaceId: personal },
      query: {},
      body: { voiceInput: { enabled: false } },
    };
    const unconfirmed = await call(voiceOff);
    expect(unconfirmed.isError).toBe(true);
    expect(textOf(unconfirmed)).toStartWith("Nothing was run: this change needs a confirmation");
    expect((await settingsRow()).voiceInput?.enabled).not.toBe(false);
    // Confirmed, it runs, exactly as in their browser.
    await allow(voiceOff);
    const saved = await call(voiceOff);
    expect(saved.isError, textOf(saved)).toBeUndefined();
    expect(JSON.parse(textOf(saved))).toMatchObject({ status: 200 });
    expect((await settingsRow()).voiceInput?.enabled).toBe(false);

    const videoOff = {
      id: "updateVideoGenerationPolicy",
      pathParameters: { workspaceId: personal },
      query: {},
      body: {
        expectedRevision: 0,
        fundingSource: "workspace_gateway",
        enabledModelIds: [],
        defaultModelId: null,
      },
    };
    expect(textOf(await call(videoOff))).toStartWith(
      "Nothing was run: this change needs a confirmation",
    );
    await allow(videoOff);
    const video = await call(videoOff);
    expect(video.isError, textOf(video)).toBeUndefined();
    expect(JSON.parse(textOf(video))).toMatchObject({ status: 200, body: { revision: 1 } });

    // Access management stays where it was: confirmed or not, never from chat.
    const addMember = {
      id: "addWorkspaceMember",
      pathParameters: { workspaceId: personal },
      query: {},
      body: { subjectId: "user:outsider", permissions: ["workspace:read"] },
    };
    await allow(addMember);
    const added = await call(addMember);
    expect(added.isError).toBe(true);
    expect(JSON.parse(textOf(added)).status).toBe(403);
    const apiKey = {
      id: "createApiKey",
      pathParameters: { workspaceId: personal },
      query: {},
      body: { name: "chat key", permissions: ["workspace:read"] },
    };
    await allow(apiKey);
    const key = await call(apiKey);
    expect(key.isError).toBe(true);
    expect(textOf(key)).toStartWith("Nothing was run: this call creates, shows, copies");
    expect(
      await shared.admin`select id from workspace_memberships where workspace_id = ${personal}`,
    ).toHaveLength(0);
    expect(
      await shared.admin`select id from api_keys where workspace_id = ${personal}`,
    ).toHaveLength(0);

    // Unattended turns gain nothing from a recorded grant (child chats: see
    // packages/db/test/session-app-actions.test.ts).
    const turnKey = {
      accountId: organizationId,
      workspaceId: personal,
      sessionId: first.sessionId,
      turnId: claim.turn.id,
    };
    for (const source of ["scheduled_task", "goal"]) {
      await shared.admin`update session_turns set source = ${source} where id = ${claim.turn.id}`;
      expect(await resolveSessionAppActionAuthority(db, turnKey)).toEqual({
        kind: "unavailable",
        reason: "no_person_present",
      });
    }
    await shared.admin`update session_turns set source = 'user' where id = ${claim.turn.id}`;
    expect(await resolveSessionAppActionAuthority(db, turnKey)).toMatchObject({ kind: "confirm" });

    // Someone whose Personal workspace is no longer this one is refused live,
    // even with the permission recorded and the change confirmed.
    const moved = crypto.randomUUID();
    await shared.admin`
      insert into workspaces (id, account_id, name) values (${moved}, ${organizationId}, 'Moved')`;
    await shared.admin`
      insert into workspace_inference_controls (workspace_id, account_id)
      values (${moved}, ${organizationId})`;
    await shared.admin`
      update organization_memberships set personal_workspace_id = ${moved}
      where account_id = ${organizationId} and subject_id = ${subjectId}`;
    try {
      const voiceOn = { ...voiceOff, body: { voiceInput: { enabled: true } } };
      await allow(voiceOn);
      const refused = await call(voiceOn);
      expect(refused.isError).toBe(true);
      expect(JSON.parse(textOf(refused)).status).toBe(403);
      expect((await settingsRow()).voiceInput?.enabled).toBe(false);
    } finally {
      await shared.admin`
        update organization_memberships set personal_workspace_id = ${personal}
        where account_id = ${organizationId} and subject_id = ${subjectId}`;
    }

    // An embed's host-issued token naming the same owner records nothing
    // extra: its own request can't change settings either.
    const token = await signDelegatedAccessToken(delegationSecret, {
      accountId: organizationId,
      workspaceId: personal,
      subjectId,
      principalKind: "human_session",
      permissions: managedPersonalWorkspacePermissions,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const embed = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const direct = await app.request(`/v1/workspaces/${personal}/settings`, {
      method: "PATCH",
      headers: embed,
      body: JSON.stringify({ voiceInput: { enabled: true } }),
    });
    expect(direct.status).toBe(403);
    const embedded = await start(personal, embed);
    const embeddedGrant = await frozen(embedded.turnId);
    expect(embeddedGrant?.permissions ?? []).not.toContain("workspace:admin");

    // A member who isn't an admin of a shared workspace is unchanged.
    await shared.admin`
      update workspace_memberships
      set permissions = ${shared.admin.json(["workspace:read", "sessions:create", "sessions:read"])}
      where workspace_id = ${teamGrant.workspaceId} and subject_id = ${subjectId}`;
    const team = await start(teamGrant.workspaceId, browser(cookie));
    expect(await frozen(team.turnId)).toMatchObject({ changes: "confirm" });
    expect((await frozen(team.turnId))!.permissions).not.toContain("workspace:admin");
  });
});
