import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { migrate } from "../src/migrate";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
const migration = "0404_new_session_draft_project_provenance.sql";
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
setDefaultTimeout(900_000);

async function migrationFiles(): Promise<string[]> {
  return (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
}

async function applyBelow(url: string, upperBound: string): Promise<void> {
  const deferred = (await migrationFiles()).filter((file) => file >= upperBound);
  const ledger = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    await ledger.unsafe(
      `CREATE TABLE IF NOT EXISTS "schema_migrations" (
        "name" text PRIMARY KEY,
        "applied_at" timestamptz NOT NULL DEFAULT now()
      )`,
    );
    for (const file of deferred) {
      await ledger`insert into schema_migrations (name) values (${file}) on conflict do nothing`;
    }
    await migrate(url);
    await ledger`delete from schema_migrations where name >= ${upperBound}`;
  } finally {
    await ledger.end({ timeout: 5 });
  }
}

describe("migration 0404 new-session draft project provenance", () => {
  let owned: OwnerMigratedTestDatabase | null = null;

  beforeAll(async () => {
    owned = await acquireOwnerMigratedTestDatabase("migration-0404-draft-project-provenance");
    if (!owned && requireRealDatabase) {
      throw new Error("real database required but unavailable");
    }
  }, 900_000);

  afterAll(async () => {
    await owned?.release();
  }, 120_000);

  test("a NOSUPERUSER NOBYPASSRLS owner backfills legacy JSON and restores FORCE RLS", async () => {
    if (!owned) return;
    const { admin, ownerRole, ownerUrl } = owned;
    await applyBelow(ownerUrl, migration);

    const accountId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    const draftId = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    const targetSandboxId = crypto.randomUUID();
    const compute = {
      sandboxBackend: "selfhosted",
      targetSandboxId,
      workingDir: "/workspace/project-a",
    };
    await admin.begin(async (tx) => {
      await tx`
        insert into managed_accounts (id, name)
        values (${accountId}, '0404 owner migration account')`;
      await tx`
        insert into workspaces (id, account_id, name)
        values (${workspaceId}, ${accountId}, '0404 owner migration workspace')`;
      await tx`
        insert into new_session_drafts (
          id, account_id, workspace_id, subject_id, revision, text, resources,
          tools, model, reasoning_effort, latency_mode, session_options
        ) values (
          ${draftId}, ${accountId}, ${workspaceId}, 'subject:0404-owner', 1, '',
          '[]'::jsonb, '[]'::jsonb, 'scripted-model', 'low', 'standard',
          ${tx.json({
            ...compute,
            toolsProvided: false,
            selectionHistory: { projects: [] },
            selectedProjectChannelId: projectId,
          })}
        )`;
    });

    const [identity] = await admin<Array<{ superuser: boolean; bypassRls: boolean }>>`
      select rolsuper as "superuser", rolbypassrls as "bypassRls"
      from pg_roles where rolname = ${ownerRole}`;
    expect(identity).toEqual({ superuser: false, bypassRls: false });

    await migrate(ownerUrl);

    const [migrated] = await admin<
      Array<{
        selectedProjectChannelId: string | null;
        selectedProjectComputeSnapshot: Record<string, unknown> | null;
        sessionOptions: Record<string, unknown>;
        forced: boolean;
      }>
    >`
      select
        draft.selected_project_channel_id as "selectedProjectChannelId",
        draft.selected_project_compute_snapshot as "selectedProjectComputeSnapshot",
        draft.session_options as "sessionOptions",
        table_class.relforcerowsecurity as forced
      from new_session_drafts draft
      join pg_class table_class on table_class.oid = 'new_session_drafts'::regclass
      where draft.id = ${draftId}`;
    expect(migrated).toEqual({
      selectedProjectChannelId: projectId,
      selectedProjectComputeSnapshot: compute,
      sessionOptions: {
        ...compute,
        toolsProvided: false,
        selectionHistory: { projects: [] },
      },
      forced: true,
    });

    await admin`
      update new_session_drafts
      set session_options = ${admin.json({
        ...compute,
        selectedProjectChannelId: crypto.randomUUID(),
      })}
      where id = ${draftId}`;
    const [afterLegacyWrite] = await admin<Array<{ sessionOptions: Record<string, unknown> }>>`
      select session_options as "sessionOptions"
      from new_session_drafts where id = ${draftId}`;
    expect(afterLegacyWrite?.sessionOptions).toEqual(compute);
  });
});
