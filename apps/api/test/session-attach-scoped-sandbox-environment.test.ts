// A session bound to an organization (or personal) Sandbox Environment homed in
// another workspace of the same organization must open its terminal, Files and
// viewers. Those versions live in the environment's home workspace, so the old
// physical-workspace version lookup missed them and every attach answered 500
// while agent turns (which resolve through the scoped authority) kept working.
// Visibility and organization boundaries are unchanged: an environment the
// attaching subject cannot use, or one from another organization, is refused.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { signDelegatedAccessToken, type Permission, type Session } from "@opengeni/contracts";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createRig,
  getRigVersion,
  getSession,
  initializeSessionStartAtomically,
  type DbClient,
} from "@opengeni/db";
import {
  resolveSessionSandboxRuntime,
  type SessionAttachRigAuthority,
  type SessionWorkflowClient,
} from "@opengeni/core";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { createApp } from "../src/app";

const SECRET = "session-attach-scoped-sandbox-environment-secret";
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

const settings = testSettings({
  productAccessMode: "managed",
  delegationSecret: SECRET,
  environmentsEncryptionKey: Buffer.alloc(32, 43).toString("base64"),
  sandboxBackend: "local",
  sandboxOwnershipEnabled: true,
  sandboxLeaseTtlMs: 5_000,
});

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;

setDefaultTimeout(120_000);

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api-session-attach-scoped-sandbox-environment");
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
  await shared?.release();
}, 60_000);

let cachedApp: Hono | null = null;
/** The composed public app, so failures render through the real error envelope. */
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

/** One workspace membership in a synthetic organization. */
async function workspace(organizationId: string, name: string, subjectId: string): Promise<Grant> {
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "session-attach-scoped-sandbox-environment",
    accountExternalId: organizationId,
    accountName: "Scoped environment attach",
    workspaceExternalSource: "session-attach-scoped-sandbox-environment",
    workspaceExternalId: `${organizationId}:${name}`,
    workspaceName: name,
    subjectId,
  });
  return access.workspaceGrants[0]!;
}

async function organizationMember(personal: Grant): Promise<void> {
  await shared!.admin`
    insert into organization_memberships (account_id, subject_id, status, personal_workspace_id)
    values (${personal.accountId}, ${personal.subjectId}, 'active', ${personal.workspaceId})`;
}

/**
 * Organization with a home workspace (the owner's personal workspace, where the
 * environments live) and a separate team workspace whose sessions use them. A
 * colleague is a member of the team workspace only.
 */
async function organization() {
  const id = `organization-${crypto.randomUUID()}`;
  const owner = `user:${crypto.randomUUID()}`;
  const colleague = `user:${crypto.randomUUID()}`;
  const home = await workspace(id, "home", owner);
  const team = await workspace(id, "team", owner);
  const colleaguePersonal = await workspace(id, "colleague-personal", colleague);
  expect(team.workspaceId).not.toBe(home.workspaceId);
  await shared!.admin`
    insert into workspace_memberships (account_id, workspace_id, subject_id)
    values (${team.accountId}, ${team.workspaceId}, ${colleague})`;
  const colleagueTeam: Grant = { ...team, subjectId: colleague };
  await organizationMember(home);
  await organizationMember(colleaguePersonal);
  return { home, team, colleagueTeam };
}

async function createSession(grant: Grant, rigId?: string): Promise<Session> {
  const created = await app().request(`/v1/workspaces/${grant.workspaceId}/sessions`, {
    method: "POST",
    headers: {
      authorization: await bearer(grant, ["sessions:create", "sessions:read", "rigs:use"]),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      initialMessage: "work in the shared environment",
      ...(rigId ? { rigId } : {}),
    }),
  });
  expect(created.status).toBe(202);
  return (await created.json()) as Session;
}

async function channelA(
  grant: Grant,
  session: Session,
  path: "terminal/exec" | "fs/list",
  body: unknown,
): Promise<Response> {
  return await app().request(`/v1/workspaces/${grant.workspaceId}/sessions/${session.id}/${path}`, {
    method: "POST",
    headers: {
      authorization: await bearer(grant, ["sessions:read", "files:read", "terminal:attach"]),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function storedSession(grant: Grant, session: Session): Promise<Session> {
  return (await getSession(client.db, grant.workspaceId, session.id)) as Session;
}

const AGENT_SUBJECT = "worker:first-party-mcp";
const AGENT_PERMISSIONS: Permission[] = ["sessions:read", "files:read", "terminal:attach"];

/** Claim a live attempt on the session's first turn the way the worker does,
 *  and return the agent-attempt grant claims that attempt carries. */
async function liveAgentAttempt(grant: Grant, sessionId: string) {
  const attemptId = crypto.randomUUID();
  const claim = async () =>
    await claimSessionWorkForAttempt(client.db, grant.workspaceId, {
      sessionId,
      workflowId: `session-${sessionId}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
  let claimed = await claim();
  if (claimed.action !== "claimed") {
    await initializeSessionStartAtomically(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId,
      reasoningEffortFallback: "low",
      createdEventPayload: {},
      goal: null,
    });
    claimed = await claim();
  }
  if (claimed.action !== "claimed") throw new Error("test attempt was not claimed");
  const metadata = {
    sessionId,
    turnId: claimed.turn.id,
    attemptId,
    executionGeneration: claimed.turn.executionGeneration,
  };
  return {
    grant: {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      subjectId: AGENT_SUBJECT,
      permissions: AGENT_PERMISSIONS,
      principalKind: "agent_attempt" as const,
      metadata,
    },
    authorization: `Bearer ${await signDelegatedAccessToken(SECRET, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      subjectId: AGENT_SUBJECT,
      permissions: AGENT_PERMISSIONS,
      principalKind: "agent_attempt",
      ...metadata,
      exp: Math.floor(Date.now() / 1000) + 3_600,
    })}`,
  };
}

/** The Terminal panel's viewer attach (the reported failing request). */
async function attachTerminalViewer(grant: Grant, session: Session): Promise<Response> {
  return await app().request(`/v1/workspaces/${grant.workspaceId}/sessions/${session.id}/viewers`, {
    method: "POST",
    headers: {
      authorization: await bearer(grant, ["sessions:read", "terminal:attach"]),
      "content-type": "application/json",
    },
    body: JSON.stringify({ terminal: true }),
  });
}

async function runtimeStatus(
  session: Session,
  authority: string | null | SessionAttachRigAuthority,
): Promise<{ rigVersionId: string | null } | { status: number }> {
  try {
    const runtime = await resolveSessionSandboxRuntime(
      client.db,
      settings,
      session,
      authority !== null && typeof authority === "object" ? authority : { subjectId: authority },
    );
    return { rigVersionId: runtime.rigVersion?.id ?? null };
  } catch (error) {
    if (error instanceof HTTPException) return { status: error.status };
    throw error;
  }
}

describe("session attach with a Sandbox Environment homed in another workspace", () => {
  test("an organization environment opens terminal, Files and viewers for every member", async () => {
    if (!available) return;
    const { home, team, colleagueTeam } = await organization();
    const rig = await createRig(client.db, {
      ...home,
      scope: "organization",
      allowOrganization: true,
      name: "shared organization environment",
      createdBy: home.subjectId,
    });
    const session = await createSession(team, rig.id);
    expect(session.rigId).toBe(rig.id);
    expect(session.rigVersionId).toBe(rig.activeVersion!.id);
    // The version lives in the home workspace, not the session's workspace.
    expect(
      await getRigVersion(client.db, team.workspaceId, rig.id, session.rigVersionId!),
    ).toBeNull();

    for (const grant of [team, colleagueTeam]) {
      const exec = await channelA(grant, session, "terminal/exec", { command: "printf ready" });
      expect(exec.status).toBe(200);
      const execBody = (await exec.json()) as { stdout: string; exitCode: number };
      expect(execBody).toMatchObject({ exitCode: 0, stdout: "ready" });
      const list = await channelA(grant, session, "fs/list", { path: "/workspace" });
      expect(list.status).toBe(200);
      const viewer = await attachTerminalViewer(grant, session);
      expect(viewer.status).toBe(201);
      expect(((await viewer.json()) as { viewerId?: string }).viewerId).toBeString();
    }

    // The desktop viewer, Browser and Computer surfaces resolve the same runtime,
    // including a service attach that carries no human subject.
    const stored = await storedSession(team, session);
    for (const subjectId of [team.subjectId, colleagueTeam.subjectId, null]) {
      expect(await runtimeStatus(stored, subjectId)).toEqual({
        rigVersionId: session.rigVersionId,
      });
    }
  });

  test("a personal environment resolves for its owner and is refused to anyone else", async () => {
    if (!available) return;
    const { home, team, colleagueTeam } = await organization();
    const rig = await createRig(client.db, {
      ...home,
      scope: "user",
      name: "owner personal environment",
      createdBy: home.subjectId,
    });
    const session = await createSession(team, rig.id);
    expect(session.rigVersionId).toBe(rig.activeVersion!.id);

    const exec = await channelA(team, session, "terminal/exec", { command: "printf ready" });
    expect(exec.status).toBe(200);
    const stored = await storedSession(team, session);
    expect(await runtimeStatus(stored, team.subjectId)).toEqual({
      rigVersionId: session.rigVersionId,
    });
    // Neither another member nor a subject-less service attach can use it, and
    // the refusal is an explicit 403 rather than an internal error.
    expect(await runtimeStatus(stored, colleagueTeam.subjectId)).toEqual({ status: 403 });
    expect(await runtimeStatus(stored, null)).toEqual({ status: 403 });
  });

  test("the owner's agent resolves a personal environment as its initiating human", async () => {
    if (!available) return;
    const { home, team } = await organization();
    const rig = await createRig(client.db, {
      ...home,
      scope: "user",
      name: "owner personal environment for agents",
      createdBy: home.subjectId,
    });
    // Claiming an attempt on a personal-environment session needs the owner's
    // personal-resource grant snapshot (turn-time authority, out of scope
    // here). Claim on an unbound session, then bind the environment so the
    // attach resolution is exercised under exactly that live attempt.
    const created = await createSession(team);
    const agent = await liveAgentAttempt(team, created.id);
    await shared!.admin`
      update sessions set rig_id = ${rig.id}, rig_version_id = ${rig.activeVersion!.id}
      where id = ${created.id}`;
    const session = await storedSession(team, created);
    expect(session.rigVersionId).toBe(rig.activeVersion!.id);
    const stored = await storedSession(team, session);

    // The technical worker identity alone holds no organization membership.
    expect(await runtimeStatus(stored, AGENT_SUBJECT)).toEqual({ status: 403 });
    expect(await runtimeStatus(stored, { grant: agent.grant })).toEqual({
      rigVersionId: session.rigVersionId,
    });
    const list = await app().request(
      `/v1/workspaces/${team.workspaceId}/sessions/${session.id}/fs/list`,
      {
        method: "POST",
        headers: { authorization: agent.authorization, "content-type": "application/json" },
        body: JSON.stringify({ path: "/workspace" }),
      },
    );
    expect(list.status).toBe(200);
  });

  test("another organization's environment is never resolved", async () => {
    if (!available) return;
    const { team } = await organization();
    const foreignOwner = `user:${crypto.randomUUID()}`;
    const foreign = await workspace(`organization-${crypto.randomUUID()}`, "home", foreignOwner);
    await organizationMember(foreign);
    const foreignRig = await createRig(client.db, {
      ...foreign,
      scope: "organization",
      allowOrganization: true,
      name: "foreign organization environment",
      createdBy: foreign.subjectId,
    });

    // Selecting it is still an unknown environment.
    const rejected = await app().request(`/v1/workspaces/${team.workspaceId}/sessions`, {
      method: "POST",
      headers: {
        authorization: await bearer(team, ["sessions:create", "sessions:read", "rigs:use"]),
        "content-type": "application/json",
      },
      body: JSON.stringify({ initialMessage: "use it", rigId: foreignRig.id }),
    });
    expect(rejected.status).toBe(422);

    // A binding that somehow names it is refused at attach, never materialized.
    const session = await createSession(team);
    await shared!.admin`
      update sessions
      set rig_id = ${foreignRig.id}, rig_version_id = ${foreignRig.activeVersion!.id}
      where id = ${session.id}`;
    for (const [path, body] of [
      ["terminal/exec", { command: "true" }],
      ["fs/list", { path: "/workspace" }],
    ] as const) {
      const response = await channelA(team, session, path, body);
      expect(response.status).toBe(403);
      const envelope = (await response.json()) as { error: { code: string } };
      expect(envelope.error.code).toBe("forbidden");
    }
    expect((await attachTerminalViewer(team, session)).status).toBe(403);
    const stored = await storedSession(team, session);
    expect(stored.rigVersionId).toBe(foreignRig.activeVersion!.id);
    for (const subjectId of [team.subjectId, null]) {
      expect(await runtimeStatus(stored, subjectId)).toEqual({ status: 403 });
    }
  });
});
