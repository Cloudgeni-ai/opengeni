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
} from "@opengeni/db";
import { updateManagedHumanSessionVisibility, type ApiRouteDeps } from "@opengeni/core";
import { teamsRouteId } from "../src/integrations/teams-protocol";
import { createApp } from "../src/app";
import { drainTeamsBotOnce } from "../src/integrations/teams-bot";
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
  const send = async (_m: unknown, text: string) => {
    messages.push(text);
    return `sent-${messages.length}`;
  };
  const tick = async (sender = send) => {
    await shared.admin`update teams_bot_routes set lease_until=null where route_id=${routeId}`;
    await drainTeamsBotOnce(deps, sender);
  };
  return { i, actor, subject, deps, input, messages, tick, grant, access };
}
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
  const app = createApp(f.deps);
  const response = await app.request("/v1/integrations/teams/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: "Invalid Connector token" });
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
