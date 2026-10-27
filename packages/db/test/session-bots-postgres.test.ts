import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { BOT_TEMPLATES_PER_WORKSPACE_MAX } from "@opengeni/contracts";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  BotTemplateLimitError,
  bootstrapWorkspace,
  createBotTemplate,
  createDb,
  createSession,
  deleteBotTemplate,
  getBotTemplate,
  getSession,
  listBotTemplates,
  listSessions,
  updateBotTemplate,
  updateSessionProfileWithEvent,
  type DbClient,
} from "../src/index";

// Bots (migration 1004): a chat's description and avatar, and the workspace's
// bot templates.

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

describe("bot templates", () => {
  test("save, read, change and delete within one workspace", async () => {
    if (!shared) return;
    const place = await workspace("templates");
    const other = await workspace("templates-other");
    const source = await newSession(place);
    const created = await createBotTemplate(client.db, {
      ...place,
      name: "Release owner",
      description: "Keeps the release checklist moving",
      avatar: { kind: "letters", letters: "RO", hue: 120 },
      setupInstructions: "You own releases. Install the release Skill.",
      sourceSessionId: source.id,
      createdBySubjectId: "user:someone",
    });
    expect(created).toMatchObject({
      workspaceId: place.workspaceId,
      name: "Release owner",
      sourceSessionId: source.id,
      createdBySubjectId: "user:someone",
    });
    expect((await listBotTemplates(client.db, place.workspaceId)).map((row) => row.id)).toEqual([
      created.id,
    ]);
    // Another workspace sees nothing, even by id.
    expect(await listBotTemplates(client.db, other.workspaceId)).toEqual([]);
    expect(await getBotTemplate(client.db, other.workspaceId, created.id)).toBeNull();
    expect(
      await updateBotTemplate(client.db, {
        workspaceId: other.workspaceId,
        templateId: created.id,
        name: "Taken over",
      }),
    ).toBeNull();
    expect(await deleteBotTemplate(client.db, other.workspaceId, created.id)).toBe(false);

    const updated = await updateBotTemplate(client.db, {
      workspaceId: place.workspaceId,
      templateId: created.id,
      name: "Release captain",
      avatar: null,
    });
    expect(updated).toMatchObject({
      name: "Release captain",
      description: "Keeps the release checklist moving",
      avatar: null,
      setupInstructions: "You own releases. Install the release Skill.",
    });
    expect(updated!.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());

    expect(await deleteBotTemplate(client.db, place.workspaceId, created.id)).toBe(true);
    expect(await getBotTemplate(client.db, place.workspaceId, created.id)).toBeNull();
    expect(await deleteBotTemplate(client.db, place.workspaceId, created.id)).toBe(false);
  }, 180_000);

  test("a workspace keeps at most the limit, even when saves race", async () => {
    if (!shared) return;
    const place = await workspace("limit");
    const existing = BOT_TEMPLATES_PER_WORKSPACE_MAX - 2;
    await shared.admin`
      insert into bot_templates (account_id, workspace_id, name, setup_instructions)
      select ${place.accountId}::uuid, ${place.workspaceId}::uuid, 'Bot ' || n, 'Set up.'
      from generate_series(1, ${existing}) as n`;
    const save = (index: number) =>
      createBotTemplate(client.db, {
        ...place,
        name: `Racing ${index}`,
        description: "",
        avatar: null,
        setupInstructions: "Set up.",
        sourceSessionId: null,
        createdBySubjectId: null,
      });
    const results = await Promise.allSettled([0, 1, 2, 3, 4].map(save));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    for (const result of results) {
      if (result.status === "rejected") expect(result.reason).toBeInstanceOf(BotTemplateLimitError);
    }
    expect(await listBotTemplates(client.db, place.workspaceId)).toHaveLength(
      BOT_TEMPLATES_PER_WORKSPACE_MAX,
    );
  }, 180_000);

  test("the database bounds what a template holds", async () => {
    if (!shared) return;
    const place = await workspace("template-bounds");
    await expect(
      shared.admin`insert into bot_templates (account_id, workspace_id, name, setup_instructions)
        values (${place.accountId}, ${place.workspaceId}, '', 'Set up.')`,
    ).rejects.toThrow(/check constraint/);
    await expect(
      shared.admin`insert into bot_templates (account_id, workspace_id, name, setup_instructions)
        values (${place.accountId}, ${place.workspaceId}, 'Bot', ${"x".repeat(20_001)})`,
    ).rejects.toThrow(/check constraint/);
  }, 180_000);
});
