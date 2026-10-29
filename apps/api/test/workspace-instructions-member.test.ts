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
 * Workspace instructions are shared work, like a shared Skill: a Member of a
 * shared workspace (who can start chats there), signed in as themselves,
 * edits, activates and rolls them back and reviews the agent's proposed
 * changes, through the real app and PostgreSQL as the restricted application
 * role. A Viewer can't, the learning settings stay with admins, and tokens
 * that only carry sessions:create (an agent's or a worker's) are refused.
 */

const ORIGIN = "https://opengeni.example";
const SECRET = "workspace-instructions-member-secret-at-least-32-bytes";
let shared: SharedTestDatabase;
let client: DbClient;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("workspace-instructions-member");
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
  const userId = `instructions-member-${crypto.randomUUID()}`;
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

test("a Member edits and reviews the workspace instructions; a Viewer and bare tokens can't", async () => {
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
  const [membership] = await shared.admin<Array<{ accountId: string }>>`
    select account_id as "accountId" from organization_memberships
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
  const policies = `/v1/workspaces/${team}/instruction-policies`;
  const draft = (content: string) => ({
    operationId: crypto.randomUUID(),
    kind: "policy",
    scope: "global",
    content,
  });

  // A Member writes and activates the instructions.
  const first = await call(as(colleague), "POST", `${policies}/drafts`, draft("Review every PR."));
  expect(first.status).toBe(201);
  const activated = await call(as(colleague), "POST", `${policies}/${first.body.id}/activate`, {
    expectedCurrentRevisionId: null,
    reason: "First instructions",
  });
  expect(activated.status).toBe(200);
  expect(activated.body.head.revisionId).toBe(first.body.id);
  const second = await call(as(colleague), "POST", `${policies}/drafts`, draft("Be brief."));
  expect(second.status).toBe(201);
  const changed = await call(as(colleague), "POST", `${policies}/${second.body.id}/activate`, {
    expectedCurrentRevisionId: first.body.id,
    reason: "Shorter",
  });
  expect(changed.status).toBe(200);
  // ...rolls them back...
  const restored = await call(as(colleague), "POST", `${policies}/rollback`, {
    targetRevisionId: first.body.id,
    expectedCurrentRevisionId: second.body.id,
    reason: "Restore",
  });
  expect(restored.status).toBe(200);
  // ...proposes onboarding instructions and reviews the agent's changes.
  const head = restored.body.head;
  expect(
    (
      await call(as(colleague), "POST", `${policies}/onboarding-proposals`, {
        operationId: crypto.randomUUID(),
        kind: "policy",
        scope: "global",
        content: "Review every PR.\n\nWrite tests.",
        sourceId: "member-onboarding",
        sourceVersion: "1",
        confidenceBps: 9_000,
        expectedCurrentRevisionId: head.revisionId,
        expectedActivationVersion: head.activationVersion,
      })
    ).status,
  ).toBe(201);
  const reviews = await call(
    as(colleague),
    "GET",
    `/v1/workspaces/${team}/agent-learning/instructions/reviews`,
  );
  expect(reviews.status).toBe(200);
  expect(reviews.body.entries).toEqual([]);
  // The workspace's learning settings stay with admins.
  const settings = await call(as(colleague), "POST", `/v1/workspaces/${team}/agent-learning`, {
    scope: "workspace",
    operationId: crypto.randomUUID(),
    expectedVersion: 0,
    settings: { instructions: "automatic" },
  });
  expect(settings.status).toBe(403);

  // A Viewer reads but can't change or review them.
  expect((await call(as(reader), "GET", policies)).status).toBe(200);
  expect((await call(as(reader), "POST", `${policies}/drafts`, draft("No."))).status).toBe(403);
  expect(
    (
      await call(as(reader), "POST", `${policies}/rollback`, {
        targetRevisionId: second.body.id,
        expectedCurrentRevisionId: head.revisionId,
        reason: "No",
      })
    ).status,
  ).toBe(403);
  expect(
    (await call(as(reader), "GET", `/v1/workspaces/${team}/agent-learning/instructions/reviews`))
      .status,
  ).toBe(403);

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
    expect(
      (await call({ authorization: `Bearer ${token}` }, "POST", `${policies}/drafts`, draft("X")))
        .status,
    ).toBe(403);
  }

  // Instructions are per workspace: the Member can't reach another organization's.
  const stranger = await signUp(true);
  const [elsewhere] = await shared.admin<Array<{ workspaceId: string }>>`
    select personal_workspace_id as "workspaceId" from organization_memberships
    where subject_id = ${stranger.subjectId} and status = 'active'`;
  const foreign = await call(
    as(colleague),
    "POST",
    `/v1/workspaces/${elsewhere!.workspaceId}/instruction-policies/drafts`,
    draft("No."),
  );
  expect([403, 404]).toContain(foreign.status);

  await shared.admin`delete from workspace_memberships
    where workspace_id = ${team} and subject_id in (${colleague.subjectId}, ${reader.subjectId})`;
}, 120_000);
