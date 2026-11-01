import { afterAll, beforeAll, expect, test } from "bun:test";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import type { SessionWorkflowClient } from "@opengeni/core";
import {
  acceptOrganizationInvitation,
  createDb,
  createOrganizationInvitation,
  ensureManagedAccessForUserWithOrganizationMemberships,
  upsertWorkspaceMemberAsWorkspaceManager,
  type DbClient,
} from "@opengeni/db";
import { synchronizeCanonicalHumanLoginBindings } from "@opengeni/db/canonical-human-identities";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { createApp, type AppDependencies } from "../src/app";

/*
 * A shared workspace's name and its custom model entries are ordinary shared
 * things: a Member (who can start chats there), signed in as themselves,
 * renames it and adds and removes its custom models through the real app and
 * PostgreSQL as the restricted application role. Its slug stays with admins,
 * a Personal workspace keeps its name, a Viewer can't, and tokens that only
 * carry sessions:create (an agent's or a worker's) are refused.
 */

const ORIGIN = "https://opengeni.example";
const SECRET = "workspace-member-rename-models-secret-at-least-32-bytes";
let shared: SharedTestDatabase;
let client: DbClient;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("workspace-member-rename-models");
  if (!acquired) throw new Error("These tests require real PostgreSQL");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

const noop = async () => undefined;
type Person = { userId: string; subjectId: string; email: string; cookie: string };
const cookies = new Map<string, { authSessionId: string; userId: string; email: string }>();

function buildApp() {
  return createApp({
    db: client.db,
    bus: new MemoryEventBus(),
    settings: testSettings({
      productAccessMode: "managed",
      publicBaseUrl: ORIGIN,
      sandboxBackend: "none",
      delegationSecret: SECRET,
    }),
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
    managedAuth: {
      api: {
        getSession: async ({ headers }: { headers: Headers }) => {
          const record = cookies.get(headers.get("cookie") ?? "");
          if (!record) return { headers: new Headers(), response: null };
          return {
            headers: new Headers(),
            response: {
              session: { id: record.authSessionId },
              user: { id: record.userId, email: record.email, emailVerified: true, name: "Ida" },
            },
          };
        },
      },
    },
  } as unknown as AppDependencies);
}

async function signUp(ownOrganization: boolean): Promise<Person> {
  const userId = `rename-member-${crypto.randomUUID()}`;
  const email = `${userId}@example.test`;
  const authSessionId = `session-${crypto.randomUUID()}`;
  await shared.admin`insert into auth_users (id, name, email, email_verified)
    values (${userId}, 'Ida', ${email}, true)`;
  await shared.admin`insert into auth_identities (id, user_id, provider_id, account_id)
    values (${crypto.randomUUID()}, ${userId}, 'credential', ${userId})`;
  if (ownOrganization)
    await ensureManagedAccessForUserWithOrganizationMemberships(client.db, {
      userId,
      email,
      name: "Ida",
      emailVerified: true,
    });
  const identity = await synchronizeCanonicalHumanLoginBindings(client.db, userId);
  await shared.admin`insert into auth_sessions (
      id, user_id, token, expires_at, identity_id, identity_revision, auth_revision
    ) values (
      ${authSessionId}, ${userId}, ${crypto.randomUUID()}, now() + interval '1 hour',
      ${identity.identityId}, ${identity.identityRevision}, ${identity.authRevision}
    )`;
  const cookie = `session=${authSessionId}`;
  cookies.set(cookie, { authSessionId, userId, email });
  return { userId, subjectId: `user:${userId}`, email, cookie };
}

async function invite(owner: Person, accountId: string): Promise<Person> {
  const person = await signUp(false);
  const invitation = await createOrganizationInvitation(client.db, {
    organizationId: accountId,
    actorSubjectId: owner.subjectId,
    operationId: crypto.randomUUID(),
    targetSubjectId: person.subjectId,
    targetEmail: person.email,
    role: "member",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  await acceptOrganizationInvitation(client.db, {
    organizationId: accountId,
    actorSubjectId: person.subjectId,
    operationId: crypto.randomUUID(),
    invitationId: invitation.id,
    expectedRevision: invitation.revision,
  });
  return person;
}

async function rolePermissions(role: "member" | "viewer") {
  const [row] = await shared.admin<Array<{ permissions: string[] }>>`
    select opengeni_private.workspace_member_role_permissions(${role}) as permissions`;
  return row!.permissions;
}

type Result = { status: number; body: any };

test("a Member renames a shared workspace and manages its custom models; others can't", async () => {
  const app = buildApp();
  const call = async (
    headers: Record<string, string>,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Result> => {
    const response = await app.request(path, {
      method,
      headers: { ...headers, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  const as = (person: Person) => ({
    cookie: person.cookie,
    origin: ORIGIN,
    "sec-fetch-site": "same-origin",
  });
  const owner = await signUp(true);
  const [membership] = await shared.admin<Array<{ accountId: string; personal: string }>>`
    select account_id as "accountId", personal_workspace_id as personal
    from organization_memberships
    where subject_id = ${owner.subjectId} and status = 'active'`;
  const accountId = membership!.accountId;
  const created = await call(as(owner), "POST", "/v1/workspaces", { accountId, name: "Team" });
  expect(created.status).toBe(201);
  const team = String(created.body.id);
  const colleague = await invite(owner, accountId);
  const reader = await invite(owner, accountId);
  for (const [person, role] of [
    [colleague, "member"],
    [reader, "viewer"],
  ] as const)
    await upsertWorkspaceMemberAsWorkspaceManager(client.db, {
      accountId,
      workspaceId: team,
      actorSubjectId: owner.subjectId,
      targetSubjectId: person.subjectId,
      mode: "add",
      role,
      permissions: (await rolePermissions(role)) as never,
    });
  const workspace = `/v1/workspaces/${team}`;

  // A Member renames the shared workspace and edits its legacy instructions...
  const renamed = await call(as(colleague), "PATCH", workspace, { name: "  Team North  " });
  expect(renamed.status).toBe(200);
  expect(renamed.body.name).toBe("Team North");
  const instructed = await call(as(colleague), "PATCH", workspace, {
    agentInstructions: "Answer in English.",
  });
  expect(instructed.status).toBe(200);
  // ...but its slug, alone or with a name, stays with admins.
  for (const body of [{ slug: "north" }, { name: "Team South", slug: "south" }]) {
    expect((await call(as(colleague), "PATCH", workspace, body)).status).toBe(403);
  }
  expect((await call(as(owner), "GET", workspace)).body.name).toBe("Team North");
  expect((await call(as(owner), "PATCH", workspace, { slug: "north" })).status).toBe(200);

  // A Member adds and removes the workspace's custom model entries.
  for (const [path, upstreamModelId] of [
    ["gateway-custom-models", `acme/member-gateway-${crypto.randomUUID().slice(0, 8)}`],
    ["openrouter-custom-models", `acme/member-openrouter-${crypto.randomUUID().slice(0, 8)}`],
    ["opper-custom-models", `acme/member-opper-${crypto.randomUUID().slice(0, 8)}`],
    ["model-providers/anthropic/custom-models", `claude-member-${crypto.randomUUID().slice(0, 8)}`],
  ] as const) {
    const url = `${workspace}/${path}`;
    const body = { operationId: crypto.randomUUID(), upstreamModelId };
    expect((await call(as(reader), "POST", url, body)).status, `viewer ${path}`).toBe(403);
    const added = await call(as(colleague), "POST", url, body);
    expect(added.status, `${path} ${JSON.stringify(added.body)}`).toBe(201);
    expect(added.body.upstreamModelId).toBe(upstreamModelId);
    const removal = { expectedVersion: added.body.version, operationId: crypto.randomUUID() };
    expect((await call(as(reader), "DELETE", `${url}/${added.body.id}`, removal)).status).toBe(403);
    expect((await call(as(colleague), "DELETE", `${url}/${added.body.id}`, removal)).status).toBe(
      204,
    );
  }

  // A Viewer renames nothing.
  expect((await call(as(reader), "PATCH", workspace, { name: "Mine" })).status).toBe(403);

  // A token that only carries the Member's sessions:create (a worker's, or an
  // agent attempt's own) is not the Member acting as themselves.
  for (const turn of [
    { principalKind: "human_session" as const },
    {
      principalKind: "agent_attempt" as const,
      sessionId: crypto.randomUUID(),
      turnId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      executionGeneration: 1,
    },
  ]) {
    const token = await signDelegatedAccessToken(SECRET, {
      accountId,
      workspaceId: team,
      subjectId: colleague.subjectId,
      permissions: ["workspace:read", "sessions:create"],
      ...turn,
      exp: Math.floor(Date.now() / 1000) + 600,
    });
    const bearer = { authorization: `Bearer ${token}` };
    expect((await call(bearer, "PATCH", workspace, { name: "Agent" })).status).toBe(403);
    expect(
      (
        await call(bearer, "POST", `${workspace}/gateway-custom-models`, {
          operationId: crypto.randomUUID(),
          upstreamModelId: "acme/agent-model",
        })
      ).status,
    ).toBe(403);
  }

  // A Personal workspace keeps its name, even for its owner.
  expect(
    (await call(as(owner), "PATCH", `/v1/workspaces/${membership!.personal}`, { name: "Mine" }))
      .status,
  ).toBe(403);

  // The Member can't reach another organization's workspace.
  const stranger = await signUp(true);
  const [elsewhere] = await shared.admin<Array<{ workspaceId: string }>>`
    select personal_workspace_id as "workspaceId" from organization_memberships
    where subject_id = ${stranger.subjectId} and status = 'active'`;
  expect([403, 404]).toContain(
    (await call(as(colleague), "PATCH", `/v1/workspaces/${elsewhere!.workspaceId}`, { name: "X" }))
      .status,
  );
  expect([403, 404]).toContain(
    (
      await call(
        as(colleague),
        "POST",
        `/v1/workspaces/${elsewhere!.workspaceId}/gateway-custom-models`,
        {
          operationId: crypto.randomUUID(),
          upstreamModelId: "acme/elsewhere",
        },
      )
    ).status,
  );

  await shared.admin`delete from workspace_memberships
    where workspace_id = ${team} and subject_id in (${colleague.subjectId}, ${reader.subjectId})`;
}, 120_000);
