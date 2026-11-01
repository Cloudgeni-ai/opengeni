import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
import {
  ChannelAudienceMismatchError,
  ChannelNameConflictError,
  ChannelNotFoundError,
  createChannel,
  createDb,
  createSession,
  deleteChannel,
  getChannel,
  listChannels,
  moveSiteToProject,
  reorderChannels,
  setSessionChannel,
  transitionSessionVisibility,
  updateChannel,
} from "../src/index";
import { withSessionRlsActorContext } from "../src/database";

// A project is shared with its workspace or Only me, like a chat (1161). An
// Only me project is seen by its owner alone (and agent turns acting for
// them), holds only their own Only me chats, and its name never blocks or
// reaches anyone else. Runs as the restricted application role, as deployed.

let shared: RestrictedRuntimeTestDatabase;
let app: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireRestrictedRuntimeTestDatabase("project-audience");
  if (!acquired) throw new Error("PostgreSQL required");
  shared = acquired;
  app = createDb(shared.appUrl, { searchPath: shared.schema });
}, 600_000);
afterAll(async () => {
  await app?.close();
  await shared?.release();
}, 60_000);

async function workspace() {
  const accountId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  const owner = `user:${crypto.randomUUID()}`;
  const colleague = `user:${crypto.randomUUID()}`;
  const admin = `user:${crypto.randomUUID()}`;
  await shared.admin`insert into managed_accounts(id,name) values(${accountId},'Project audiences')`;
  await shared.admin`insert into workspaces(id,account_id,name) values(${workspaceId},${accountId},'Team')`;
  const personal = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()] as const;
  for (const id of personal)
    await shared.admin`insert into workspaces(id,account_id,name) values(${id},${accountId},'Personal')`;
  await shared.admin`insert into organization_memberships(account_id,subject_id,role,status,personal_workspace_id)
    values(${accountId},${owner},'member','active',${personal[0]}),
      (${accountId},${colleague},'member','active',${personal[1]}),
      (${accountId},${admin},'admin','active',${personal[2]})`;
  await shared.admin`insert into workspace_memberships(account_id,workspace_id,subject_id,role,permissions)
    values(${accountId},${workspaceId},${owner},'member',
        opengeni_private.workspace_member_role_permissions('member')),
      (${accountId},${workspaceId},${colleague},'member',
        opengeni_private.workspace_member_role_permissions('member')),
      (${accountId},${workspaceId},${admin},'admin',
        opengeni_private.workspace_member_role_permissions('admin'))`;
  await shared.admin`insert into workspace_inference_controls (account_id, workspace_id)
    values (${accountId}, ${workspaceId}) on conflict (workspace_id) do nothing`;
  return { accountId, workspaceId, owner, colleague, admin };
}

type Workspace = Awaited<ReturnType<typeof workspace>>;

const as = <T>(subjectId: string, run: () => Promise<T>) =>
  withSessionRlsActorContext({ subjectId }, run);
/** An agent turn acting for a person, as the runtime scopes it. */
const agentFor = <T>(person: string, run: () => Promise<T>) =>
  withSessionRlsActorContext(
    { subjectId: `agent:${crypto.randomUUID()}`, initiatingHumanSubjectId: person },
    run,
  );

function project(
  ws: Workspace,
  name: string,
  audience?: { visibility: "user_private" | "workspace_shared"; ownerSubjectId: string | null },
) {
  return createChannel(app.db, {
    accountId: ws.accountId,
    workspaceId: ws.workspaceId,
    name,
    createdBy: audience?.ownerSubjectId ?? ws.owner,
    ...(audience ? { audience } : {}),
  });
}

function chat(ws: Workspace, by: string, onlyMe: boolean) {
  return as(by, () =>
    createSession(app.db, {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      initialMessage: "",
      resources: [],
      metadata: {},
      createdBy: { kind: "subject", subjectId: by },
      createdByContext: {},
      ...(onlyMe ? { visibility: "user_private" as const, subjectId: by } : {}),
      model: "gpt-5.6-sol",
      reasoningEffort: "medium" as const,
      latencyMode: "standard" as const,
      sandboxBackend: "none",
    }),
  );
}

async function filedIn(sessionId: string): Promise<string | null> {
  const [row] = await shared.admin<Array<{ channel: string | null }>>`
    select channel_id::text as channel from sessions where id = ${sessionId}`;
  return row?.channel ?? null;
}

const names = (projects: readonly { name: string }[]) => projects.map((p) => p.name).sort();

test("an existing or unspecified project is shared with the whole workspace", async () => {
  const ws = await workspace();
  const shared_ = await as(ws.colleague, () => project(ws, "Roadmap"));
  expect(shared_.visibility).toBe("workspace");
  for (const viewer of [ws.owner, ws.colleague, ws.admin])
    expect(names(await as(viewer, () => listChannels(app.db, ws.workspaceId)))).toEqual([
      "Roadmap",
    ]);
}, 120_000);

test("an Only me project is seen by its owner and their agent turns, never by colleagues or admins", async () => {
  const ws = await workspace();
  const mine = await as(ws.owner, () =>
    project(ws, "Job search", { visibility: "user_private", ownerSubjectId: ws.owner }),
  );
  expect(mine.visibility).toBe("private");
  await as(ws.owner, () => project(ws, "Roadmap"));

  expect(names(await as(ws.owner, () => listChannels(app.db, ws.workspaceId)))).toEqual([
    "Job search",
    "Roadmap",
  ]);
  expect(names(await agentFor(ws.owner, () => listChannels(app.db, ws.workspaceId)))).toEqual([
    "Job search",
    "Roadmap",
  ]);
  for (const viewer of [ws.colleague, ws.admin]) {
    expect(names(await as(viewer, () => listChannels(app.db, ws.workspaceId)))).toEqual([
      "Roadmap",
    ]);
    expect(await as(viewer, () => getChannel(app.db, ws.workspaceId, mine.id))).toBeNull();
    // Nor can they rename, pin, share or delete it.
    expect(
      await as(viewer, () =>
        updateChannel(app.db, ws.workspaceId, mine.id, { name: "Seen", pinned: true }),
      ),
    ).toBeNull();
    expect(
      await as(viewer, () =>
        updateChannel(app.db, ws.workspaceId, mine.id, { visibility: "workspace_shared" }),
      ),
    ).toBeNull();
    expect(await as(viewer, () => deleteChannel(app.db, ws.workspaceId, mine.id))).toBe(false);
  }
  expect(names(await agentFor(ws.colleague, () => listChannels(app.db, ws.workspaceId)))).toEqual([
    "Roadmap",
  ]);

  // Someone else cannot make an Only me project owned by the owner.
  await expect(
    as(ws.colleague, () =>
      project(ws, "Planted", { visibility: "user_private", ownerSubjectId: ws.owner }),
    ),
  ).rejects.toThrow();

  // The colleague's reorder covers only what they see; the owner's covers both.
  const visibleToColleague = await as(ws.colleague, () => listChannels(app.db, ws.workspaceId));
  expect(
    await as(ws.colleague, () =>
      reorderChannels(
        app.db,
        ws.workspaceId,
        visibleToColleague.map((p) => p.id),
      ),
    ),
  ).not.toBeNull();
}, 120_000);

test("names are unique within an audience, so a private name blocks and reveals nothing", async () => {
  const ws = await workspace();
  await as(ws.owner, () =>
    project(ws, "Plans", { visibility: "user_private", ownerSubjectId: ws.owner }),
  );
  // A colleague can still use the name, shared or for themselves.
  await as(ws.colleague, () =>
    project(ws, "plans", { visibility: "user_private", ownerSubjectId: ws.colleague }),
  );
  const sharedPlans = await as(ws.colleague, () => project(ws, "PLANS"));
  // Within one audience a name stays unique.
  await expect(
    as(ws.owner, () =>
      project(ws, "plans", { visibility: "user_private", ownerSubjectId: ws.owner }),
    ),
  ).rejects.toBeInstanceOf(ChannelNameConflictError);
  await expect(as(ws.admin, () => project(ws, "Plans"))).rejects.toBeInstanceOf(
    ChannelNameConflictError,
  );
  expect(sharedPlans.visibility).toBe("workspace");
}, 120_000);

test("an Only me project holds only its owner's Only me chats", async () => {
  const ws = await workspace();
  const mine = await as(ws.owner, () =>
    project(ws, "Taxes", { visibility: "user_private", ownerSubjectId: ws.owner }),
  );
  const myOnlyMe = await chat(ws, ws.owner, true);
  const myShared = await chat(ws, ws.owner, false);
  const theirOnlyMe = await chat(ws, ws.colleague, true);

  expect(
    await as(ws.owner, () =>
      setSessionChannel(app.db, {
        workspaceId: ws.workspaceId,
        sessionId: myOnlyMe.id,
        channelId: mine.id,
      }),
    ),
  ).toBe(true);
  expect(await filedIn(myOnlyMe.id)).toBe(mine.id);

  await expect(
    as(ws.owner, () =>
      setSessionChannel(app.db, {
        workspaceId: ws.workspaceId,
        sessionId: myShared.id,
        channelId: mine.id,
      }),
    ),
  ).rejects.toBeInstanceOf(ChannelAudienceMismatchError);
  // The colleague does not see the project at all.
  await expect(
    as(ws.colleague, () =>
      setSessionChannel(app.db, {
        workspaceId: ws.workspaceId,
        sessionId: theirOnlyMe.id,
        channelId: mine.id,
      }),
    ),
  ).rejects.toBeInstanceOf(ChannelNotFoundError);

  // Written past the checks, a chat that does not fit is still left unfiled.
  await shared.admin`update sessions set channel_id = ${mine.id} where id = ${myShared.id}`;
  expect(await filedIn(myShared.id)).toBeNull();
  await shared.admin`update sessions set channel_id = ${mine.id} where id = ${theirOnlyMe.id}`;
  expect(await filedIn(theirOnlyMe.id)).toBeNull();

  // Sharing a chat takes it out of its owner's Only me project.
  const shared_ = await transitionSessionVisibility(app.db, {
    workspaceId: ws.workspaceId,
    sessionId: myOnlyMe.id,
    actorSubjectId: ws.owner,
    targetVisibility: "workspace_shared",
    expectedAuthorityEpoch: 1,
    operationKey: `share-${myOnlyMe.id}`,
  });
  expect(shared_).toMatchObject({ visibility: "workspace_shared", changed: true });
  expect(await filedIn(myOnlyMe.id)).toBeNull();
}, 120_000);

test("only the owner shares an Only me project, and a shared project never becomes Only me", async () => {
  const ws = await workspace();
  const mine = await as(ws.owner, () =>
    project(ws, "Launch", { visibility: "user_private", ownerSubjectId: ws.owner }),
  );
  const myOnlyMe = await chat(ws, ws.owner, true);
  await as(ws.owner, () =>
    setSessionChannel(app.db, {
      workspaceId: ws.workspaceId,
      sessionId: myOnlyMe.id,
      channelId: mine.id,
    }),
  );
  await as(ws.colleague, () => project(ws, "Taken"));
  const taken = await as(ws.owner, () =>
    project(ws, "taken", { visibility: "user_private", ownerSubjectId: ws.owner }),
  );
  // Sharing needs the name to be free among shared projects.
  await expect(
    as(ws.owner, () =>
      updateChannel(app.db, ws.workspaceId, taken.id, { visibility: "workspace_shared" }),
    ),
  ).rejects.toBeInstanceOf(ChannelNameConflictError);

  const nowShared = await as(ws.owner, () =>
    updateChannel(app.db, ws.workspaceId, mine.id, { visibility: "workspace_shared" }),
  );
  expect(nowShared?.visibility).toBe("workspace");
  expect(names(await as(ws.colleague, () => listChannels(app.db, ws.workspaceId)))).toEqual([
    "Launch",
    "Taken",
  ]);
  // The Only me chat stays in it, still seen by its owner alone.
  expect(await filedIn(myOnlyMe.id)).toBe(mine.id);

  await expect(
    shared.admin`update channels set visibility = 'user_private' where id = ${mine.id}`,
  ).rejects.toThrow("a shared project cannot be made Only me");
  await expect(
    shared.admin`update channels set owner_subject_id = ${ws.colleague} where id = ${taken.id}`,
  ).rejects.toThrow("a project keeps its owner");
}, 120_000);

test("an Only me project holds only its owner's Only me Sites, and a Site shared later leaves it", async () => {
  const ws = await workspace();
  const mine = await as(ws.owner, () =>
    project(ws, "Mine", { visibility: "user_private", ownerSubjectId: ws.owner }),
  );
  const site = async (owner: string | null) => {
    const id = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    await shared.admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`insert into workspace_artifacts (id, account_id, workspace_id, slug, title,
          current_version_id, created_by_subject_id, visibility, owner_subject_id)
        values (${id}, ${ws.accountId}, ${ws.workspaceId}, ${`site-${id.slice(0, 8)}`}, 'Page',
          ${versionId}, ${ws.owner},
          ${owner ? "user_private" : "workspace_shared"}, ${owner})`;
      await tx`insert into workspace_artifact_versions (id, account_id, workspace_id, artifact_id,
          revision, content_key, content_sha256, size_bytes, operation_key, source_session_id,
          source_turn_id, source_attempt_id, source_execution_generation, created_by_subject_id)
        values (${versionId}, ${ws.accountId}, ${ws.workspaceId}, ${id}, 1, ${`blob-${id}`},
          ${"a".repeat(64)}, 10, ${`op-${id}`}, ${crypto.randomUUID()}, ${crypto.randomUUID()},
          ${crypto.randomUUID()}, 1, ${ws.owner})`;
    });
    return id;
  };
  const placedIn = async (siteId: string) =>
    (
      await shared.admin<{ channelId: string | null }[]>`
        select channel_id::text as "channelId" from site_project_placements where site_id = ${siteId}`
    )[0]?.channelId;
  const move = (siteId: string) =>
    as(ws.owner, () =>
      moveSiteToProject(app.db, {
        workspaceId: ws.workspaceId,
        subjectId: ws.owner,
        siteId,
        fromChannelId: null,
        channelId: mine.id,
        sessionIds: [],
      }),
    );

  const sharedSite = await site(null);
  await expect(move(sharedSite)).rejects.toBeInstanceOf(ChannelAudienceMismatchError);
  expect(await placedIn(sharedSite)).toBeUndefined();
  // The database refuses it too, whoever writes.
  await expect(
    shared.admin`insert into site_project_placements (account_id, workspace_id, site_id, channel_id)
      values (${ws.accountId}, ${ws.workspaceId}, ${sharedSite}, ${mine.id})`,
  ).rejects.toThrow("an Only me project holds only its owner's Only me Sites");

  const ownSite = await site(ws.owner);
  expect((await move(ownSite)).siteMoved).toBe(true);
  expect(await placedIn(ownSite)).toBe(mine.id);

  // Sharing the Site takes it out of the Only me project.
  await shared.admin`update workspace_artifacts
    set visibility = 'workspace_shared', owner_subject_id = null where id = ${ownSite}`;
  expect(await placedIn(ownSite)).toBeUndefined();
}, 120_000);
