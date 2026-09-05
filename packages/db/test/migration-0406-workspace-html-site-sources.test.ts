// opengeni:test-shared-postgres-exclusive
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { migrate } from "../src/migrate";

const migrationName = "0406_workspace_html_site_sources.sql";
const migrationUrl = new URL(`../drizzle/${migrationName}`, import.meta.url);
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

setDefaultTimeout(900_000);

let blank: BlankTestDatabase | null = null;
let admin: ReturnType<typeof postgres> | null = null;

beforeAll(async () => {
  blank = await acquireBlankTestDatabase("migration-0405-html-site-sources");
  if (!blank) {
    if (requireRealDatabase) throw new Error("migration 0405 requires real PostgreSQL");
    return;
  }
  admin = postgres(blank.databaseUrl, { max: 2, prepare: false });

  // Let the canonical runner build the exact pre-0405 schema, including every
  // historical directive and maintenance boundary, without copying that logic
  // into this test. Removing the temporary receipt then exercises the ordinary
  // forward-upgrade path through the same runner.
  await admin.unsafe(`create table schema_migrations (
    name text primary key,
    applied_at timestamptz not null default now()
  )`);
  await admin`insert into schema_migrations (name) values (${migrationName})`;
  await migrate(blank.databaseUrl);
}, 900_000);

afterAll(async () => {
  await admin?.end().catch(() => undefined);
  await blank?.release();
}, 180_000);

describe("migration 0406 workspace HTML Site sources", () => {
  test("is a bounded rolling extension of the existing immutable artifact ledger", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.split(/\r?\n/, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(source).toContain('ADD COLUMN "source_key" text');
    expect(source).toContain('ADD COLUMN "requested_tools" jsonb NOT NULL DEFAULT');
    expect(source).toContain('"size_bytes" BETWEEN 1 AND 4194304');
    expect(source).toContain('"source_size_bytes" BETWEEN 1 AND 4194304');
    expect(source).toContain('jsonb_array_length("requested_tools") <= 128');
    expect(source).toContain('ADD COLUMN "request_digest" text');
    expect(source).toContain("\"request_digest\" ~ '^[0-9a-f]{64}$'");
    expect(source).toContain("'archived', 'restored'");
    expect(source).toContain('CREATE INDEX "workspace_artifacts_status_list_idx"');
    expect(source).not.toMatch(/UPDATE\s+"workspace_artifact_versions"/u);
  });

  test("upgrades legacy versions without rewriting them and enforces new version bounds", async () => {
    if (!admin) return;
    const [account] = await admin<{ id: string }[]>`
      insert into managed_accounts (name)
      values ('migration 0405 account')
      returning id`;
    const [workspace] = await admin<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${account!.id}, 'migration 0406 workspace')
      returning id`;
    const artifactId = crypto.randomUUID();
    const legacyVersionId = crypto.randomUUID();
    await admin`
      insert into workspace_artifacts (
        id, account_id, workspace_id, slug, title, created_by_subject_id
      ) values (
        ${artifactId}, ${account!.id}, ${workspace!.id}, 'legacy-site',
        'Legacy Site', 'migration-0405'
      )`;
    await admin`
      insert into workspace_artifact_versions (
        id, account_id, workspace_id, artifact_id, revision, content_key,
        content_sha256, size_bytes, operation_key, created_by_subject_id
      ) values (
        ${legacyVersionId}, ${account!.id}, ${workspace!.id}, ${artifactId}, 1,
        'legacy/index.html', ${"a".repeat(64)}, 128, 'legacy-publish', 'migration-0405'
      )`;
    await admin`
      update workspace_artifacts
      set current_version_id = ${legacyVersionId}
      where id = ${artifactId}`;
    await admin`
      insert into workspace_artifact_events (
        account_id, workspace_id, artifact_id, type, from_version_id,
        to_version_id, operation_key, actor_subject_id, reason
      ) values (
        ${account!.id}, ${workspace!.id}, ${artifactId}, 'published', null,
        ${legacyVersionId}, 'legacy-publish', 'migration-0405', 'Initial publication'
      )`;

    await admin`delete from schema_migrations where name = ${migrationName}`;
    await migrate(blank!.databaseUrl);

    const [legacy] = await admin<
      Array<{
        source_key: string | null;
        source_sha256: string | null;
        source_size_bytes: number | null;
        requested_tools: unknown[];
      }>
    >`
      select source_key, source_sha256, source_size_bytes, requested_tools
      from workspace_artifact_versions
      where id = ${legacyVersionId}`;
    expect(legacy).toEqual({
      source_key: null,
      source_sha256: null,
      source_size_bytes: null,
      requested_tools: [],
    });
    const [legacyEvent] = await admin<Array<{ request_digest: string | null }>>`
      select request_digest from workspace_artifact_events
      where operation_key = 'legacy-publish'`;
    expect(legacyEvent).toEqual({ request_digest: null });

    const newVersionId = crypto.randomUUID();
    await admin`
      insert into workspace_artifact_versions (
        id, account_id, workspace_id, artifact_id, revision, content_key,
        content_sha256, size_bytes, source_key, source_sha256, source_size_bytes,
        requested_tools, operation_key, created_by_subject_id
      ) values (
        ${newVersionId}, ${account!.id}, ${workspace!.id}, ${artifactId}, 2,
        'sites/v2.html', ${"b".repeat(64)}, 256, 'sites/v2-source.json',
        ${"c".repeat(64)}, 512,
        ${admin.json([{ serverId: "opengeni", toolName: "documents.search" }])},
        'publish-v2', 'migration-0405'
      )`;
    await admin`
      insert into workspace_artifact_events (
        account_id, workspace_id, artifact_id, type, from_version_id,
        to_version_id, operation_key, actor_subject_id, reason
      ) values (
        ${account!.id}, ${workspace!.id}, ${artifactId}, 'archived',
        ${newVersionId}, ${newVersionId}, 'archive-v2', 'migration-0405',
        'Temporarily unpublish the Site'
      )`;

    let partialSourceError: unknown;
    try {
      await admin`
        insert into workspace_artifact_versions (
          account_id, workspace_id, artifact_id, revision, content_key,
          content_sha256, size_bytes, source_key, operation_key, created_by_subject_id
        ) values (
          ${account!.id}, ${workspace!.id}, ${artifactId}, 3, 'invalid.html',
          ${"d".repeat(64)}, 128, 'partial-source.json', 'invalid-source', 'migration-0405'
        )`;
    } catch (error) {
      partialSourceError = error;
    }
    expect(String(partialSourceError)).toContain("workspace_artifact_versions_content_chk");

    let requestedToolLimitError: unknown;
    try {
      await admin`
        insert into workspace_artifact_versions (
          account_id, workspace_id, artifact_id, revision, content_key,
          content_sha256, size_bytes, requested_tools, operation_key, created_by_subject_id
        ) values (
          ${account!.id}, ${workspace!.id}, ${artifactId}, 3, 'too-many-tools.html',
          ${"e".repeat(64)}, 128,
          ${admin.json(
            Array.from({ length: 129 }, (_, index) => ({
              serverId: "opengeni",
              toolName: `tool-${index}`,
            })),
          )},
          'too-many-tools', 'migration-0405'
        )`;
    } catch (error) {
      requestedToolLimitError = error;
    }
    expect(String(requestedToolLimitError)).toContain("workspace_artifact_versions_content_chk");

    const rowSecurity = await admin<
      Array<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>
    >`
      select relname, relrowsecurity, relforcerowsecurity
      from pg_class
      where relname in (
        'workspace_artifacts', 'workspace_artifact_versions', 'workspace_artifact_events'
      )
      order by relname`;
    expect(rowSecurity).toHaveLength(3);
    expect(rowSecurity.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
  }, 900_000);
});
