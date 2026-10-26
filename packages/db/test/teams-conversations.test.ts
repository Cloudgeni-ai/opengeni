import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { sql } from "drizzle-orm";
import {
  createDb,
  type DbClient,
  installTeamsBot,
  getTeamsActor,
  linkTeamsActor,
  enqueueTeamsMessage,
  claimTeamsRoute,
  renewTeamsRoute,
  enqueueTeamsOutput,
  claimTeamsOutput,
  settleTeamsOutput,
  disconnectTeamsBot,
  getTeamsInstallation,
  teamsScoped,
} from "../src";
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
beforeAll(async () => {
  shared = await acquireSharedTestDatabase("teams-conversations");
  if (!shared) throw new Error("Real PostgreSQL required for Teams authority tests");
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
});
async function fixture() {
  const account = crypto.randomUUID(),
    workspace = crypto.randomUUID(),
    tenant = crypto.randomUUID(),
    actor = crypto.randomUUID(),
    subject = `user:${crypto.randomUUID()}`;
  await shared!.admin`insert into managed_accounts(id,name) values(${account},'Teams fixture')`;
  await shared!
    .admin`insert into workspaces(id,account_id,name) values(${workspace},${account},'Teams fixture')`;
  const i = await installTeamsBot(client!.db, {
    accountId: account,
    workspaceId: workspace,
    tenantId: tenant,
    actorId: actor,
    subjectId: subject,
    nonce: crypto.randomUUID(),
  });
  return { i, actor, subject };
}
test("binding proof is single use; another workspace cannot claim an existing tenant", async () => {
  const { i, actor, subject } = await fixture();
  const nonce = crypto.randomUUID();
  await linkTeamsActor(client!.db, i, { actorId: actor, subjectId: subject, nonce });
  await expect(
    linkTeamsActor(client!.db, i, { actorId: actor, subjectId: subject, nonce }),
  ).rejects.toThrow();
  await expect(
    linkTeamsActor(client!.db, i, {
      actorId: actor,
      subjectId: "user:attacker",
      nonce: crypto.randomUUID(),
    }),
  ).rejects.toThrow();
  expect(await getTeamsActor(client!.db, i, actor)).toBe(subject);
  const other = await fixture();
  await expect(
    installTeamsBot(client!.db, {
      accountId: other.i.account_id,
      workspaceId: other.i.workspace_id,
      tenantId: i.tenant_id,
      actorId: actor,
      subjectId: other.subject,
      nonce: crypto.randomUUID(),
    }),
  ).rejects.toThrow();
});
test("durable duplicate events, exclusive leases, numeric chunks, and no unknown-outcome resend", async () => {
  const { i, actor, subject } = await fixture();
  const routeId = `route:${crypto.randomUUID()}`;
  const input = {
    routeId,
    actorId: actor,
    subjectId: subject,
    personal: true,
    conversationId: "19:test",
    threadId: null,
    serviceUrl: "https://smba.trafficmanager.net/emea/",
    botId: "28:test",
    eventId: `event:${crypto.randomUUID()}`,
    payload: { text: "hello" },
  };
  await enqueueTeamsMessage(client!.db, i, input);
  await enqueueTeamsMessage(client!.db, i, input);
  const rows = await shared!
    .admin`select count(*)::int as count from teams_bot_inbox where route_id=${routeId}`;
  expect(rows[0]!.count).toBe(1);
  const route = await claimTeamsRoute(client!.db, i);
  expect(route).not.toBeNull();
  expect(await claimTeamsRoute(client!.db, i)).toBeNull();
  expect(await renewTeamsRoute(client!.db, i, route!)).toBe(true);
  await enqueueTeamsOutput(
    client!.db,
    i,
    route!,
    2,
    Array.from({ length: 12 }, (_, n) => `part ${n}`),
  );
  for (let n = 0; n < 12; n++) {
    const out = await claimTeamsOutput(client!.db, i, route!);
    expect(out?.payload.text).toBe(`part ${n}`);
    await settleTeamsOutput(client!.db, i, out!.operation_id, {
      state: "delivered",
      providerMessageId: `provider-${n}`,
    });
  }
  await enqueueTeamsOutput(client!.db, i, route!, 10, ["uncertain"]);
  const unknown = await claimTeamsOutput(client!.db, i, route!);
  expect(unknown?.payload.text).toBe("uncertain");
  expect(await claimTeamsOutput(client!.db, i, route!)).toBeNull();
  const [stored] = await shared!
    .admin`select state from teams_bot_outbox where operation_id=${unknown!.operation_id}`;
  expect(stored!.state).toBe("unknown");
  await disconnectTeamsBot(client!.db, i);
  expect((await getTeamsInstallation(client!.db, i.tenant_id))?.active).toBe(false);
  await expect(
    enqueueTeamsMessage(client!.db, i, { ...input, eventId: "after-revoke" }),
  ).rejects.toThrow();
});
test("RLS hides another workspace's content and composite FK rejects mismatched route", async () => {
  const first = await fixture(),
    second = await fixture();
  const routeId = `route:${crypto.randomUUID()}`;
  await enqueueTeamsMessage(client!.db, first.i, {
    routeId,
    actorId: first.actor,
    subjectId: first.subject,
    personal: true,
    conversationId: "19:test",
    threadId: null,
    serviceUrl: "https://smba.trafficmanager.net/emea/",
    botId: "28:test",
    eventId: "cross-scope-test",
    payload: { text: "private" },
  });
  await teamsScoped(client!.db, second.i, async (tx) => {
    const rows = await tx.execute(sql`select * from teams_bot_inbox where route_id=${routeId}`);
    expect(Array.from(rows as unknown as unknown[]).length).toBe(0);
  });
  await expect(
    teamsScoped(client!.db, second.i, async (tx) =>
      tx.execute(
        sql`insert into teams_bot_inbox(account_id,workspace_id,event_id,route_id,actor_id,payload) values(${second.i.account_id}::uuid,${second.i.workspace_id}::uuid,'wrong-scope',${routeId},${second.actor}::uuid,'{}'::jsonb)`,
      ),
    ),
  ).rejects.toThrow();
});

test("throttled first chunk blocks later chunks until its retry is due", async () => {
  const { i, actor, subject } = await fixture();
  const routeId = `route:${crypto.randomUUID()}`;
  await enqueueTeamsMessage(client!.db, i, {
    routeId,
    actorId: actor,
    subjectId: subject,
    personal: false,
    conversationId: "19:test",
    threadId: "root",
    serviceUrl: "https://smba.trafficmanager.net/emea/",
    botId: "28:bot",
    eventId: crypto.randomUUID(),
    payload: { text: "hello" },
  });
  const route = (await claimTeamsRoute(client!.db, i))!;
  await enqueueTeamsOutput(client!.db, i, route, 2, ["first", "second"]);
  const first = (await claimTeamsOutput(client!.db, i, route))!;
  await settleTeamsOutput(client!.db, i, first.operation_id, { state: "pending", retryMs: 60_000 });
  expect(await claimTeamsOutput(client!.db, i, route)).toBeNull();
  await shared!
    .admin`update teams_bot_outbox set retry_at=now() where operation_id=${first.operation_id}`;
  expect((await claimTeamsOutput(client!.db, i, route))?.payload.text).toBe("first");
});
