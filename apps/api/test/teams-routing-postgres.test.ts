import { createHash } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { App } from "@microsoft/teams.apps";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import {
  appendSessionEvents,
  bootstrapWorkspace,
  createAgent,
  createOrganizationApiKey,
  createDb,
  installTeamsBot,
  PERSONAL_WORKSPACE_EXTERNAL_SOURCE,
  setTeamsReach,
} from "@opengeni/db";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import { createApp } from "../src/app";
import { drainTeamsBotOnce, handleTeamsActivity } from "../src/integrations/teams-bot";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const value = await acquireSharedTestDatabase("teams-bot-routing");
  if (!value) throw new Error("Teams routing tests require real PostgreSQL");
  shared = value;
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
});

const serviceUrl = "https://smba.trafficmanager.net/emea/";

/**
 * An organization with Teams connected to "Home", where the linked person is
 * also a member of "Research" but not of "Finance". Workspace routing is on.
 * Personal workspaces are off unless `personal` is set, so the person really
 * has a choice to make.
 */
async function fixture(options: { routing?: boolean; personal?: boolean } = {}) {
  const subject = `user:teams:${crypto.randomUUID()}`;
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "teams-test",
    accountExternalId: crypto.randomUUID(),
    accountName: "Teams",
    workspaceExternalSource: "teams-test",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Home",
    subjectId: subject,
  });
  const grant = access.workspaceGrants[0]!;
  const accountId = grant.accountId;
  const home = grant.workspaceId;
  const research = crypto.randomUUID();
  const finance = crypto.randomUUID();
  const personal = crypto.randomUUID();
  await shared.admin`insert into workspaces(id,account_id,name) values
    (${research},${accountId},'Research'),(${finance},${accountId},'Finance')`;
  await shared.admin`insert into workspaces(id,account_id,name,external_source,external_id)
    values(${personal},${accountId},'Personal',${PERSONAL_WORKSPACE_EXTERNAL_SOURCE},${`${accountId}:${subject}`})`;
  await shared.admin`insert into workspace_memberships(account_id,workspace_id,subject_id,subject_label,role,permissions)
    select account_id,${research},subject_id,subject_label,role,permissions from workspace_memberships
    where workspace_id=${home} and subject_id=${subject}`;
  await shared.admin`insert into organization_memberships(account_id,subject_id,role,status,personal_workspace_id)
    values(${accountId},${subject},'owner','active',${personal})`;
  if (!options.personal)
    await shared.admin`insert into organization_privacy_preferences(account_id,personal_workspaces_enabled) values(${accountId},false)
      on conflict(account_id) do update set personal_workspaces_enabled=false`;
  for (const workspace of [home, research, finance, personal])
    await shared.admin`insert into workspace_inference_controls(workspace_id,account_id) values(${workspace},${accountId}) on conflict do nothing`;
  await shared.admin`insert into session_tenancy_activations(account_id,activation_version,inventory_digest,parity_digest,activated_by) values(${accountId},1,${"1".repeat(64)},${"2".repeat(64)},'test')`;
  const tenant = crypto.randomUUID(),
    actor = crypto.randomUUID(),
    clientId = crypto.randomUUID();
  const i = await installTeamsBot(client.db, {
    accountId,
    workspaceId: home,
    tenantId: tenant,
    actorId: actor,
    subjectId: subject,
    nonce: crypto.randomUUID(),
  });
  const noop = async () => undefined;
  const outcomes: string[] = [];
  const deps = {
    db: client.db,
    settings: testSettings({
      databaseUrl: shared.appUrl,
      sandboxBackend: "none",
      productAccessMode: "managed",
      teamsBotClientId: clientId,
      teamsBotClientSecret: "test",
      teamsBotTenantId: tenant,
      teamsBotAllowedTenantIds: [tenant],
      teamsWorkspaceRoutingEnabled: options.routing ?? true,
      integrationsStateSecret: "test",
      webBaseUrl: "https://app.example.test",
    }),
    bus: new MemoryEventBus(),
    workflowClient: { wakeSessionWorkflow: noop, requestSessionWorkflowWakeDispatch: noop },
    objectStorage: null,
    githubStateSecret: "test",
    documentIndexer: { indexDocument: noop },
    getDocumentServices: () => ({}),
    observability: {
      info: (message: string, fields: { reason?: string }) => {
        if (message === "Teams authenticated activity outcome" && fields.reason)
          outcomes.push(fields.reason);
      },
      error: () => undefined,
      warn: () => undefined,
    },
  } as unknown as ApiRouteDeps;
  /** Every activity sent to Teams directly (replies to a message, cards). */
  const calls: Array<Record<string, unknown>> = [];
  const app = {
    api: {
      fromServiceUrl: () => ({
        conversations: {
          createActivity: async (_conversationId: string, activity: Record<string, unknown>) => {
            calls.push(activity);
            return { id: `activity-${calls.length}` };
          },
        },
      }),
    },
  } as unknown as App;
  const botId = `28:${clientId}`;
  const message = (text: string, from = actor) => ({
    type: "message",
    id: `message-${crypto.randomUUID()}`,
    timestamp: new Date().toISOString(),
    channelId: "msteams",
    serviceUrl,
    from: { id: `29:${from}`, aadObjectId: from },
    recipient: { id: botId },
    conversation: { id: `a:${from}`, conversationType: "personal", tenantId: tenant },
    channelData: { tenant: { id: tenant } },
    text,
  });
  /** Sends a 1:1 message and returns the texts Teams was sent in reply (typing aside). */
  const say = async (text: string) => {
    const before = calls.length;
    await handleTeamsActivity(deps, app, message(text));
    return calls
      .slice(before)
      .filter((activity) => activity.type === "message")
      .map((activity) => activity.text as string);
  };
  /** What the pump delivered, in order. */
  const delivered: string[] = [];
  const pump = async () => {
    await shared.admin`update teams_bot_routes set lease_until=null where workspace_id=${home}`;
    await drainTeamsBotOnce(deps, async (_m, text) => {
      delivered.push(text);
      return `sent-${delivered.length}`;
    });
  };
  /** The newest route's session, with where it runs. */
  const latestSession = async () => {
    const [row] = await shared.admin<
      {
        route_id: string;
        session_id: string;
        session_workspace_id: string | null;
        agent_id: string | null;
        workspace_id: string;
        visibility: string;
        owner_subject_id: string;
        session_agent_id: string | null;
      }[]
    >`select r.route_id,r.session_id,r.session_workspace_id,r.agent_id,s.workspace_id,s.visibility,s.owner_subject_id,s.agent_id as session_agent_id
      from teams_bot_routes r join sessions s on s.id=r.session_id
      where r.workspace_id=${home} order by s.created_at desc, s.id desc limit 1`;
    return row!;
  };
  const turnOf = async (sessionId: string) => {
    const [row] =
      await shared.admin`select b.turn_id::text as turn_id from teams_bot_inbox b join teams_bot_routes r on r.route_id=b.route_id where r.session_id=${sessionId} and b.turn_id is not null order by b.created_at desc limit 1`;
    return row?.turn_id as string | undefined;
  };
  const answer = async (session: { workspace_id: string; session_id: string }, output: string) => {
    await appendSessionEvents(client.db, session.workspace_id, session.session_id, [
      {
        type: "turn.completed",
        ...((await turnOf(session.session_id)) ? { turnId: await turnOf(session.session_id) } : {}),
        payload: { output },
      },
    ]);
  };
  const agent = async (workspaceId: string, name: string) =>
    (
      await createAgent(
        client.db,
        { accountId, workspaceId },
        {
          visibility: "workspace",
          ownerSubjectId: null,
          name,
          description: "",
          avatar: null,
          instructions: `You are ${name}.`,
          firstMessage: "",
          memoryEnabled: false,
          origin: "app",
          sourceSessionId: null,
          createdBySubjectId: subject,
        },
      )
    ).agent.id;
  const inboxCount = async () =>
    Number(
      (
        await shared.admin`select count(*)::int as n from teams_bot_inbox where workspace_id=${home}`
      )[0]!.n,
    );
  return {
    i,
    accountId,
    home,
    research,
    finance,
    personal,
    subject,
    actor,
    deps,
    calls,
    say,
    pump,
    delivered,
    latestSession,
    answer,
    agent,
    inboxCount,
    outcomes,
  };
}

/** The button titles on the newest switch card. */
function cardChoices(activity: Record<string, unknown>): string[] {
  const attachments = activity.attachments as
    | Array<{ content: { body?: Array<{ actions: Array<{ title: string }> }> } }>
    | undefined;
  return (attachments?.[0]?.content.body ?? []).map((row) => row.actions[0]!.title);
}

test("a person with two workspaces is asked, and the parked message starts in the one they pick", async () => {
  const f = await fixture();
  const [asked] = await f.say("Plan the launch");
  expect(asked).toStartWith("Where should I work on this?");
  // Finance isn't theirs, so it isn't offered.
  const choices = cardChoices(f.calls.at(-1)!);
  expect(choices.map((choice) => choice.replace(/^\d+\. /u, "")).toSorted()).toEqual([
    "Home",
    "Research",
  ]);
  expect(asked).not.toContain("Finance");
  expect(await f.inboxCount()).toBe(0);

  const research = choices.find((choice) => choice.endsWith("Research"))!;
  await f.say(`switch ${research.split(".")[0]}`);
  await f.pump();
  const session = await f.latestSession();
  expect(session.workspace_id).toBe(f.research);
  expect(session.session_workspace_id).toBe(f.research);
  expect(session.visibility).toBe("user_private");
  expect(session.owner_subject_id).toBe(f.subject);
  expect(f.delivered[0]).toStartWith("Started in **Research**. Follow progress");
  const [first] = await shared.admin`select payload from session_events
    where session_id=${session.session_id} and type='user.message' order by sequence limit 1`;
  expect(JSON.stringify(first!.payload)).toContain("Plan the launch");

  await f.answer(session, "Here is the plan");
  await f.pump();
  expect(f.delivered.at(-1)).toBe("Here is the plan");

  // The chat keeps using Research: a follow-up joins the same session.
  expect(await f.say("And the budget?")).toEqual([]);
  await f.pump();
  expect((await f.latestSession()).session_id).toBe(session.session_id);
  // A request that starts with "switch" but names no workspace or agent is a request.
  expect(await f.say("switch the deploy to blue-green please")).toEqual([]);
  expect(await f.say("switch Marketing")).toEqual([
    "You have no workspace or agent called **Marketing**. Send **switch** to see them.",
  ]);
});

test("in <Workspace>: sends one message elsewhere; a workspace without access is refused", async () => {
  const f = await fixture();
  await f.say("switch Research");
  expect(await f.say("in Home: check the release notes")).toEqual([]);
  await f.pump();
  const home = await f.latestSession();
  expect(home.workspace_id).toBe(f.home);
  expect(home.session_workspace_id).toBeNull();
  expect(f.delivered[0]).toStartWith("Started in **Home**.");
  const [first] = await shared.admin`select payload from session_events
    where session_id=${home.session_id} and type='user.message' order by sequence limit 1`;
  expect(JSON.stringify(first!.payload)).toContain("check the release notes");
  expect(JSON.stringify(first!.payload)).not.toContain("in Home:");

  const before = await f.inboxCount();
  const [refused] = await f.say("in Finance: show me the ledger");
  expect(refused).toStartWith("You can't start work in a workspace called **Finance**.");
  expect(refused).toEndWith("No chat was started.");
  expect(await f.inboxCount()).toBe(before);

  // The one-off didn't change the chat's choice.
  await f.say("Next step?");
  await f.pump();
  expect((await f.latestSession()).workspace_id).toBe(f.research);
});

test("an agent is addressed by name, answers under its header, and an agent without access is refused", async () => {
  const f = await fixture();
  const planner = await f.agent(f.research, "Planner");
  await f.agent(f.finance, "Auditor");
  expect(await f.say("Planner: draft the roadmap")).toEqual([]);
  await f.pump();
  const session = await f.latestSession();
  expect(session.workspace_id).toBe(f.research);
  expect(session.agent_id).toBe(planner);
  expect(session.session_agent_id).toBe(planner);
  expect(f.delivered[0]).toStartWith("Started in **Research** with **Planner**.");
  await f.answer(session, "Roadmap drafted");
  await f.pump();
  expect(f.delivered.at(-1)).toBe("**Planner** · Research\n\nRoadmap drafted");

  const [refused] = await f.say("+auditor check the books");
  expect(refused).toBe(
    "**Auditor** works in the **Finance** workspace, which you don't have access to. Ask an admin of that workspace for access. No chat was started.",
  );
  const [unknown] = await f.say("+nobody hello");
  expect(unknown).toStartWith("No agent called **nobody**.");
});

test("an organization admin's reach limit hides a workspace and stops its chat", async () => {
  const f = await fixture();
  await f.say("switch Research");
  await f.say("Start the study");
  await f.pump();
  const session = await f.latestSession();
  expect(session.workspace_id).toBe(f.research);

  await setTeamsReach(client.db, f.i, { workspaceIds: [], personalWorkspaces: true });
  // Output already under way stops before it reaches Teams.
  await f.answer(session, "Study results");
  await f.pump();
  expect(f.delivered).not.toContain("Study results");
  // The remembered choice is refused, never served from Home instead.
  const before = await f.inboxCount();
  const [refused] = await f.say("Continue the study");
  expect(refused).toBe(
    "You can no longer start chats in **Research** from Teams. Send **switch** to choose another. No chat was started.",
  );
  expect(await f.inboxCount()).toBe(before);
  // Home is now the only workspace, so the next message goes there.
  await f.say("Something for Home");
  await f.pump();
  expect((await f.latestSession()).workspace_id).toBe(f.home);
  const [card] = await f.say("switch");
  expect(card).toBe("You have one workspace: **Home**. New messages go there.");
});

test("routing reads organization membership live: a removed member is asked to link again", async () => {
  const f = await fixture();
  await shared.admin`update organization_memberships set status='suspended' where account_id=${f.accountId} and subject_id=${f.subject}`;
  const [reply] = await f.say("Plan the launch");
  expect(reply).toContain("Link your Opengeni account");
  // The link opens the organization's Teams page, not the connected workspace.
  const action = JSON.stringify(f.calls.at(-1)!.attachments);
  expect(action).toContain("https://app.example.test/teams/connect#teams_link=");
  expect(action).toContain(`teams_workspace=${f.home}`);
  expect(await f.inboxCount()).toBe(0);
});

test("with routing off, a 1:1 message keeps the installation's rules", async () => {
  const f = await fixture({ routing: false });
  await f.say("Plan the launch");
  await f.pump();
  expect((await f.latestSession()).workspace_id).toBe(f.home);
  expect(f.delivered[0]).toStartWith("Started. Follow progress");
});

test("a person's Personal workspace is the default, and the reach can leave it out", async () => {
  const f = await fixture({ personal: true });
  await f.say("Note to self");
  await f.pump();
  const session = await f.latestSession();
  expect(session.workspace_id).toBe(f.personal);
  expect(session.visibility).toBe("user_private");
  expect(f.delivered[0]).toStartWith("Started in **Personal**.");

  await setTeamsReach(client.db, f.i, { workspaceIds: null, personalWorkspaces: false });
  const [asked] = await f.say("Another note");
  expect(asked).toStartWith("Where should I work on this?");
  expect(asked).not.toContain("Personal");
});

test("only an organization admin who manages the connected workspace's integrations changes the reach", async () => {
  const f = await fixture();
  const secret = "teams-routing-delegation-secret";
  const server = createApp({
    settings: { ...f.deps.settings, delegationSecret: secret },
    db: client.db,
    bus: {} as never,
    workflowClient: {} as never,
    managedAuth: null,
  } as never);
  const path = `/v1/workspaces/${f.home}/integrations/teams/reach`;
  const request = (authorization: string, method = "GET", body?: unknown) =>
    server.request(path, {
      method,
      headers: { authorization, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  // A workspace member who manages its integrations, but not the organization.
  const member = `Bearer ${await signDelegatedAccessToken(secret, {
    accountId: f.accountId,
    workspaceId: f.home,
    subjectId: f.subject,
    permissions: ["connections:read", "connections:write", "capabilities:manage"],
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1000) + 3_600,
  })}`;
  const read = await request(member);
  expect({ status: read.status, body: await read.json() }).toEqual({
    status: 200,
    body: { workspaceIds: null, personalWorkspaces: true, version: expect.any(Number) },
  });
  const refused = await request(member, "PUT", { workspaceIds: [], personalWorkspaces: false });
  expect(refused.status).toBe(403);

  const token = crypto.randomUUID();
  await createOrganizationApiKey(client.db, {
    accountId: f.accountId,
    name: "Teams administrator",
    prefix: "test",
    keyHash: createHash("sha256").update(token).digest("hex"),
    permissions: [
      "workspace:read",
      "workspace:admin",
      "connections:read",
      "connections:write",
      "capabilities:manage",
    ],
  });
  const admin = `Bearer ${token}`;
  const saved = await request(admin, "PUT", {
    workspaceIds: [f.research],
    personalWorkspaces: false,
  });
  expect({ status: saved.status, body: await saved.json() }).toEqual({
    status: 200,
    body: { workspaceIds: [f.research], personalWorkspaces: false, version: expect.any(Number) },
  });
  // Only shared workspaces of this organization can be chosen.
  const outside = await request(admin, "PUT", {
    workspaceIds: [crypto.randomUUID()],
    personalWorkspaces: false,
  });
  expect(outside.status).toBe(422);
  // A stale version is refused rather than overwriting a newer choice.
  const stale = await request(admin, "PUT", {
    workspaceIds: null,
    personalWorkspaces: true,
    expectedVersion: 0,
  });
  expect(stale.status).toBe(409);
});
