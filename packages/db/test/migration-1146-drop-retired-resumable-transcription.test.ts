import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing/shared-pg";
import postgres from "postgres";
import { createDb, createRecording, ensureManagedAccessForUser, type DbClient } from "../src";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import { assertRuntimeDatabasePosture } from "../src/runtime-posture";

const migration = "1146_drop_retired_resumable_transcription.sql";
const tables = [
  "transcription_recording_chunks",
  "transcription_recording_objects",
  "transcription_recording_segments",
  "transcription_recordings",
];
const names = [
  "fence_legacy_lossless_content_update",
  "organization_retention_object_candidates",
  "finalize_organization_retention_deletion",
  "claim_due_transcription_recording_object_cleanup",
  "purge_expired_transcription_recordings",
];
const realDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let owned: OwnerMigratedTestDatabase | null = null;
let client: DbClient | null = null;
let owner: postgres.Sql | null = null;
let prefix: string | null = null;
let scope: { accountId: string; workspaceId: string; subjectId: string };
let legacyRecordingId: string;
let currentRecordingId: string;
let before: Awaited<ReturnType<typeof definitions>>;
const objectKey = "legacy-transcription-retirement-test-only";

async function definitions() {
  return Array.from(
    await owned!.admin`
    select p.oid, p.proname, p.prosrc, p.proowner, p.proacl, p.prosecdef, p.proconfig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'opengeni_private') and p.proname = any(${names}::text[])
    order by p.oid`,
  );
}

function applyContract() {
  return migrate(owned!.ownerUrl, undefined, { migrationsDirectory: prefix! });
}

beforeAll(async () => {
  if (!realDatabase) return;
  owned = await acquireOwnerMigratedTestDatabase("retired-resumable-transcription-contract");
  if (!owned) throw new Error("Real PostgreSQL is required for recording contraction");
  prefix = await mkdtemp(join(tmpdir(), "opengeni-before-transcription-contract-"));
  const source = join(import.meta.dir, "../drizzle");
  for (const name of await readdir(source))
    if (name.endsWith(".sql") && name < migration)
      await copyFile(join(source, name), join(prefix, name));
  await migrate(owned.ownerUrl, undefined, { migrationsDirectory: prefix });
  await provisionRoles(owned.adminUrl, { appPassword: owned.appPassword });
  owner = postgres(owned.ownerUrl, { max: 1, onnotice: () => undefined });
  const appUrl = new URL(owned.ownerUrl);
  appUrl.username = "opengeni_app";
  appUrl.password = owned.appPassword;
  client = createDb(appUrl.toString(), { max: 2 });
  const userId = crypto.randomUUID();
  const access = await ensureManagedAccessForUser(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Transcription retirement",
  });
  const grant = access.workspaceGrants.find(
    (row) => row.workspaceId === access.defaultWorkspaceId,
  )!;
  scope = {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    subjectId: grant.subjectId,
  };
  currentRecordingId = crypto.randomUUID();
  await createRecording(client.db, {
    ...scope,
    recordingId: currentRecordingId,
    tracks: [{ trackNumber: 0, source: "microphone", mimeType: "audio/webm" }],
  });
  legacyRecordingId = crypto.randomUUID();
  await owned.admin`insert into transcription_recordings
    (id, account_id, workspace_id, subject_id, mime_type, state, expires_at)
    values (${legacyRecordingId}, ${scope.accountId}, ${scope.workspaceId}, ${scope.subjectId}, 'audio/webm', 'complete', now() - interval '1 day')`;
  await owned.admin`insert into transcription_recording_objects
    (account_id, workspace_id, subject_id, recording_id, object_key, kind, cleanup_after)
    values (${scope.accountId}, ${scope.workspaceId}, ${scope.subjectId}, ${legacyRecordingId}, ${objectKey}, 'chunk', now() - interval '1 day')`;
  await owned.admin`insert into transcription_recording_chunks
    (account_id, workspace_id, subject_id, recording_id, chunk_number, byte_length, sha256, start_milliseconds, duration_milliseconds, object_key)
    values (${scope.accountId}, ${scope.workspaceId}, ${scope.subjectId}, ${legacyRecordingId}, 0, 1, ${"a".repeat(64)}, 0, 1, ${objectKey})`;
  // This independently retained obligation must survive removal of the old
  // source tables; a cleaned source registry is not a retention receipt.
  const [membership] = await owned.admin<{ id: string }[]>`select id from organization_memberships
    where account_id = ${scope.accountId} and subject_id = ${scope.subjectId}`;
  if (!membership) throw new Error("Missing retention fixture membership");
  const operationId = crypto.randomUUID();
  await owned.admin`insert into organization_user_retention_deletions
    (account_id, membership_id, retention_until, claim_operation_id, claim_expires_at)
    values (${scope.accountId}, ${membership.id}, now() - interval '1 day',
      ${operationId}, now() + interval '1 hour')`;
  await owned.admin`insert into organization_user_retention_object_obligations
    (account_id, membership_id, object_kind, source_id, object_bucket, object_key,
      prepared_operation_id, object_key_hash)
    values (${scope.accountId}, ${membership.id}, 'transcription_recording_object',
      ${legacyRecordingId}, 'retention-test-only', 'independent-retention-obligation',
      ${operationId}, ${"b".repeat(64)})`;
  before = await definitions();
  expect(before).toHaveLength(5);
  await copyFile(join(source, migration), join(prefix, migration));
}, 600_000);

afterAll(async () => {
  await client?.close();
  await owner?.end();
  await owned?.release();
  if (prefix) await rm(prefix, { recursive: true, force: true });
}, 180_000);

async function assertRolledBack() {
  expect(await definitions()).toEqual(before);
  const rows = await owned!.admin<{ name: string; forced: boolean }[]>`
    select c.relname as name, c.relforcerowsecurity as forced
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = any(${tables}::text[]) order by c.relname`;
  expect(Array.from(rows)).toEqual([...tables].sort().map((name) => ({ name, forced: true })));
}

describe.skipIf(!realDatabase)("retired resumable transcription contraction", () => {
  test("the real owner refuses an outstanding object hidden by FORCE RLS", async () => {
    expect(await owner!`select object_key from transcription_recording_objects`).toHaveLength(0);
    const ledger = await owned!.admin`select * from transcription_recording_objects`;
    await expect(applyContract()).rejects.toThrow("must be confirmed deleted");
    await assertRolledBack();
    expect(await owned!.admin`select * from transcription_recording_objects`).toEqual(ledger);
  }, 180_000);

  test("each audio reference requires its own matching deletion record", async () => {
    await expect(
      owned!.admin`delete from transcription_recording_objects where object_key = ${objectKey}`,
    ).rejects.toMatchObject({ code: "23503" });
    await owned!.admin`update transcription_recording_objects
      set kind = 'segment', cleaned_at = now() where object_key = ${objectKey}`;
    try {
      await expect(applyContract()).rejects.toThrow("matching confirmed deletion record");
      await assertRolledBack();
    } finally {
      await owned!.admin`update transcription_recording_objects
        set kind = 'chunk', cleaned_at = now() where object_key = ${objectKey}`;
    }
  }, 180_000);

  test("a retained processing owner refuses contraction even after objects are cleaned", async () => {
    await owned!.admin`update transcription_recordings
      set processing_owner = ${crypto.randomUUID()}, processing_started_at = now()
      where id = ${legacyRecordingId}`;
    try {
      await expect(applyContract()).rejects.toThrow("processing must drain");
      await assertRolledBack();
    } finally {
      await owned!.admin`update transcription_recordings
        set processing_owner = null, processing_started_at = null where id = ${legacyRecordingId}`;
    }
  }, 180_000);

  test("an unexpected dependent view rolls every replacement back", async () => {
    await owner!`create view unexpected_transcription_reader as select id from transcription_recordings`;
    try {
      await expect(applyContract()).rejects.toThrow();
      await assertRolledBack();
    } finally {
      await owner!`drop view unexpected_transcription_reader`;
    }
  }, 180_000);

  test("confirmed cleanup permits the closed-group drop without changing current recordings or authority", async () => {
    const current = await owned!.admin`select * from recordings where id = ${currentRecordingId}`;
    const tracks = await owned!
      .admin`select * from recording_tracks where recording_id = ${currentRecordingId}`;
    const obligations = await owned!
      .admin`select * from organization_user_retention_object_obligations order by account_id, membership_id, source_id`;
    expect(obligations).toHaveLength(1);
    await applyContract();
    expect(await owned!.admin`select * from recordings where id = ${currentRecordingId}`).toEqual(
      current,
    );
    expect(
      await owned!.admin`select * from recording_tracks where recording_id = ${currentRecordingId}`,
    ).toEqual(tracks);
    expect(
      await owned!
        .admin`select * from organization_user_retention_object_obligations order by account_id, membership_id, source_id`,
    ).toEqual(obligations);
    const after = await definitions();
    expect(after).toHaveLength(3);
    const identity = ({ prosrc: _body, ...row }: (typeof before)[number]) => row;
    const survivingOids = new Set(after.map((row) => row.oid));
    expect(after.map(identity)).toEqual(
      before.filter((row) => survivingOids.has(row.oid)).map(identity),
    );
    expect(
      await owned!.admin`
      select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = any(${tables}::text[])`,
    ).toHaveLength(0);
    const pattern = `\\m(${tables.join("|")})\\M`;
    expect(
      await owned!.admin`
      select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'opengeni_private') and p.prokind in ('f', 'p') and p.prosrc ~ ${pattern}`,
    ).toHaveLength(0);
    await assertRuntimeDatabasePosture(client!.db, { rlsStrategy: "force" });
    await provisionRoles(owned!.adminUrl, { appPassword: owned!.appPassword });
    await assertRuntimeDatabasePosture(client!.db, { rlsStrategy: "force" });
    await applyContract();
    expect(await definitions()).toEqual(after);
  }, 180_000);
});
