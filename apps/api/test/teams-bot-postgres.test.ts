import { sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import {
  createDb,
  bootstrapWorkspace,
  installTeamsBot,
  enqueueTeamsMessage,
  appendSessionEvents,
  removeTeamsLink,
  claimTeamsRoute,
  linkTeamsActor,
  getTeamsInstallation,
  createConnection,
  upsertCapabilityCatalogItem,
  enableCapabilityInstallation,
  recordTeamsContextMessage,
  listTeamsContextMessages,
  markTeamsContextMentionAccepted,
  reviseTeamsContextMessage,
  clearTeamsContextConversation,
  disconnectTeamsBot,
  TEAMS_CONTEXT_MESSAGES_PER_THREAD,
} from "@opengeni/db";
import { updateManagedHumanSessionVisibility, type ApiRouteDeps } from "@opengeni/core";
import { teamsRouteId } from "../src/integrations/teams-protocol";
import { createApp } from "../src/app";
import { drainTeamsBotOnce, teamsChatPersonalWorkspace } from "../src/integrations/teams-bot";
let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const value = await acquireSharedTestDatabase("teams-bot-pump");
  if (!value) throw new Error("Teams pump requires real PostgreSQL");
  shared = value;
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
});
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
  const personal = crypto.randomUUID();
  await shared.admin`insert into workspaces(id,account_id,name) values(${personal},${grant.accountId},'Personal')`;
  await shared.admin`insert into organization_memberships(account_id,subject_id,role,status,personal_workspace_id) values(${grant.accountId},${subject},'owner','active',${personal})`;
  const tenant = crypto.randomUUID(),
    actor = crypto.randomUUID();
  const i = await installTeamsBot(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    tenantId: tenant,
    actorId: actor,
    subjectId: subject,
    nonce: crypto.randomUUID(),
  });
  const noop = async () => undefined;
  const deps = {
    db: client.db,
    settings: testSettings({
      databaseUrl: shared.appUrl,
      sandboxBackend: "none",
      productAccessMode: "managed",
      teamsBotClientId: crypto.randomUUID(),
      teamsBotClientSecret: "test",
      teamsBotTenantId: tenant,
      teamsBotAllowedTenantIds: [tenant],
      teamsBotAllowedChannelIds: [`${tenant}:19:channel`],
      integrationsStateSecret: "test",
      webBaseUrl: "https://app.example.test",
    }),
    bus: new MemoryEventBus(),
    workflowClient: { wakeSessionWorkflow: noop, requestSessionWorkflowWakeDispatch: noop },
    objectStorage: null,
    githubStateSecret: "test",
    documentIndexer: { indexDocument: noop },
    getDocumentServices: () => ({}),
  } as unknown as ApiRouteDeps;
  const routeId = `route:${crypto.randomUUID()}`;
  const input = {
    routeId,
    actorId: actor,
    subjectId: subject,
    personal: false,
    channelId: "19:channel",
    conversationId: "19:channel",
    threadId: "message",
    serviceUrl: "https://smba.trafficmanager.net/emea/",
    botId: "28:bot",
    eventId: `event:${crypto.randomUUID()}`,
    payload: { text: "Please investigate the project" },
  };
  const messages: string[] = [];
  const deliveries: Array<{ text: string; ai: boolean }> = [];
  const send = async (_m: unknown, text: string, options?: { ai?: boolean }) => {
    messages.push(text);
    deliveries.push({ text, ai: options?.ai === true });
    return `sent-${messages.length}`;
  };
  const tick = async (sender = send) => {
    await shared.admin`update teams_bot_routes set lease_until=null where route_id=${routeId}`;
    await drainTeamsBotOnce(deps, sender);
  };
  return { i, actor, subject, deps, input, messages, deliveries, tick, grant, access, personal };
}

test("a linked person's 1:1 chat lands in their own Personal workspace; channels and Personal-off stay in the installation's", async () => {
  const f = await fixture();
  await shared.admin`insert into workspace_inference_controls(workspace_id,account_id) values(${f.personal},${f.i.account_id})`;
  await shared.admin`insert into session_tenancy_activations(account_id,activation_version,inventory_digest,parity_digest,activated_by) values(${f.i.account_id},1,${"1".repeat(64)},${"2".repeat(64)},'test')`;
  // Only me chats in shared workspaces are off; a Personal workspace doesn't need them.
  await shared.admin`insert into organization_private_session_settings(account_id,enabled,version,updated_by_membership_id) values(${f.i.account_id},false,1,null) on conflict(account_id) do update set enabled=false`;
  expect(await teamsChatPersonalWorkspace(f.deps, f.i, f.subject)).toBe(f.personal);
  await enqueueTeamsMessage(client.db, f.i, {
    ...f.input,
    personal: true,
    channelId: null,
    threadId: null,
    sessionWorkspaceId: f.personal,
  });
  await f.tick();
  const [session] =
    await shared.admin`select s.id,s.workspace_id,s.visibility,s.owner_subject_id from sessions s join teams_bot_routes r on r.session_id=s.id where r.route_id=${f.input.routeId}`;
  expect(session!.workspace_id).toBe(f.personal);
  expect(session!.visibility).toBe("user_private");
  expect(session!.owner_subject_id).toBe(f.subject);
  expect(f.messages).toEqual([
    `Started. Follow progress or approve requests: https://app.example.test/workspaces/${f.personal}/sessions/${session!.id}\n\nOpengeni is an AI agent and can make mistakes. Send **help** for tips and commands.`,
  ]);
  const [shared0] =
    await shared.admin`select count(*)::int as n from sessions where workspace_id=${f.i.workspace_id}`;
  expect(shared0!.n).toBe(0);
  // The native event in the Personal workspace wakes the route and is delivered.
  await appendSessionEvents(client.db, f.personal, session!.id, [
    { type: "turn.completed", payload: { output: "Answer from your workspace" } },
  ]);
  const [woken] =
    await shared.admin`select relevant_event_sequence::int as n from teams_bot_routes where route_id=${f.input.routeId}`;
  expect(woken!.n).toBeGreaterThan(0);
  await f.tick();
  expect(f.messages.at(-1)).toBe("Answer from your workspace");
  // A follow-up continues the same chat there.
  await enqueueTeamsMessage(client.db, f.i, {
    ...f.input,
    personal: true,
    channelId: null,
    threadId: null,
    sessionWorkspaceId: f.personal,
    eventId: `event:${crypto.randomUUID()}`,
    payload: { text: "And one more thing" },
  });
  await f.tick();
  const [followUp] =
    await shared.admin`select count(*)::int as n from session_events where session_id=${session!.id} and type='user.message'`;
  expect(followUp!.n).toBe(2);
  // Losing the installation's workspace stops delivery, as for any Teams chat.
  await removeTeamsLink(client.db, f.i, f.subject);
  await appendSessionEvents(client.db, f.personal, session!.id, [
    { type: "turn.completed", payload: { output: "Revoked answer" } },
  ]);
  await f.tick();
  expect(f.messages).not.toContain("Revoked answer");
  // With Personal workspaces off, new 1:1 chats stay in the installation's workspace.
  await shared.admin`insert into organization_privacy_preferences(account_id,personal_workspaces_enabled) values(${f.i.account_id},false) on conflict(account_id) do update set personal_workspaces_enabled=false`;
  expect(await teamsChatPersonalWorkspace(f.deps, f.i, f.subject)).toBeNull();
});

test("a Personal 1:1 route whose chat hasn't started yet gets the admission notice when Personal workspaces are turned off", async () => {
  const f = await fixture();
  await shared.admin`insert into workspace_inference_controls(workspace_id,account_id) values(${f.personal},${f.i.account_id})`;
  await shared.admin`insert into session_tenancy_activations(account_id,activation_version,inventory_digest,parity_digest,activated_by) values(${f.i.account_id},1,${"1".repeat(64)},${"2".repeat(64)},'test')`;
  await enqueueTeamsMessage(client.db, f.i, {
    ...f.input,
    personal: true,
    channelId: null,
    threadId: null,
    sessionWorkspaceId: f.personal,
  });
  await shared.admin`insert into organization_privacy_preferences(account_id,personal_workspaces_enabled) values(${f.i.account_id},false) on conflict(account_id) do update set personal_workspaces_enabled=false`;
  await f.tick();
  expect(f.messages).toHaveLength(1);
  expect(f.messages[0]).toContain("could not start");
  expect(
    (await shared.admin`select state from teams_bot_inbox where event_id=${f.input.eventId}`)[0]!
      .state,
  ).toBe("failed");
  expect(
    (
      await shared.admin`select count(*)::int as n from sessions where account_id=${f.i.account_id}`
    )[0]!.n,
  ).toBe(0);
  // The message is settled, so later ticks don't retry or resend it.
  await f.tick();
  expect(f.messages).toHaveLength(1);
});

test("a 1:1 route can't take a channel, and its proof doesn't create the chat in the installation's workspace", async () => {
  const f = await fixture();
  await expect(
    enqueueTeamsMessage(client.db, f.i, { ...f.input, sessionWorkspaceId: f.personal }),
  ).rejects.toThrow("teams_route_unavailable");
  await enqueueTeamsMessage(client.db, f.i, {
    ...f.input,
    personal: true,
    channelId: null,
    threadId: null,
    sessionWorkspaceId: f.personal,
  });
  // Even the installation workspace's own grant can't start it there.
  const route = (await claimTeamsRoute(client.db, f.i))!;
  const { createSessionForRequest } = await import("@opengeni/core");
  await expect(
    createSessionForRequest(
      f.deps,
      f.grant,
      f.i.workspace_id,
      {
        requestedSessionId: route.session_id,
        initialMessage: f.input.payload.text,
        visibility: "private",
        idempotencyKey: `teams:${route.route_id}`,
      },
      undefined,
      {
        teamsConversation: {
          routeId: route.route_id,
          eventId: f.input.eventId,
          leaseToken: route.lease_token!,
          installationGeneration: f.i.generation,
        },
      },
    ),
  ).rejects.toMatchObject({ status: 403 });
  const [count] =
    await shared.admin`select count(*)::int as n from sessions where id=${route.session_id}`;
  expect(count!.n).toBe(0);
});
test("duplicate channel delivery creates one native session, acknowledges, and publishes asynchronous final once", async () => {
  const f = await fixture();
  await enqueueTeamsMessage(client.db, f.i, f.input);
  await enqueueTeamsMessage(client.db, f.i, f.input);
  await f.tick();
  const [route] =
    await shared.admin`select session_id,session_bound from teams_bot_routes where route_id=${f.input.routeId}`;
  expect(route!.session_bound).toBe(true);
  expect(f.messages).toHaveLength(1);
  expect(f.messages[0]).toContain(route!.session_id);
  const [count] =
    await shared.admin`select count(*)::int as n from sessions where workspace_id=${f.i.workspace_id}`;
  expect(count!.n).toBe(1);
  await appendSessionEvents(client.db, f.i.workspace_id, route!.session_id, [
    { type: "turn.completed", payload: { output: "The completed answer" } },
  ]);
  await f.tick();
  expect(f.messages).toEqual([f.messages[0]!, "The completed answer"]);
  await f.tick();
  expect(f.messages).toHaveLength(2);
});
test("a channel thread mention sees the unmentioned messages before it, and a follow-up only the new ones", async () => {
  const f = await fixture();
  const thread = "root";
  const context = (messageId: string, minute: number, text: string, mentioned = false) =>
    recordTeamsContextMessage(client.db, f.i, {
      conversationId: "19:channel",
      threadId: thread,
      messageId,
      actorId: f.actor,
      actorName: "Ada Lovelace",
      text,
      hasAttachments: false,
      mentioned,
      occurredAt: `2026-11-02T13:0${minute}:00.000Z`,
    });
  const mention = (eventId: string, minute: number, text: string) => ({
    ...f.input,
    conversationId: `19:channel;messageid=${thread}`,
    threadId: thread,
    eventId,
    payload: {
      text,
      personal: false,
      groupChat: false,
      conversationId: `19:channel;messageid=${thread}`,
      threadId: thread,
      eventId,
      occurredAt: `2026-11-02T13:0${minute}:00.000Z`,
    },
  });
  const userMessages = async (sessionId: string) =>
    await shared.admin<{ text: string; model_context: string | null }[]>`
      select payload ->> 'text' as text, payload ->> 'modelContext' as model_context
      from session_events where session_id=${sessionId} and type='user.message' order by sequence`;
  await context(thread, 1, "Root post: planning the launch");
  await context("m2", 2, "The codeword is HERON");
  // Recorded twice (Teams redelivery): kept once.
  await context("m2", 2, "The codeword is HERON");
  // Recorded unmarked, as the webhook does; the drain marks it once accepted.
  await context("m3", 3, "@Opengeni what is the codeword?");
  // Posted after the mention: never part of its context.
  await context("m4", 4, "Later message");
  await enqueueTeamsMessage(client.db, f.i, mention("m3", 3, "what is the codeword?"));
  await f.tick();
  const [route] =
    await shared.admin`select session_id from teams_bot_routes where route_id=${f.input.routeId}`;
  const [first] = await userMessages(route!.session_id);
  expect(first!.text).toBe("what is the codeword?");
  expect(first!.model_context).toContain(
    "Recent messages in this channel thread before the mention",
  );
  expect(first!.model_context).toContain("Root post: planning the launch");
  expect(first!.model_context?.match(/The codeword is HERON/g)).toHaveLength(1);
  expect(first!.model_context).not.toContain("Later message");
  expect(first!.model_context).not.toContain("what is the codeword?");
  const [marked] =
    await shared.admin`select mentioned from teams_bot_context_messages where workspace_id=${f.i.workspace_id} and message_id='m3'`;
  expect(marked!.mentioned).toBe(true);

  await context("m5", 5, "Actually it changed to EGRET");
  await context("m6", 6, "@Opengeni and now?");
  await enqueueTeamsMessage(client.db, f.i, mention("m6", 6, "and now?"));
  await f.tick();
  const [, second] = await userMessages(route!.session_id);
  expect(second!.text).toBe("and now?");
  expect(second!.model_context).toContain("since Opengeni was last mentioned");
  expect(second!.model_context).toContain("Later message");
  expect(second!.model_context).toContain("Actually it changed to EGRET");
  expect(second!.model_context).not.toContain("HERON");

  // Each thread keeps its newest messages only; disconnecting removes them all.
  for (let index = 0; index < TEAMS_CONTEXT_MESSAGES_PER_THREAD + 5; index++)
    await recordTeamsContextMessage(client.db, f.i, {
      conversationId: "19:channel",
      threadId: "busy",
      messageId: `busy-${index}`,
      actorId: f.actor,
      actorName: null,
      text: `busy ${index}`,
      hasAttachments: false,
      mentioned: false,
      occurredAt: new Date(Date.UTC(2026, 10, 2, 14, 0, index)).toISOString(),
    });
  const busy = await listTeamsContextMessages(client.db, f.i, {
    conversationId: "19:channel",
    threadId: "busy",
    beforeMessageId: "none",
    notAfter: "2026-11-03T00:00:00.000Z",
    limit: 200,
  });
  expect(busy).toHaveLength(TEAMS_CONTEXT_MESSAGES_PER_THREAD);
  expect(busy[0]!.text).toBe(`busy ${TEAMS_CONTEXT_MESSAGES_PER_THREAD + 4}`);
  const roots = await listTeamsContextMessages(client.db, f.i, {
    conversationId: "19:channel",
    threadId: null,
    beforeMessageId: "none",
    notAfter: "2026-11-03T00:00:00.000Z",
    limit: 5,
    rootPostsOnly: true,
  });
  expect(roots.map((row) => row.text)).toEqual(["Root post: planning the launch"]);
  await disconnectTeamsBot(client.db, f.i);
  const [left] =
    await shared.admin`select count(*)::int as n from teams_bot_context_messages where workspace_id=${f.i.workspace_id}`;
  expect(left!.n).toBe(0);
});
test("recorded context follows edits, deletions, accepted mentions, retention and its workspace", async () => {
  const f = await fixture();
  const other = await fixture();
  const keep = (
    i: typeof f.i,
    conversationId: string,
    messageId: string,
    minute: number,
    text: string,
  ) =>
    recordTeamsContextMessage(client.db, i, {
      conversationId,
      threadId: null,
      messageId,
      actorId: f.actor,
      actorName: "Ada Lovelace",
      text,
      hasAttachments: false,
      mentioned: false,
      occurredAt: `2026-11-02T15:0${minute}:00.000Z`,
    });
  const read = (i: typeof f.i, conversationId = "19:group") =>
    listTeamsContextMessages(client.db, i, {
      conversationId,
      threadId: null,
      beforeMessageId: "none",
      notAfter: "2026-11-03T00:00:00.000Z",
      limit: 50,
    });
  await keep(f.i, "19:group", "g1", 1, "The password is hunter2");
  await keep(f.i, "19:group", "g2", 2, "Lunch at noon");
  await keep(f.i, "19:group", "g3", 3, "@Opengeni summarize");
  await keep(f.i, "19:elsewhere", "e1", 1, "Another chat");
  // Another workspace's installation never sees these rows.
  await keep(other.i, "19:group", "o1", 1, "Other workspace");
  expect((await read(other.i)).map((row) => row.text)).toEqual(["Other workspace"]);

  // Teams edits replace the text; deletions (and edits to nothing) remove it.
  await reviseTeamsContextMessage(client.db, f.i, {
    conversationId: "19:group",
    messageId: "g2",
    edit: { text: "Lunch at one", hasAttachments: false },
  });
  await reviseTeamsContextMessage(client.db, f.i, {
    conversationId: "19:group",
    messageId: "g1",
    edit: null,
  });
  // A revision of a message never recorded records nothing.
  await reviseTeamsContextMessage(client.db, f.i, {
    conversationId: "19:group",
    messageId: "unknown",
    edit: { text: "new", hasAttachments: false },
  });
  // Only an accepted mention is marked.
  await markTeamsContextMentionAccepted(client.db, f.i, {
    conversationId: "19:group",
    messageId: "g3",
  });
  expect((await read(f.i)).map((row) => [row.messageId, row.text, row.mentioned])).toEqual([
    ["g3", "@Opengeni summarize", true],
    ["g2", "Lunch at one", false],
  ]);

  // Past retention, a row is no longer offered even before it is pruned.
  await shared.admin`update teams_bot_context_messages set created_at=now()-interval '8 days' where workspace_id=${f.i.workspace_id} and message_id='g2'`;
  expect((await read(f.i)).map((row) => row.messageId)).toEqual(["g3"]);

  // Clearing one conversation leaves the others.
  await clearTeamsContextConversation(client.db, f.i, "19:group");
  expect(await read(f.i)).toEqual([]);
  expect((await read(f.i, "19:elsewhere")).map((row) => row.text)).toEqual(["Another chat"]);

  // Clearing also sets the chat's join cutoff: a delayed delivery of a message
  // from before people were added never puts that history back, while a
  // message from after it is kept.
  await keep(f.i, "19:group", "delayed", 4, "Posted before the join");
  const afterJoin = new Date(Date.now() + 60_000).toISOString();
  await recordTeamsContextMessage(client.db, f.i, {
    conversationId: "19:group",
    threadId: null,
    messageId: "joined",
    actorId: f.actor,
    actorName: "Ada Lovelace",
    text: "Posted after the join",
    hasAttachments: false,
    mentioned: false,
    occurredAt: afterJoin,
  });
  // A row from before the cutoff that is somehow still there is never read.
  await shared.admin`insert into teams_bot_context_messages(account_id,workspace_id,tenant_id,conversation_id,thread_id,message_id,actor_id,text,occurred_at)
    values(${f.i.account_id},${f.i.workspace_id},${f.i.tenant_id},'19:group','','stale',${f.actor},'Stale pre-join row','2026-11-02T15:05:00Z')`;
  const readAll = () =>
    listTeamsContextMessages(client.db, f.i, {
      conversationId: "19:group",
      threadId: null,
      beforeMessageId: "none",
      notAfter: new Date(Date.now() + 3_600_000).toISOString(),
      limit: 50,
    });
  expect((await readAll()).map((row) => row.messageId)).toEqual(["joined"]);
  const [delayed] =
    await shared.admin`select count(*)::int as n from teams_bot_context_messages where workspace_id=${f.i.workspace_id} and message_id='delayed'`;
  expect(delayed!.n).toBe(0);
  // Adding people again only moves the cutoff forward.
  await clearTeamsContextConversation(client.db, f.i, "19:group");
  const [cutoffs] =
    await shared.admin`select count(*)::int as n from teams_bot_context_cutoffs where workspace_id=${f.i.workspace_id} and conversation_id='19:group'`;
  expect(cutoffs!.n).toBe(1);

  // A write from before a disconnect never lands after it.
  await disconnectTeamsBot(client.db, f.i);
  await keep(f.i, "19:group", "late", 4, "Racing the disconnect");
  const [left] =
    await shared.admin`select count(*)::int as n from teams_bot_context_messages where workspace_id=${f.i.workspace_id}`;
  expect(left!.n).toBe(0);
  const [cutoffsLeft] =
    await shared.admin`select count(*)::int as n from teams_bot_context_cutoffs where workspace_id=${f.i.workspace_id}`;
  expect(cutoffsLeft!.n).toBe(0);
});
test("throttling retries durable output while an ambiguous delivery is never repeated", async () => {
  const f = await fixture();
  await enqueueTeamsMessage(client.db, f.i, f.input);
  await f.tick(async () => {
    throw { response: { status: 429, headers: { "retry-after": "1" } } };
  });
  await shared.admin`update teams_bot_outbox set retry_at=now() where route_id=${f.input.routeId}`;
  await f.tick();
  expect(f.messages).toHaveLength(1);
  const [route] =
    await shared.admin`select session_id from teams_bot_routes where route_id=${f.input.routeId}`;
  await appendSessionEvents(client.db, f.i.workspace_id, route!.session_id, [
    { type: "turn.completed", payload: { output: "Unknown transport" } },
  ]);
  await f.tick(async () => {
    throw new Error("socket closed after request");
  });
  await f.tick();
  expect(f.messages).toHaveLength(1);
  const [out] =
    await shared.admin`select state from teams_bot_outbox where route_id=${f.input.routeId} and source_sequence>0`;
  expect(out!.state).toBe("unknown");
});
test("revoking linked owner prevents queued channel output", async () => {
  const f = await fixture();
  await enqueueTeamsMessage(client.db, f.i, f.input);
  await f.tick();
  const [route] =
    await shared.admin`select session_id from teams_bot_routes where route_id=${f.input.routeId}`;
  await appendSessionEvents(client.db, f.i.workspace_id, route!.session_id, [
    { type: "turn.completed", payload: { output: "Must not be sent" } },
  ]);
  await removeTeamsLink(client.db, f.i, f.subject);
  await f.tick();
  expect(f.messages).toHaveLength(1);
});

test("channel destination rejects output after its native session becomes Only me", async () => {
  const f = await fixture();
  await enqueueTeamsMessage(client.db, f.i, f.input);
  await f.tick();
  const [route] =
    await shared.admin`select session_id from teams_bot_routes where route_id=${f.input.routeId}`;
  await shared.admin`insert into session_tenancy_activations(account_id,activation_version,inventory_digest,parity_digest,activated_by) values(${f.i.account_id},1,${"1".repeat(64)},${"2".repeat(64)},'test')`;
  await shared.admin`insert into organization_private_session_settings(account_id,enabled,version,updated_by_membership_id) values(${f.i.account_id},true,1,null) on conflict(account_id) do update set enabled=true`;
  await updateManagedHumanSessionVisibility(
    f.deps,
    {
      grant: { ...f.grant, principalKind: "human_session" },
      accountGrant: f.access.accountGrants[0] ?? null,
      authenticatedSubjectId: f.subject,
      contextIntegrity: true,
      canonicalManagedHumanSession: true,
    },
    f.i.workspace_id,
    route!.session_id,
    {
      visibility: "private",
      expectedAuthorityEpoch: 1,
      idempotencyKey: "private-change",
      stopActiveWork: true,
    },
  );
  await appendSessionEvents(client.db, f.i.workspace_id, route!.session_id, [
    { type: "turn.completed", payload: { output: "Private answer" } },
  ]);
  await f.tick();
  expect(f.messages).toHaveLength(1);
});

test("verified personal route creates owner-only native session and cannot deliver after unlink", async () => {
  const f = await fixture();
  await shared.admin`insert into session_tenancy_activations(account_id,activation_version,inventory_digest,parity_digest,activated_by) values(${f.i.account_id},1,${"1".repeat(64)},${"2".repeat(64)},'test')`;
  await shared.admin`insert into organization_private_session_settings(account_id,enabled,version,updated_by_membership_id) values(${f.i.account_id},true,1,null) on conflict(account_id) do update set enabled=true`;
  await enqueueTeamsMessage(client.db, f.i, { ...f.input, personal: true, threadId: null });
  await f.tick();
  const [session] =
    await shared.admin`select s.id,s.visibility,s.owner_subject_id from sessions s join teams_bot_routes r on r.session_id=s.id where r.route_id=${f.input.routeId}`;
  expect(session!.visibility).toBe("user_private");
  expect(session!.owner_subject_id).toBe(f.subject);
  expect(f.messages).toHaveLength(1);
  await appendSessionEvents(client.db, f.i.workspace_id, session!.id, [
    { type: "turn.completed", payload: { output: "Personal answer" } },
  ]);
  await f.tick();
  expect(f.messages.at(-1)).toBe("Personal answer");
  await removeTeamsLink(client.db, f.i, f.subject);
  await appendSessionEvents(client.db, f.i.workspace_id, session!.id, [
    { type: "turn.completed", payload: { output: "Revoked answer" } },
  ]);
  await f.tick();
  expect(f.messages).toHaveLength(2);
});

test("personal admission refusal delivers durable generic guidance without creating a shared session", async () => {
  const f = await fixture();
  await shared.admin`insert into organization_private_session_settings(account_id,enabled,version,updated_by_membership_id) values(${f.i.account_id},false,1,null) on conflict(account_id) do update set enabled=false`;
  await enqueueTeamsMessage(client.db, f.i, { ...f.input, personal: true, threadId: null });
  await f.tick();
  expect(f.messages).toHaveLength(1);
  expect(f.messages[0]).toContain("could not start");
  expect(f.messages[0]).toContain(`/workspaces/${f.i.workspace_id}/plugins`);
  const [count] =
    await shared.admin`select count(*)::int as n from sessions where workspace_id=${f.i.workspace_id}`;
  expect(count!.n).toBe(0);
  await f.tick();
  expect(f.messages).toHaveLength(1);
});

test("followup commit refuses identity revoked after proof preflight", async () => {
  const f = await fixture();
  await enqueueTeamsMessage(client.db, f.i, f.input);
  await f.tick();
  const second = {
    ...f.input,
    eventId: crypto.randomUUID(),
    payload: { text: "Second message must not enter native history" },
  };
  await enqueueTeamsMessage(client.db, f.i, second);
  let revoked = false;
  f.deps.sessionAuthorization = {
    authorizeSession: async () => {
      if (!revoked) {
        revoked = true;
        await removeTeamsLink(client.db, f.i, f.subject);
      }
      return { allowed: true, relatedSessionAccess: "root" };
    },
    resolveListScope: async () => ({ kind: "all" }),
  };
  await f.tick();
  expect(revoked).toBe(true);
  const [row] =
    await shared.admin`select state from teams_bot_inbox where event_id=${second.eventId}`;
  expect(row!.state).toBe("failed");
  const [count] =
    await shared.admin`select count(*)::int as n from session_turns where workspace_id=${f.i.workspace_id}`;
  expect(count!.n).toBe(1);
});

test("thousands of idle routes do not delay completion and irrelevant events do not wake routes", async () => {
  const f = await fixture();
  await enqueueTeamsMessage(client.db, f.i, f.input);
  await f.tick();
  const [route] =
    await shared.admin`select session_id,delivered_sequence from teams_bot_routes where route_id=${f.input.routeId}`;
  await shared.admin`insert into teams_bot_routes(account_id,workspace_id,tenant_id,route_id,generation,actor_id,subject_id,personal,channel_id,conversation_id,service_url,bot_id)
 select ${f.i.account_id},${f.i.workspace_id},${f.i.tenant_id},'idle:'||gen_random_uuid()::text,${f.i.generation},${f.actor},${f.subject},false,'19:channel','19:idle','https://smba.trafficmanager.net/emea/','28:bot' from generate_series(1,5000)`;
  await appendSessionEvents(client.db, f.i.workspace_id, route!.session_id, [
    { type: "session.title_set", payload: { title: "Irrelevant title update" } },
  ]);
  await shared.admin`update teams_bot_routes set lease_until=null where route_id=${f.input.routeId}`;
  expect(await claimTeamsRoute(client.db, f.i)).toBeNull();
  await appendSessionEvents(client.db, f.i.workspace_id, route!.session_id, [
    { type: "turn.completed", payload: { output: "Prompt completion after idle history" } },
  ]);
  await f.tick();
  expect(f.messages.at(-1)).toBe("Prompt completion after idle history");
  await shared.admin`update teams_bot_routes set lease_until=null where route_id=${f.input.routeId}`;
  expect(await claimTeamsRoute(client.db, f.i)).toBeNull();
  expect(
    (
      await shared.admin`select has_function_privilege(current_user,'opengeni_private.wake_teams_route_for_session_event()','execute') as allowed`
    )[0]!.allowed,
  ).toBe(true);
  const privilege = await client.db.execute(
    sql`select has_function_privilege(current_user,'opengeni_private.wake_teams_route_for_session_event()','execute') as allowed`,
  );
  expect(Array.from(privilege as unknown as { allowed: boolean }[])[0]!.allowed).toBe(false);
});

test("DM changed to workspace-shared refuses subsequent private input", async () => {
  const f = await fixture();
  await shared.admin`insert into session_tenancy_activations(account_id,activation_version,inventory_digest,parity_digest,activated_by) values(${f.i.account_id},1,${"1".repeat(64)},${"2".repeat(64)},'test')`;
  await shared.admin`insert into organization_private_session_settings(account_id,enabled,version,updated_by_membership_id) values(${f.i.account_id},true,1,null) on conflict(account_id) do update set enabled=true`;
  await enqueueTeamsMessage(client.db, f.i, { ...f.input, personal: true, threadId: null });
  await f.tick();
  const [route] =
    await shared.admin`select session_id from teams_bot_routes where route_id=${f.input.routeId}`;
  await updateManagedHumanSessionVisibility(
    f.deps,
    {
      grant: { ...f.grant, principalKind: "human_session" },
      accountGrant: f.access.accountGrants[0] ?? null,
      authenticatedSubjectId: f.subject,
      contextIntegrity: true,
      canonicalManagedHumanSession: true,
    },
    f.i.workspace_id,
    route!.session_id,
    {
      visibility: "workspace",
      expectedAuthorityEpoch: 1,
      idempotencyKey: "dm-shared-change",
      stopActiveWork: true,
    },
  );
  const followup = {
    ...f.input,
    personal: true,
    threadId: null,
    eventId: crypto.randomUUID(),
    payload: { text: "Never put this DM in a shared conversation" },
  };
  await enqueueTeamsMessage(client.db, f.i, followup);
  await f.tick();
  const [inbox] =
    await shared.admin`select state from teams_bot_inbox where event_id=${followup.eventId}`;
  expect(inbox!.state).toBe("failed");
  const [turns] =
    await shared.admin`select count(*)::int as n from session_turns where workspace_id=${f.i.workspace_id}`;
  expect(turns!.n).toBe(1);
});

test("each refused input gets one actionable notice while provider replay stays deduplicated", async () => {
  const f = await fixture();
  await shared.admin`insert into organization_private_session_settings(account_id,enabled,version,updated_by_membership_id) values(${f.i.account_id},false,1,null) on conflict(account_id) do update set enabled=false`;
  const first = { ...f.input, personal: true, threadId: null };
  await enqueueTeamsMessage(client.db, f.i, first);
  await f.tick();
  const second = { ...first, eventId: crypto.randomUUID() };
  await enqueueTeamsMessage(client.db, f.i, second);
  await f.tick();
  expect(f.messages).toHaveLength(2);
  await enqueueTeamsMessage(client.db, f.i, second);
  await f.tick();
  expect(f.messages).toHaveLength(2);
  expect(f.messages.every((text) => text.includes(`/workspaces/${f.i.workspace_id}/plugins`))).toBe(
    true,
  );
});

test("an immediate native completion wakes the reserved route before inbox binding", async () => {
  const f = await fixture();
  await enqueueTeamsMessage(client.db, f.i, f.input);
  let immediate = false;
  const publish = f.deps.bus.publish.bind(f.deps.bus);
  f.deps.bus.publish = async (events) => {
    if (!immediate && events.length) {
      immediate = true;
      const [route] =
        await shared.admin`select session_id,session_bound from teams_bot_routes where route_id=${f.input.routeId}`;
      expect(route!.session_bound).toBe(false);
      await appendSessionEvents(client.db, f.i.workspace_id, route!.session_id, [
        { type: "turn.completed", payload: { output: "Immediate native answer" } },
      ]);
    }
    await publish(events);
  };
  await f.tick();
  expect(immediate).toBe(true);
  await f.tick();
  expect(f.messages.at(-1)).toBe("Immediate native answer");
});

test("events for sessions without a Teams route create no wake or ghost route", async () => {
  const f = await fixture();
  await enqueueTeamsMessage(client.db, f.i, f.input);
  await f.tick();
  const [route] =
    await shared.admin`select session_id from teams_bot_routes where route_id=${f.input.routeId}`;
  await shared.admin`delete from teams_bot_routes where route_id=${f.input.routeId}`;
  await appendSessionEvents(client.db, f.i.workspace_id, route!.session_id, [
    { type: "turn.completed", payload: { output: "No Teams route" } },
  ]);
  expect(await claimTeamsRoute(client.db, f.i)).toBeNull();
  expect(
    (
      await shared.admin`select count(*)::int as n from teams_bot_routes where workspace_id=${f.i.workspace_id}`
    )[0]!.n,
  ).toBe(0);
});

test("composed application routes Connector ingress without cookie or API-contract header, still rejecting unsigned requests", async () => {
  const f = await fixture();
  f.deps.settings.authRequired = true;
  f.deps.settings.accessKey = "test-only-required-api-key";
  f.deps.settings.environment = "development";
  const app = createApp(f.deps);
  const protectedRead = await app.request(`/v1/workspaces/${f.i.workspace_id}/sessions`);
  expect(protectedRead.status).toBe(401);
  expect(await protectedRead.json()).toEqual({ error: "unauthorized" });
  const protectedMutation = await app.request(`/v1/workspaces/${f.i.workspace_id}/sessions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-opengeni-access-key": "test-only-required-api-key",
    },
    body: "{}",
  });
  expect(protectedMutation.status).toBe(409);
  expect(((await protectedMutation.json()) as { code: string }).code).toBe("API_CONTRACT_CHANGED");
  const response = await app.request("/v1/integrations/teams/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: "Invalid Connector token" });
  const token = `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(JSON.stringify({ iss: "https://api.botframework.com", aud: f.deps.settings.teamsBotClientId, exp: Math.floor(Date.now() / 1000) + 300 })).toString("base64url")}.`;
  const unsignedConnector = await app.request("/v1/integrations/teams/messages", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      type: "message",
      channelId: "msteams",
      serviceUrl: "https://smba.trafficmanager.net/emea/",
    }),
  });
  expect(unsignedConnector.status).toBe(401);
  f.deps.settings.teamsBotAllowedTenantIds = [];
  const disabled = await app.request("/v1/integrations/teams/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  expect(disabled.status).toBe(404);
  expect(await disabled.json()).toEqual({ error: "Teams is not enabled" });
});

test("unlink then relink as another human creates a fresh DM route without moving private history", async () => {
  const f = await fixture();
  const identity = { personal: true, routeIdentity: "same-provider-dm" };
  const original = {
    ...f.input,
    personal: true,
    threadId: null,
    routeId: teamsRouteId(identity, f.i.generation, f.subject),
  };
  await enqueueTeamsMessage(client.db, f.i, original);
  await f.tick();
  const [old] =
    await shared.admin`select session_id from teams_bot_routes where route_id=${original.routeId}`;
  const subject = `user:teams-new:${crypto.randomUUID()}`;
  const personal = crypto.randomUUID();
  await shared.admin`insert into workspaces(id,account_id,name) values(${personal},${f.i.account_id},'Personal')`;
  await shared.admin`insert into organization_memberships(account_id,subject_id,role,status,personal_workspace_id) values(${f.i.account_id},${subject},'member','active',${personal})`;
  await shared.admin`insert into workspace_memberships(account_id,workspace_id,subject_id,role,permissions) select account_id,workspace_id,${subject},role,permissions from workspace_memberships where workspace_id=${f.i.workspace_id} and subject_id=${f.subject}`;
  await removeTeamsLink(client.db, f.i, f.subject);
  await linkTeamsActor(client.db, f.i, {
    actorId: f.actor,
    subjectId: subject,
    nonce: crypto.randomUUID(),
  });
  const replacement = {
    ...original,
    subjectId: subject,
    eventId: crypto.randomUUID(),
    routeId: teamsRouteId(identity, f.i.generation, subject),
  };
  expect(replacement.routeId).not.toBe(original.routeId);
  expect(replacement.routeId.length).toBe(64);
  await enqueueTeamsMessage(client.db, f.i, replacement);
  await f.tick();
  const [current] =
    await shared.admin`select s.id,s.owner_subject_id from sessions s join teams_bot_routes r on r.session_id=s.id where r.route_id=${replacement.routeId}`;
  expect(current!.id).not.toBe(old!.session_id);
  expect(current!.owner_subject_id).toBe(subject);
  expect(
    (await shared.admin`select owner_subject_id from sessions where id=${old!.session_id}`)[0]!
      .owner_subject_id,
  ).toBe(f.subject);
});

test("unlink settles pending input so same-human relink never revives it", async () => {
  const f = await fixture();
  await enqueueTeamsMessage(client.db, f.i, f.input);
  await removeTeamsLink(client.db, f.i, f.subject);
  await linkTeamsActor(client.db, f.i, {
    actorId: f.actor,
    subjectId: f.subject,
    nonce: crypto.randomUUID(),
  });
  await f.tick();
  expect(f.messages).toHaveLength(0);
  expect(
    (await shared.admin`select state from teams_bot_inbox where event_id=${f.input.eventId}`)[0]!
      .state,
  ).toBe("failed");
  expect(
    (
      await shared.admin`select count(*)::int as n from sessions where workspace_id=${f.i.workspace_id}`
    )[0]!.n,
  ).toBe(0);
});

test("group sessions keep DM history separate and stop output when any participant changes", async () => {
  const f = await fixture();
  await shared.admin`insert into organization_private_session_settings(account_id,enabled,version,updated_by_membership_id) values(${f.i.account_id},true,1,null) on conflict(account_id) do update set enabled=true`;
  await enqueueTeamsMessage(client.db, f.i, {
    ...f.input,
    personal: true,
    channelId: null,
    threadId: null,
    payload: { text: "Private DM marker must never join group" },
  });
  await f.tick();
  await f.tick(); // Drain the DM's creation wake before exercising group delivery.
  const [dm] =
    await shared.admin`select session_id from teams_bot_routes where route_id=${f.input.routeId}`;

  const otherActor = crypto.randomUUID(),
    otherSubject = `user:teams:${crypto.randomUUID()}`,
    personal = crypto.randomUUID();
  await shared.admin`insert into workspaces(id,account_id,name) values(${personal},${f.i.account_id},'Personal')`;
  await shared.admin`insert into organization_memberships(account_id,subject_id,role,status,personal_workspace_id) values(${f.i.account_id},${otherSubject},'member','active',${personal})`;
  await shared.admin`insert into workspace_memberships(account_id,workspace_id,subject_id,role,permissions) select account_id,workspace_id,${otherSubject},role,permissions from workspace_memberships where workspace_id=${f.i.workspace_id} and subject_id=${f.subject}`;
  await linkTeamsActor(client.db, f.i, {
    actorId: otherActor,
    subjectId: otherSubject,
    nonce: crypto.randomUUID(),
  });
  await upsertCapabilityCatalogItem(client.db, {
    accountId: f.i.account_id,
    workspaceId: f.i.workspace_id,
    id: "example-mail",
    kind: "mcp",
    source: "manual",
    name: "Example Mail",
    description: "Synthetic personal connector",
    category: "integrations",
    tags: ["fixture"],
    endpointUrl: "https://mail.example.test/mcp",
    metadata: { mcpServerId: "example-mail" },
  });
  await enableCapabilityInstallation(client.db, {
    accountId: f.i.account_id,
    workspaceId: f.i.workspace_id,
    capabilityId: "example-mail",
    kind: "mcp",
    config: {
      connectionRef: {
        providerDomain: "mail.example.test",
        kind: "oauth2",
        subjectScope: "subject",
      },
    },
    metadata: { mcpConnectivity: { status: "ok" } },
  });
  const connection = async (subjectId: string) =>
    createConnection(client.db, {
      accountId: f.i.account_id,
      workspaceId: f.i.workspace_id,
      subjectId,
      providerDomain: "mail.example.test",
      kind: "oauth2",
      credentialEncrypted: "fixture-ciphertext",
      createdBySubjectId: subjectId,
    });
  const creatorConnection = await connection(f.subject),
    senderConnection = await connection(otherSubject);
  const audience = [
    { actorId: f.actor, subjectId: f.subject },
    { actorId: otherActor, subjectId: otherSubject },
  ].sort((a, b) => a.actorId.localeCompare(b.actorId));
  const group = "19:approved-group";
  f.deps.settings.teamsBotAllowedGroupChatIds = [`${f.i.tenant_id}:${group}`];
  let roster: unknown[] = [
    { id: "29:one", aadObjectId: f.actor, tenantId: f.i.tenant_id },
    { id: "29:two", aadObjectId: otherActor, tenantId: f.i.tenant_id },
  ];
  const messages: string[] = [];
  const send = async (_m: unknown, text: string) => {
    messages.push(text);
    return `sent-${messages.length}`;
  };
  const tick = async () => {
    await shared.admin`update teams_bot_routes set lease_until=null where tenant_id=${f.i.tenant_id}`;
    await drainTeamsBotOnce(f.deps, send, async () => roster);
  };
  const input = {
    ...f.input,
    channelId: null,
    conversationId: group,
    threadId: null,
    eventId: crypto.randomUUID(),
    groupAudience: audience,
    groupRevision: f.i.group_revision,
  };
  await enqueueTeamsMessage(client.db, f.i, input);
  await tick();
  const [route] =
    await shared.admin`select * from teams_bot_routes where tenant_id=${f.i.tenant_id} and group_active`;
  expect(route!.session_bound).toBe(true);
  expect(route!.session_id).not.toBe(dm!.session_id);
  expect(messages).toHaveLength(1);
  const [session] =
    await shared.admin`select visibility from sessions where id=${route!.session_id}`;
  expect(session!.visibility).toBe("workspace_shared");
  const [initialTurn] =
    await shared.admin`select initiating_human_subject_id,initiator_subject_id,personal_connection_delegations,mcp_account_bindings from session_turns where session_id=${route!.session_id} order by position limit 1`;
  expect(initialTurn!.initiating_human_subject_id).toBe(f.subject);
  const installation = (await getTeamsInstallation(client.db, f.i.tenant_id))!;
  await enqueueTeamsMessage(client.db, installation, {
    ...input,
    groupRevision: installation.group_revision,
    eventId: crypto.randomUUID(),
    actorId: otherActor,
    subjectId: otherSubject,
    payload: { text: "Second human synthetic request" },
  });
  await tick();
  const [followupTurn] =
    await shared.admin`select initiating_human_subject_id,initiator_subject_id,personal_connection_delegations,mcp_account_bindings from session_turns where session_id=${route!.session_id} and prompt='Second human synthetic request'`;
  expect(followupTurn!.initiating_human_subject_id).toBe(otherSubject);
  expect(followupTurn!.initiator_subject_id).toBe(otherSubject);
  expect(JSON.stringify(followupTurn)).not.toContain(creatorConnection.id);
  expect(followupTurn!.mcp_account_bindings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        canonicalServerId: "example-mail",
        connectionId: senderConnection.id,
      }),
    ]),
  );
  expect(initialTurn!.mcp_account_bindings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        canonicalServerId: "example-mail",
        connectionId: creatorConnection.id,
      }),
    ]),
  );

  await appendSessionEvents(client.db, f.i.workspace_id, route!.session_id, [
    { type: "turn.completed", payload: { output: "Group-only reply" } },
  ]);
  await tick();
  expect(messages).toEqual([messages[0]!, "Group-only reply"]);
  await appendSessionEvents(client.db, f.i.workspace_id, route!.session_id, [
    {
      type: "turn.completed",
      payload: { output: ".".repeat(45000) + "Old audience private marker" },
    },
  ]);
  await tick(); // First part is sent to the still-authorized roster.
  expect(messages).toHaveLength(3);
  roster = [
    ...roster,
    { id: "29:unlinked", aadObjectId: crypto.randomUUID(), tenantId: f.i.tenant_id },
  ];
  await tick();
  expect(messages).toHaveLength(3);
  expect(
    (
      await shared.admin`select group_active from teams_bot_routes where route_id=${route!.route_id}`
    )[0]!.group_active,
  ).toBe(false);
  // Returning to the original roster cannot revive its previous native history.
  roster = roster.slice(0, 2);
  const current = (await getTeamsInstallation(client.db, f.i.tenant_id))!;
  await enqueueTeamsMessage(client.db, current, {
    ...input,
    eventId: crypto.randomUUID(),
    groupRevision: current.group_revision,
  });
  await tick();
  const [next] =
    await shared.admin`select * from teams_bot_routes where tenant_id=${f.i.tenant_id} and group_active`;
  expect(next!.session_id).not.toBe(route!.session_id);
  await appendSessionEvents(client.db, f.i.workspace_id, route!.session_id, [
    { type: "turn.completed", payload: { output: "Retired route late completion" } },
  ]);
  await tick();
  expect(
    (
      await shared.admin`select group_active from teams_bot_routes where route_id=${next!.route_id}`
    )[0]!.group_active,
  ).toBe(true);
  expect(messages.join(" ")).not.toContain("Retired route late completion");

  expect(messages.join(" ")).not.toContain("Old audience private marker");
  // An audience member who never sent a message still owns a revocation fence.
  await removeTeamsLink(client.db, current, otherSubject);
  await linkTeamsActor(client.db, current, {
    actorId: otherActor,
    subjectId: otherSubject,
    nonce: crypto.randomUUID(),
  });
  expect(
    (
      await shared.admin`select group_active from teams_bot_routes where route_id=${next!.route_id}`
    )[0]!.group_active,
  ).toBe(false);
});
