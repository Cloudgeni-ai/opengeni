import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import type postgres from "postgres";
import { migrate } from "../src/migrate";

const migrationName = "0305_personal_resource_grant_management.sql";
const migrationPath = join(dirname(fileURLToPath(import.meta.url)), "../drizzle", migrationName);
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

async function expectSqlState(run: () => Promise<unknown>, code: string): Promise<void> {
  let captured: unknown;
  try {
    await run();
  } catch (error) {
    captured = error;
  }
  expect(captured).toBeDefined();
  expect((captured as { code?: string }).code).toBe(code);
}

describe("migration 0305 personal-resource grant management", () => {
  test("opens and closes one exact FORCE-RLS backfill window and hardens runtime paths", async () => {
    const source = await readFile(migrationPath, "utf8");
    const noForce = 'ALTER TABLE "organization_user_resource_grants" NO FORCE ROW LEVEL SECURITY;';
    const force = 'ALTER TABLE "organization_user_resource_grants" FORCE ROW LEVEL SECURITY;';
    const authorityNoForce =
      'ALTER TABLE "organization_user_resource_authorities" NO FORCE ROW LEVEL SECURITY;';
    const authorityForce =
      'ALTER TABLE "organization_user_resource_authorities" FORCE ROW LEVEL SECURITY;';
    expect(source.indexOf(noForce)).toBeGreaterThan(-1);
    expect(source.indexOf(force)).toBeGreaterThan(source.indexOf(noForce));
    expect(source.indexOf(authorityNoForce)).toBeGreaterThan(source.indexOf(noForce));
    expect(source.indexOf(authorityForce)).toBeGreaterThan(source.indexOf(force));
    expect(source).toContain("coalesce(prior_trigger_state, 'missing')");
    expect(source).toContain("prior_trigger_state IS NOT NULL AND prior_trigger_state <> 'D'");
    expect(source).toContain("ENABLE TRIGGER organization_user_resource_grants_action_contract");
    expect(source).toContain(
      "ENABLE REPLICA TRIGGER organization_user_resource_grants_action_contract",
    );
    expect(source).toContain(
      "ENABLE ALWAYS TRIGGER organization_user_resource_grants_action_contract",
    );
    expect(source.indexOf('UPDATE "organization_user_resource_grants"')).toBeGreaterThan(
      source.indexOf(noForce),
    );
    expect(source.indexOf('UPDATE "organization_user_resource_grants" grant_value')).toBeLessThan(
      source.indexOf(force),
    );
    expect(source).toContain("ALTER FUNCTION %I.list_self_user_resource_authorities");
    expect(source).toContain("SET search_path = pg_catalog, %I, pg_temp");
    expect(source).toContain("grant_value.action = CASE authority.resource_kind");
    expect(source).toContain("p_workspace_shared_acknowledged IS NOT TRUE");
    expect(source).toContain("p_limit IS NULL");
    expect(source).toContain("p_resource_kind IS NULL");
    expect(source).toContain("p_mode IS NULL");
    expect(source).toContain("p_context IS NULL");
    expect(source).toContain("FOREACH legacy_signature IN ARRAY ARRAY[");
    const legacyRevocationBlock = source.match(
      /FOREACH legacy_signature IN ARRAY ARRAY\[(.*?)\]\s+LOOP/s,
    )?.[1];
    expect(
      Array.from(legacyRevocationBlock?.matchAll(/'([^']+\([^']*\))'/g) ?? []).map(
        (match) => match[1],
      ),
    ).toEqual([
      "list_self_user_resource_authorities(uuid)",
      "issue_self_user_resource_grant(uuid,uuid,uuid,text,text,text,uuid,boolean)",
      "revoke_self_user_resource_grant(uuid,uuid)",
      "list_self_connection_authorities(uuid)",
      "issue_self_connection_use_grant(uuid,uuid,uuid,text,text,uuid,boolean)",
      "revoke_self_connection_use_grant(uuid,uuid)",
    ]);
    expect(source).toContain("pg_catalog.format('%I.%s', pg_catalog.current_schema()");
  });
});

describe("migration 0305 under a NOSUPERUSER NOBYPASSRLS owner", () => {
  let owned: OwnerMigratedTestDatabase | null = null;

  beforeAll(async () => {
    owned = await acquireOwnerMigratedTestDatabase("migration-0305-owner-migrated");
    if (!owned) {
      if (requireRealDatabase) {
        throw new Error(
          "[migration-0305] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
        );
      }
      return;
    }
    await migrate(owned.ownerUrl);
  }, 900_000);

  afterAll(async () => {
    await owned?.release();
  }, 180_000);

  test("expires canonical grants, revokes active mismatches, omits invalid history, and restores FORCE RLS", async () => {
    if (!owned) return;
    const { admin, ownerRole, ownerUrl } = owned;
    const [identity] = await admin<Array<{ superuser: boolean; bypassRls: boolean }>>`
      select rolsuper as "superuser", rolbypassrls as "bypassRls"
      from pg_roles where rolname = ${ownerRole}`;
    expect(identity).toEqual({ superuser: false, bypassRls: false });

    const accountId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    const subjectId = `user:migration-0305-${crypto.randomUUID()}`;
    const authorityId = crypto.randomUUID();
    const connectionAuthorityId = crypto.randomUUID();
    await admin`
      insert into managed_accounts (id, name, external_source, external_id)
      values (${accountId}, 'migration-0305', 'better-auth:user', ${accountId})`;
    await admin`
      insert into workspaces (id, account_id, name)
      values (${workspaceId}, ${accountId}, 'migration-0305 personal')`;
    await admin`
      insert into workspace_inference_controls (workspace_id, account_id)
      values (${workspaceId}, ${accountId})`;
    const [membership] = await admin<Array<{ id: string }>>`
      insert into organization_memberships (
        account_id, subject_id, status, personal_workspace_id
      ) values (${accountId}, ${subjectId}, 'active', ${workspaceId})
      returning id`;
    if (!membership) throw new Error("membership insert returned no row");
    await admin`
      insert into session_tenancy_activations (
        account_id, activation_version, inventory_digest, parity_digest, activated_by
      ) values (${accountId}, 1, ${"5".repeat(64)}, ${"6".repeat(64)}, 'migration-0305')`;
    await admin`
      insert into organization_user_resource_authorities (
        id, account_id, organization_membership_id, resource_kind, resource_id,
        origin_workspace_id, generation, status
      ) values (
        ${authorityId}, ${accountId}, ${membership.id}, 'rig', ${crypto.randomUUID()},
        ${workspaceId}, 1, 'active'
      )`;
    await admin`
      insert into organization_user_resource_authorities (
        id, account_id, organization_membership_id, resource_kind, resource_id,
        origin_workspace_id, generation, status
      ) values (
        ${connectionAuthorityId}, ${accountId}, ${membership.id}, 'connection',
        ${crypto.randomUUID()}, ${workspaceId}, 1, 'active'
      )`;

    const expiredId = crypto.randomUUID();
    const arbitraryId = crypto.randomUUID();
    const crossKindId = crypto.randomUUID();
    const invalidConnectionId = crypto.randomUUID();
    const terminalId = crypto.randomUUID();
    await admin`
      alter table organization_user_resource_grants
        disable trigger organization_user_resource_grants_action_contract`;
    await admin`
      insert into organization_user_resource_grants (
        id, account_id, authority_id, owner_organization_membership_id, workspace_id,
        action, mode, context, generation, status, expires_at, revoked_at
      ) values
        (${expiredId}, ${accountId}, ${authorityId}, ${membership.id}, ${workspaceId},
          'rig.use', 'always', 'user_private', 1, 'active', now() - interval '1 hour', null),
        (${arbitraryId}, ${accountId}, ${authorityId}, ${membership.id}, ${workspaceId},
          'provider.admin', 'always', 'user_private', 1, 'active', null, null),
        (${crossKindId}, ${accountId}, ${authorityId}, ${membership.id}, ${workspaceId},
          'connection.use', 'always', 'user_private', 1, 'active', null, null),
        (${invalidConnectionId}, ${accountId}, ${connectionAuthorityId}, ${membership.id},
          ${workspaceId}, 'provider.admin', 'always', 'user_private', 1, 'active', null, null),
        (${terminalId}, ${accountId}, ${authorityId}, ${membership.id}, ${workspaceId},
          'legacy.read', 'always', 'user_private', 5, 'revoked', null, now() - interval '2 hours')`;
    await admin`
      alter table organization_user_resource_grants
        enable trigger organization_user_resource_grants_action_contract`;

    await admin`delete from schema_migrations where name = ${migrationName}`;
    await migrate(ownerUrl);

    const rows = await admin<
      Array<{ id: string; status: string; generation: number; revokedAt: string | null }>
    >`
      select id, status, generation::int, revoked_at::text as "revokedAt"
      from organization_user_resource_grants
      where id in (
        ${expiredId}, ${arbitraryId}, ${crossKindId}, ${invalidConnectionId}, ${terminalId}
      )
      order by id`;
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(expiredId)).toMatchObject({ status: "expired", generation: 1 });
    expect(byId.get(arbitraryId)).toMatchObject({ status: "revoked", generation: 2 });
    expect(byId.get(arbitraryId)?.revokedAt).not.toBeNull();
    expect(byId.get(crossKindId)).toMatchObject({ status: "revoked", generation: 2 });
    expect(byId.get(crossKindId)?.revokedAt).not.toBeNull();
    expect(byId.get(invalidConnectionId)).toMatchObject({ status: "revoked", generation: 2 });
    expect(byId.get(invalidConnectionId)?.revokedAt).not.toBeNull();
    expect(byId.get(terminalId)).toMatchObject({ status: "revoked", generation: 5 });

    const [posture] = await admin<Array<{ forced: boolean }>>`
      select relforcerowsecurity as forced
      from pg_class
      where oid = 'organization_user_resource_grants'::regclass`;
    expect(posture).toEqual({ forced: true });
    const [trigger] = await admin<Array<{ enabled: string }>>`
      select tgenabled as enabled from pg_trigger
      where tgrelid = 'organization_user_resource_grants'::regclass
        and tgname = 'organization_user_resource_grants_action_contract'`;
    expect(trigger).toEqual({ enabled: "O" });

    await admin`
      alter table organization_user_resource_grants
        disable trigger organization_user_resource_grants_action_contract`;
    await admin`delete from schema_migrations where name = ${migrationName}`;
    await migrate(ownerUrl);
    const [disabledTrigger] = await admin<Array<{ enabled: string }>>`
      select tgenabled as enabled from pg_trigger
      where tgrelid = 'organization_user_resource_grants'::regclass
        and tgname = 'organization_user_resource_grants_action_contract'`;
    expect(disabledTrigger).toEqual({ enabled: "D" });
    await admin`
      alter table organization_user_resource_grants
        enable trigger organization_user_resource_grants_action_contract`;
    const legacySignatures = [
      "list_self_user_resource_authorities(uuid)",
      "issue_self_user_resource_grant(uuid,uuid,uuid,text,text,text,uuid,boolean)",
      "revoke_self_user_resource_grant(uuid,uuid)",
      "list_self_connection_authorities(uuid)",
      "issue_self_connection_use_grant(uuid,uuid,uuid,text,text,uuid,boolean)",
      "revoke_self_connection_use_grant(uuid,uuid)",
    ];
    const legacyPrivileges = await admin<Array<{ signature: string; executable: boolean }>>`
      select signature,
        has_function_privilege(
          'opengeni_app',
          to_regprocedure(format('%I.%s', current_schema(), signature)),
          'EXECUTE'
        ) as executable
      from unnest(${admin.array(legacySignatures)}::text[]) as signature
      order by signature`;
    expect(Array.from(legacyPrivileges)).toEqual(
      [...legacySignatures].sort().map((signature) => ({ signature, executable: false })),
    );
    const routines = await admin<Array<{ name: string; settings: string[] | null }>>`
      select proname as name, proconfig as settings
      from pg_proc
      where oid in (
        'list_self_user_resource_authorities(uuid,uuid,text,uuid,integer)'::regprocedure,
        'issue_self_user_resource_grant(uuid,uuid,uuid,text,text,text,uuid,integer,boolean)'::regprocedure,
        'revoke_self_user_resource_grant(uuid,uuid,uuid)'::regprocedure
      )
      order by proname`;
    expect(Array.from(routines)).toEqual([
      {
        name: "issue_self_user_resource_grant",
        settings: ["search_path=pg_catalog, public, pg_temp"],
      },
      {
        name: "list_self_user_resource_authorities",
        settings: ["search_path=pg_catalog, public, pg_temp"],
      },
      {
        name: "revoke_self_user_resource_grant",
        settings: ["search_path=pg_catalog, public, pg_temp"],
      },
    ]);

    const listed = await admin.begin(async (sql) => {
      await sql`select set_config('opengeni.account_id', ${accountId}, true)`;
      await sql`select set_config('opengeni.workspace_id', ${workspaceId}, true)`;
      await sql`select set_config('opengeni.subject_id', ${subjectId}, true)`;
      return await sql<Array<{ grantId: string | null; action: string | null }>>`
        select grant_id as "grantId", action
        from list_self_user_resource_authorities(
          ${accountId}::uuid, ${workspaceId}::uuid, 'rig', null, 50
        )`;
    });
    expect(listed.filter((row) => row.grantId !== null)).toEqual([
      { grantId: expiredId, action: "rig.use" },
    ]);

    const asAppRole = async (
      run: (sql: postgres.TransactionSql) => Promise<unknown>,
    ): Promise<unknown> =>
      await admin.begin(async (sql) => {
        await sql.unsafe("set local role opengeni_app");
        await sql`select set_config('opengeni.account_id', ${accountId}, true)`;
        await sql`select set_config('opengeni.workspace_id', ${workspaceId}, true)`;
        await sql`select set_config('opengeni.subject_id', ${subjectId}, true)`;
        return await run(sql as postgres.TransactionSql);
      });
    const issue = async (
      resourceKind: string | null,
      mode: string | null,
      context: string | null,
      acknowledged: boolean | null,
    ): Promise<unknown> =>
      await asAppRole(
        async (sql) =>
          await sql`
          select * from issue_self_user_resource_grant(
            ${accountId}::uuid, ${authorityId}::uuid, ${workspaceId}::uuid,
            ${resourceKind}::text, ${mode}::text, ${context}::text,
            null::uuid, null::integer, ${acknowledged}::boolean
          )
        `,
      );

    await expectSqlState(
      () =>
        asAppRole(
          async (sql) =>
            await sql`select * from list_self_user_resource_authorities(
            ${accountId}::uuid, ${workspaceId}::uuid, null::text, null::uuid, 50
          )`,
        ),
      "22023",
    );
    await expectSqlState(
      () =>
        asAppRole(
          async (sql) =>
            await sql`select * from list_self_user_resource_authorities(
            ${accountId}::uuid, ${workspaceId}::uuid, 'rig', null::uuid, null::integer
          )`,
        ),
      "22023",
    );
    await expectSqlState(() => issue(null, "always", "user_private", false), "22023");
    await expectSqlState(() => issue("rig", null, "user_private", false), "22023");
    await expectSqlState(() => issue("rig", "always", null, false), "22023");
    await expectSqlState(() => issue("rig", "always", "workspace_shared", null), "42501");

    const [grantCount] = await admin<Array<{ count: number }>>`
      select count(*)::int as count from organization_user_resource_grants
      where authority_id = ${authorityId}`;
    expect(grantCount?.count).toBe(4);
  }, 900_000);
});
