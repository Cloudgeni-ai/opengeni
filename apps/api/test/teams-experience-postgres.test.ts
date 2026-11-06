import { createHash } from "node:crypto";
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
import {
  TEAMS_CANNOT_START_TEXT,
  TEAMS_CONNECT_REMINDER_TEXT,
  TEAMS_CONVERSATION_OFF_TEXT,
  TEAMS_WORK_ACCOUNT_TEXT,
} from "../src/integrations/teams-experience";

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

/**
 * `cardsWithoutId` makes the fake Teams answer a message that carries a card
 * as Teams can: accepted, with an empty body and no message id.
 */
async function fixture(options: { cardsWithoutId?: boolean } = {}) {
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
  /** Sends that fail before reaching Teams, next first. */
  const failures: Error[] = [];
  /** A separate Teams client, as each API replica has its own. */
  const teamsApp = () =>
    ({
      api: {
        fromServiceUrl: () => ({
          conversations: {
            createActivity: async (conversationId: string, activity: Record<string, unknown>) => {
              const failure = failures.shift();
              if (failure) throw failure;
              calls.push({ conversationId, activity });
              return options.cardsWithoutId && activity.attachments
                ? ""
                : { id: `activity-${calls.length}` };
            },
          },
        }),
      },
    }) as unknown as App;
  const app = teamsApp();
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
  /**
   * Another API replica on the same database: its own process state (route
   * dependencies, reply budgets) and its own Teams client.
   */
  const replica = (settings: Partial<ApiRouteDeps["settings"]> = {}) => {
    const other = {
      ...deps,
      settings: { ...deps.settings, ...settings },
    } as ApiRouteDeps;
    const otherApp = teamsApp();
    return (body: unknown) => handleTeamsActivity(other, otherApp, body);
  };
  return {
    i,
    tenant,
    actor,
    subject,
    deps,
    app,
    calls,
    failures,
    botId,
    message,
    handle,
    replica,
    outcomes,
  };
}

function cardActions(activity: Record<string, unknown>): unknown[] {
  const attachments = activity.attachments as
    | Array<{ content: { actions: unknown[] } }>
    | undefined;
  return attachments?.[0]?.content.actions ?? [];
}

test("unmentioned channel messages are kept as context and follow edits and deletions, without starting work", async () => {
  const f = await fixture();
  const root = `root-${crypto.randomUUID()}`;
  const channelMessage = (id: string, text: string, at: string) =>
    f.message(text, f.actor, {
      id,
      timestamp: at,
      conversation: { id: `19:channel;messageid=${root}`, conversationType: "channel" },
      channelData: { tenant: { id: f.tenant }, channel: { id: "19:channel" } },
    });
  const rows = () =>
    shared.admin`select message_id,thread_id,text,mentioned from teams_bot_context_messages where workspace_id=${f.i.workspace_id} order by occurred_at`;
  await f.handle(
    channelMessage(
      root,
      "The migration window is Tuesday 14:00",
      new Date(Date.now() - 120_000).toISOString(),
    ),
  );
  await f.handle(
    channelMessage("reply-1", "Ravi owns it", new Date(Date.now() - 60_000).toISOString()),
  );
  expect(await rows()).toEqual([
    {
      message_id: root,
      thread_id: root,
      text: "The migration window is Tuesday 14:00",
      mentioned: false,
    },
    { message_id: "reply-1", thread_id: root, text: "Ravi owns it", mentioned: false },
  ]);
  expect(f.outcomes.filter((x) => x === "context_recorded")).toHaveLength(2);
  // Without a mention nothing is queued and nothing is sent.
  expect(
    await shared.admin`select 1 from teams_bot_inbox where workspace_id=${f.i.workspace_id}`,
  ).toHaveLength(0);
  expect(f.calls).toHaveLength(0);

  const revision = (type: "messageUpdate" | "messageDelete", eventType: string, text?: string) => ({
    type,
    id: "reply-1",
    channelId: "msteams",
    recipient: { id: f.botId },
    conversation: { id: `19:channel;messageid=${root}`, conversationType: "channel" },
    channelData: { tenant: { id: f.tenant }, channel: { id: "19:channel" }, eventType },
    ...(text === undefined ? {} : { text }),
  });
  await f.handle(revision("messageUpdate", "editMessage", "Priya owns it"));
  expect((await rows()).map((x) => x.text)).toEqual([
    "The migration window is Tuesday 14:00",
    "Priya owns it",
  ]);
  await f.handle(revision("messageDelete", "softDeleteMessage"));
  expect((await rows()).map((x) => x.message_id)).toEqual([root]);
  expect(f.outcomes.filter((x) => x === "context_revised")).toHaveLength(2);
  expect(f.calls).toHaveLength(0);
});

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

test("in an organization that hasn't connected Opengeni, installs and messages get a bounded Connect your organization card", async () => {
  const f = await fixture();
  const other = crypto.randomUUID();
  const deps = {
    ...f.deps,
    settings: {
      ...f.deps.settings,
      teamsBotSelfServeSetupEnabled: true,
      teamsBotAllowedTenantIds: [f.tenant, other],
    },
  } as ApiRouteDeps;
  const handle = (body: unknown) => handleTeamsActivity(deps, f.app, body);
  const person = crypto.randomUUID();
  const chat = {
    conversation: { id: `a:${person}`, conversationType: "personal", tenantId: other },
    channelData: { tenant: { id: other } },
  };
  const connectAction = (index: number) => {
    const [action] = cardActions(f.calls[index]!.activity) as Array<{
      type: string;
      title: string;
      url: string;
    }>;
    expect(action).toMatchObject({ type: "Action.OpenUrl", title: "Connect your organization" });
    return new URLSearchParams(new URL(action!.url).hash.slice(1)).get("teams_setup")!;
  };
  await handle({
    type: "conversationUpdate",
    channelId: "msteams",
    serviceUrl,
    from: { id: `29:${person}`, aadObjectId: person },
    recipient: { id: f.botId },
    membersAdded: [{ id: f.botId }],
    ...chat,
  });
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]!.activity.text).toContain("Your organization hasn't connected Opengeni yet.");
  expect(verifyTeamsProof("test", connectAction(0))).toMatchObject({
    purpose: "setup",
    tenantId: other,
    actorId: person,
    workspaceId: null,
    conversation: { id: `a:${person}`, serviceUrl },
  });
  await handle(f.message("hello", person, chat));
  expect(f.calls).toHaveLength(2);
  connectAction(1);
  // A repeat within the card's cooldown gets a short reminder, without a card
  // or an identity proof; one more within the reminder's cooldown gets nothing.
  await handle(f.message("hello again", person, chat));
  expect(f.calls).toHaveLength(3);
  expect(f.calls[2]!.activity).toEqual({
    type: "message",
    text: TEAMS_CONNECT_REMINDER_TEXT,
    textFormat: "markdown",
  });
  await handle(f.message("and again", person, chat));
  expect(f.calls).toHaveLength(3);
  // Help and unlink always answer, with the Connect your organization card.
  await handle(f.message("help", person, chat));
  expect(f.calls).toHaveLength(4);
  expect(f.calls[3]!.activity.text).toContain("**Opengeni help**");
  expect(f.calls[3]!.activity.text).toContain("If that's you, select Connect your organization.");
  expect(verifyTeamsProof("test", connectAction(3))).toMatchObject({
    purpose: "setup",
    tenantId: other,
    actorId: person,
    conversation: { id: `a:${person}`, serviceUrl },
  });
  await handle(f.message("unlink", person, chat));
  expect(f.calls).toHaveLength(5);
  expect(f.calls[4]!.activity.text).toContain("Your Teams account isn't linked to Opengeni.");
  connectAction(4);
  expect(f.outcomes).toEqual([
    "connect_link_sent",
    "connect_link_sent",
    "connect_reminder_sent",
    "onboarding_reply_limited",
    "help_sent",
    "unlink_not_linked",
  ]);
  // The counts are shared through the database: another replica, with its own
  // process state, doesn't send this person another card.
  await f.replica(deps.settings)(f.message("hello from elsewhere", person, chat));
  expect(f.calls).toHaveLength(5);
  // Only content-free counts are stored.
  const limits = await shared.admin<Array<{ scope_hash: string }>>`
    select scope_hash from teams_bot_onboarding_limits`;
  expect(limits.length).toBeGreaterThanOrEqual(3);
  for (const row of limits) expect(row.scope_hash).toMatch(/^[0-9a-f]{64}$/);
  expect(JSON.stringify(limits)).not.toContain(person);
});

test("a personal Microsoft account is told a work or school account is needed, on install and in reply", async () => {
  const f = await fixture();
  const consumer = "9188040d-6c67-4c5b-b112-36a304b66dad";
  f.deps.settings.teamsBotSelfServeSetupEnabled = true;
  f.deps.settings.teamsBotEnabled = true;
  const person = crypto.randomUUID();
  const chat = {
    conversation: { id: `a:${person}`, conversationType: "personal", tenantId: consumer },
    channelData: { tenant: { id: consumer } },
  };
  await f.handle(personalInstall(f, person, consumer));
  await f.handle(f.message("hello", person, chat));
  await f.handle(f.message("help", person, chat));
  await f.handle(f.message("unlink", person, chat));
  expect(f.calls.map((call) => call.activity.text)).toEqual([
    TEAMS_WORK_ACCOUNT_TEXT,
    TEAMS_WORK_ACCOUNT_TEXT,
    expect.stringContaining(TEAMS_WORK_ACCOUNT_TEXT),
    `Your Teams account isn't linked to Opengeni.\n\n${TEAMS_WORK_ACCOUNT_TEXT}`,
  ]);
  for (const call of f.calls) expect(cardActions(call.activity)).toEqual([]);
  expect(f.outcomes).toEqual([
    "work_account_notice_sent",
    "work_account_notice_sent",
    "help_sent",
    "unlink_not_linked",
  ]);
});

test("a linked person who can't start chats is told why and what to do", async () => {
  const f = await fixture();
  await shared.admin`update workspace_memberships set permissions = '["workspace:read", "sessions:read"]'::jsonb where workspace_id=${f.i.workspace_id} and subject_id=${f.subject}`;
  await f.handle(f.message("Plan the launch"));
  expect(f.calls.map((call) => call.activity.text)).toEqual([TEAMS_CANNOT_START_TEXT]);
  expect(f.outcomes).toEqual(["sessions_create_denied"]);
  const [inbox] =
    await shared.admin`select count(*)::int as n from teams_bot_inbox where workspace_id=${f.i.workspace_id}`;
  expect(inbox!.n).toBe(0);
});

/** A personal install of the fixture's bot, as Teams delivers it. */
function personalInstall(
  f: Awaited<ReturnType<typeof fixture>>,
  from: string,
  tenant: string = f.tenant,
) {
  return {
    type: "conversationUpdate",
    id: `f:${crypto.randomUUID()}`,
    channelId: "msteams",
    serviceUrl,
    from: { id: `29:${from}`, aadObjectId: from },
    recipient: { id: f.botId },
    conversation: { id: `a:${from}`, conversationType: "personal", tenantId: tenant },
    channelData: { tenant: { id: tenant } },
    membersAdded: [{ id: f.botId }],
  };
}

test("an install Teams redelivers to another replica is welcomed once, and a card Teams accepts without an id doesn't fail it", async () => {
  // Staging, 6 Nov 2026: Teams accepted the welcome card with an empty 202,
  // the missing id failed the install with a 500, and Teams redelivered it to
  // another replica, which welcomed the person again.
  const f = await fixture({ cardsWithoutId: true });
  const replicaB = f.replica();
  const replicaC = f.replica();

  // Connected organization, unlinked person: the welcome has a Link account card.
  const stranger = crypto.randomUUID();
  const install = personalInstall(f, stranger);
  expect(await f.handle(install)).toEqual({ status: 200 });
  expect(f.calls).toHaveLength(1);
  expect((cardActions(f.calls[0]!.activity)[0] as { title: string }).title).toBe("Link account");
  // The same install delivered again, to other replicas, sends nothing more.
  expect(await replicaB(install)).toEqual({ status: 200 });
  expect(await replicaC(install)).toEqual({ status: 200 });
  expect(f.calls).toHaveLength(1);

  // Linked person: a text-only welcome, also once across replicas.
  expect(await replicaB(personalInstall(f, f.actor))).toEqual({ status: 200 });
  expect(await f.handle(personalInstall(f, f.actor))).toEqual({ status: 200 });
  expect(f.calls).toHaveLength(2);
  expect(cardActions(f.calls[1]!.activity)).toEqual([]);

  // Deliveries that arrive together still welcome once.
  const concurrent = crypto.randomUUID();
  const body = personalInstall(f, concurrent);
  expect(await Promise.all([f.handle(body), replicaB(body), replicaC(body)])).toEqual([
    { status: 200 },
    { status: 200 },
    { status: 200 },
  ]);
  expect(f.calls.filter((c) => c.conversationId === `a:${concurrent}`)).toHaveLength(1);

  // An unlinked person's message gets its link card, which also comes back
  // without an id, and the message doesn't fail.
  expect(await replicaB(f.message("hello", stranger))).toEqual({ status: 200 });
  expect(f.calls).toHaveLength(4);
  expect(cardActions(f.calls[3]!.activity)).toHaveLength(1);
  // So does a command reply with a button (staging sent "unlink" twice too).
  expect(await f.handle(f.message("unlink"))).toEqual({ status: 200 });
  expect(f.calls).toHaveLength(5);
  expect((cardActions(f.calls[4]!.activity)[0] as { title: string }).title).toBe("Unlink account");

  expect(f.outcomes.slice(0, 5)).toEqual([
    "welcome_sent",
    "welcome_duplicate",
    "welcome_duplicate",
    "welcome_sent",
    "welcome_duplicate",
  ]);
  expect([...f.outcomes.slice(5, 8)].sort()).toEqual([
    "welcome_duplicate",
    "welcome_duplicate",
    "welcome_sent",
  ]);
  expect(f.outcomes.slice(8)).toEqual(["unlink_confirmation_sent"]);
  // Only content-free claims are stored.
  const claims = await shared.admin<Array<{ scope_hash: string }>>`
    select scope_hash from teams_bot_welcomes`;
  expect(claims.length).toBeGreaterThanOrEqual(3);
  for (const claim of claims) expect(claim.scope_hash).toMatch(/^[0-9a-f]{64}$/);
  expect(JSON.stringify(claims)).not.toContain(stranger);
});

test("in an organization that hasn't connected Opengeni, a redelivered install gets one Connect your organization card", async () => {
  const f = await fixture({ cardsWithoutId: true });
  const other = crypto.randomUUID();
  const settings = {
    teamsBotSelfServeSetupEnabled: true,
    teamsBotAllowedTenantIds: [f.tenant, other],
  };
  // Replicas share the install-welcome budget, but a second delivery is kept
  // from even reaching it by the database claim.
  const replicaA = f.replica(settings);
  const replicaB = f.replica(settings);
  const person = crypto.randomUUID();
  const install = personalInstall(f, person, other);
  expect(await replicaA(install)).toEqual({ status: 200 });
  expect(await replicaB(install)).toEqual({ status: 200 });
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]!.activity.text).toContain("Your organization hasn't connected Opengeni yet.");
  // Throttled: Teams is asked to redeliver, and the reply budget is given
  // back in the database, so the redelivery sends the card.
  const throttled = personalInstall(f, crypto.randomUUID(), other);
  f.failures.push(Object.assign(new Error("throttled"), { response: { status: 429 } }));
  expect(await replicaA(throttled)).toEqual({ status: 503 });
  expect(await replicaA(throttled)).toEqual({ status: 200 });
  expect(f.calls).toHaveLength(2);
  expect(f.outcomes).toEqual([
    "connect_link_sent",
    "welcome_duplicate",
    "onboarding_reply_failed",
    "connect_link_sent",
  ]);
});

test("a welcome Teams refuses is given back for a later delivery, one that may have arrived isn't repeated, and a reinstall after the window is welcomed again", async () => {
  const f = await fixture();
  const replicaB = f.replica();
  const person = crypto.randomUUID();
  const install = personalInstall(f, person);
  // A local failure before anything reached Teams: the install succeeds and
  // gives the claim back.
  f.failures.push(new Error("teams_unreachable"));
  expect(await f.handle(install)).toEqual({ status: 200 });
  expect(f.calls).toHaveLength(0);
  // Teams throttles the send: the install asks Teams to redeliver.
  f.failures.push(Object.assign(new Error("throttled"), { response: { status: 429 } }));
  expect(await f.handle(install)).toEqual({ status: 503 });
  expect(f.calls).toHaveLength(0);
  // The redelivery, on another replica, sends the welcome; later ones don't.
  expect(await replicaB(install)).toEqual({ status: 200 });
  expect(f.calls).toHaveLength(1);
  expect(await f.handle(install)).toEqual({ status: 200 });
  expect(f.calls).toHaveLength(1);

  // A send that timed out may have arrived, so its claim is kept: no second try.
  const timedOut = personalInstall(f, crypto.randomUUID());
  f.failures.push(Object.assign(new Error("timeout"), { code: "ECONNABORTED" }));
  expect(await f.handle(timedOut)).toEqual({ status: 200 });
  expect(await replicaB(timedOut)).toEqual({ status: 200 });
  expect(f.calls).toHaveLength(1);

  // Once the claim window has passed, installing again welcomes again.
  const scope = createHash("sha256").update(`${f.tenant}\na:${person}`).digest("hex");
  const aged = await shared.admin`
    update teams_bot_welcomes set claimed_at = now() - interval '11 minutes'
    where scope_hash = ${scope}`;
  expect(aged.count).toBe(1);
  expect(await replicaB(personalInstall(f, person))).toEqual({ status: 200 });
  expect(f.calls).toHaveLength(2);
  expect(f.outcomes).toEqual([
    "welcome_failed",
    "welcome_failed",
    "welcome_sent",
    "welcome_duplicate",
    "welcome_failed",
    "welcome_duplicate",
    "welcome_sent",
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
  // A channel that isn't allowlisted says so, in the thread, at most once a
  // minute per person.
  const closed = () =>
    f.message(`<at>Opengeni</at> help`, stranger, {
      conversation: { id: "19:closed", conversationType: "channel", tenantId: f.tenant },
      channelData: { tenant: { id: f.tenant }, channel: { id: "19:closed" } },
      entities: [{ type: "mention", mentioned: { id: f.botId }, text: "<at>Opengeni</at>" }],
    });
  await f.handle(closed());
  await f.handle(closed());
  expect(f.calls).toHaveLength(4);
  expect(f.calls[3]!.conversationId).toContain("19:closed;messageid=");
  expect(f.calls[3]!.activity.text).toBe(TEAMS_CONVERSATION_OFF_TEXT);
  expect(f.outcomes).toEqual([
    "help_sent",
    "help_sent",
    "help_sent",
    "channel_disabled_notice_sent",
    "channel_disabled",
  ]);
});

test("1:1 help mentions group chats and channels only when the organization has one enabled", async () => {
  const tip = "In a group chat or channel where Opengeni is enabled";
  const f = await fixture();
  // The fixture's tenant has allowlisted channels.
  await f.handle(f.message("help"));
  expect(f.calls[0]!.activity.text).toContain(tip);
  // Entries for another tenant don't count.
  f.deps.settings.teamsBotAllowedChannelIds = [`${crypto.randomUUID()}:19:channel`];
  f.deps.settings.teamsBotAllowedGroupChatIds = [];
  await f.handle(f.message("help"));
  expect(f.calls[1]!.activity.text).not.toContain(tip);
  f.deps.settings.teamsBotAllowedGroupChatIds = [`${f.tenant}:19:group@thread.v2`];
  await f.handle(f.message("help"));
  expect(f.calls[2]!.activity.text).toContain(tip);
  // An admitted organization that isn't connected yet gets no tip: its group
  // chats can't answer until it connects.
  const other = crypto.randomUUID();
  f.deps.settings.teamsBotAllowedTenantIds = [f.tenant, other];
  f.deps.settings.teamsBotAllowedGroupChatIds = [`${other}:19:group@thread.v2`];
  const person = crypto.randomUUID();
  await f.handle(
    f.message("help", person, {
      conversation: { id: `a:${person}`, conversationType: "personal", tenantId: other },
      channelData: { tenant: { id: other } },
    }),
  );
  expect(f.calls[3]!.activity.text).toContain("**Opengeni help**");
  expect(f.calls[3]!.activity.text).not.toContain(tip);
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
  expect(f.calls[2]!.activity.text).toBe(
    "Your Teams account isn't linked to Opengeni.\n\nLink your Opengeni account to start.",
  );
  expect((cardActions(f.calls[2]!.activity)[0] as { title: string }).title).toBe("Link account");
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
  const deliveries: Array<{ text: string; ai: boolean; link?: string }> = [];
  const send = async (
    _m: unknown,
    text: string,
    options?: { ai?: boolean; link?: { title: string } },
  ) => {
    deliveries.push({
      text,
      ai: options?.ai === true,
      ...(options?.link ? { link: options.link.title } : {}),
    });
    return `sent-${deliveries.length}`;
  };
  await drainTeamsBotOnce(f.deps, send);
  expect(deliveries).toHaveLength(1);
  expect(deliveries[0]!.ai).toBe(false);
  expect(deliveries[0]!.link).toBe("Open in Opengeni");
  expect(await pending(inbox!.event_id)).toBe(true);
  const [route] =
    await shared.admin`select session_id,session_workspace_id,workspace_id from teams_bot_routes where route_id=${inbox!.route_id}`;
  const [admitted] =
    await shared.admin`select turn_id::text as turn_id from teams_bot_inbox where event_id=${inbox!.event_id}`;
  expect(admitted!.turn_id).toBeTruthy();
  await appendSessionEvents(
    client.db,
    route!.session_workspace_id ?? route!.workspace_id,
    route!.session_id,
    [
      {
        type: "turn.completed",
        turnId: admitted!.turn_id,
        payload: { output: "| A | B |\n| - | - |\n| 1 | 2 |" },
      },
    ],
  );
  await shared.admin`update teams_bot_routes set lease_until=null where route_id=${inbox!.route_id}`;
  await drainTeamsBotOnce(f.deps, send);
  expect(await pending(inbox!.event_id)).toBe(false);
  // The agent reply is Teams Markdown and carries the AI label and feedback.
  expect(deliveries.at(-1)).toEqual({ text: "- **1**\n  - B: 2", ai: true });
  const [outbox] =
    await shared.admin`select payload from teams_bot_outbox where route_id=${inbox!.route_id} and source_sequence>0`;
  expect(outbox!.payload).toMatchObject({ text: "- **1**\n  - B: 2", ai: true });

  // A message admitted without a known turn (by an older release) falls back
  // to its chat: a turn that completes, even without text, ends typing.
  await f.handle(f.message("Anything else?"));
  const [next] =
    await shared.admin`select event_id from teams_bot_inbox where route_id=${inbox!.route_id} and event_id<>${inbox!.event_id}`;
  const [progress] =
    await shared.admin`select relevant_event_sequence::int as n from teams_bot_routes where route_id=${inbox!.route_id}`;
  expect(await pending(next!.event_id, progress!.n)).toBe(true);
  await shared.admin`update teams_bot_routes set lease_until=null where route_id=${inbox!.route_id}`;
  await drainTeamsBotOnce(f.deps, send);
  await shared.admin`update teams_bot_inbox set turn_id=null where event_id=${next!.event_id}`;
  expect(await pending(next!.event_id, progress!.n)).toBe(true);
  await appendSessionEvents(
    client.db,
    route!.session_workspace_id ?? route!.workspace_id,
    route!.session_id,
    [{ type: "turn.completed", payload: { output: "" } }],
  );
  expect(await pending(next!.event_id, progress!.n)).toBe(false);
});

test("typing follows the turn that answers each message, not the chat", async () => {
  const f = await fixture();
  await personalWorkspace(f);
  const send = async () => `sent-${crypto.randomUUID()}`;
  await f.handle(f.message("First"));
  const [first] =
    await shared.admin`select route_id,event_id from teams_bot_inbox where workspace_id=${f.i.workspace_id}`;
  const tick = async () => {
    await shared.admin`update teams_bot_routes set lease_until=null where route_id=${first!.route_id}`;
    await drainTeamsBotOnce(f.deps, send);
  };
  await tick();
  await f.handle(f.message("Second"));
  await tick();
  const messages =
    await shared.admin`select event_id,state,turn_id::text as turn_id from teams_bot_inbox where route_id=${first!.route_id} order by created_at`;
  expect(messages.map((m: { state: string }) => m.state)).toEqual(["accepted", "accepted"]);
  const [a, b] = messages as Array<{ event_id: string; turn_id: string }>;
  expect(a!.turn_id).toBeTruthy();
  expect(b!.turn_id).toBeTruthy();
  expect(b!.turn_id).not.toBe(a!.turn_id);
  const pending = (eventId: string) =>
    teamsReplyPending(client.db, f.i, { eventId, replySequence: 0 });
  expect(await pending(a!.event_id)).toBe(true);
  expect(await pending(b!.event_id)).toBe(true);
  const [route] =
    await shared.admin`select session_id,session_workspace_id,workspace_id from teams_bot_routes where route_id=${first!.route_id}`;
  const complete = (turnId: string) =>
    appendSessionEvents(
      client.db,
      route!.session_workspace_id ?? route!.workspace_id,
      route!.session_id,
      [{ type: "turn.completed", turnId, payload: { output: "Done" } }],
    );
  // The first turn's reply ends typing for the first message only.
  await complete(a!.turn_id);
  await tick();
  expect(await pending(a!.event_id)).toBe(false);
  expect(await pending(b!.event_id)).toBe(true);
  await complete(b!.turn_id);
  await tick();
  expect(await pending(b!.event_id)).toBe(false);
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
  // Feedback on a chat whose session is gone is answered, not an error.
  await shared.admin`delete from sessions where id=${route!.session_id}`;
  expect(await f.handle(feedback("bot-message-2"))).toEqual({ status: 200 });
  expect(f.outcomes).toEqual([
    "feedback_target_missing",
    "feedback_actor_unlinked",
    "feedback_target_missing",
    "feedback_recorded",
    "feedback_replayed",
    "feedback_target_missing",
    "channel_disabled",
    "feedback_recorded",
    "feedback_target_missing",
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
  // A private chat that is no longer this person's is answered as missing.
  await shared.admin`insert into organization_memberships(account_id,subject_id,role) select account_id,${otherSubject},role from organization_memberships where account_id=${f.i.account_id} and subject_id=${f.subject}`;
  await shared.admin.begin(async (tx) => {
    const capability = crypto.randomUUID();
    await tx`insert into session_visibility_write_capabilities values (pg_backend_pid(), pg_current_xact_id(), ${capability})`;
    await tx`select set_config('opengeni.session_visibility_write_capability', ${capability}, true)`;
    await tx`update sessions set owner_subject_id=${otherSubject} where id=${route!.session_id}`;
  });
  expect(await f.handle(rate(f.actor))).toEqual({ status: 200 });
  expect(f.outcomes).toEqual([
    "feedback_target_missing",
    "feedback_recorded",
    "feedback_target_missing",
  ]);
});
