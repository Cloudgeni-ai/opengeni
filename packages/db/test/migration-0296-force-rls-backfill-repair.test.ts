// Migration 0296: `FORCE ROW LEVEL SECURITY` binds the TABLE OWNER,
// and OpenGeni migrates as a NON-superuser owner without BYPASSRLS. No tenant
// GUC is set during a migration, so 0256's and 0262's `origin_workspace_id`
// backfills matched ZERO rows and reported success on every real deployment.
//
// This file is the regression harness for that whole class: it drives the real
// migration chain through `acquireOwnerMigratedTestDatabase`, whose owner role
// is `NOSUPERUSER NOBYPASSRLS` - unlike `acquireSharedTestDatabase` /
// `acquireBlankTestDatabase`, which hand out the container superuser and
// therefore cannot observe the bug at all.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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
const REPAIR_MIGRATION = "0296_force_rls_backfill_noop_repair.sql";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const WORKSPACE = "22222222-2222-4222-8222-222222222222";
const CONNECTION = "33333333-3333-4333-8333-333333333333";
const ENROLLMENT = "66666666-6666-4666-8666-666666666666";

async function migrationFiles(): Promise<string[]> {
  return (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
}

/**
 * Apply every migration strictly below `upperBound` through the real migrator,
 * by pre-recording the later files in the ledger and removing the placeholders
 * afterwards. Using `migrate()` (rather than replaying raw SQL) keeps the
 * per-file session preamble the runner establishes.
 */
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

describe("migration 0296 repairs the FORCE-RLS backfill no-ops", () => {
  let owned: OwnerMigratedTestDatabase | null = null;

  beforeAll(async () => {
    owned = await acquireOwnerMigratedTestDatabase("migration-0296-force-rls-repair");
  }, 600_000);

  afterAll(async () => {
    await owned?.release();
  }, 120_000);

  test("a NOSUPERUSER NOBYPASSRLS owner silently loses the backfill, and 0296 restores it", async () => {
    if (!owned) return;
    const { admin, ownerUrl, ownerRole } = owned;

    const [identity] = await admin<Array<{ superuser: boolean; bypassRls: boolean }>>`
      select rolsuper as "superuser", rolbypassrls as "bypassRls"
      from pg_roles where rolname = ${ownerRole}
    `;
    expect(identity).toEqual({ superuser: false, bypassRls: false });

    // ---- everything before the two offending migrations -------------------
    await applyBelow(ownerUrl, "0256");

    // Seed as the superuser so the fixture itself is never RLS-filtered. The
    // Better Auth self-organization shape is what 0263's owner backfill targets.
    await admin.unsafe(`
      insert into managed_accounts (id, name, external_source, external_id)
        values ('${ACCOUNT}', 'rlsbackfill-account', 'better-auth:user', 'rlsbackfill-external');
      insert into workspaces (id, account_id, name) values ('${WORKSPACE}', '${ACCOUNT}', 'rlsbackfill-workspace');
      insert into organization_memberships (account_id, subject_id, status, personal_workspace_id)
        values ('${ACCOUNT}', 'user:rlsbackfill-external', 'active', '${WORKSPACE}');
      insert into connections (id, account_id, workspace_id, subject_id, provider_domain, kind, credential_encrypted)
        values ('${CONNECTION}', '${ACCOUNT}', '${WORKSPACE}', null, 'example.com', 'api_key', 'ciphertext');
      insert into enrollments (id, account_id, workspace_id, pubkey)
        values ('${ENROLLMENT}', '${ACCOUNT}', '${WORKSPACE}', 'rlsbackfill-pubkey');
    `);

    // The mechanism itself: with no tenant GUC the owner sees nothing.
    const owner = postgres(ownerUrl, { max: 1, onnotice: () => undefined });
    try {
      const [visible] = await owner<Array<{ count: string }>>`
        select count(*)::text as count from connections
      `;
      expect(visible!.count).toBe("0");
    } finally {
      await owner.end({ timeout: 5 });
    }

    // ---- apply 0256..0293: the backfills run, and match nothing -----------
    await applyBelow(ownerUrl, REPAIR_MIGRATION);

    const observe = async () =>
      (
        await admin<
          Array<{
            connectionOrigin: string | null;
            enrollmentOrigin: string | null;
            membershipRole: string;
          }>
        >`
          select
            (select origin_workspace_id from connections where id = ${CONNECTION}) as "connectionOrigin",
            (select origin_workspace_id from enrollments where id = ${ENROLLMENT}) as "enrollmentOrigin",
            (select role from organization_memberships where account_id = ${ACCOUNT}) as "membershipRole"
        `
      )[0]!;

    // BEFORE: all three backfills silently no-oped.
    // `resolve_accepted_connection_use` compares
    // `origin_workspace_id IS DISTINCT FROM p_workspace_id`, so the NULL denies
    // every workspace-owned connection at use time; and the self-organization
    // owner keeps `member`, which locks the organization out of membership
    // administration.
    expect(await observe()).toEqual({
      connectionOrigin: null,
      enrollmentOrigin: null,
      membershipRole: "member",
    });

    // ---- apply 0296 -------------------------------------------------------
    await migrate(ownerUrl);

    expect(await observe()).toEqual({
      connectionOrigin: WORKSPACE,
      enrollmentOrigin: WORKSPACE,
      membershipRole: "owner",
    });

    // The shipped posture is restored, not left relaxed.
    const posture = await admin<Array<{ table: string; forced: boolean }>>`
      select relname as "table", relforcerowsecurity as forced
      from pg_class
      where relname in ('connections', 'enrollments', 'organization_memberships')
      order by relname
    `;
    expect([...posture]).toEqual([
      { table: "connections", forced: true },
      { table: "enrollments", forced: true },
      { table: "organization_memberships", forced: true },
    ]);
    const [trigger] = await admin<Array<{ enabled: string }>>`
      select tgenabled as enabled from pg_trigger
      where tgname = 'connections_authority_binding'
    `;
    expect(trigger!.enabled).toBe("O");
  }, 900_000);

  test("re-running 0296 converges and never widens authority", async () => {
    if (!owned) return;
    const { admin, ownerUrl } = owned;

    // Add a personal (subject-owned) connection through the runtime path so the
    // repair has a non-workspace scope in front of it.
    const personalConnection = "77777777-7777-4777-8777-777777777777";
    const personalWorkspace = "88888888-8888-4888-8888-888888888888";
    // One statement batch = one implicit transaction, so the transaction-local
    // subject GUC the authority-binding trigger reads is still set at INSERT.
    await admin.unsafe(`
      insert into workspaces (id, account_id, name)
        values ('${personalWorkspace}', '${ACCOUNT}', 'rlsbackfill-personal');
      insert into organization_memberships (account_id, subject_id, status, personal_workspace_id)
        values ('${ACCOUNT}', 'rlsbackfill-subject', 'active', '${personalWorkspace}');
      select set_config('opengeni.subject_id', 'rlsbackfill-subject', true);
      insert into connections (
        id, account_id, workspace_id, subject_id, provider_domain, kind, credential_encrypted
      ) values (
        '${personalConnection}', '${ACCOUNT}', '${WORKSPACE}', 'rlsbackfill-subject',
        'example.com', 'oauth2', 'ciphertext'
      );
    `);
    const [personal] = await admin<Array<{ scope: string }>>`
      select authority_scope as scope from connections where id = ${personalConnection}
    `;
    // The binding trigger classifies it as a subject-owned row, never as
    // `workspace`, so the repair's `authority_scope = 'workspace'` predicate
    // must leave it entirely alone.
    expect(personal!.scope).not.toBe("workspace");

    const snapshotQuery = async () => ({
      connections: [
        ...(await admin<Array<{ id: string; scope: string; origin: string | null }>>`
          select id, authority_scope as scope, origin_workspace_id as origin
          from connections order by id
        `),
      ],
      // The ordinary (non-self-organization) membership must stay `member`:
      // 0263's predicate is an exact identity match, never a promotion of
      // whoever happens to hold a membership.
      memberships: [
        ...(await admin<Array<{ subjectId: string; role: string }>>`
          select subject_id as "subjectId", role from organization_memberships order by subject_id
        `),
      ],
    });
    const before = await snapshotQuery();
    expect(before.memberships).toEqual([
      { subjectId: "rlsbackfill-subject", role: "member" },
      { subjectId: "user:rlsbackfill-external", role: "owner" },
    ]);

    const ledger = postgres(ownerUrl, { max: 1, onnotice: () => undefined });
    try {
      await ledger`delete from schema_migrations where name = ${REPAIR_MIGRATION}`;
    } finally {
      await ledger.end({ timeout: 5 });
    }
    await migrate(ownerUrl);

    // Idempotent: identical rows, and no scope was reclassified or widened.
    expect(await snapshotQuery()).toEqual(before);
  }, 600_000);
});
