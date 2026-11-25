import { afterAll, beforeAll, expect, test } from "bun:test";
import type { SessionWorkflowClient } from "@opengeni/core";
import {
  acceptOrganizationInvitation,
  createDb,
  createOrganizationInvitation,
  ensureManagedAccessForUserWithOrganizationMemberships,
  upsertWorkspaceMemberAsWorkspaceManager,
  withWorkspaceSubjectRls,
  type DbClient,
} from "@opengeni/db";
import * as schema from "@opengeni/db/schema";
import { synchronizeCanonicalHumanLoginBindings } from "@opengeni/db/canonical-human-identities";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { createApp, type AppDependencies } from "../src/app";

/*
 * A meeting recorded in its owner's Personal workspace, shared with one of
 * their team workspaces: through the real app as signed-in people and
 * PostgreSQL as the restricted application role. Everyone in that workspace
 * lists and opens it there, read only; nobody else sees it; its owner changes
 * where it is shared, or unshares it, from wherever they see it; and the
 * share stops when its owner leaves the workspace.
 */

const ORIGIN = "https://opengeni.example";
let shared: SharedTestDatabase;
let client: DbClient;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("recordings-share-with-team");
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
  const settings = testSettings({
    productAccessMode: "managed",
    publicBaseUrl: ORIGIN,
    sandboxBackend: "none",
  });
  return createApp({
    db: client.db,
    bus: new MemoryEventBus(),
    settings,
    objectStorage: {
      createPutUrl: async (args: { key: string; contentType: string }) => ({
        url: `https://storage.example/${args.key}?signed=put`,
        requiredHeaders: { "content-type": args.contentType },
        expiresAt: new Date(Date.now() + 900_000),
      }),
      createGetUrl: async (args: { key: string }) => ({
        url: `https://storage.example/${args.key}?signed=get`,
        expiresAt: new Date(Date.now() + 3_600_000),
      }),
      headObject: async () => null,
      getObjectBytes: async () => null,
    },
    workflowClient: {
      signalUserMessage: noop,
      wakeSessionWorkflow: noop,
      requestSessionWorkflowWakeDispatch: noop,
      signalApprovalDecision: noop,
      signalSessionControl: noop,
      syncScheduledTask: noop,
      deleteScheduledTaskSchedule: noop,
      triggerScheduledTask: noop,
      startRecordingWorkflow: noop,
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
              user: { id: record.userId, email: record.email, emailVerified: true, name: "Lea" },
            },
          };
        },
      },
    },
  } as unknown as AppDependencies);
}

/** One verified login; `ownOrganization` bootstraps their own organization. */
async function signUp(ownOrganization: boolean): Promise<Person> {
  const userId = `share-team-${crypto.randomUUID()}`;
  const email = `${userId}@example.test`;
  const authSessionId = `session-${crypto.randomUUID()}`;
  await shared.admin`insert into auth_users (id, name, email, email_verified)
    values (${userId}, 'Lea', ${email}, true)`;
  await shared.admin`insert into auth_identities (id, user_id, provider_id, account_id)
    values (${crypto.randomUUID()}, ${userId}, 'credential', ${userId})`;
  if (ownOrganization)
    await ensureManagedAccessForUserWithOrganizationMemberships(client.db, {
      userId,
      email,
      name: "Lea",
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

async function personalWorkspace(person: Person) {
  const [found] = await shared.admin<Array<{ accountId: string; personalWorkspaceId: string }>>`
    select account_id as "accountId", personal_workspace_id as "personalWorkspaceId"
    from organization_memberships
    where subject_id = ${person.subjectId} and status = 'active'`;
  if (!found) throw new Error("No organization membership");
  return found;
}

/** Adds a new person to the organization. */
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

test("a Personal workspace meeting shared with a team workspace opens there, read only, for its members", async () => {
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
  const { accountId, personalWorkspaceId: personal } = await personalWorkspace(owner);
  const workspace = async (by: Person, name: string) => {
    const created = await call(as(by), "POST", "/v1/workspaces", { accountId, name });
    expect(created.status).toBe(201);
    return String(created.body.id);
  };
  const team = await workspace(owner, "Team");
  const sales = await workspace(owner, "Sales");
  const colleague = await invite(owner, accountId);
  const seller = await invite(owner, accountId);
  const add = async (person: Person, workspaceId: string) =>
    await upsertWorkspaceMemberAsWorkspaceManager(client.db, {
      accountId,
      workspaceId,
      actorSubjectId: owner.subjectId,
      targetSubjectId: person.subjectId,
      mode: "add",
      role: "member",
      permissions: (await rolePermissions("member")) as never,
    });
  await add(colleague, team);
  await add(seller, sales);
  // A workspace of the organization the owner doesn't belong to.
  const theirs = await workspace(owner, "Colleague's own");
  await add(colleague, theirs);
  await shared.admin`delete from workspace_memberships
    where workspace_id = ${theirs} and subject_id = ${owner.subjectId}`;
  const record = async (workspaceId: string, title: string, startedAt: string) => {
    const recordingId = crypto.randomUUID();
    const created = await call(as(owner), "POST", `/v1/workspaces/${workspaceId}/recordings`, {
      recordingId,
      title,
      startedAt,
      tracks: [{ trackNumber: 0, source: "microphone", mimeType: "audio/webm" }],
    });
    expect(created.status).toBe(201);
    return recordingId;
  };
  const ids = (result: Result) => result.body.recordings.map((row: { id: string }) => row.id);
  const at = (person: Person, workspaceId: string, method: string, path: string, body?: unknown) =>
    call(as(person), method, `/v1/workspaces/${workspaceId}${path}`, body);
  const share = (from: string, recordingId: string, body: unknown, who = owner) =>
    at(who, from, "PATCH", `/recordings/${recordingId}`, body);

  const customer = await record(personal, "Customer call", "2026-11-20T09:00:00Z");
  const teamOwn = await record(team, "Standup", "2026-11-20T08:00:00Z");
  expect((await at(colleague, team, "GET", `/recordings/${customer}`)).status).toBe(404);
  expect(ids(await at(colleague, team, "GET", "/recordings"))).toEqual([]);

  // Shared from Personal with Team.
  expect(await share(personal, customer, { sharedWorkspaceId: team })).toMatchObject({
    status: 200,
    body: { visibility: "workspace", sharedWorkspaceId: team, workspaceId: personal },
  });
  // Everyone in Team lists and opens it there, with its notes.
  expect(ids(await at(colleague, team, "GET", "/recordings"))).toEqual([customer]);
  const opened = await at(colleague, team, "GET", `/recordings/${customer}`);
  expect(opened).toMatchObject({
    status: 200,
    body: { id: customer, workspaceId: personal, sharedWorkspaceId: team },
  });
  expect(opened.body.sourceWorkspace ?? null).toBeNull();
  expect((await at(colleague, team, "GET", `/recordings/${customer}/notes`)).status).toBe(200);
  expect((await at(colleague, team, "GET", `/recordings/${customer}/transcripts`)).status).toBe(
    200,
  );
  // Read only: only its owner changes, re-runs, shares or deletes it.
  for (const [method, path, body] of [
    ["PATCH", "", { title: "Renamed" }],
    ["PATCH", "", { visibility: "private" }],
    ["PUT", "/notes/notes", { body: "Mine now" }],
    ["POST", "/transcripts", {}],
    ["DELETE", "", undefined],
  ] as const) {
    expect((await at(colleague, team, method, `/recordings/${customer}${path}`, body)).status).toBe(
      403,
    );
  }
  // Nobody else: not Sales, nor the colleague from another workspace.
  expect((await at(seller, sales, "GET", `/recordings/${customer}`)).status).toBe(404);
  expect(ids(await at(seller, sales, "GET", "/recordings"))).toEqual([]);
  expect((await at(colleague, theirs, "GET", `/recordings/${customer}`)).status).toBe(404);
  // Its owner opens it from Team as their own, and still changes it there.
  expect(await at(owner, team, "GET", `/recordings/${customer}`)).toMatchObject({
    status: 200,
    body: { sourceWorkspace: { id: personal }, sharedWorkspaceId: team },
  });
  expect(
    await at(owner, team, "PATCH", `/recordings/${customer}`, { title: "Customer call, Acme" }),
  ).toMatchObject({ status: 200, body: { title: "Customer call, Acme" } });
  expect(ids(await at(owner, team, "GET", "/recordings"))).toEqual([customer, teamOwn]);

  // Only the owner's team workspaces they belong to, and only from Personal.
  expect((await share(personal, customer, { sharedWorkspaceId: theirs })).status).toBe(400);
  expect((await share(personal, customer, { sharedWorkspaceId: crypto.randomUUID() })).status).toBe(
    400,
  );
  expect(
    (await share(personal, customer, { visibility: "private", sharedWorkspaceId: team })).status,
  ).toBe(400);
  expect((await share(team, teamOwn, { sharedWorkspaceId: sales })).status).toBe(409);

  // Shared with Sales instead, from Team: it leaves Team.
  expect(
    await share(team, customer, { visibility: "workspace", sharedWorkspaceId: sales }),
  ).toMatchObject({ status: 200, body: { sharedWorkspaceId: sales } });
  expect(ids(await at(colleague, team, "GET", "/recordings"))).toEqual([]);
  expect((await at(colleague, team, "GET", `/recordings/${customer}`)).status).toBe(404);
  expect(ids(await at(seller, sales, "GET", "/recordings"))).toEqual([customer]);
  // Naming its visibility again, without the workspace, keeps it shared there.
  expect(
    await share(personal, customer, { visibility: "workspace", title: "Acme call" }),
  ).toMatchObject({ status: 200, body: { sharedWorkspaceId: sales, title: "Acme call" } });
  expect(ids(await at(seller, sales, "GET", "/recordings"))).toEqual([customer]);
  // A meeting that isn't there is not found, not refused.
  expect((await share(team, crypto.randomUUID(), { sharedWorkspaceId: sales })).status).toBe(404);
  // Anyone in Team still renames a meeting shared there, naming its visibility unchanged.
  expect((await share(team, teamOwn, { visibility: "workspace" })).status).toBe(200);
  expect(
    await at(colleague, team, "PATCH", `/recordings/${teamOwn}`, {
      title: "Standup, Tuesday",
      visibility: "workspace",
    }),
  ).toMatchObject({ status: 200, body: { title: "Standup, Tuesday", sharedWorkspaceId: null } });

  // Unshared: Only me again, for its owner alone.
  expect(await share(sales, customer, { visibility: "private" })).toMatchObject({
    status: 200,
    body: { visibility: "private", sharedWorkspaceId: null },
  });
  expect((await at(seller, sales, "GET", `/recordings/${customer}`)).status).toBe(404);
  expect(ids(await at(seller, sales, "GET", "/recordings"))).toEqual([]);
  const [{ count }] = await shared.admin<Array<{ count: number }>>`
    select count(*)::int as count from recording_shares where recording_id = ${customer}`;
  expect(count).toBe(0);
  // The application role lets nobody else share it, as themselves or as its owner.
  for (const sharedBy of [colleague.subjectId, owner.subjectId]) {
    await expect(
      withWorkspaceSubjectRls(client.db, personal, colleague.subjectId, async (tx) =>
        tx.insert(schema.recordingShares).values({
          accountId,
          recordingWorkspaceId: personal,
          recordingId: customer,
          workspaceId: team,
          sharedBySubjectId: sharedBy,
        }),
      ),
    ).rejects.toThrow();
  }

  // A share left behind while it was Only me (by an older server) never comes
  // back by itself: sharing it again names the workspace.
  expect((await share(personal, customer, { sharedWorkspaceId: sales })).status).toBe(200);
  await shared.admin`update recordings set visibility = 'user_private' where id = ${customer}`;
  expect(await share(personal, customer, { visibility: "workspace" })).toMatchObject({
    status: 200,
    body: { sharedWorkspaceId: null },
  });
  expect((await at(seller, sales, "GET", `/recordings/${customer}`)).status).toBe(404);
  expect((await share(personal, customer, { visibility: "private" })).status).toBe(200);
  // No workspace named shares nothing.
  expect((await share(team, teamOwn, { visibility: "private" })).status).toBe(200);
  expect(await share(team, teamOwn, { sharedWorkspaceId: null })).toMatchObject({
    status: 200,
    body: { visibility: "private" },
  });

  // Its owner leaving the workspace ends the share.
  expect((await share(personal, customer, { sharedWorkspaceId: team })).status).toBe(200);
  expect((await at(colleague, team, "GET", `/recordings/${customer}`)).status).toBe(200);
  await shared.admin`delete from workspace_memberships
    where workspace_id = ${team} and subject_id = ${owner.subjectId}`;
  expect((await at(colleague, team, "GET", `/recordings/${customer}`)).status).toBe(404);
  expect(ids(await at(colleague, team, "GET", "/recordings"))).toEqual([]);

  // Deleting the meeting removes the share.
  await shared.admin`delete from recordings where id = ${customer}`;
  const [{ left }] = await shared.admin<Array<{ left: number }>>`
    select count(*)::int as left from recording_shares where recording_id = ${customer}`;
  expect(left).toBe(0);
}, 180_000);
