import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import type postgres from "postgres";
import {
  ChannelNameConflictError,
  ChannelNotFoundError,
  createChannel,
  createDb,
  createSession,
  deleteChannel,
  getChannel,
  getSession,
  listChannels,
  setSessionChannel,
  updateChannel,
  type Database,
  type DbClient,
} from "../src/index";

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

async function freshWorkspace(): Promise<{ accountId: string; workspaceId: string }> {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('channels-account') returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name, settings)
    values (${account!.id}, 'channels-workspace', ${admin.json({})}) returning id`;
  await admin`insert into workspace_inference_controls (workspace_id, account_id) values (${workspace!.id}, ${account!.id})`;
  return { accountId: account!.id, workspaceId: workspace!.id };
}

async function session(input: {
  accountId: string;
  workspaceId: string;
  message: string;
  channelId?: string | null;
}) {
  return await createSession(db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    initialMessage: input.message,
    resources: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none",
    ...(input.channelId !== undefined ? { channelId: input.channelId } : {}),
  });
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("channels");
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error(
        "[channels] OPENGENI_REQUIRE_REAL_DB=1 but the real PostgreSQL harness is unavailable",
      );
    }
    available = false;
    // eslint-disable-next-line no-console
    console.warn("[channels] docker unavailable, skipping");
    return;
  }
  admin = shared.admin;
  client = createDb(shared.appUrl);
  db = client.db;
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

describe("channels (real PostgreSQL + FORCE RLS)", () => {
  test("creates, lists project-ordered, updates, and deletes workspace channels", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const security = await createChannel(db, {
      ...workspace,
      name: "security",
      createdBy: "user:test",
    });
    expect(security.name).toBe("security");
    expect(security.createdBy).toBe("user:test");
    const knowledge = await createChannel(db, { ...workspace, name: "knowledge" });

    const listed = await listChannels(db, workspace.workspaceId);
    expect(listed.map((channel) => [channel.name, channel.sortOrder])).toEqual([
      ["security", 0],
      ["knowledge", 1],
    ]);

    const renamed = await updateChannel(db, workspace.workspaceId, knowledge.id, {
      name: "knowledge-base",
      description: "curated ingest",
    });
    expect(renamed?.name).toBe("knowledge-base");
    expect(renamed?.description).toBe("curated ingest");

    expect(await deleteChannel(db, workspace.workspaceId, knowledge.id)).toBe(true);
    expect(await deleteChannel(db, workspace.workspaceId, knowledge.id)).toBe(false);
    expect(await getChannel(db, workspace.workspaceId, knowledge.id)).toBeNull();
  });

  test("rejects duplicate names case-insensitively within one workspace only", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const other = await freshWorkspace();
    await createChannel(db, { ...workspace, name: "platform" });
    await expect(createChannel(db, { ...workspace, name: "Platform" })).rejects.toBeInstanceOf(
      ChannelNameConflictError,
    );
    // The same name is fine in a different workspace.
    await createChannel(db, { ...other, name: "platform" });
  });

  test("files a session at create, re-files it, and detaches on channel delete", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const inboxSession = await session({ ...workspace, message: "unfiled" });
    expect(inboxSession.channelId).toBeNull();

    const channel = await createChannel(db, { ...workspace, name: "security" });
    const filed = await session({ ...workspace, message: "filed", channelId: channel.id });
    expect(filed.channelId).toBe(channel.id);

    // Re-file the unfiled session into the channel, then back to the inbox.
    expect(
      await setSessionChannel(db, {
        workspaceId: workspace.workspaceId,
        sessionId: inboxSession.id,
        channelId: channel.id,
      }),
    ).toBe(true);
    const refiled = await getSession(db, workspace.workspaceId, inboxSession.id);
    expect(refiled?.channelId).toBe(channel.id);
    expect(
      await setSessionChannel(db, {
        workspaceId: workspace.workspaceId,
        sessionId: inboxSession.id,
        channelId: null,
      }),
    ).toBe(true);
    expect((await getSession(db, workspace.workspaceId, inboxSession.id))?.channelId).toBeNull();

    // An unknown target channel is a typed error; a foreign session is a no-op false.
    await expect(
      setSessionChannel(db, {
        workspaceId: workspace.workspaceId,
        sessionId: filed.id,
        channelId: crypto.randomUUID(),
      }),
    ).rejects.toBeInstanceOf(ChannelNotFoundError);
    expect(
      await setSessionChannel(db, {
        workspaceId: workspace.workspaceId,
        sessionId: crypto.randomUUID(),
        channelId: channel.id,
      }),
    ).toBe(false);

    // Deleting the channel detaches its sessions instead of blocking or cascading.
    expect(await deleteChannel(db, workspace.workspaceId, channel.id)).toBe(true);
    expect((await getSession(db, workspace.workspaceId, filed.id))?.channelId).toBeNull();
  });

  test("cannot attach a foreign workspace's channel to a session", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const other = await freshWorkspace();
    const foreign = await createChannel(db, { ...other, name: "foreign" });
    const row = await session({ ...workspace, message: "target" });
    await expect(
      setSessionChannel(db, {
        workspaceId: workspace.workspaceId,
        sessionId: row.id,
        channelId: foreign.id,
      }),
    ).rejects.toBeInstanceOf(ChannelNotFoundError);
  });
});
