import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  createDb,
  type DbClient,
  installTeamsBot,
  enqueueTeamsMessage,
  claimTeamsRoute,
  getTeamsChatChoice,
  setTeamsChatChoice,
  clearTeamsChatChoice,
  putTeamsRoutePrompt,
  readTeamsRoutePrompt,
  takeTeamsRoutePromptOption,
  pruneTeamsRoutePrompts,
  getTeamsReach,
  setTeamsReach,
  teamsReachIncludes,
  listTeamsAgentDirectory,
  removeTeamsLink,
  TEAMS_ROUTE_PROMPT_TTL_MS,
} from "../src";
import { PERSONAL_WORKSPACE_EXTERNAL_SOURCE } from "../src/personal-workspace-membership";

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
beforeAll(async () => {
  shared = await acquireSharedTestDatabase("teams-routing");
  if (!shared) throw new Error("Real PostgreSQL required");
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
});

/** An organization with a Teams installation in `home`, two more shared workspaces and a Personal one. */
async function organization() {
  const accountId = crypto.randomUUID(),
    home = crypto.randomUUID(),
    design = crypto.randomUUID(),
    sales = crypto.randomUUID(),
    personal = crypto.randomUUID(),
    tenantId = crypto.randomUUID(),
    actorId = crypto.randomUUID(),
    subjectId = `user:${crypto.randomUUID()}`;
  await shared!.admin`insert into managed_accounts(id,name) values(${accountId},'Teams routing')`;
  await shared!.admin`insert into workspaces(id,account_id,name) values
    (${home},${accountId},'Home'),(${design},${accountId},'Design'),(${sales},${accountId},'Sales')`;
  await shared!.admin`insert into workspaces(id,account_id,name,external_source,external_id)
    values(${personal},${accountId},'Personal',${PERSONAL_WORKSPACE_EXTERNAL_SOURCE},${`${accountId}:${subjectId}`})`;
  await shared!
    .admin`insert into organization_memberships(account_id,subject_id,role,status,personal_workspace_id)
    values(${accountId},${subjectId},'member','active',${personal})`;
  const i = await installTeamsBot(client!.db, {
    accountId,
    workspaceId: home,
    tenantId,
    actorId,
    subjectId,
    nonce: crypto.randomUUID(),
  });
  return { i, accountId, home, design, sales, personal, tenantId, actorId, subjectId };
}

async function agent(
  accountId: string,
  workspaceId: string,
  name: string,
  visibility: "workspace" | "private" = "workspace",
  owner: string | null = null,
) {
  const id = crypto.randomUUID();
  await shared!
    .admin`insert into agents(id,account_id,workspace_id,visibility,owner_subject_id,name,name_key,origin)
    values(${id},${accountId},${workspaceId},${visibility},${owner},${name},${name.toLowerCase()},'app')`;
  return id;
}

test("a chat choice is the linked person's memory in their organization, and goes with their link", async () => {
  const o = await organization();
  const who = { actorId: o.actorId, subjectId: o.subjectId };
  expect(await getTeamsChatChoice(client!.db, o.i, who)).toBeNull();
  const helper = await agent(o.accountId, o.design, "Helper");
  await setTeamsChatChoice(client!.db, o.i, { ...who, workspaceId: o.design, agentId: helper });
  expect(await getTeamsChatChoice(client!.db, o.i, who)).toMatchObject({
    workspaceId: o.design,
    agentId: helper,
    version: 1,
  });
  await setTeamsChatChoice(client!.db, o.i, { ...who, workspaceId: o.sales, agentId: null });
  expect(await getTeamsChatChoice(client!.db, o.i, who)).toMatchObject({
    workspaceId: o.sales,
    agentId: null,
    version: 2,
  });
  // Another Opengeni account reading the same Teams person sees nothing.
  expect(
    await getTeamsChatChoice(client!.db, o.i, { actorId: o.actorId, subjectId: "user:other" }),
  ).toBeNull();
  // Only the linked person can store one.
  await expect(
    setTeamsChatChoice(client!.db, o.i, {
      actorId: o.actorId,
      subjectId: "user:other",
      workspaceId: o.design,
      agentId: null,
    }),
  ).rejects.toThrow("teams_link_missing");
  await clearTeamsChatChoice(client!.db, o.i, { actorId: o.actorId });
  expect(await getTeamsChatChoice(client!.db, o.i, who)).toBeNull();
  await setTeamsChatChoice(client!.db, o.i, { ...who, workspaceId: o.design, agentId: null });
  await removeTeamsLink(client!.db, o.i, o.subjectId);
  expect(
    await shared!.admin`select 1 from teams_bot_chat_choices where tenant_id=${o.tenantId}`,
  ).toHaveLength(0);
});

test("route tables never name a workspace or agent of another organization", async () => {
  const o = await organization();
  const other = await organization();
  const foreignAgent = await agent(other.accountId, other.design, "Foreign");
  const who = { actorId: o.actorId, subjectId: o.subjectId };
  await expect(
    setTeamsChatChoice(client!.db, o.i, { ...who, workspaceId: other.design, agentId: null }),
  ).rejects.toThrow();
  await expect(
    setTeamsChatChoice(client!.db, o.i, { ...who, workspaceId: o.design, agentId: foreignAgent }),
  ).rejects.toThrow();
  await expect(
    putTeamsRoutePrompt(client!.db, o.i, {
      ...who,
      payload: null,
      options: [{ workspaceId: other.design, agentId: null }],
    }),
  ).rejects.toThrow();
  // The same-account CHECK holds even for the table owner.
  await expect(
    shared!
      .admin`insert into teams_bot_chat_choices(account_id,workspace_id,tenant_id,actor_id,subject_id,target_account_id,target_workspace_id)
      values(${o.accountId},${o.home},${o.tenantId},${o.actorId},${o.subjectId},${other.accountId},${other.design})`,
  ).rejects.toThrow(/teams_bot_chat_choices_same_account_check/);
  await enqueueTeamsMessage(client!.db, o.i, {
    routeId: `route:${crypto.randomUUID()}`,
    actorId: o.actorId,
    subjectId: o.subjectId,
    personal: true,
    conversationId: "19:dm",
    threadId: null,
    serviceUrl: "https://smba.trafficmanager.net/emea/",
    botId: "28:test",
    eventId: `event:${crypto.randomUUID()}`,
    payload: { text: "hello" },
  });
  await expect(
    shared!
      .admin`update teams_bot_routes set agent_id=${foreignAgent} where tenant_id=${o.tenantId}`,
  ).rejects.toThrow(/teams_bot_routes_agent/);
});

test("a switch card's numbers count once, only on the latest fresh card of this installation", async () => {
  const o = await organization();
  const who = { actorId: o.actorId, subjectId: o.subjectId };
  const helper = await agent(o.accountId, o.design, "Helper");
  await putTeamsRoutePrompt(client!.db, o.i, {
    ...who,
    payload: null,
    options: [{ workspaceId: o.sales, agentId: null }],
  });
  await putTeamsRoutePrompt(client!.db, o.i, {
    ...who,
    payload: { text: "waiting message" },
    options: [
      { workspaceId: o.design, agentId: null },
      { workspaceId: o.design, agentId: helper },
    ],
  });
  const card = await readTeamsRoutePrompt(client!.db, o.i, who);
  expect(card?.payload).toEqual({ text: "waiting message" });
  expect(card?.options).toEqual([
    { position: 1, workspaceId: o.design, agentId: null },
    { position: 2, workspaceId: o.design, agentId: helper },
  ]);
  expect(
    await takeTeamsRoutePromptOption(client!.db, o.i, {
      ...who,
      subjectId: "user:other",
      position: 1,
    }),
  ).toBeNull();
  expect(await takeTeamsRoutePromptOption(client!.db, o.i, { ...who, position: 3 })).toBeNull();
  expect(await takeTeamsRoutePromptOption(client!.db, o.i, { ...who, position: 2 })).toEqual({
    target: { workspaceId: o.design, agentId: helper },
    payload: { text: "waiting message" },
  });
  // Answered: a second answer finds nothing.
  expect(await takeTeamsRoutePromptOption(client!.db, o.i, { ...who, position: 1 })).toBeNull();

  await putTeamsRoutePrompt(client!.db, o.i, {
    ...who,
    payload: null,
    options: [{ workspaceId: o.sales, agentId: null }],
  });
  const later = new Date(Date.now() + TEAMS_ROUTE_PROMPT_TTL_MS + 1000);
  expect(await readTeamsRoutePrompt(client!.db, o.i, { ...who, now: later })).toBeNull();
  expect(
    await takeTeamsRoutePromptOption(client!.db, o.i, { ...who, position: 1, now: later }),
  ).toBeNull();
  // A card from an earlier installation generation doesn't count.
  expect(
    await readTeamsRoutePrompt(client!.db, { ...o.i, generation: crypto.randomUUID() }, who),
  ).toBeNull();
  expect(await pruneTeamsRoutePrompts(client!.db, o.i, later)).toBe(1);
  expect(await readTeamsRoutePrompt(client!.db, o.i, who)).toBeNull();
  await expect(
    putTeamsRoutePrompt(client!.db, o.i, { ...who, payload: null, options: [] }),
  ).rejects.toThrow("teams_route_prompt_options_invalid");
});

test("the organization's reach defaults to every workspace and narrows to shared workspaces it owns", async () => {
  const o = await organization();
  const other = await organization();
  const reach = await getTeamsReach(client!.db, o.i);
  expect(reach).toEqual({ workspaceIds: null, personalWorkspaces: true, version: 1 });
  for (const id of [o.home, o.design, o.sales])
    expect(teamsReachIncludes(reach, o.i, { workspaceId: id, personal: false })).toBe(true);
  expect(teamsReachIncludes(reach, o.i, { workspaceId: o.personal, personal: true })).toBe(true);

  const narrowed = await setTeamsReach(client!.db, o.i, {
    workspaceIds: [o.design, o.home, o.design],
    personalWorkspaces: false,
    expectedVersion: 1,
  });
  // The installation's own workspace is implied, never stored.
  expect(narrowed).toEqual({ workspaceIds: [o.design], personalWorkspaces: false, version: 2 });
  expect(teamsReachIncludes(narrowed, o.i, { workspaceId: o.home, personal: false })).toBe(true);
  expect(teamsReachIncludes(narrowed, o.i, { workspaceId: o.design, personal: false })).toBe(true);
  expect(teamsReachIncludes(narrowed, o.i, { workspaceId: o.sales, personal: false })).toBe(false);
  expect(teamsReachIncludes(narrowed, o.i, { workspaceId: o.personal, personal: true })).toBe(
    false,
  );
  // A stale editor fails instead of overwriting.
  await expect(
    setTeamsReach(client!.db, o.i, {
      workspaceIds: null,
      personalWorkspaces: true,
      expectedVersion: 1,
    }),
  ).rejects.toThrow("teams_reach_version_conflict");
  // Another organization's workspace, or a Personal workspace, can't be selected.
  await expect(
    setTeamsReach(client!.db, o.i, { workspaceIds: [other.design], personalWorkspaces: true }),
  ).rejects.toThrow("teams_reach_invalid");
  await expect(
    setTeamsReach(client!.db, o.i, { workspaceIds: [o.personal], personalWorkspaces: true }),
  ).rejects.toThrow("teams_reach_invalid");
  expect(
    await setTeamsReach(client!.db, o.i, { workspaceIds: [], personalWorkspaces: true }),
  ).toEqual({ workspaceIds: [], personalWorkspaces: true, version: 3 });
  expect(await getTeamsReach(client!.db, other.i)).toMatchObject({ workspaceIds: null });
});

test("the agent directory lists shared agents of shared workspaces, never Only me or Personal ones", async () => {
  const o = await organization();
  const other = await organization();
  const helper = await agent(o.accountId, o.design, "Helper");
  const writer = await agent(o.accountId, o.sales, "Writer");
  await agent(o.accountId, o.design, "Mine", "private", o.subjectId);
  await agent(o.accountId, o.personal, "Personal");
  await agent(other.accountId, other.design, "Foreign");
  const all = await listTeamsAgentDirectory(client!.db, {
    accountId: o.accountId,
    workspaceIds: [o.design, o.sales, o.personal, other.design],
  });
  expect(all.map((a) => [a.id, a.workspaceId, a.name])).toEqual([
    [helper, o.design, "Helper"],
    [writer, o.sales, "Writer"],
  ]);
  expect(
    (
      await listTeamsAgentDirectory(client!.db, { accountId: o.accountId, workspaceIds: [o.sales] })
    ).map((a) => a.id),
  ).toEqual([writer]);
  expect(
    await listTeamsAgentDirectory(client!.db, { accountId: o.accountId, workspaceIds: [] }),
  ).toEqual([]);
});

test("a routed 1:1 route holds its workspace and agent, checked by the caller in the enqueue transaction", async () => {
  const o = await organization();
  const helper = await agent(o.accountId, o.design, "Helper");
  const message = (routeId: string, extra: Record<string, unknown> = {}) => ({
    routeId,
    actorId: o.actorId,
    subjectId: o.subjectId,
    personal: true,
    conversationId: "19:dm",
    threadId: null,
    serviceUrl: "https://smba.trafficmanager.net/emea/",
    botId: "28:test",
    eventId: `event:${crypto.randomUUID()}`,
    payload: { text: "routed" },
    ...extra,
  });
  const checked: string[] = [];
  const allow = async (_tx: unknown, workspaceId: string) => {
    checked.push(workspaceId);
    return workspaceId === o.design;
  };
  await expect(
    enqueueTeamsMessage(
      client!.db,
      o.i,
      message(`route:${crypto.randomUUID()}`, {
        sessionWorkspaceId: o.sales,
        authorizeSessionWorkspace: allow,
      }),
    ),
  ).rejects.toThrow("teams_route_unavailable");
  // An agent is only ever on a 1:1 route.
  await expect(
    enqueueTeamsMessage(
      client!.db,
      o.i,
      message(`route:${crypto.randomUUID()}`, {
        personal: false,
        channelId: "19:channel",
        agentId: helper,
      }),
    ),
  ).rejects.toThrow("teams_route_unavailable");
  const routeId = `route:${crypto.randomUUID()}`;
  await enqueueTeamsMessage(
    client!.db,
    o.i,
    message(routeId, {
      sessionWorkspaceId: o.design,
      authorizeSessionWorkspace: allow,
      agentId: helper,
    }),
  );
  expect(checked).toEqual([o.sales, o.design]);
  // The same route can't later be read as another agent's or as the plain assistant's.
  await expect(
    enqueueTeamsMessage(
      client!.db,
      o.i,
      message(routeId, { sessionWorkspaceId: o.design, authorizeSessionWorkspace: allow }),
    ),
  ).rejects.toThrow("teams_route_unavailable");
  const route = (await claimTeamsRoute(client!.db, o.i))!;
  expect(route).toMatchObject({
    route_id: routeId,
    session_workspace_id: o.design,
    agent_id: helper,
  });
  // Without the caller's check only the person's own Personal workspace can hold the chat.
  await expect(
    enqueueTeamsMessage(
      client!.db,
      o.i,
      message(`route:${crypto.randomUUID()}`, { sessionWorkspaceId: o.design }),
    ),
  ).rejects.toThrow("teams_route_unavailable");
  await enqueueTeamsMessage(
    client!.db,
    o.i,
    message(`route:${crypto.randomUUID()}`, { sessionWorkspaceId: o.personal }),
  );
});
