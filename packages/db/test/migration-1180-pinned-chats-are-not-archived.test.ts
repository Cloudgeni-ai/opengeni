import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing/shared-pg";
import { bootstrapWorkspace, createDb, createSession, type DbClient } from "../src";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

const migration = "1180_pinned_chats_are_not_archived.sql";
const realDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const subjectId = "user:pinned-archived-repair";
let owned: OwnerMigratedTestDatabase | null = null;
let client: DbClient | null = null;
let prefix: string | null = null;

beforeAll(async () => {
  if (!realDatabase) return;
  owned = await acquireOwnerMigratedTestDatabase("pinned-chats-not-archived");
  if (!owned) throw new Error("Real PostgreSQL is required for the pinned chat repair");
  prefix = await mkdtemp(join(tmpdir(), "opengeni-before-pinned-chat-repair-"));
  const source = join(import.meta.dir, "../drizzle");
  for (const name of await readdir(source)) {
    if (name.endsWith(".sql") && name < migration) {
      await copyFile(join(source, name), join(prefix, name));
    }
  }
  await migrate(owned.ownerUrl, undefined, { migrationsDirectory: prefix });
  await provisionRoles(owned.adminUrl, { appPassword: owned.appPassword });
  const appUrl = new URL(owned.ownerUrl);
  appUrl.username = "opengeni_app";
  appUrl.password = owned.appPassword;
  client = createDb(appUrl.toString(), { max: 2 });
}, 600_000);

afterAll(async () => {
  await client?.close();
  await owned?.release();
  if (prefix) await rm(prefix, { recursive: true, force: true });
}, 180_000);

describe.skipIf(!realDatabase)("1180 pinned chats are not archived", () => {
  test("restores only chats saved as both pinned and archived, despite FORCE RLS", async () => {
    const access = await bootstrapWorkspace(client!.db, {
      accountExternalSource: "pinned-chat-repair-test",
      accountExternalId: crypto.randomUUID(),
      accountName: "Pinned chat repair",
      workspaceExternalSource: "pinned-chat-repair-test",
      workspaceExternalId: crypto.randomUUID(),
      workspaceName: "Pinned chat repair",
      subjectId,
    });
    const accountId = access.defaultAccountId!;
    const workspaceId = access.defaultWorkspaceId!;
    const chat = async (message: string) =>
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
      });
    const both = await chat("archived, then pinned from search");
    const archivedOnly = await chat("archived");
    const pinnedOnly = await chat("pinned");
    const admin = owned!.admin;
    await admin`
      insert into session_pins
        (account_id, workspace_id, subject_id, session_id, pinned, pinned_at, version,
         archived, archived_at, archive_version)
      values
        (${accountId}, ${workspaceId}, ${subjectId}, ${both.id}, true, now(), 3,
         true, now() - interval '1 hour', 1),
        (${accountId}, ${workspaceId}, ${subjectId}, ${archivedOnly.id}, false, null, 2,
         true, now(), 1),
        (${accountId}, ${workspaceId}, ${subjectId}, ${pinnedOnly.id}, true, now(), 1,
         false, null, 0)`;

    await migrate(owned!.ownerUrl);

    const rows = await admin<
      {
        sessionId: string;
        pinned: boolean;
        version: number;
        archived: boolean;
        archivedAt: Date | null;
        archiveVersion: number;
      }[]
    >`
      select session_id as "sessionId", pinned, version, archived,
        archived_at as "archivedAt", archive_version as "archiveVersion"
      from session_pins where workspace_id = ${workspaceId}`;
    const bySession = new Map(rows.map((row) => [row.sessionId, row]));
    expect(bySession.get(both.id)).toMatchObject({
      pinned: true,
      version: 3,
      archived: false,
      archivedAt: null,
      archiveVersion: 2,
    });
    expect(bySession.get(archivedOnly.id)).toMatchObject({
      pinned: false,
      version: 2,
      archived: true,
      archiveVersion: 1,
    });
    expect(bySession.get(archivedOnly.id)?.archivedAt).not.toBeNull();
    expect(bySession.get(pinnedOnly.id)).toMatchObject({
      pinned: true,
      version: 1,
      archived: false,
      archiveVersion: 0,
    });

    const [state] = await admin<{ forced: boolean; applied: boolean }[]>`
      select c.relforcerowsecurity as forced,
        exists(select 1 from schema_migrations where name = ${migration}) as applied
      from pg_class c where c.oid = 'public.session_pins'::regclass`;
    expect(state).toEqual({ forced: true, applied: true });
  }, 180_000);
});
