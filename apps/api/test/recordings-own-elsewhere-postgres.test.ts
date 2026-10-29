import { afterAll, beforeAll, expect, test } from "bun:test";
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
 * A person's own Only me meetings across the workspaces of their
 * organization, through the real app as signed-in people (a verified managed
 * cookie, as in the product) and PostgreSQL as the restricted application
 * role. They are listed and open in place in every workspace of the
 * organization the person can read now, with the access the request has in
 * the workspace that stores them; nobody else's, no shared ones, and nothing
 * from another organization.
 */

const ORIGIN = "https://opengeni.example";
let shared: SharedTestDatabase;
let client: DbClient;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("recordings-own-elsewhere");
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
  const userId = `own-elsewhere-${crypto.randomUUID()}`;
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

async function personalWorkspace(person: Person, accountId?: string) {
  const rows = await shared.admin<Array<{ accountId: string; personalWorkspaceId: string }>>`
    select account_id as "accountId", personal_workspace_id as "personalWorkspaceId"
    from organization_memberships
    where subject_id = ${person.subjectId} and status = 'active'`;
  const found = rows.find((row) => !accountId || row.accountId === accountId);
  if (!found) throw new Error("No organization membership");
  return found;
}

/** Adds `person` (signed up already, or new) to the organization. */
async function invite(owner: Person, accountId: string, existing?: Person): Promise<Person> {
  const person = existing ?? (await signUp(false));
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

test("own Only me meetings open in place across the organization's workspaces, and nowhere else", async () => {
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
  const workspace = async (name: string) => {
    const created = await call(as(owner), "POST", "/v1/workspaces", { accountId, name });
    expect(created.status).toBe(201);
    return String(created.body.id);
  };
  const team = await workspace("Team");
  const sales = await workspace("Sales");
  const colleague = await invite(owner, accountId);
  const reader = await invite(owner, accountId);
  const add = async (person: Person, workspaceId: string, role: "member" | "viewer") =>
    await upsertWorkspaceMemberAsWorkspaceManager(client.db, {
      accountId,
      workspaceId,
      actorSubjectId: owner.subjectId,
      targetSubjectId: person.subjectId,
      mode: "add",
      role,
      permissions: (await rolePermissions(role)) as never,
    });
  await add(colleague, team, "member");
  await add(colleague, sales, "member");
  await add(reader, team, "member");
  await add(reader, sales, "member");
  const record = async (person: Person, workspaceId: string, title: string, startedAt: string) => {
    const recordingId = crypto.randomUUID();
    const created = await call(as(person), "POST", `/v1/workspaces/${workspaceId}/recordings`, {
      recordingId,
      title,
      startedAt,
      tracks: [{ trackNumber: 0, source: "microphone", mimeType: "audio/webm" }],
    });
    expect(created.status).toBe(201);
    return recordingId;
  };
  const ids = (result: Result) => result.body.recordings.map((row: { id: string }) => row.id);
  const inTeam = (person: Person, method: string, path: string, body?: unknown) =>
    call(as(person), method, `/v1/workspaces/${team}${path}`, body);

  const older = await record(owner, sales, "Pipeline review", "2026-10-26T08:00:00Z");
  const newer = await record(owner, sales, "Forecast", "2026-10-27T08:00:00Z");
  const notes = await record(owner, personal, "My notes", "2026-10-27T07:00:00Z");
  const allHands = await record(owner, sales, "All hands", "2026-10-27T09:00:00Z");
  expect(
    (
      await call(as(owner), "PATCH", `/v1/workspaces/${sales}/recordings/${allHands}`, {
        visibility: "workspace",
      })
    ).status,
  ).toBe(200);
  const theirs = await record(colleague, sales, "Colleague's", "2026-10-27T10:00:00Z");
  const here = await record(owner, team, "Here", "2026-10-27T11:00:00Z");

  // Team lists the owner's own Only me meetings from Sales and their Personal
  // workspace, labelled with where each is stored, in the one list.
  const listed = await inTeam(owner, "GET", "/recordings");
  expect(listed.status).toBe(200);
  expect(
    listed.body.recordings.map((row: { id: string; sourceWorkspace?: { id: string } | null }) => [
      row.id,
      row.sourceWorkspace?.id ?? null,
    ]),
  ).toEqual([
    [here, null],
    [newer, sales],
    [notes, personal],
    [older, sales],
  ]);
  // Pages continue across workspaces.
  const first = await inTeam(owner, "GET", "/recordings?limit=2");
  expect(ids(first)).toEqual([here, newer]);
  const cursor = first.body.nextBefore;
  const rest = await inTeam(
    owner,
    "GET",
    `/recordings?limit=2&beforeStartedAt=${encodeURIComponent(cursor.startedAt)}&beforeId=${cursor.id}`,
  );
  expect(ids(rest)).toEqual([notes, older]);
  // The Personal workspace lists the shared workspaces' ones too.
  expect(ids(await call(as(owner), "GET", `/v1/workspaces/${personal}/recordings`))).toEqual([
    here,
    newer,
    notes,
    older,
  ]);

  // It opens in place, as the owner, with its notes and title.
  expect(await inTeam(owner, "GET", `/recordings/${newer}`)).toMatchObject({
    status: 200,
    body: { id: newer, workspaceId: sales, sourceWorkspace: { id: sales, name: "Sales" } },
  });
  expect(
    (await inTeam(owner, "PUT", `/recordings/${newer}/notes/notes`, { body: "Follow up" })).status,
  ).toBe(200);
  expect(
    (await call(as(owner), "GET", `/v1/workspaces/${sales}/recordings/${newer}/notes`)).body
      .notes[0],
  ).toMatchObject({ body: "Follow up" });
  expect(
    await inTeam(owner, "PATCH", `/recordings/${newer}`, { title: "Forecast, Q4" }),
  ).toMatchObject({ status: 200, body: { title: "Forecast, Q4" } });
  // Sharing it shares it with Sales, so that is done there.
  expect(
    (await inTeam(owner, "PATCH", `/recordings/${newer}`, { visibility: "workspace" })).status,
  ).toBe(409);
  // Shared and other people's meetings stay where they are.
  for (const id of [allHands, theirs]) {
    expect((await inTeam(owner, "GET", `/recordings/${id}`)).status).toBe(404);
  }
  // A colleague in both workspaces sees only their own.
  expect(ids(await inTeam(colleague, "GET", "/recordings"))).toEqual([theirs]);
  expect((await inTeam(colleague, "GET", `/recordings/${newer}`)).status).toBe(404);

  // With read-only access to the storing workspace, it is read, not changed.
  const readers = await record(reader, sales, "Reader's own", "2026-10-25T08:00:00Z");
  await upsertWorkspaceMemberAsWorkspaceManager(client.db, {
    accountId,
    workspaceId: sales,
    actorSubjectId: owner.subjectId,
    targetSubjectId: reader.subjectId,
    mode: "update",
    role: "viewer",
    permissions: (await rolePermissions("viewer")) as never,
  });
  expect(ids(await inTeam(reader, "GET", "/recordings"))).toContain(readers);
  expect((await inTeam(reader, "GET", `/recordings/${readers}`)).status).toBe(200);
  expect(
    (await inTeam(reader, "PATCH", `/recordings/${readers}`, { title: "Renamed" })).status,
  ).toBe(404);
  expect(
    (await inTeam(reader, "PUT", `/recordings/${readers}/notes/notes`, { body: "x" })).status,
  ).toBe(404);

  // A key the owner scoped to Team reaches only Team's meetings.
  const key = await call(as(owner), "POST", `/v1/organizations/${accountId}/personal-api-keys`, {
    name: "Team only",
    access: {
      preset: "full",
      permissions: ["workspace:read", "sessions:read", "sessions:create"],
      workspaceScope: { kind: "selected", workspaceIds: [team] },
    },
  });
  expect(key.status).toBe(201);
  const bearer = { authorization: `Bearer ${key.body.token}` };
  const keyed = await call(bearer, "GET", `/v1/workspaces/${team}/recordings`);
  expect(keyed.status).toBe(200);
  expect(ids(keyed)).toEqual([here]);
  expect((await call(bearer, "GET", `/v1/workspaces/${team}/recordings/${newer}`)).status).toBe(
    404,
  );

  // Another organization the owner also belongs to: nothing crosses, either way.
  const stranger = await signUp(true);
  const elsewhere = await personalWorkspace(stranger);
  await invite(stranger, elsewhere.accountId, owner);
  const { personalWorkspaceId: theirPersonal } = await personalWorkspace(
    owner,
    elsewhere.accountId,
  );
  const foreign = await record(owner, theirPersonal, "Board meeting", "2026-10-27T12:00:00Z");
  const there = await call(as(owner), "GET", `/v1/workspaces/${theirPersonal}/recordings`);
  expect(ids(there)).toEqual([foreign]);
  for (const id of [newer, notes, older]) {
    expect(
      (await call(as(owner), "GET", `/v1/workspaces/${theirPersonal}/recordings/${id}`)).status,
    ).toBe(404);
  }
  const back = await inTeam(owner, "GET", "/recordings");
  expect(ids(back)).not.toContain(foreign);
  expect(JSON.stringify(back.body)).not.toContain("Board meeting");
  expect((await inTeam(owner, "GET", `/recordings/${foreign}`)).status).toBe(404);

  // Leaving Sales takes its meetings with it.
  await shared.admin`delete from workspace_memberships
    where workspace_id = ${sales} and subject_id = ${owner.subjectId}`;
  expect(ids(await inTeam(owner, "GET", "/recordings"))).toEqual([here, notes]);
  expect((await inTeam(owner, "GET", `/recordings/${newer}`)).status).toBe(404);
}, 120_000);
