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
 * A Personal workspace's owner, signed in as themselves, changes its model
 * account settings the organization has not locked (migration 1233), through
 * the real app and PostgreSQL as the restricted application role: the rules
 * (rotation, fallback, switching models) and Codex's source and rotation. A
 * locked setting still wins. A token that names the owner, a colleague, the
 * organization's owner and another organization are refused; a shared
 * workspace is unchanged.
 */

const ORIGIN = "https://opengeni.example";
const SECRET = "personal-owner-model-account-settings-secret-32-bytes";
let shared: SharedTestDatabase;
let client: DbClient;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("personal-owner-model-account-settings");
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
              user: { id: record.userId, email: record.email, emailVerified: true, name: "Ada" },
            },
          };
        },
      },
    },
  } as unknown as AppDependencies);
}

async function signUp(ownOrganization: boolean): Promise<Person> {
  const userId = `personal-settings-${crypto.randomUUID()}`;
  const email = `${userId}@example.test`;
  const authSessionId = `session-${crypto.randomUUID()}`;
  await shared.admin`insert into auth_users (id, name, email, email_verified)
    values (${userId}, 'Ada', ${email}, true)`;
  await shared.admin`insert into auth_identities (id, user_id, provider_id, account_id)
    values (${crypto.randomUUID()}, ${userId}, 'credential', ${userId})`;
  if (ownOrganization)
    await ensureManagedAccessForUserWithOrganizationMemberships(client.db, {
      userId,
      email,
      name: "Ada",
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

async function invite(owner: Person, accountId: string, person?: Person): Promise<Person> {
  const joining = person ?? (await signUp(false));
  const invitation = await createOrganizationInvitation(client.db, {
    organizationId: accountId,
    actorSubjectId: owner.subjectId,
    operationId: crypto.randomUUID(),
    targetSubjectId: joining.subjectId,
    targetEmail: joining.email,
    role: "member",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  await acceptOrganizationInvitation(client.db, {
    organizationId: accountId,
    actorSubjectId: joining.subjectId,
    operationId: crypto.randomUUID(),
    invitationId: invitation.id,
    expectedRevision: invitation.revision,
  });
  return joining;
}

async function personalOf(person: Person, accountId: string): Promise<string> {
  const [row] = await shared.admin<Array<{ workspaceId: string }>>`
    select personal_workspace_id as "workspaceId" from organization_memberships
    where account_id = ${accountId} and subject_id = ${person.subjectId} and status = 'active'`;
  return row!.workspaceId;
}

type Result = { status: number; body: any };

test("a Personal workspace's owner changes its unlocked model account settings; nobody else does", async () => {
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
  const colleague = await invite(owner, accountId);
  const mine = await personalOf(colleague, accountId);
  const settings = (workspaceId: string) => `/v1/workspaces/${workspaceId}/model-account-settings`;

  // The owner, signed in as themselves, changes the rules of their Personal workspace.
  const read = await call(as(colleague), "GET", settings(mine));
  expect(read.status).toBe(200);
  expect(read.body.canEdit).toBe(true);
  const changed = await call(as(colleague), "PATCH", settings(mine), {
    crossProviderFailover: true,
    fallbackOrder: { "claude-opus": ["gpt-sol"] },
    rotation: { codex: { mode: "primary_first" } },
    expectedVersion: read.body.version,
  });
  expect(changed.status, JSON.stringify(changed.body)).toBe(200);
  expect(changed.body.sources).toMatchObject({
    crossProviderFailover: "workspace",
    fallbackOrder: "workspace",
    rotation: "workspace",
  });
  // And Codex's source and rotation there.
  const off = await call(as(colleague), "PATCH", `/v1/workspaces/${mine}/codex/source`, {
    mode: "disabled",
  });
  expect(off.status, JSON.stringify(off.body)).toBe(200);
  expect(off.body.effectiveSource).toBe("disabled");
  const rotation = await call(as(colleague), "PATCH", `/v1/workspaces/${mine}/codex/settings`, {
    rotationEnabled: true,
  });
  expect(rotation.status, JSON.stringify(rotation.body)).toBe(200);
  const on = await call(as(colleague), "PATCH", `/v1/workspaces/${mine}/codex/source`, {
    mode: "automatic",
  });
  expect(on.status).toBe(200);

  // A token naming the owner is not the owner acting as themselves.
  const ownerToken = await signDelegatedAccessToken(SECRET, {
    accountId,
    workspaceId: mine,
    subjectId: colleague.subjectId,
    permissions: ["workspace:read", "sessions:create", "connections:write"],
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1000) + 600,
  });
  const bearer = { authorization: `Bearer ${ownerToken}` };
  const delegatedRead = await call(bearer, "GET", settings(mine));
  expect(delegatedRead.status).toBe(200);
  expect(delegatedRead.body.canEdit).toBe(false);
  expect(
    (await call(bearer, "PATCH", settings(mine), { crossProviderFailover: false })).status,
  ).toBe(403);
  const delegatedOff = await call(bearer, "PATCH", `/v1/workspaces/${mine}/codex/source`, {
    mode: "disabled",
  });
  expect(delegatedOff.status).toBe(409);
  expect(
    (
      await call(bearer, "PATCH", `/v1/workspaces/${mine}/codex/settings`, {
        rotationEnabled: false,
      })
    ).status,
  ).toBe(404);

  // The organization's owner can't reach a colleague's Personal workspace, nor the colleague the owner's.
  const ownersPersonal = await personalOf(owner, accountId);
  for (const [who, workspaceId] of [
    [owner, mine],
    [colleague, ownersPersonal],
  ] as const) {
    expect([403, 404]).toContain((await call(as(who), "GET", settings(workspaceId))).status);
    expect([403, 404]).toContain(
      (await call(as(who), "PATCH", settings(workspaceId), { crossProviderFailover: false }))
        .status,
    );
    expect([403, 404]).toContain(
      (
        await call(as(who), "PATCH", `/v1/workspaces/${workspaceId}/codex/source`, {
          mode: "disabled",
        })
      ).status,
    );
  }
  expect((await call(as(colleague), "GET", settings(mine))).body.values.crossProviderFailover).toBe(
    true,
  );

  // A locked setting wins, and replaces the Personal workspace's change.
  const locked = await call(
    as(owner),
    "PATCH",
    `/v1/organizations/${accountId}/model-account-settings`,
    {
      crossProviderFailover: false,
      locked: ["crossProviderFailover"],
    },
  );
  expect(locked.status, JSON.stringify(locked.body)).toBe(200);
  const afterLock = await call(as(colleague), "GET", settings(mine));
  expect(afterLock.body.sources.crossProviderFailover).toBe("locked");
  expect(afterLock.body.values.crossProviderFailover).toBe(false);
  const refused = await call(as(colleague), "PATCH", settings(mine), {
    crossProviderFailover: true,
  });
  expect(refused.status).toBe(409);
  expect(refused.body.error.details).toEqual({
    reason: "setting_locked",
    settings: ["crossProviderFailover"],
  });
  expect(
    (await call(as(colleague), "PATCH", settings(mine), { personalConnectionsAllowed: false }))
      .status,
  ).toBe(200);

  // A shared workspace is unchanged: its admins change it, a member reads it.
  const created = await call(as(owner), "POST", "/v1/workspaces", { accountId, name: "Team" });
  expect(created.status).toBe(201);
  const team = String(created.body.id);
  await upsertWorkspaceMemberAsWorkspaceManager(client.db, {
    accountId,
    workspaceId: team,
    actorSubjectId: owner.subjectId,
    targetSubjectId: colleague.subjectId,
    mode: "add",
    role: "member",
    permissions: ["workspace:read", "sessions:create", "connections:read", "connections:write"],
  });
  const memberRead = await call(as(colleague), "GET", settings(team));
  expect(memberRead.status).toBe(200);
  expect(memberRead.body.canEdit).toBe(false);
  expect(
    (await call(as(colleague), "PATCH", settings(team), { personalConnectionsAllowed: false }))
      .status,
  ).toBe(403);
  expect((await call(as(owner), "GET", settings(team))).body.canEdit).toBe(true);
  expect(
    (await call(as(owner), "PATCH", settings(team), { personalConnectionsAllowed: false })).status,
  ).toBe(200);

  // Another organization: the colleague's Personal workspace there is their own and separate.
  const stranger = await signUp(true);
  const [elsewhere] = await shared.admin<Array<{ accountId: string; workspaceId: string }>>`
    select account_id as "accountId", personal_workspace_id as "workspaceId"
    from organization_memberships where subject_id = ${stranger.subjectId} and status = 'active'`;
  expect([403, 404]).toContain(
    (await call(as(colleague), "GET", settings(elsewhere!.workspaceId))).status,
  );
  await invite(stranger, elsewhere!.accountId, colleague);
  const theirs = await personalOf(colleague, elsewhere!.accountId);
  const there = await call(as(colleague), "GET", settings(theirs));
  expect(there.body.canEdit).toBe(true);
  expect(there.body.sources.crossProviderFailover).toBe("organization");
  expect(
    (await call(as(colleague), "PATCH", settings(theirs), { crossProviderFailover: true })).status,
  ).toBe(200);
  expect((await call(as(colleague), "GET", settings(mine))).body.values.crossProviderFailover).toBe(
    false,
  );
  await shared.admin`delete from workspace_memberships
    where workspace_id = ${team} and subject_id = ${colleague.subjectId}`;
}, 120_000);
