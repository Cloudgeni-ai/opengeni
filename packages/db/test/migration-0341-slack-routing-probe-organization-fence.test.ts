// Migration 0341 fences both Slack routing tenancy probes on the organization
// the caller is acting for. Crossing workspaces inside one organization is what
// routing is; crossing organizations never is.
//
// Driven through `acquireOwnerMigratedTestDatabase` because the shared harness
// hands out the container superuser, for whom FORCE ROW LEVEL SECURITY never
// engages, and the owner posture is exactly what a definer probe has to survive.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import { migrate } from "../src/migrate";

const migrationUrl = new URL(
  "../drizzle/0341_slack_routing_probe_organization_fence.sql",
  import.meta.url,
);
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

const ACCOUNT = "aaaaaaaa-0341-4341-8341-aaaaaaaaaaaa";
const OTHER_ACCOUNT = "bbbbbbbb-0341-4341-8341-bbbbbbbbbbbb";
const HOME_WORKSPACE = "11111111-0341-4341-8341-111111111111";
const TARGET_WORKSPACE = "22222222-0341-4341-8341-222222222222";
const CONNECTION = "33333333-0341-4341-8341-333333333333";
const INTERACTION = "44444444-0341-4341-8341-444444444444";
const ROUTE_KEY = "C0341:1700000000.0001";

let owned: OwnerMigratedTestDatabase | null = null;

describe("migration 0341 organization-fenced Slack routing probes", () => {
  beforeAll(async () => {
    owned = await acquireOwnerMigratedTestDatabase("slack-probe-fence");
    if (!owned) {
      if (requireRealDatabase) {
        throw new Error("OPENGENI_REQUIRE_REAL_DB=1 but no owner-migrated database was available");
      }
      return;
    }
    await migrate(owned.ownerUrl);
    await owned.admin.unsafe(`
      insert into managed_accounts (id, name) values
        ('${ACCOUNT}', 'fence'), ('${OTHER_ACCOUNT}', 'other');
      insert into workspaces (id, account_id, name) values
        ('${HOME_WORKSPACE}', '${ACCOUNT}', 'Home'),
        ('${TARGET_WORKSPACE}', '${ACCOUNT}', 'Target');
      insert into connections
        (id, account_id, workspace_id, provider_domain, kind, status, credential_encrypted)
        values ('${CONNECTION}', '${ACCOUNT}', '${HOME_WORKSPACE}', 'slack.com', 'app_install',
                'active', '\\x00'::bytea);
      insert into slack_interactions
        (id, account_id, workspace_id, connection_id, slack_team_id, slack_channel_id,
         slack_thread_ts, route_key, triggering_provider_event_id, owning_subject_id, visibility)
        values ('${INTERACTION}', '${ACCOUNT}', '${TARGET_WORKSPACE}', '${CONNECTION}', 'T0341',
                'C0341', '1700000000.0001', '${ROUTE_KEY}', 'Ev0341', 'user:fence', 'workspace');
    `);
  }, 900_000);

  afterAll(async () => {
    await owned?.release();
  });

  test("adds the fenced routines without dropping the ones an old image calls", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.startsWith("-- deployment-mode: rolling")).toBe(true);
    expect(source).toContain("SET search_path");
    expect(source).toContain("REVOKE ALL ON FUNCTION");
    // Expand-and-contract: dropping the unfenced pair here would break every
    // running old worker the moment this commits.
    expect(source).not.toMatch(/DROP\s+FUNCTION/u);
    expect(source).not.toContain("resolve_slack_installation");
  });

  test("resolves inside the organization and refuses across organizations", async () => {
    if (!owned) return;
    const rows = await owned.admin<Array<{ account_id: string; workspace_id: string }>>`
      select account_id, workspace_id
      from opengeni_private.resolve_slack_interaction_tenancy(
        ${ACCOUNT}::uuid, ${CONNECTION}::uuid, ${ROUTE_KEY})`;
    expect([...rows]).toEqual([{ account_id: ACCOUNT, workspace_id: TARGET_WORKSPACE }]);

    // The same connection and route key, named by another organization, learns
    // nothing at all - not even that the interaction exists.
    const foreign = await owned.admin<Array<Record<string, unknown>>>`
      select account_id, workspace_id
      from opengeni_private.resolve_slack_interaction_tenancy(
        ${OTHER_ACCOUNT}::uuid, ${CONNECTION}::uuid, ${ROUTE_KEY})`;
    expect([...foreign]).toEqual([]);

    const missing = await owned.admin<Array<Record<string, unknown>>>`
      select account_id, workspace_id
      from opengeni_private.resolve_slack_interaction_tenancy(
        null::uuid, ${CONNECTION}::uuid, ${ROUTE_KEY})`;
    expect([...missing]).toEqual([]);
  }, 120_000);

  test("fences the action-handle probe the same way", async () => {
    if (!owned) return;
    const [privileges] = await owned.admin<Array<{ fenced: boolean; unfenced: boolean }>>`
      select
        has_function_privilege(
          'opengeni_app',
          'opengeni_private.resolve_slack_action_handle_tenancy(uuid, uuid, uuid)',
          'EXECUTE') as fenced,
        has_function_privilege(
          'opengeni_app',
          'opengeni_private.resolve_slack_action_handle_tenancy(uuid, uuid)',
          'EXECUTE') as unfenced`;
    // Both are executable during the rolling window; the fenced one is what the
    // new image calls.
    expect(privileges).toEqual({ fenced: true, unfenced: true });

    const [definer] = await owned.admin<Array<{ security: string; config: string[] | null }>>`
      select case when p.prosecdef then 'definer' else 'invoker' end as security,
             p.proconfig as config
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'opengeni_private'
        and p.proname = 'resolve_slack_action_handle_tenancy'
        and p.pronargs = 3`;
    expect(definer?.security).toBe("definer");
    expect(definer?.config).toContain("search_path=opengeni_private, pg_catalog");
  }, 120_000);
});
