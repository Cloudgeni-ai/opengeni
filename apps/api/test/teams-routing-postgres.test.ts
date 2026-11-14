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
import { stampDelegatedHumanAuthorization, type ApiRouteDeps } from "@opengeni/core";
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
      teamsBotAllowedChannelIds: [`${tenant}:19:channel`],
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
  /** What Teams says about a 1:1 sender: a full member of the tenant unless a test changes it. */
  const sender: { userRole: string | null; tenantId: string | null; fails: boolean } = {
    userRole: "user",
    tenantId: tenant,
    fails: false,
  };
  const app = {
    api: {
      fromServiceUrl: () => ({
        conversations: {
          createActivity: async (_conversationId: string, activity: Record<string, unknown>) => {
            calls.push(activity);
            return { id: `activity-${calls.length}` };
          },
          getMemberById: async (_conversationId: string, memberId: string) => {
            if (sender.fails) throw new Error("Teams unavailable");
            return { aadObjectId: memberId, tenantId: sender.tenantId, userRole: sender.userRole };
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
  /** A channel message that mentions the bot. */
  const channelMention = (text: string) => ({
    ...message(`<at>Opengeni</at> ${text}`),
    conversation: {
      id: `19:channel;messageid=${crypto.randomUUID()}`,
      conversationType: "channel",
    },
    channelData: { tenant: { id: tenant }, channel: { id: "19:channel" } },
    entities: [{ type: "mention", mentioned: { id: botId }, text: "<at>Opengeni</at>" }],
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
  /**
   * A thumbs down on a reply the pump delivered, as Teams sends it; returns
   * the Teams outcome logged for it.
   */
  const rate = async (
    replyText: string,
    from = actor,
    where: { conversation?: Record<string, unknown>; channelData?: Record<string, unknown> } = {},
  ) => {
    const index = delivered.findIndex((text) => text.endsWith(replyText));
    if (index < 0) throw new Error(`no delivered reply ${replyText}`);
    const before = outcomes.length;
    await handleTeamsActivity(deps, app, {
      type: "invoke",
      name: "message/submitAction",
      id: crypto.randomUUID(),
      channelId: "msteams",
      serviceUrl,
      from: { id: `29:${from}`, aadObjectId: from },
      recipient: { id: botId },
      conversation: where.conversation ?? {
        id: `a:${from}`,
        conversationType: "personal",
        tenantId: tenant,
      },
      channelData: where.channelData ?? { tenant: { id: tenant } },
      replyToId: `sent-${index + 1}`,
      value: {
        actionName: "feedback",
        actionValue: {
          reaction: "dislike",
          feedback: JSON.stringify({ feedbackText: "Too long" }),
        },
      },
    });
    return outcomes.slice(before);
  };
  const feedbackRows = () =>
    shared.admin<
      { workspace_id: string; subject_id: string; session_id: string; sentiment: string }[]
    >`
      select workspace_id::text as workspace_id,subject_id,session_id::text as session_id,sentiment
      from feedback_submissions where account_id=${accountId} order by created_at`;
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
  const agent = async (workspaceId: string, name: string, agentOptions: { open?: boolean } = {}) =>
    (
      await createAgent(
        client.db,
        { accountId, workspaceId },
        {
          visibility: "workspace",
          ...(agentOptions.open ? { organizationAccess: true } : {}),
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
    app,
    channelMention,
    sender,
    rate,
    feedbackRows,
    tenant,
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

test("only switch commands that name something are switches; requests and shared chats are read as before", async () => {
  const f = await fixture();
  expect(await f.say("switch Research")).toEqual([
    "Now using **Research**. New messages start work there. Send **switch** to change.",
  ]);
  // Ordinary requests that start like a command are queued, not answered.
  for (const text of ["use Postgres instead", "switch to dark mode"]) {
    const before = await f.inboxCount();
    await f.say(text);
    expect(await f.inboxCount()).toBe(before + 1);
  }
  // A one-word name that matches nothing is still a switch, refused.
  expect(await f.say("switch Desgin")).toEqual([
    "You have no workspace or agent called **Desgin**. Send **switch** to see them.",
  ]);
  // A channel mention is read as before: never a switch.
  const before = await f.inboxCount();
  await handleTeamsActivity(f.deps, f.app, f.channelMention("switch the deploy to blue-green"));
  expect(await f.inboxCount()).toBe(before + 1);
});

test("the app's name never moves a chat whose workspace was lost to another workspace", async () => {
  const f = await fixture({ personal: true });
  expect(await f.say("switch Research")).toHaveLength(1);
  await shared.admin`delete from workspace_memberships where workspace_id=${f.research} and subject_id=${f.subject}`;
  const before = await f.inboxCount();
  expect(await f.say("Opengeni: summarize the week")).toEqual([
    "You can no longer start chats in **Research** from Teams. Send **switch** to choose another. No chat was started.",
  ]);
  expect(await f.inboxCount()).toBe(before);
  // The lost choice is forgotten: the next message uses the Personal workspace.
  await f.say("summarize the week");
  expect(await f.inboxCount()).toBe(before + 1);
});

test("an agent anyone in the organization may use answers a non-member as itself, saying once who sees the chat", async () => {
  const f = await fixture();
  const auditor = await f.agent(f.finance, "Auditor", { open: true });
  // Offered on the switch card, though the person isn't in Finance.
  await f.say("switch");
  expect(cardChoices(f.calls.at(-1)!).some((choice) => choice.includes("Auditor"))).toBe(true);

  expect(await f.say("Auditor: check the books")).toEqual([]);
  await f.pump();
  const session = await f.latestSession();
  expect(session.workspace_id).toBe(f.finance);
  expect(session.session_workspace_id).toBe(f.finance);
  expect(session.agent_id).toBe(auditor);
  expect(session.session_agent_id).toBe(auditor);
  expect(session.route_id).toStartWith("teams-agent:");
  // The chat belongs to the agent's workspace, run by the agent itself.
  expect(session.visibility).toBe("workspace_shared");
  expect(session.owner_subject_id).toBeNull();
  const [creator] =
    await shared.admin`select created_by_kind, created_by_subject_id, created_by_context
    from sessions where id=${session.session_id}`;
  expect(creator!.created_by_subject_id).toBe(`teams-agent:${auditor}`);
  // The person is recorded as context only.
  expect(JSON.stringify(creator!.created_by_context)).toContain(f.subject);
  const notice = "What you tell **Auditor** is visible to members of the **Finance** workspace.";
  expect(f.delivered[0]).toStartWith(`Started in **Finance** with **Auditor**.\n\n${notice}\n\n`);
  // Only Finance's members can open the chat, so there is no link to it.
  expect(f.delivered[0]).not.toContain("https://app.example.test");

  await f.answer(session, "Books checked");
  await f.pump();
  expect(f.delivered.at(-1)).toBe("**Auditor** · Finance\n\nBooks checked");
  // The agent is now the chat's choice: a follow-up continues the same chat, without the notice again.
  expect(await f.say("And the ledger?")).toEqual([]);
  await f.pump();
  expect((await f.latestSession()).session_id).toBe(session.session_id);
  expect(f.delivered.filter((text) => text.includes(notice))).toHaveLength(1);

  // A member of the agent's workspace keeps their own Only me chat with it.
  const research = await f.agent(f.research, "Scout", { open: true });
  await f.say("Scout: look around");
  await f.pump();
  const own = await f.latestSession();
  expect(own.agent_id).toBe(research);
  expect(own.route_id).not.toStartWith("teams-agent:");
  expect(own.visibility).toBe("user_private");
  expect(own.owner_subject_id).toBe(f.subject);
});

test("an organization agent refuses guests, and stops when the person or the agent loses access", async () => {
  const f = await fixture();
  await f.agent(f.finance, "Auditor", { open: true });
  const before = await f.inboxCount();
  f.sender.userRole = "guest";
  expect(await f.say("Auditor: check the books")).toEqual([
    "**Auditor** doesn't take requests from guests or people outside your organization's Microsoft Teams. No chat was started.",
  ]);
  f.sender.userRole = "user";
  f.sender.fails = true;
  expect(await f.say("Auditor: check the books")).toHaveLength(1);
  f.sender.fails = false;
  f.sender.tenantId = crypto.randomUUID();
  expect(await f.say("Auditor: check the books")).toHaveLength(1);
  f.sender.tenantId = f.i.tenant_id;
  expect(await f.inboxCount()).toBe(before);

  expect(await f.say("Auditor: check the books")).toEqual([]);
  await f.pump();
  const session = await f.latestSession();
  expect(session.route_id).toStartWith("teams-agent:");
  // The person leaves the organization: output under way stops before Teams.
  await shared.admin`update organization_memberships set status='suspended' where account_id=${f.accountId} and subject_id=${f.subject}`;
  await f.answer(session, "Ledger totals");
  await f.pump();
  expect(f.delivered).not.toContain("**Auditor** · Finance\n\nLedger totals");
  await shared.admin`update organization_memberships set status='active' where account_id=${f.accountId} and subject_id=${f.subject}`;

  // The agent is no longer open to the organization: refused, never answered elsewhere.
  await shared.admin`update agents set organization_access=false where account_id=${f.accountId} and name='Auditor'`;
  const queued = await f.inboxCount();
  expect(await f.say("Auditor: one more thing")).toEqual([
    "**Auditor** works in the **Finance** workspace, which you don't have access to. Ask an admin of that workspace for access. No chat was started.",
  ]);
  expect(await f.inboxCount()).toBe(queued);
});

test("a one-off in <Workspace>: message continues that workspace's chat, and its reply names the workspace", async () => {
  const f = await fixture();
  await f.say("switch Home");
  await f.say("Plan the launch");
  await f.pump();
  const home = await f.latestSession();
  expect(home.workspace_id).toBe(f.home);
  await f.answer(home, "Plan ready");
  await f.pump();
  // The chat's own workspace needs no header.
  expect(f.delivered.at(-1)).toBe("Plan ready");

  await f.say("switch Research");
  expect(await f.say("in Home: and the budget?")).toEqual([]);
  await f.pump();
  const sessions = await shared.admin`select id from sessions where workspace_id=${f.home}`;
  expect(sessions).toHaveLength(1);
  await f.answer(home, "Budget attached");
  await f.pump();
  expect(f.delivered.at(-1)).toBe("**Home**\n\nBudget attached");
});

test("an organization agent picked by name says where it works, and only the asker's own turns reach Teams", async () => {
  const f = await fixture();
  await f.agent(f.finance, "Auditor", { open: true });
  expect(await f.say("switch Auditor")).toEqual([
    "Now using **Auditor** in **Finance**. New messages go to this agent. Send **switch** to change.",
  ]);
  expect(await f.say("Check the books")).toEqual([]);
  await f.pump();
  const session = await f.latestSession();
  expect(session.route_id).toStartWith("teams-agent:");
  // A member of Finance continues the shared chat in Opengeni: their turn stays out of Teams.
  await appendSessionEvents(client.db, session.workspace_id, session.session_id, [
    {
      type: "turn.completed",
      turnId: crypto.randomUUID(),
      payload: { output: "Member-only notes" },
    },
  ]);
  await f.answer(session, "Books checked");
  await f.pump();
  expect(f.delivered.some((text) => text.includes("Member-only notes"))).toBe(false);
  expect(f.delivered.at(-1)).toBe("**Auditor** · Finance\n\nBooks checked");
});

test("an organization agent closed after a message is queued starts nothing", async () => {
  const f = await fixture();
  await f.agent(f.finance, "Auditor", { open: true });
  expect(await f.say("Auditor: check the books")).toEqual([]);
  await shared.admin`update agents set organization_access=false where account_id=${f.accountId} and name='Auditor'`;
  await f.pump();
  expect(await shared.admin`select 1 from sessions where workspace_id=${f.finance}`).toHaveLength(
    0,
  );
  expect(f.delivered).toEqual([]);
});

test("feedback on a routed 1:1 reply is recorded in its chat's workspace, as its owner, while they may use it", async () => {
  const f = await fixture({ personal: true });
  // The Personal workspace (the default).
  await f.say("Plan the launch");
  await f.pump();
  const personal = await f.latestSession();
  expect(personal.workspace_id).toBe(f.personal);
  await f.answer(personal, "Launch plan");
  await f.pump();
  expect(await f.rate("Launch plan")).toContain("feedback_recorded");
  // Another workspace the person is a member of.
  await f.say("switch Research");
  await f.say("Start the study");
  await f.pump();
  const research = await f.latestSession();
  expect(research.workspace_id).toBe(f.research);
  await f.answer(research, "Study plan");
  await f.pump();
  expect(await f.rate("Study plan")).toContain("feedback_recorded");
  expect(await f.feedbackRows()).toEqual([
    {
      workspace_id: f.personal,
      subject_id: f.subject,
      session_id: personal.session_id,
      sentiment: "negative",
    },
    {
      workspace_id: f.research,
      subject_id: f.subject,
      session_id: research.session_id,
      sentiment: "negative",
    },
  ]);
  // Someone else in the tenant can't rate it: not when unlinked, and not as
  // another linked member of the organization in this chat.
  const owners = { conversation: { id: `a:${f.actor}`, conversationType: "personal" } };
  expect(await f.rate("Study plan", crypto.randomUUID(), owners)).toContain(
    "feedback_actor_unlinked",
  );
  const other = crypto.randomUUID();
  const otherSubject = `user:teams:${crypto.randomUUID()}`;
  const [otherPersonal] = await shared.admin<{ id: string }[]>`
    insert into workspaces(account_id,name) values(${f.accountId},'Other Personal') returning id::text as id`;
  await shared.admin`insert into organization_memberships(account_id,subject_id,role,status,personal_workspace_id)
    values(${f.accountId},${otherSubject},'member','active',${otherPersonal!.id})`;
  await shared.admin`insert into workspace_memberships(account_id,workspace_id,subject_id,subject_label,role,permissions)
    select account_id,workspace_id,${otherSubject},subject_label,role,permissions from workspace_memberships
    where workspace_id=${f.research} and subject_id=${f.subject}`;
  await shared.admin`insert into teams_bot_links(account_id,workspace_id,tenant_id,actor_id,subject_id)
    values(${f.accountId},${f.home},${f.tenant},${other},${otherSubject})`;
  expect(await f.rate("Study plan", other, owners)).toContain("feedback_target_missing");
  // Losing the workspace, the Personal workspace or the organization stops it.
  await shared.admin`delete from workspace_memberships where workspace_id=${f.research} and subject_id=${f.subject}`;
  expect(await f.rate("Study plan")).toContain("feedback_not_permitted");
  await setTeamsReach(client.db, f.i, { workspaceIds: null, personalWorkspaces: false });
  expect(await f.rate("Launch plan")).toContain("feedback_not_permitted");
  await shared.admin`update organization_memberships set status='suspended' where account_id=${f.accountId} and subject_id=${f.subject}`;
  expect(await f.rate("Launch plan")).toContain("feedback_actor_unlinked");
  expect(await f.feedbackRows()).toHaveLength(2);
});

test("feedback on an organization agent's reply is recorded on its chat, as the agent, while the asker may use it", async () => {
  const f = await fixture();
  const auditor = await f.agent(f.finance, "Auditor", { open: true });
  await f.say("Auditor: check the books");
  await f.pump();
  const session = await f.latestSession();
  expect(session.route_id).toStartWith("teams-agent:");
  await f.answer(session, "Books checked");
  await f.pump();
  expect(await f.rate("Books checked")).toContain("feedback_recorded");
  expect(await f.feedbackRows()).toEqual([
    {
      workspace_id: f.finance,
      subject_id: `teams-agent:${auditor}`,
      session_id: session.session_id,
      sentiment: "negative",
    },
  ]);
  // The asker leaving the organization stops it.
  await shared.admin`update organization_memberships set status='suspended' where account_id=${f.accountId} and subject_id=${f.subject}`;
  expect(await f.rate("Books checked")).toContain("feedback_actor_unlinked");
  await shared.admin`update organization_memberships set status='active' where account_id=${f.accountId} and subject_id=${f.subject}`;
  // Closed to the organization: nothing more is recorded.
  await shared.admin`update agents set organization_access=false where id=${auditor}`;
  expect(await f.rate("Books checked")).toContain("feedback_not_permitted");
  expect(await f.feedbackRows()).toHaveLength(1);
});

test("only the signed-in person links Teams: an agent acting for them, or a token, is refused", async () => {
  const f = await fixture();
  const secret = "teams-routing-link-delegation-secret";
  const server = createApp({
    settings: { ...f.deps.settings, delegationSecret: secret },
    db: client.db,
    bus: {} as never,
    workflowClient: {} as never,
    managedAuth: null,
  } as never);
  // A real Opengeni person, so the agent's authority resolves and the link
  // route itself must refuse it.
  const userId = f.subject.slice("user:".length);
  await shared.admin`insert into auth_users (id, name, email, email_verified)
    values (${userId}, 'Ida', ${`${userId}@example.test`}, true)`;
  const links = async () =>
    (
      await shared.admin`select count(*)::int as n from teams_bot_links where subject_id=${f.subject}`
    )[0]!.n as number;
  const before = await links();
  for (const suffix of ["link", "link/microsoft-sign-in"]) {
    const url = `http://localhost/v1/workspaces/${f.home}/integrations/teams/${suffix}`;
    const body = JSON.stringify({ token: "proof" });
    // An agent's app action carrying the person's delegated authority.
    const delegated = new Request(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body)),
      },
      body,
    });
    stampDelegatedHumanAuthorization(delegated, {
      organizationId: f.accountId,
      subjectId: f.subject,
      permissions: ["workspace:read", "sessions:read", "sessions:create"] as never,
      workspaceScope: { kind: "all" },
    });
    const refused = await server.request(delegated);
    expect({ status: refused.status, body: await refused.json() }).toMatchObject({
      status: 403,
      body: { error: { message: "A signed-in human account is required." } },
    });
    // A delegated bearer token for the same person.
    const token = await signDelegatedAccessToken(secret, {
      accountId: f.accountId,
      workspaceId: f.home,
      subjectId: f.subject,
      permissions: ["workspace:read", "sessions:read", "sessions:create"],
      principalKind: "human_session",
      exp: Math.floor(Date.now() / 1000) + 3_600,
    });
    const bearer = await server.request(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body,
    });
    expect(bearer.status).toBe(401);
  }
  expect(await links()).toBe(before);
});

test("feedback in a channel keeps the installation's rules with routing on", async () => {
  const f = await fixture();
  const mention = f.channelMention("Summarize the thread");
  await handleTeamsActivity(f.deps, f.app, mention);
  await f.pump();
  const session = await f.latestSession();
  expect(session.workspace_id).toBe(f.home);
  await f.answer(session, "Thread summary");
  await f.pump();
  const channel = { conversation: mention.conversation, channelData: mention.channelData };
  expect(await f.rate("Thread summary", f.actor, channel)).toContain("feedback_recorded");
  // In a shared chat any linked member who may use the connected workspace
  // rates replies, as before routing.
  const other = crypto.randomUUID();
  const otherSubject = `user:teams:${crypto.randomUUID()}`;
  const [otherPersonal] = await shared.admin<{ id: string }[]>`
    insert into workspaces(account_id,name) values(${f.accountId},'Other Personal') returning id::text as id`;
  await shared.admin`insert into organization_memberships(account_id,subject_id,role,status,personal_workspace_id)
    values(${f.accountId},${otherSubject},'member','active',${otherPersonal!.id})`;
  await shared.admin`insert into workspace_memberships(account_id,workspace_id,subject_id,subject_label,role,permissions)
    select account_id,workspace_id,${otherSubject},subject_label,role,permissions from workspace_memberships
    where workspace_id=${f.home} and subject_id=${f.subject}`;
  await shared.admin`insert into teams_bot_links(account_id,workspace_id,tenant_id,actor_id,subject_id)
    values(${f.accountId},${f.home},${f.tenant},${other},${otherSubject})`;
  expect(await f.rate("Thread summary", other, channel)).toContain("feedback_recorded");
  // Unlinked people still can't.
  expect(await f.rate("Thread summary", crypto.randomUUID(), channel)).toContain(
    "feedback_actor_unlinked",
  );
  expect((await f.feedbackRows()).map((row) => row.subject_id)).toEqual([f.subject, otherSubject]);
});
