// Migration 0333 adds per-channel and per-DM Slack workspace routing as four
// FORCE-RLS tables plus additive inbox/interaction columns. Nothing reads them
// yet, so the proof that matters here is structural: tenant isolation, the
// same-organization fence, the composite target FK, the inbox's legacy arm, and
// the one narrow content-free definer probe.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { FORCE_RLS_TABLES, RUNTIME_FULL_DML_TABLES } from "../src/runtime-posture";

const migrationUrl = new URL("../drizzle/0333_slack_workspace_routing.sql", import.meta.url);
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

const ACCOUNT = "aaaaaaaa-0333-4333-8333-aaaaaaaaaaaa";
const OTHER_ACCOUNT = "bbbbbbbb-0333-4333-8333-bbbbbbbbbbbb";
const HOME_WORKSPACE = "11111111-0333-4333-8333-111111111111";
const TARGET_WORKSPACE = "22222222-0333-4333-8333-222222222222";
const OTHER_WORKSPACE = "33333333-0333-4333-8333-333333333333";
const CASCADE_WORKSPACE = "44444444-0333-4333-8333-444444444444";
const FOREIGN_WORKSPACE = "55555555-0333-4333-8333-555555555555";
const CONNECTION = "66666666-0333-4333-8333-666666666666";

const ROUTING_TABLES = [
  "slack_channel_routes",
  "slack_user_dm_routes",
  "slack_route_prompts",
  "slack_route_prompt_options",
] as const;

let shared: SharedTestDatabase | null = null;
let app: postgres.Sql | null = null;

/** Run one statement batch as `opengeni_app` under an exact tenant scope. */
async function asTenant<T>(
  accountId: string,
  workspaceId: string,
  run: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  if (!app) throw new Error("database unavailable");
  // `begin` is typed to unwrap a returned promise ARRAY, which it never does for
  // the single values these helpers return, so the generic needs restating.
  const result = await app.begin(async (tx) => {
    await tx`select
      set_config('opengeni.account_id', ${accountId}, true),
      set_config('opengeni.workspace_id', ${workspaceId}, true)`;
    return await run(tx);
  });
  return result as T;
}

async function captureSqlState(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
  } catch (error) {
    return (error as { code?: string }).code ?? null;
  }
  return null;
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("migration-0333-slack-workspace-routing");
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error(
        "[migration-0333-slack-workspace-routing] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
      );
    }
    return;
  }
  app = postgres(shared.appUrl, { max: 2, onnotice: () => undefined });
  await shared.admin.unsafe(`
    insert into managed_accounts (id, name) values
      ('${ACCOUNT}', 'slack-routing-account'),
      ('${OTHER_ACCOUNT}', 'slack-routing-foreign-account');
    insert into workspaces (id, account_id, name) values
      ('${HOME_WORKSPACE}', '${ACCOUNT}', 'Home'),
      ('${TARGET_WORKSPACE}', '${ACCOUNT}', 'Target'),
      ('${OTHER_WORKSPACE}', '${ACCOUNT}', 'Other'),
      ('${CASCADE_WORKSPACE}', '${ACCOUNT}', 'Cascade'),
      ('${FOREIGN_WORKSPACE}', '${OTHER_ACCOUNT}', 'Foreign');
    insert into connections (
      id, account_id, workspace_id, provider_domain, kind, credential_encrypted
    ) values (
      '${CONNECTION}', '${ACCOUNT}', '${HOME_WORKSPACE}', 'routing.test', 'app_install', 'sealed'
    );
  `);
}, 180_000);

afterAll(async () => {
  await app?.end({ timeout: 5 });
  await shared?.release();
}, 180_000);

describe("migration 0333 Slack workspace routing", () => {
  test("declares a rolling additive migration that leaves installation authority alone", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: rolling");
    for (const table of ROUTING_TABLES) {
      expect(source).toContain(`CREATE TABLE "${table}"`);
      expect(source).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
      expect(source).toContain(`CREATE POLICY workspace_isolation ON "${table}"`);
      expect(FORCE_RLS_TABLES).toContain(table);
      expect(RUNTIME_FULL_DML_TABLES).toContain(table);
    }
    expect(source).toContain("resolve_slack_interaction_tenancy");
    // The probe is schema-qualified because it now opens a private capability
    // before reading the FORCE-RLS interaction table.
    expect(source).toContain("SET search_path = %1$I, pg_catalog");
    expect(source).toContain("slack_routing_capability_active");
    expect(source).toContain("CREATE POLICY slack_routing_capability_read");
    expect(source).toContain("REVOKE ALL ON FUNCTION");

    // The installation binding stays frozen: one team still installs into one
    // home workspace and one credential. Routing is a separate additive fact.
    // Assert on DDL verbs rather than bare names, because the migration's own
    // comments deliberately explain what it is NOT touching and why.
    const executableSource = source.replace(/^\s*--.*$/gmu, "");
    expect(executableSource).not.toMatch(
      /FUNCTION\s+opengeni_private\.resolve_slack_installation/u,
    );
    expect(executableSource).not.toMatch(/FUNCTION\s+opengeni_private\.sync_slack_installation/u);
    expect(executableSource).not.toContain("slack_installation_bindings");
    expect(executableSource).not.toContain("CREATE TRIGGER");
    expect(executableSource).not.toMatch(/DROP\s+(INDEX|TRIGGER|POLICY|FUNCTION|TABLE|COLUMN)/u);
    // Exactly one new privileged routine, and it is the ids-only probe.
    expect(executableSource.match(/CREATE (OR REPLACE )?FUNCTION/gu)).toEqual([
      "CREATE FUNCTION",
      "CREATE FUNCTION",
    ]);

    // Rolling safety is the absence of a backfill: an absent route is exactly
    // today's behaviour, so there is nothing to rewrite.
    expect(source).not.toMatch(/^\s*UPDATE /mu);
    expect(source).not.toMatch(/INSERT INTO .* SELECT/iu);
    expect(source).not.toContain("NO FORCE ROW LEVEL SECURITY");
  });

  test("grants the runtime full DML on the routing tables and execute on the ids-only probe", async () => {
    if (!shared) return;
    const [privileges] = await shared.admin<Array<Record<string, boolean>>>`select
        has_table_privilege('opengeni_app', 'slack_channel_routes', 'select') as "channelSelect",
        has_table_privilege('opengeni_app', 'slack_channel_routes', 'insert') as "channelInsert",
        has_table_privilege('opengeni_app', 'slack_channel_routes', 'update') as "channelUpdate",
        has_table_privilege('opengeni_app', 'slack_channel_routes', 'delete') as "channelDelete",
        has_table_privilege('opengeni_app', 'slack_user_dm_routes', 'insert') as "dmInsert",
        has_table_privilege('opengeni_app', 'slack_route_prompts', 'insert') as "promptInsert",
        has_table_privilege('opengeni_app', 'slack_route_prompt_options', 'insert') as "optionInsert",
        has_function_privilege('opengeni_app',
          'opengeni_private.resolve_slack_interaction_tenancy(uuid,text)', 'execute') as "appProbe",
        has_function_privilege('public',
          'opengeni_private.resolve_slack_interaction_tenancy(uuid,text)', 'execute') as "publicProbe"`;
    expect(privileges).toEqual({
      channelSelect: true,
      channelInsert: true,
      channelUpdate: true,
      channelDelete: true,
      dmInsert: true,
      promptInsert: true,
      optionInsert: true,
      appProbe: true,
      publicProbe: false,
    });

    const [probe] = await shared.admin<Array<{ security: string; config: string[] | null }>>`
      select
        case when p.prosecdef then 'definer' else 'invoker' end as security,
        p.proconfig as config
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'opengeni_private'
        and p.proname = 'resolve_slack_interaction_tenancy'`;
    expect(probe?.security).toBe("definer");
    expect(probe?.config).toContain("search_path=public, pg_catalog");
  });

  test("carries a workspace_isolation policy with both USING and WITH CHECK on every table", async () => {
    if (!shared) return;
    const policies = await shared.admin<
      Array<{ tablename: string; qual: string | null; withCheck: string | null }>
    >`select tablename, qual, with_check as "withCheck"
      from pg_policies
      where schemaname = current_schema()
        and policyname = 'workspace_isolation'
        and tablename = any(${ROUTING_TABLES as unknown as string[]})
      order by tablename`;
    expect(policies.map((row) => row.tablename).sort()).toEqual([...ROUTING_TABLES].sort());
    for (const policy of policies) {
      expect(policy.qual).toContain("workspace_rls_visible");
      expect(policy.withCheck).toContain("workspace_rls_visible");
    }
  });

  test("isolates route rows to their home tenant and refuses a mismatched WITH CHECK", async () => {
    if (!shared) return;
    await asTenant(ACCOUNT, HOME_WORKSPACE, async (tx) => {
      await tx`insert into slack_channel_routes (
        account_id, workspace_id, connection_id, slack_team_id, slack_channel_id,
        target_account_id, target_workspace_id, decided_by_subject_id,
        decided_by_slack_user_id, source
      ) values (
        ${ACCOUNT}, ${HOME_WORKSPACE}, ${CONNECTION}, 'T0333', 'C-ISOLATION',
        ${ACCOUNT}, ${TARGET_WORKSPACE}, 'user:isolation', 'U0333', 'picker'
      )`;
    });

    const visible = await asTenant(
      ACCOUNT,
      HOME_WORKSPACE,
      async (tx) =>
        await tx<Array<{ slackChannelId: string }>>`
          select slack_channel_id as "slackChannelId" from slack_channel_routes`,
    );
    expect(visible.map((row) => row.slackChannelId)).toEqual(["C-ISOLATION"]);

    // The same row under a sibling workspace's scope is not merely filtered by a
    // WHERE clause; it is invisible.
    const hidden = await asTenant(
      ACCOUNT,
      OTHER_WORKSPACE,
      async (tx) => await tx`select slack_channel_id from slack_channel_routes`,
    );
    expect(hidden.length).toBe(0);

    const writeAcrossScope = await captureSqlState(async () =>
      asTenant(
        ACCOUNT,
        HOME_WORKSPACE,
        async (tx) =>
          await tx`insert into slack_channel_routes (
            account_id, workspace_id, connection_id, slack_team_id, slack_channel_id,
            target_account_id, target_workspace_id, decided_by_subject_id,
            decided_by_slack_user_id, source
          ) values (
            ${ACCOUNT}, ${OTHER_WORKSPACE}, ${CONNECTION}, 'T0333', 'C-SMUGGLED',
            ${ACCOUNT}, ${TARGET_WORKSPACE}, 'user:isolation', 'U0333', 'picker'
          )`,
      ),
    );
    expect(writeAcrossScope).toBe("42501");
  });

  test("fences routing to one organization", async () => {
    if (!shared) return;
    const crossOrganization = await captureSqlState(
      async () =>
        await shared!.admin`insert into slack_channel_routes (
          account_id, workspace_id, connection_id, slack_team_id, slack_channel_id,
          target_account_id, target_workspace_id, decided_by_subject_id,
          decided_by_slack_user_id, source
        ) values (
          ${ACCOUNT}, ${HOME_WORKSPACE}, ${CONNECTION}, 'T0333', 'C-CROSS-ORG',
          ${OTHER_ACCOUNT}, ${FOREIGN_WORKSPACE}, 'user:cross', 'U0333', 'admin'
        )`,
    );
    expect(crossOrganization).toBe("23514");

    const unknownSource = await captureSqlState(
      async () =>
        await shared!.admin`insert into slack_user_dm_routes (
          account_id, workspace_id, connection_id, slack_team_id, slack_user_id,
          target_account_id, target_workspace_id, decided_by_subject_id,
          decided_by_slack_user_id, source
        ) values (
          ${ACCOUNT}, ${HOME_WORKSPACE}, ${CONNECTION}, 'T0333', 'U-BAD-SOURCE',
          ${ACCOUNT}, ${TARGET_WORKSPACE}, 'user:cross', 'U0333', 'guessed'
        )`,
    );
    expect(unknownSource).toBe("23514");

    const crossOrganizationDm = await captureSqlState(
      async () =>
        await shared!.admin`insert into slack_user_dm_routes (
          account_id, workspace_id, connection_id, slack_team_id, slack_user_id,
          target_account_id, target_workspace_id, decided_by_subject_id,
          decided_by_slack_user_id, source
        ) values (
          ${ACCOUNT}, ${HOME_WORKSPACE}, ${CONNECTION}, 'T0333', 'U-CROSS-ORG',
          ${OTHER_ACCOUNT}, ${FOREIGN_WORKSPACE}, 'user:cross', 'U0333', 'picker'
        )`,
    );
    expect(crossOrganizationDm).toBe("23514");

    const promptId = crypto.randomUUID();
    await shared.admin`insert into slack_route_prompts (
      id, account_id, workspace_id, connection_id, inbox_id, slack_team_id,
      slack_user_id, slack_channel_id, slack_message_ts, provider_event_id,
      trigger_kind, request_text, has_files, message_operation_id, status, expires_at
    ) values (
      ${promptId}, ${ACCOUNT}, ${HOME_WORKSPACE}, ${CONNECTION}, ${crypto.randomUUID()},
      'T0333', 'U0333', 'C-PROMPT-ORG', '1.0', ${`ev-org-${promptId}`},
      'app_mention', 'do it', false, ${crypto.randomUUID()}, 'pending', now() + interval '10 minutes'
    )`;
    const crossOrganizationOption = await captureSqlState(
      async () =>
        await shared!.admin`insert into slack_route_prompt_options (
          account_id, workspace_id, prompt_id, candidate_account_id,
          candidate_workspace_id, candidate_label, position
        ) values (
          ${ACCOUNT}, ${HOME_WORKSPACE}, ${promptId}, ${OTHER_ACCOUNT},
          ${FOREIGN_WORKSPACE}, 'Foreign', 1
        )`,
    );
    expect(crossOrganizationOption).toBe("23514");
  });



  test("cascades a route away with its target workspace through the composite FK", async () => {
    if (!shared) return;
    await shared.admin`insert into slack_channel_routes (
      account_id, workspace_id, connection_id, slack_team_id, slack_channel_id,
      target_account_id, target_workspace_id, decided_by_subject_id,
      decided_by_slack_user_id, source
    ) values (
      ${ACCOUNT}, ${HOME_WORKSPACE}, ${CONNECTION}, 'T0333', 'C-CASCADE',
      ${ACCOUNT}, ${CASCADE_WORKSPACE}, 'user:cascade', 'U0333', 'admin'
    )`;
    await shared.admin`delete from workspaces where id = ${CASCADE_WORKSPACE}`;
    const [{ remaining } = { remaining: "1" }] = await shared.admin<Array<{ remaining: string }>>`
      select count(*)::text as remaining
      from slack_channel_routes where slack_channel_id = 'C-CASCADE'`;
    expect(remaining).toBe("0");
  });

  test("keeps the inbox legacy arm open and both routed arms consistent", async () => {
    if (!shared) return;
    const insertInbox = (
      suffix: string,
      routeColumns: string,
      routeValues: string,
    ): Promise<unknown> =>
      shared!.admin.unsafe(`
        insert into slack_interaction_inbox (
          account_id, workspace_id, connection_id, provider_event_id, provider_message_id,
          slack_team_id, slack_user_id, slack_channel_id, slack_message_ts, trigger_kind,
          text${routeColumns}
        ) values (
          '${ACCOUNT}', '${HOME_WORKSPACE}', '${CONNECTION}', 'Ev0333-${suffix}',
          'Msg0333-${suffix}', 'T0333', 'U0333', 'C0333', '1700000000.0001',
          'app_mention', 'route check'${routeValues}
        )`);

    // Legacy arm: no routing columns at all is exactly pre-routing behaviour.
    await insertInbox("legacy", "", "");

    // A resolved route must name its target.
    expect(
      await captureSqlState(async () =>
        insertInbox("bad-resolved", ", route_state", ", 'resolved'"),
      ),
    ).toBe("23514");
    // An awaiting_choice route must name its prompt, and must NOT name a target.
    expect(
      await captureSqlState(async () =>
        insertInbox("bad-await", ", route_state", ", 'awaiting_choice'"),
      ),
    ).toBe("23514");
    // A target account without a target workspace is never a legal half.
    expect(
      await captureSqlState(async () =>
        insertInbox("bad-half", ", route_state, target_account_id", `, 'resolved', '${ACCOUNT}'`),
      ),
    ).toBe("23514");
    // An unknown route state is refused outright.
    expect(
      await captureSqlState(async () => insertInbox("bad-state", ", route_state", ", 'guessed'")),
    ).toBe("23514");
    // The inbox is fenced to one organization exactly like every route table:
    // this is the row the pump actually claims and routes from.
    expect(
      await captureSqlState(async () =>
        insertInbox(
          "bad-org",
          ", route_state, target_account_id, target_workspace_id",
          `, 'resolved', '${OTHER_ACCOUNT}', '${FOREIGN_WORKSPACE}'`,
        ),
      ),
    ).toBe("23514");

    await insertInbox(
      "resolved",
      ", route_state, target_account_id, target_workspace_id",
      `, 'resolved', '${ACCOUNT}', '${TARGET_WORKSPACE}'`,
    );
    await insertInbox(
      "awaiting",
      ", route_state, route_prompt_id",
      `, 'awaiting_choice', '${CONNECTION}'`,
    );

    const rows = await shared.admin<Array<{ providerEventId: string; routeState: string | null }>>`
      select provider_event_id as "providerEventId", route_state as "routeState"
      from slack_interaction_inbox
      where connection_id = ${CONNECTION}
      order by provider_event_id`;
    expect([...rows]).toEqual([
      { providerEventId: "Ev0333-awaiting", routeState: "awaiting_choice" },
      { providerEventId: "Ev0333-legacy", routeState: null },
      { providerEventId: "Ev0333-resolved", routeState: "resolved" },
    ]);
  });

  test("bounds the frozen routed workspace label on slack_interactions", async () => {
    if (!shared) return;
    const insertInteraction = (routeKey: string, label: string | null): Promise<unknown> =>
      shared!.admin`insert into slack_interactions (
        account_id, workspace_id, connection_id, slack_team_id, slack_channel_id,
        slack_thread_ts, route_key, triggering_provider_event_id, owning_subject_id,
        visibility, routed_workspace_label
      ) values (
        ${ACCOUNT}, ${TARGET_WORKSPACE}, ${CONNECTION}, 'T0333', 'C0333',
        '1700000000.0002', ${routeKey}, 'Ev0333-interaction', 'user:label',
        'workspace', ${label}
      )`;

    await insertInteraction("route-label-null", null);
    expect(await captureSqlState(async () => insertInteraction("route-label-empty", ""))).toBe(
      "23514",
    );
    expect(
      await captureSqlState(async () => insertInteraction("route-label-long", "x".repeat(129))),
    ).toBe("23514");
    await insertInteraction("route-label-ok", "Target");
  });
});
