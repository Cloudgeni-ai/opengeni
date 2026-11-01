import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import postgres from "postgres";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing/shared-pg";
import { bootstrapWorkspace, createDb, createSession, type DbClient } from "../src";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

const migration = "1213_one_session_archive.sql";
const realDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const subjectId = "user:hidden-chats-archived";
let owned: OwnerMigratedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  if (!realDatabase) return;
  owned = await acquireOwnerMigratedTestDatabase("one-session-archive");
  if (!owned) throw new Error("Real PostgreSQL is required for the one-archive migration");
  // The fixture is written with the current schema, then the migration's
  // statements run again as the owner, exactly as a deploy runs them.
  await migrate(owned.ownerUrl);
  await provisionRoles(owned.adminUrl, { appPassword: owned.appPassword });
  const appUrl = new URL(owned.ownerUrl);
  appUrl.username = "opengeni_app";
  appUrl.password = owned.appPassword;
  client = createDb(appUrl.toString(), { max: 2 });
}, 600_000);

afterAll(async () => {
  await client?.close();
  await owned?.release();
}, 180_000);

describe.skipIf(!realDatabase)("1213 one session archive", () => {
  test("archives chats hidden with the old personal archive, with their sub-chats, unless kept live", async () => {
    const access = await bootstrapWorkspace(client!.db, {
      accountExternalSource: "one-archive-test",
      accountExternalId: crypto.randomUUID(),
      accountName: "One archive",
      workspaceExternalSource: "one-archive-test",
      workspaceExternalId: crypto.randomUUID(),
      workspaceName: "One archive",
      subjectId,
    });
    const accountId = access.defaultAccountId!;
    const workspaceId = access.defaultWorkspaceId!;
    const chat = async (message: string, parentSessionId?: string) =>
      await createSession(client!.db, {
        accountId,
        workspaceId,
        initialMessage: message,
        resources: [],
        metadata: {},
        model: "test-model",
        reasoningEffort: "medium" as const,
        latencyMode: "standard" as const,
        sandboxBackend: "none",
        ...(parentSessionId ? { parentSessionId } : {}),
      });
    const hidden = await chat("hidden with the old button");
    const child = await chat("its sub-chat", hidden.id);
    const keptLive = await chat("hidden but kept live");
    const visible = await chat("never hidden");
    const admin = owned!.admin;
    await admin`update sessions set keep_live = true where id = ${keptLive.id}`;
    await admin`
      insert into session_pins
        (account_id, workspace_id, subject_id, session_id, pinned, pinned_at, version,
         archived, archived_at, archive_version)
      values
        (${accountId}, ${workspaceId}, ${subjectId}, ${hidden.id}, false, null, 0,
         true, '2026-10-01T12:00:00Z', 1),
        (${accountId}, ${workspaceId}, 'user:later', ${hidden.id}, false, null, 0,
         true, '2026-10-02T12:00:00Z', 1),
        (${accountId}, ${workspaceId}, ${subjectId}, ${keptLive.id}, false, null, 0,
         true, now(), 1)`;

    const owner = postgres(owned!.ownerUrl, { max: 1, onnotice: () => {} });
    try {
      const statements = await readFile(join(import.meta.dir, "../drizzle", migration), "utf8");
      await owner.begin(async (tx) => await tx.unsafe(statements));
    } finally {
      await owner.end();
    }

    const rows = await admin<
      { id: string; archivedAt: Date | null; archiveRequestedBy: string | null }[]
    >`
      select id, archived_at as "archivedAt", archive_requested_by as "archiveRequestedBy"
      from sessions where workspace_id = ${workspaceId}`;
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const id of [hidden.id, child.id]) {
      expect(byId.get(id)).toEqual({
        id,
        archivedAt: new Date("2026-10-01T12:00:00Z"),
        archiveRequestedBy: subjectId,
      });
    }
    expect(byId.get(keptLive.id)?.archivedAt).toBeNull();
    expect(byId.get(visible.id)?.archivedAt).toBeNull();
    // The previous release keeps reading its personal rows during the rollout.
    const [pins] = await admin<{ count: number }[]>`
      select count(*)::int as count from session_pins
      where workspace_id = ${workspaceId} and archived`;
    expect(pins?.count).toBe(3);
  }, 120_000);
});
