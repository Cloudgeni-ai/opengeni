// The one thing `migration-0335-slack-workspace-routing.test.ts` structurally
// cannot prove.
//
// `acquireSharedTestDatabase` hands out the container SUPERUSER, for whom
// `FORCE ROW LEVEL SECURITY` never engages, so a SECURITY DEFINER probe over a
// FORCE-RLS table looks correct there and returns ZERO rows in production.
// `slack_interactions` is FORCE-RLS with a strict-equality `workspace_isolation`
// policy, and OpenGeni migrates as a NOSUPERUSER NOBYPASSRLS owner, so the
// definer routine executes as a role that policy still binds.
//
// This file drives the real migration chain through
// `acquireOwnerMigratedTestDatabase` and asserts the property the whole
// thread-continuation design rests on: the probe resolves an interaction owned
// by workspace B while the caller is scoped to workspace A, and the caller
// still cannot read that row directly.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";
import { migrate } from "../src/migrate";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

const ACCOUNT = "aaaaaaaa-0335-4333-8333-aaaaaaaaaaaa";
const WORKSPACE_A = "11111111-0335-4333-8333-aaaaaaaaaaaa";
const WORKSPACE_B = "22222222-0335-4333-8333-bbbbbbbbbbbb";
const CONNECTION = "33333333-0335-4333-8333-cccccccccccc";
const INTERACTION = "44444444-0335-4333-8333-dddddddddddd";
const ROUTE_KEY = "C0335:1700000000.0001";
const PROBE_PASSWORD = "probe_role_password";

let owned: OwnerMigratedTestDatabase | null = null;
let appUrl: string | null = null;
let probeRole: string | null = null;

describe("migration 0335 tenancy probe under a non-superuser owner", () => {
  beforeAll(async () => {
    owned = await acquireOwnerMigratedTestDatabase("slack-tenancy-probe");
    if (!owned) {
      if (requireRealDatabase) {
        throw new Error("OPENGENI_REQUIRE_REAL_DB=1 but no owner-migrated database was available");
      }
      return;
    }
    await migrate(owned.ownerUrl);
    // Do NOT create or alter the cluster-global `opengeni_app` role: it is
    // shared by every suite on this container and the harness owns it. Use a
    // dedicated per-database login with exactly the privileges the migration
    // grants the runtime role.
    probeRole = `${owned.ownerRole}_probe`.slice(0, 63);
    await owned.admin.unsafe(`
      CREATE ROLE "${probeRole}" WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE
        NOCREATEDB NOREPLICATION NOINHERIT PASSWORD '${PROBE_PASSWORD}';
      GRANT USAGE ON SCHEMA public TO "${probeRole}";
      GRANT USAGE ON SCHEMA opengeni_private TO "${probeRole}";
      -- Mirror role provisioning for the public schema: the RESTRICTIVE
      -- session-visibility policy on slack_interactions resolves the session
      -- through helper routines that read sessions, exactly as it does for the
      -- real runtime role. None of this reaches the private schema tables, so
      -- the capability table stays unreachable, which the privilege assertions
      -- below pin.
      GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${probeRole}";
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO "${probeRole}";
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA opengeni_private TO "${probeRole}";
    `);
    await owned.admin.unsafe(`
      insert into managed_accounts (id, name) values ('${ACCOUNT}', 'probe');
      insert into workspaces (id, account_id, name) values
        ('${WORKSPACE_A}', '${ACCOUNT}', 'Home'),
        ('${WORKSPACE_B}', '${ACCOUNT}', 'Target');
      insert into connections
        (id, account_id, workspace_id, provider_domain, kind, status, credential_encrypted)
        values ('${CONNECTION}', '${ACCOUNT}', '${WORKSPACE_A}', 'slack.com', 'app_install',
                'active', '\\x00'::bytea);
      insert into slack_interactions
        (id, account_id, workspace_id, connection_id, slack_team_id, slack_channel_id,
         slack_thread_ts, route_key, triggering_provider_event_id, owning_subject_id, visibility)
        values ('${INTERACTION}', '${ACCOUNT}', '${WORKSPACE_B}', '${CONNECTION}', 'T0335',
                'C0335', '1700000000.0001', '${ROUTE_KEY}', 'Ev0335', 'user:probe', 'workspace');
    `);
    appUrl = owned.adminUrl.replace(
      /postgres:\/\/[^@]+@/u,
      `postgres://${probeRole}:${PROBE_PASSWORD}@`,
    );
  }, 900_000);

  afterAll(async () => {
    // Drop the per-database probe login before the harness drops the database:
    // its only privileges live there, so `DROP OWNED BY` leaves nothing behind.
    if (owned && probeRole) {
      await owned.admin
        .unsafe(`DROP OWNED BY "${probeRole}"; DROP ROLE IF EXISTS "${probeRole}"`)
        .catch(() => undefined);
    }
    await owned?.release();
  });

  test("resolves a target-workspace interaction while the caller is scoped elsewhere", async () => {
    if (!owned || !appUrl) return;
    const app = postgres(appUrl, { max: 1, onnotice: () => undefined });
    try {
      const observed = await app.begin(async (tx) => {
        await tx.unsafe(`select
          set_config('opengeni.account_id', '${ACCOUNT}', true),
          set_config('opengeni.workspace_id', '${WORKSPACE_A}', true)`);
        const direct = await tx.unsafe<Array<{ n: number }>>(
          `select count(*)::int as n from slack_interactions where id = '${INTERACTION}'`,
        );
        const probed = await tx.unsafe<
          Array<{ account_id: string; workspace_id: string; interaction_id: string }>
        >(
          `select account_id, workspace_id, interaction_id
             from opengeni_private.resolve_slack_interaction_tenancy(
               '${CONNECTION}'::uuid, '${ROUTE_KEY}')`,
        );
        const stillFenced = await tx.unsafe<Array<{ n: number }>>(
          `select count(*)::int as n from slack_interactions where id = '${INTERACTION}'`,
        );
        return { direct: direct[0]?.n, probed: [...probed], stillFenced: stillFenced[0]?.n };
      });
      // The caller cannot see the row before or after the probe: the capability
      // is transaction-local to the definer routine and is deleted on the way
      // out, so it never widens the calling role's own visibility.
      expect(observed.direct).toBe(0);
      expect(observed.stillFenced).toBe(0);
      expect(observed.probed).toEqual([
        { account_id: ACCOUNT, workspace_id: WORKSPACE_B, interaction_id: INTERACTION },
      ]);
    } finally {
      await app.end({ timeout: 5 });
    }
  }, 120_000);

  test("returns nothing for an unknown route and leaves no capability behind", async () => {
    if (!owned || !appUrl) return;
    const app = postgres(appUrl, { max: 1, onnotice: () => undefined });
    try {
      const probed = await app.unsafe<Array<Record<string, unknown>>>(
        `select * from opengeni_private.resolve_slack_interaction_tenancy(
           '${CONNECTION}'::uuid, 'C0335:absent')`,
      );
      expect([...probed]).toEqual([]);
    } finally {
      await app.end({ timeout: 5 });
    }
    const leftover = await owned.admin<Array<{ n: number }>>`
      select count(*)::int as n from opengeni_private.slack_routing_runtime_capabilities`;
    expect(leftover[0]?.n).toBe(0);
  }, 120_000);

  test("denies the probe role every direct privilege on the capability table", async () => {
    if (!owned || !appUrl) return;
    const app = postgres(appUrl, { max: 1, onnotice: () => undefined });
    try {
      let code: string | null = null;
      try {
        await app.unsafe(
          `insert into opengeni_private.slack_routing_runtime_capabilities
             (backend_pid, transaction_id, capability_kind)
           values (pg_backend_pid(), pg_current_xact_id(), 'interaction_tenancy')`,
        );
      } catch (error) {
        code = (error as { code?: string }).code ?? null;
      }
      expect(code).toBe("42501");
    } finally {
      await app.end({ timeout: 5 });
    }
  }, 120_000);

  test("grants opengeni_app the probe but never the capability table", async () => {
    if (!owned) return;
    // The migration's own grant block ran against the real runtime role, so
    // assert the shape it produced through the catalog rather than by logging
    // in as a role every other suite on this container shares.
    const [privileges] = await owned.admin<
      Array<{ probe: boolean; predicate: boolean; select: boolean; insert: boolean }>
    >`
      select
        has_function_privilege(
          'opengeni_app',
          'opengeni_private.resolve_slack_interaction_tenancy(uuid, text)',
          'EXECUTE') as probe,
        has_function_privilege(
          'opengeni_app',
          'opengeni_private.slack_routing_capability_active()',
          'EXECUTE') as predicate,
        has_table_privilege(
          'opengeni_app',
          'opengeni_private.slack_routing_runtime_capabilities',
          'SELECT') as select,
        has_table_privilege(
          'opengeni_app',
          'opengeni_private.slack_routing_runtime_capabilities',
          'INSERT') as insert`;
    expect(privileges).toEqual({
      probe: true,
      predicate: true,
      select: false,
      insert: false,
    });
  }, 120_000);
});
