// opengeni:test-shared-postgres-exclusive
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import { FORCE_RLS_TABLES, RUNTIME_FULL_DML_TABLES } from "../src/runtime-posture";

const migrationPath = new URL(
  "../drizzle/0401_tool_gateway_approval_capabilities.sql",
  import.meta.url,
);
const source = await Bun.file(migrationPath).text();
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

setDefaultTimeout(900_000);

let blank: BlankTestDatabase | null = null;
let admin: ReturnType<typeof postgres> | null = null;
let app: ReturnType<typeof postgres> | null = null;

beforeAll(async () => {
  blank = await acquireBlankTestDatabase("migration-0401-tool-gateway-approval");
  if (!blank) {
    if (requireRealDatabase) throw new Error("migration 0401 requires real PostgreSQL");
    return;
  }
  if (!blank.appPassword) throw new Error("migration 0401 app password is unavailable");
  admin = postgres(blank.databaseUrl, { max: 1, prepare: false });
  await admin.unsafe(`
    create schema opengeni_private;
    grant usage on schema opengeni_private to opengeni_app;
    create function opengeni_private.current_subject_id() returns text
      language sql stable as $$ select nullif(current_setting('opengeni.subject_id', true), '') $$;
    create function opengeni_private.workspace_rls_visible(row_account_id uuid, row_workspace_id uuid)
      returns boolean language sql stable as $$
        select row_account_id::text = nullif(current_setting('opengeni.account_id', true), '')
          and row_workspace_id::text = nullif(current_setting('opengeni.workspace_id', true), '')
      $$;
    create table managed_accounts (id uuid primary key);
    create table workspaces (
      id uuid primary key,
      account_id uuid not null references managed_accounts(id) on delete cascade,
      unique (id, account_id)
    );
    create table workspace_artifact_versions (
      id uuid primary key,
      workspace_id uuid not null references workspaces(id) on delete cascade,
      unique (workspace_id, id)
    );
  `);
  await admin.begin(async (transaction) => {
    await transaction.unsafe(source);
  });
  const appUrl = new URL(blank.databaseUrl);
  appUrl.username = "opengeni_app";
  appUrl.password = blank.appPassword;
  app = postgres(appUrl.toString(), { max: 1, prepare: false });
}, 900_000);

afterAll(async () => {
  await app?.end().catch(() => undefined);
  await admin?.end().catch(() => undefined);
  await blank?.release();
}, 180_000);

describe("migration 0401 tool gateway approval capabilities", () => {
  test("stores only bounded hash-only one-shot approval evidence", () => {
    expect(source).toContain("-- deployment-mode: rolling");
    expect(source).toContain('CREATE TABLE "tool_gateway_approval_capabilities"');
    expect(source).toContain('"token_hash" text PRIMARY KEY');
    expect(source).not.toContain('"approval_token"');
    expect(source).toContain('"operation_id" uuid NOT NULL');
    expect(source).toContain('"arguments_digest" text NOT NULL');
    expect(source).toContain('"site_version_id" uuid');
    expect(source).toContain('"tool_gateway_approval_capabilities_site_version_fk"');
    expect(source).toContain('length("tool_name") BETWEEN 1 AND 512');
    expect(source).toContain("interval '10 minutes'");
    expect(source).toContain(
      'ALTER TABLE "tool_gateway_approval_capabilities" FORCE ROW LEVEL SECURITY',
    );
    expect(source).toContain('"subject_id" = opengeni_private.current_subject_id()');
    expect(FORCE_RLS_TABLES).toContain("tool_gateway_approval_capabilities");
    expect(RUNTIME_FULL_DML_TABLES).toContain("tool_gateway_approval_capabilities");
  });

  test("allows the matching application principal to consume one capability once", async () => {
    if (!admin || !app) return;
    const accountId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    const subjectId = `subject:${crypto.randomUUID()}`;
    const tokenHash = "a".repeat(64);
    await admin`insert into managed_accounts (id) values (${accountId})`;
    await admin`insert into workspaces (id, account_id) values (${workspaceId}, ${accountId})`;

    await app.begin(async (transaction) => {
      await transaction`select
        set_config('opengeni.account_id', ${accountId}, true),
        set_config('opengeni.workspace_id', ${workspaceId}, true),
        set_config('opengeni.subject_id', ${subjectId}, true)`;
      await transaction`
        insert into tool_gateway_approval_capabilities (
          token_hash, account_id, workspace_id, subject_id, operation_id,
          catalog_digest, server_id, tool_name, arguments_digest, expires_at
        ) values (
          ${tokenHash}, ${accountId}, ${workspaceId}, ${subjectId}, ${crypto.randomUUID()},
          ${"b".repeat(64)}, 'docs', 'search', ${"c".repeat(64)},
          clock_timestamp() + interval '5 minutes'
        )`;
      const consumed = await transaction<{ token_hash: string }[]>`
        update tool_gateway_approval_capabilities
        set consumed_at = clock_timestamp()
        where token_hash = ${tokenHash} and consumed_at is null
        returning token_hash`;
      expect(consumed).toHaveLength(1);
      const replay = await transaction<{ token_hash: string }[]>`
        update tool_gateway_approval_capabilities
        set consumed_at = clock_timestamp()
        where token_hash = ${tokenHash} and consumed_at is null
        returning token_hash`;
      expect(replay).toHaveLength(0);
    });
  });
});
