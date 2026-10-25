import { sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  createDb,
  withRlsContext,
  type DbClient,
  installTeamsBot,
  enqueueTeamsMessage,
  claimTeamsRoute,
  requireTeamsPrivateSessionProof,
  requireTeamsConversationProof,
  removeTeamsLink,
  linkTeamsActor,
  disconnectTeamsBot,
} from "../src";

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
beforeAll(async () => {
  shared = await acquireSharedTestDatabase("teams-private-session");
  if (!shared) throw new Error("Real PostgreSQL required");
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
});

async function fixture(personal = true) {
  const accountId = crypto.randomUUID(),
    workspaceId = crypto.randomUUID(),
    tenantId = crypto.randomUUID();
  const actorId = crypto.randomUUID(),
    subjectId = `user:${crypto.randomUUID()}`;
  await shared!
    .admin`insert into managed_accounts(id,name) values(${accountId},'Teams proof fixture')`;
  await shared!
    .admin`insert into workspaces(id,account_id,name) values(${workspaceId},${accountId},'Teams proof fixture')`;
  const i = await installTeamsBot(client!.db, {
    accountId,
    workspaceId,
    tenantId,
    actorId,
    subjectId,
    nonce: crypto.randomUUID(),
  });
  const routeId = `route:${crypto.randomUUID()}`,
    eventId = `event:${crypto.randomUUID()}`;
  await enqueueTeamsMessage(client!.db, i, {
    routeId,
    actorId,
    subjectId,
    personal,
    conversationId: "19:test",
    threadId: null,
    serviceUrl: "https://smba.trafficmanager.net/emea/",
    botId: "28:test",
    eventId,
    payload: { text: "accepted exact text" },
  });
  const route = (await claimTeamsRoute(client!.db, i))!;
  return {
    i,
    actorId,
    input: {
      accountId,
      workspaceId,
      subjectId,
      sessionId: route.session_id,
      initialMessage: "accepted exact text",
      proof: {
        routeId,
        eventId,
        leaseToken: route.lease_token!,
        installationGeneration: i.generation,
      },
    },
  };
}
test("private creation proof binds exact session, message, identity, lease, workspace and generation", async () => {
  const { i, input } = await fixture();
  expect(await requireTeamsPrivateSessionProof(client!.db, input)).toBe(i.tenant_id);
  for (const modified of [
    { ...input, subjectId: "user:other" },
    { ...input, sessionId: crypto.randomUUID() },
    { ...input, workspaceId: crypto.randomUUID() },
    { ...input, accountId: crypto.randomUUID() },
    { ...input, initialMessage: "injected" },
    { ...input, proof: { ...input.proof, eventId: "other" } },
    { ...input, proof: { ...input.proof, leaseToken: crypto.randomUUID() } },
    { ...input, proof: { ...input.proof, installationGeneration: crypto.randomUUID() } },
  ])
    await expect(requireTeamsPrivateSessionProof(client!.db, modified)).rejects.toThrow();
  await shared!
    .admin`update teams_bot_routes set lease_until=now()-interval '1 second' where route_id=${input.proof.routeId}`;
  await expect(requireTeamsPrivateSessionProof(client!.db, input)).rejects.toThrow();
});
test("channel events cannot authorize private creation", async () => {
  const { input } = await fixture(false);
  await expect(requireTeamsPrivateSessionProof(client!.db, input)).rejects.toThrow();
});
test("unlink/relink and installation rotation revoke old pending proof", async () => {
  const { i, input, actorId } = await fixture();
  await removeTeamsLink(client!.db, i, input.subjectId);
  await linkTeamsActor(client!.db, i, {
    actorId,
    subjectId: "user:replacement",
    nonce: crypto.randomUUID(),
  });
  await expect(requireTeamsPrivateSessionProof(client!.db, input)).rejects.toThrow();
  await expect(
    requireTeamsPrivateSessionProof(client!.db, { ...input, subjectId: "user:replacement" }),
  ).rejects.toThrow();
  const second = await fixture();
  await disconnectTeamsBot(client!.db, second.i);
  await expect(requireTeamsPrivateSessionProof(client!.db, second.input)).rejects.toThrow();
});
test("settled inbox is not fresh private creation authority", async () => {
  const { input } = await fixture();
  await shared!
    .admin`update teams_bot_inbox set state='accepted' where event_id=${input.proof.eventId}`;
  await expect(requireTeamsPrivateSessionProof(client!.db, input)).rejects.toThrow();
});

test("shared route proof preserves each accepted channel sender independently", async () => {
  const { i, input } = await fixture(false);
  expect(
    (await requireTeamsConversationProof(client!.db, { ...input, personal: false })).tenantId,
  ).toBe(i.tenant_id);
  const secondActor = crypto.randomUUID(),
    secondSubject = "user:channel-second";
  await linkTeamsActor(client!.db, i, {
    actorId: secondActor,
    subjectId: secondSubject,
    nonce: crypto.randomUUID(),
  });
  await enqueueTeamsMessage(client!.db, i, {
    routeId: input.proof.routeId,
    actorId: secondActor,
    subjectId: secondSubject,
    personal: false,
    conversationId: "19:test",
    threadId: null,
    serviceUrl: "https://smba.trafficmanager.net/emea/",
    botId: "28:test",
    eventId: "second-channel-event",
    payload: { text: "second accepted" },
  });
  const second = {
    ...input,
    subjectId: secondSubject,
    initialMessage: "second accepted",
    proof: { ...input.proof, eventId: "second-channel-event" },
  };
  expect((await requireTeamsConversationProof(client!.db, second)).tenantId).toBe(i.tenant_id);
  await expect(
    requireTeamsConversationProof(client!.db, { ...second, subjectId: input.subjectId }),
  ).rejects.toThrow();
  await removeTeamsLink(client!.db, i, secondSubject);
  await expect(requireTeamsConversationProof(client!.db, second)).rejects.toThrow();
});

test("accepted proof keeps unlink fenced until native transaction commits", async () => {
  const { i, input } = await fixture();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ready!: () => void;
  const locked = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const admission = withRlsContext(client!.db, input, async (tx) => {
    await requireTeamsPrivateSessionProof(tx, input);
    ready();
    await held;
  });
  await locked;
  let unlinked = false;
  const unlink = removeTeamsLink(client!.db, i, input.subjectId).then(() => {
    unlinked = true;
  });
  try {
    await Bun.sleep(75);
    expect(unlinked).toBe(false);
  } finally {
    release();
  }
  await admission;
  await unlink;
  expect(unlinked).toBe(true);
  await expect(requireTeamsPrivateSessionProof(client!.db, input)).rejects.toThrow();
});

test("identity relinking respects the native workspace-before-provider lock order", async () => {
  const { i, input, actorId } = await fixture();
  let linked: Promise<void> | undefined;
  await withRlsContext(client!.db, input, async (tx) => {
    await tx.execute(sql`select id from workspaces where id=${input.workspaceId}::uuid for update`);
    linked = linkTeamsActor(client!.db, i, {
      actorId,
      subjectId: input.subjectId,
      nonce: crypto.randomUUID(),
    });
    await Bun.sleep(75);
    // A relinker must be waiting on the workspace, without holding installation.
    expect(await requireTeamsPrivateSessionProof(tx, input)).toBe(i.tenant_id);
  });
  await linked;
});
