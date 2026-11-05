import { afterAll, beforeAll, expect, test } from "bun:test";
import type { App } from "@microsoft/teams.apps";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import {
  createDb,
  bootstrapWorkspace,
  installTeamsBot,
  enqueueTeamsMessage,
  appendSessionEvents,
  getTeamsActor,
  linkTeamsActor,
  teamsReplyPending,
} from "@opengeni/db";
import type { ApiRouteDeps } from "@opengeni/core";
import { drainTeamsBotOnce, handleTeamsActivity } from "../src/integrations/teams-bot";
import { verifyTeamsProof } from "../src/integrations/teams-protocol";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const value = await acquireSharedTestDatabase("teams-bot-experience");
  if (!value) throw new Error("Teams experience tests require real PostgreSQL");
  shared = value;
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
});

const serviceUrl = "https://smba.trafficmanager.net/emea/";

async function fixture() {
  const subject = `user:teams:${crypto.randomUUID()}`;
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "teams-test",
    accountExternalId: crypto.randomUUID(),
    accountName: "Teams",
    workspaceExternalSource: "teams-test",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Teams",
    subjectId: subject,
  });
  const grant = access.workspaceGrants[0]!;
  const tenant = crypto.randomUUID(),
    actor = crypto.randomUUID(),
    clientId = crypto.randomUUID();
  const i = await installTeamsBot(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
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
      teamsBotAllowedChannelIds: [`${tenant}:19:channel`, `${tenant}:19:other`],
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
  const calls: Array<{ conversationId: string; activity: Record<string, unknown> }> = [];
  const app = {
    api: {
      fromServiceUrl: () => ({
        conversations: {
          createActivity: async (conversationId: string, activity: Record<string, unknown>) => {
            calls.push({ conversationId, activity });
            return { id: `activity-${calls.length}` };
          },
        },
      }),
    },
  } as unknown as App;
  const botId = `28:${clientId}`;
  const message = (text: string, from = actor, overrides: Record<string, unknown> = {}) => ({
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
    ...overrides,
  });
  const handle = (body: unknown) => handleTeamsActivity(deps, app, body);
  return { i, tenant, actor, subject, deps, app, calls, botId, message, handle, outcomes };
}

function cardActions(activity: Record<string, unknown>): unknown[] {
  const attachments = activity.attachments as
    | Array<{ content: { actions: unknown[] } }>
    | undefined;
  return attachments?.[0]?.content.actions ?? [];
}

test("installing the bot for yourself sends one welcome; unlinked people get a button that asks for a link", async () => {
  const f = await fixture();
  const install = (from: string, overrides: Record<string, unknown> = {}) => ({
    type: "conversationUpdate",
    channelId: "msteams",
    serviceUrl,
    from: { id: `29:${from}`, aadObjectId: from },
    recipient: { id: f.botId },
    conversation: { id: `a:${from}`, conversationType: "personal", tenantId: f.tenant },
    channelData: { tenant: { id: f.tenant } },
    membersAdded: [{ id: f.botId }],
    ...overrides,
  });
  expect(await f.handle(install(f.actor))).toEqual({ status: 200 });
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]!.conversationId).toBe(`a:${f.actor}`);
  expect(f.calls[0]!.activity.text).toContain("**Welcome to Opengeni**");
  expect(f.calls[0]!.activity.text).toContain("Send a message to start a task.");
  expect(f.calls[0]!.activity.textFormat).toBe("markdown");
  expect(cardActions(f.calls[0]!.activity)).toEqual([]);

  // A redelivered install isn't welcomed twice.
  await f.handle(install(f.actor));
  expect(f.calls).toHaveLength(1);

  const stranger = crypto.randomUUID();
  await f.handle(install(stranger));
  expect(f.calls).toHaveLength(2);
  expect(f.calls[1]!.activity.text).toContain("Link your Opengeni account to start.");
  // The welcome carries no identity proof, which would expire before a late
  // click; its button sends "link" as the person, who then gets a fresh one.
  expect(JSON.stringify(f.calls[1])).not.toContain("teams_link");
  expect(cardActions(f.calls[1]!.activity)).toEqual([
    {
      type: "Action.Submit",
      title: "Link account",
      data: { msteams: { type: "imBack", value: "link" } },
    },
  ]);
  await f.handle(f.message("link", stranger));
  expect(f.calls).toHaveLength(3);
  const [action] = cardActions(f.calls[2]!.activity) as Array<{ type: string; url: string }>;
  expect(action!.type).toBe("Action.OpenUrl");
  const token = new URLSearchParams(new URL(action!.url).hash.slice(1)).get("teams_link")!;
  expect(verifyTeamsProof("test", token)).toMatchObject({
    purpose: "link",
    tenantId: f.tenant,
    actorId: stranger,
    workspaceId: f.i.workspace_id,
  });
  // A linked person asking to link is told they already are.
  await f.handle(f.message("link"));
  expect(f.calls[3]!.activity.text).toContain("already linked");

  // Without the person named, the welcome still offers linking.
  await f.handle(
    install(stranger, {
      from: undefined,
      conversation: { id: "a:unnamed", conversationType: "personal", tenantId: f.tenant },
    }),
  );
  expect(f.calls).toHaveLength(5);
  expect(f.calls[4]!.conversationId).toBe("a:unnamed");
  expect((cardActions(f.calls[4]!.activity)[0] as { title: string }).title).toBe("Link account");

  // Another bot's install, or the bot added to someone else's roster, sends nothing.
  await f.handle(
    install(f.actor, { recipient: { id: "28:other" }, membersAdded: [{ id: "28:other" }] }),
  );
  await f.handle(install(f.actor, { membersAdded: [{ id: "29:someone" }] }));
  expect(f.calls).toHaveLength(5);
  expect(f.outcomes).toEqual([
    "welcome_sent",
    "welcome_duplicate",
    "welcome_sent",
    "link_already_linked",
    "welcome_sent",
    "bot_identity_mismatch",
  ]);
});

test("help is answered in Teams without reaching the agent, for linked and unlinked people", async () => {
  const f = await fixture();
  await f.handle(f.message("help"));
  const stranger = crypto.randomUUID();
  await f.handle(f.message("Help", stranger));
  expect(f.calls).toHaveLength(2);
  expect(f.calls[0]!.activity.text).toContain("**Opengeni help**");
  expect(cardActions(f.calls[0]!.activity)).toEqual([]);
  expect(f.calls[1]!.activity.text).toContain("**Opengeni help**");
  expect((cardActions(f.calls[1]!.activity)[0] as { type: string }).type).toBe("Action.OpenUrl");
  const [inbox] =
    await shared.admin`select count(*)::int as n from teams_bot_inbox where workspace_id=${f.i.workspace_id}`;
  expect(inbox!.n).toBe(0);
  // In a channel, help answers in the thread and carries no identity link.
  await f.handle(
    f.message(`<at>Opengeni</at> help`, stranger, {
      conversation: { id: "19:channel", conversationType: "channel", tenantId: f.tenant },
      channelData: { tenant: { id: f.tenant }, channel: { id: "19:channel" } },
      entities: [{ type: "mention", mentioned: { id: f.botId }, text: "<at>Opengeni</at>" }],
    }),
  );
  expect(f.calls).toHaveLength(3);
  expect(f.calls[2]!.conversationId).toContain("19:channel;messageid=");
  expect(f.calls[2]!.activity.text).toContain("Send me a direct message to link");
  expect(cardActions(f.calls[2]!.activity)).toEqual([]);
  // A channel that isn't allowlisted gets no reply, even to help.
  await f.handle(
    f.message(`<at>Opengeni</at> help`, stranger, {
      conversation: { id: "19:closed", conversationType: "channel", tenantId: f.tenant },
      channelData: { tenant: { id: f.tenant }, channel: { id: "19:closed" } },
      entities: [{ type: "mention", mentioned: { id: f.botId }, text: "<at>Opengeni</at>" }],
    }),
  );
  expect(f.calls).toHaveLength(3);
  expect(f.outcomes).toEqual(["help_sent", "help_sent", "help_sent", "channel_disabled"]);
});

test("unlink asks for confirmation, then removes the person's Teams link", async () => {
  const f = await fixture();
  await f.handle(f.message("unlink"));
  expect(await getTeamsActor(client.db, f.i, f.actor)).toBe(f.subject);
  expect(f.calls[0]!.activity.text).toContain("Unlink your Teams account from Opengeni?");
  expect(cardActions(f.calls[0]!.activity)).toEqual([
    {
      type: "Action.Submit",
      title: "Unlink account",
      data: { msteams: { type: "imBack", value: "unlink confirm" } },
    },
  ]);
  await f.handle(f.message("unlink confirm"));
  expect(await getTeamsActor(client.db, f.i, f.actor)).toBeNull();
  expect(f.calls[1]!.activity.text).toContain("Your Teams account is unlinked");
  await f.handle(f.message("unlink"));
  expect(f.calls[2]!.activity.text).toBe("Your Teams account isn't linked to Opengeni.");
  expect(f.outcomes).toEqual(["unlink_confirmation_sent", "unlinked", "unlink_not_linked"]);
});

/** Gives the fixture's person a Personal workspace, where their 1:1 chats land. */
async function personalWorkspace(f: Awaited<ReturnType<typeof fixture>>): Promise<string> {
  const personal = crypto.randomUUID();
  await shared.admin`insert into workspaces(id,account_id,name) values(${personal},${f.i.account_id},'Personal')`;
  await shared.admin`insert into organization_memberships(account_id,subject_id,role,status,personal_workspace_id) values(${f.i.account_id},${f.subject},'owner','active',${personal})`;
  await shared.admin`insert into workspace_inference_controls(workspace_id,account_id) values(${personal},${f.i.account_id})`;
  await shared.admin`insert into session_tenancy_activations(account_id,activation_version,inventory_digest,parity_digest,activated_by) values(${f.i.account_id},1,${"1".repeat(64)},${"2".repeat(64)},'test')`;
  return personal;
}

test("an accepted message shows typing until its reply is queued", async () => {
  const f = await fixture();
  await personalWorkspace(f);
  const body = f.message("Plan the launch");
  await f.handle(body);
  const [inbox] =
    await shared.admin`select route_id,event_id from teams_bot_inbox where workspace_id=${f.i.workspace_id}`;
  expect(inbox).toBeDefined();
  for (let attempt = 0; attempt < 50 && !f.calls.length; attempt += 1) await Bun.sleep(10);
  expect(f.calls[0]!.activity).toEqual({ type: "typing" });
  const pending = (eventId: string, replySequence = 0) =>
    teamsReplyPending(client.db, f.i, { eventId, replySequence });
  expect(await pending(inbox!.event_id)).toBe(true);
  // Admission queues only the "started" notice: still working.
  const deliveries: Array<{ text: string; ai: boolean }> = [];
  const send = async (_m: unknown, text: string, options?: { ai?: boolean }) => {
    deliveries.push({ text, ai: options?.ai === true });
    return `sent-${deliveries.length}`;
  };
  await drainTeamsBotOnce(f.deps, send);
  expect(deliveries).toHaveLength(1);
  expect(deliveries[0]!.ai).toBe(false);
  expect(await pending(inbox!.event_id)).toBe(true);
  const [route] =
    await shared.admin`select session_id,session_workspace_id,workspace_id from teams_bot_routes where route_id=${inbox!.route_id}`;
  await appendSessionEvents(
    client.db,
    route!.session_workspace_id ?? route!.workspace_id,
    route!.session_id,
    [{ type: "turn.completed", payload: { output: "| A | B |\n| - | - |\n| 1 | 2 |" } }],
  );
  await shared.admin`update teams_bot_routes set lease_until=null where route_id=${inbox!.route_id}`;
  await drainTeamsBotOnce(f.deps, send);
  expect(await pending(inbox!.event_id)).toBe(false);
  // The agent reply is Teams Markdown and carries the AI label and feedback.
  expect(deliveries.at(-1)).toEqual({ text: "- **A:** 1; **B:** 2", ai: true });
  const [outbox] =
    await shared.admin`select payload from teams_bot_outbox where route_id=${inbox!.route_id} and source_sequence>0`;
  expect(outbox!.payload).toMatchObject({ text: "- **A:** 1; **B:** 2", ai: true });

  // A turn that completes without text still ends typing for the next message.
  await f.handle(f.message("Anything else?"));
  const [next] =
    await shared.admin`select event_id from teams_bot_inbox where route_id=${inbox!.route_id} and event_id<>${inbox!.event_id}`;
  const [progress] =
    await shared.admin`select relevant_event_sequence::int as n from teams_bot_routes where route_id=${inbox!.route_id}`;
  expect(await pending(next!.event_id, progress!.n)).toBe(true);
  await shared.admin`update teams_bot_routes set lease_until=null where route_id=${inbox!.route_id}`;
  await drainTeamsBotOnce(f.deps, send);
  expect(await pending(next!.event_id, progress!.n)).toBe(true);
  await appendSessionEvents(
    client.db,
    route!.session_workspace_id ?? route!.workspace_id,
    route!.session_id,
    [{ type: "turn.completed", payload: { output: "" } }],
  );
  expect(await pending(next!.event_id, progress!.n)).toBe(false);
});

test("thumbs up or down on an agent reply is recorded as Opengeni feedback once", async () => {
  const f = await fixture();
  const routeId = `route:${crypto.randomUUID()}`;
  await enqueueTeamsMessage(client.db, f.i, {
    routeId,
    actorId: f.actor,
    subjectId: f.subject,
    personal: false,
    channelId: "19:channel",
    conversationId: "19:channel",
    threadId: "root",
    serviceUrl,
    botId: f.botId,
    eventId: `event:${crypto.randomUUID()}`,
    payload: { text: "Investigate" },
  });
  let sent = 0;
  const send = async () => `bot-message-${++sent}`;
  const tick = async () => {
    await shared.admin`update teams_bot_routes set lease_until=null where route_id=${routeId}`;
    await drainTeamsBotOnce(f.deps, send);
  };
  await tick();
  const [route] =
    await shared.admin`select session_id from teams_bot_routes where route_id=${routeId}`;
  await appendSessionEvents(client.db, f.i.workspace_id, route!.session_id, [
    { type: "turn.completed", payload: { output: "Findings" } },
  ]);
  await tick();
  expect(sent).toBe(2);
  const feedback = (replyToId: string, from = f.actor, id = crypto.randomUUID()) => ({
    type: "invoke",
    name: "message/submitAction",
    id,
    channelId: "msteams",
    serviceUrl,
    from: { id: `29:${from}`, aadObjectId: from },
    recipient: { id: f.botId },
    conversation: {
      id: "19:channel;messageid=root",
      conversationType: "channel",
      tenantId: f.tenant,
    },
    channelData: { tenant: { id: f.tenant }, channel: { id: "19:channel" } },
    replyToId,
    value: {
      actionName: "feedback",
      actionValue: {
        reaction: "dislike",
        feedback: JSON.stringify({ feedbackText: "Missed a file" }),
      },
    },
  });
  const rows = () =>
    shared.admin`select subject_id,session_id,sentiment,comment,principal_kind from feedback_submissions where workspace_id=${f.i.workspace_id}`;
  // The "started" notice is not an agent reply.
  await f.handle(feedback("bot-message-1"));
  // Someone without a linked account, or an unknown message, records nothing.
  await f.handle(feedback("bot-message-2", crypto.randomUUID()));
  await f.handle(feedback("bot-message-9"));
  expect(await rows()).toHaveLength(0);
  const invoke = feedback("bot-message-2");
  expect(await f.handle(invoke)).toEqual({ status: 200 });
  await f.handle(invoke);
  const recorded = await rows();
  expect(recorded).toHaveLength(1);
  expect(recorded[0]).toMatchObject({
    subject_id: f.subject,
    session_id: route!.session_id,
    sentiment: "negative",
  });
  // Feedback about the same message from another conversation, or from a
  // channel that isn't allowlisted, records nothing.
  await f.handle({
    ...feedback("bot-message-2"),
    conversation: {
      id: "19:other;messageid=root",
      conversationType: "channel",
      tenantId: f.tenant,
    },
    channelData: { tenant: { id: f.tenant }, channel: { id: "19:other" } },
  });
  await f.handle({
    ...feedback("bot-message-2"),
    channelData: { tenant: { id: f.tenant }, channel: { id: "19:closed" } },
  });
  expect(await rows()).toHaveLength(1);
  // Feedback names the reply's turn; a turn that no longer exists leaves it on the chat.
  await shared.admin`update teams_bot_outbox set payload=payload||jsonb_build_object('turnId',${crypto.randomUUID()}::text) where route_id=${routeId} and provider_message_id='bot-message-2'`;
  await f.handle(feedback("bot-message-2"));
  const [fallback] =
    await shared.admin`select turn_id from feedback_submissions where workspace_id=${f.i.workspace_id} order by created_at desc limit 1`;
  expect(fallback!.turn_id).toBeNull();
  expect(await rows()).toHaveLength(2);
  expect(f.outcomes).toEqual([
    "feedback_target_missing",
    "feedback_actor_unlinked",
    "feedback_target_missing",
    "feedback_recorded",
    "feedback_replayed",
    "feedback_target_missing",
    "channel_disabled",
    "feedback_recorded",
  ]);
});

test("only the owner of a 1:1 chat can rate its replies", async () => {
  const f = await fixture();
  const personal = await personalWorkspace(f);
  const routeId = `route:${crypto.randomUUID()}`;
  const input = {
    routeId,
    actorId: f.actor,
    subjectId: f.subject,
    personal: true,
    sessionWorkspaceId: personal,
    conversationId: `a:${f.actor}`,
    threadId: null,
    serviceUrl,
    botId: f.botId,
    eventId: `event:${crypto.randomUUID()}`,
    payload: { text: "Investigate" },
  };
  expect(await enqueueTeamsMessage(client.db, f.i, input)).toEqual({
    routeId,
    queued: true,
    replySequence: 0,
  });
  // A redelivered message is not queued again, so it starts no second typing loop.
  expect((await enqueueTeamsMessage(client.db, f.i, input)).queued).toBe(false);
  let sent = 0;
  const send = async () => `bot-message-${++sent}`;
  const tick = async () => {
    await shared.admin`update teams_bot_routes set lease_until=null where route_id=${routeId}`;
    await drainTeamsBotOnce(f.deps, send);
  };
  await tick();
  const [route] =
    await shared.admin`select session_id from teams_bot_routes where route_id=${routeId}`;
  await appendSessionEvents(client.db, personal, route!.session_id, [
    { type: "turn.completed", payload: { output: "Findings" } },
  ]);
  await tick();
  expect(sent).toBe(2);
  // Another linked member of the same workspace.
  const other = crypto.randomUUID();
  const otherSubject = `user:teams:${crypto.randomUUID()}`;
  await shared.admin`insert into workspace_memberships(account_id,workspace_id,subject_id,role,permissions) select account_id,workspace_id,${otherSubject},role,permissions from workspace_memberships where workspace_id=${f.i.workspace_id} and subject_id=${f.subject}`;
  await linkTeamsActor(client.db, f.i, {
    actorId: other,
    subjectId: otherSubject,
    nonce: crypto.randomUUID(),
  });
  const rate = (from: string) => ({
    type: "invoke",
    name: "message/submitAction",
    id: crypto.randomUUID(),
    channelId: "msteams",
    serviceUrl,
    from: { id: `29:${from}`, aadObjectId: from },
    recipient: { id: f.botId },
    conversation: { id: `a:${f.actor}`, conversationType: "personal", tenantId: f.tenant },
    channelData: { tenant: { id: f.tenant } },
    replyToId: "bot-message-2",
    value: { actionName: "feedback", actionValue: { reaction: "like" } },
  });
  await f.handle(rate(other));
  await f.handle(rate(f.actor));
  const rows =
    await shared.admin`select subject_id,sentiment from feedback_submissions where workspace_id=${personal}`;
  expect(rows).toEqual([{ subject_id: f.subject, sentiment: "positive" }]);
  expect(f.outcomes).toEqual(["feedback_target_missing", "feedback_recorded"]);
});
