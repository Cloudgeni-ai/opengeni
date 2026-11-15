import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  getSession,
  listSessions,
  updateSessionProfileWithEvent,
  type DbClient,
} from "../src/index";

// Bots (migration 1008): a chat's description and avatar. Bot templates are
// agents now (docs/agents.md); agents-postgres.test.ts covers them.

let shared: SharedTestDatabase | null = null;
let client: DbClient;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("session-bots");
  if (!shared) return;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

async function workspace(label: string) {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `bots-account-${label}-${suffix}`,
    accountName: `Bots ${label}`,
    workspaceExternalSource: "test",
    workspaceExternalId: `bots-workspace-${label}-${suffix}`,
    workspaceName: `Bots ${label}`,
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  return { accountId: grant.accountId, workspaceId: grant.workspaceId! };
}

function newSession(place: { accountId: string; workspaceId: string }) {
  return createSession(client.db, {
    accountId: place.accountId,
    workspaceId: place.workspaceId,
    initialMessage: "Own the release checklist",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
}

describe("chat description and avatar", () => {
  test("a new chat has neither; writes change only what they name and append one event", async () => {
    if (!shared) return;
    const place = await workspace("profile");
    const session = await newSession(place);
    expect(session).toMatchObject({ description: null, avatar: null });

    const avatar = { kind: "emoji" as const, emoji: "🚀", hue: 210 };
    const first = await updateSessionProfileWithEvent(client.db, {
      ...place,
      sessionId: session.id,
      description: "Owns the release checklist",
      avatar,
      source: "agent",
    });
    expect(first).toMatchObject({
      updated: true,
      description: "Owns the release checklist",
      avatar,
    });
    expect(first.events).toHaveLength(1);
    expect(first.events[0]).toMatchObject({
      type: "session.profile_set",
      payload: { description: "Owns the release checklist", avatar, source: "agent" },
    });

    // Only the avatar: the description stays.
    const icon = { kind: "icon" as const, icon: "rocket" as const, hue: 30 };
    const second = await updateSessionProfileWithEvent(client.db, {
      ...place,
      sessionId: session.id,
      avatar: icon,
      source: "user",
    });
    expect(second).toMatchObject({
      updated: true,
      description: "Owns the release checklist",
      avatar: icon,
    });
    expect(second.events[0]!.sequence).toBe(first.events[0]!.sequence + 1);

    // The same values again: no write and no event.
    const repeat = await updateSessionProfileWithEvent(client.db, {
      ...place,
      sessionId: session.id,
      description: "Owns the release checklist",
      avatar: icon,
      source: "user",
    });
    expect(repeat).toMatchObject({ updated: false, events: [] });

    const read = await getSession(client.db, place.workspaceId, session.id);
    expect(read).toMatchObject({ description: "Owns the release checklist", avatar: icon });
    expect(read?.lastSequence).toBe(second.events[0]!.sequence);
    const listed = (await listSessions(client.db, place.workspaceId)).find(
      (entry) => entry.id === session.id,
    );
    expect(listed).toMatchObject({ description: "Owns the release checklist", avatar: icon });

    // Null clears each one.
    const cleared = await updateSessionProfileWithEvent(client.db, {
      ...place,
      sessionId: session.id,
      description: null,
      avatar: null,
      source: "user",
    });
    expect(cleared).toMatchObject({ updated: true, description: null, avatar: null });
    expect(await getSession(client.db, place.workspaceId, session.id)).toMatchObject({
      description: null,
      avatar: null,
    });
  }, 180_000);

  test("an avatar this version cannot read shows as none", async () => {
    if (!shared) return;
    const place = await workspace("unknown-avatar");
    const session = await newSession(place);
    await shared.admin`update sessions set avatar = ${shared.admin.json({ kind: "hologram" })}
      where id = ${session.id}`;
    expect((await getSession(client.db, place.workspaceId, session.id))?.avatar).toBeNull();
  }, 180_000);

  test("the database bounds a description", async () => {
    if (!shared) return;
    const place = await workspace("bounds");
    const session = await newSession(place);
    await expect(
      shared.admin`update sessions set description = ${"x".repeat(281)} where id = ${session.id}`,
    ).rejects.toThrow(/sessions_description_bounds/);
    await expect(
      shared.admin`update sessions set description = '' where id = ${session.id}`,
    ).rejects.toThrow(/sessions_description_bounds/);
  }, 180_000);
});
