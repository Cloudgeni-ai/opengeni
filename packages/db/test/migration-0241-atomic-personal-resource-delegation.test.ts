import { describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase } from "@opengeni/testing";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { createDb, createSession, transitionSessionVisibility } from "../src";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

const migrationUrl = new URL(
  "../drizzle/0241_atomic_personal_resource_delegation.sql",
  import.meta.url,
);
const runtimePostureUrl = new URL("../src/runtime-posture.ts", import.meta.url);
const provisionRolesUrl = new URL("../src/provision-roles.ts", import.meta.url);

describe("migration 0241 atomic personal-resource delegation", () => {
  test("freezes the complete admission, snapshot, consumption, and runtime posture", async () => {
    const source = await readFile(migrationUrl, "utf8");
    const executableSource = source.replace(/^--.*$/gmu, "");

    expect(source.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: rolling");

    // The slice is deliberately attempt-only. Secret loading, materialization,
    // scheduled activation/snapshots, CRUD, and Rig-default runtime activation
    // remain owned by later work.
    expect(executableSource).not.toMatch(/\b(?:scheduled_tasks|scheduled_task_runs)\b/iu);
    expect(executableSource).not.toMatch(/\b(?:value_encrypted|secret_value|plaintext_value)\b/iu);
    expect(executableSource).not.toMatch(
      /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+TABLE)\b[^;]*materializ/iu,
    );
    expect(executableSource).not.toMatch(
      /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+[^\n]*(?:create|update|delete|bind)_(?:variable_set|rig)/iu,
    );
    expect(source).toContain("It does not load secrets, materialize resources");

    // A private transaction capability, not a caller-set lifecycle GUC, crosses
    // the FORCE-RLS owner boundary. The application role cannot read or write
    // the capability or immutable ledgers directly.
    expect(source).toContain(
      "CREATE TABLE opengeni_private.personal_resource_delegation_capabilities",
    );
    expect(source).toContain("\"capability_kind\" IN ('admit', 'resolve')");
    expect(source).toContain(
      "REVOKE ALL ON TABLE opengeni_private.personal_resource_delegation_capabilities FROM PUBLIC",
    );
    expect(source).toContain(
      "REVOKE ALL ON TABLE opengeni_private.personal_resource_delegation_capabilities\n      FROM opengeni_app",
    );
    expect(source).toContain(
      "CREATE OR REPLACE FUNCTION opengeni_private.personal_resource_delegation_capability_active",
    );
    expect(source).toContain("STABLE\nSECURITY DEFINER\nSET search_path = pg_catalog");
    expect(source).toContain(
      "REVOKE ALL ON FUNCTION\n  opengeni_private.personal_resource_delegation_capability_active(text)\n  FROM PUBLIC",
    );
    expect(source).toContain(
      "GRANT EXECUTE ON FUNCTION\n      opengeni_private.personal_resource_delegation_capability_active(text)\n      TO opengeni_app",
    );
    expect(source).toContain(
      "opengeni_private.personal_resource_delegation_capability_active(''admit'')",
    );
    expect(source).toContain("opengeni_private.personal_resource_delegation_capability_active()");
    const policySource = source.slice(
      source.indexOf("DO $personal_resource_capability_policies$"),
      source.indexOf("DO $personal_resource_delegation_functions$"),
    );
    expect(policySource).not.toContain(
      "FROM opengeni_private.personal_resource_delegation_capabilities",
    );
    expect(executableSource).not.toContain("opengeni.organization_tenancy_lifecycle");

    // One exact-attempt admission header and one normalized row per unique
    // personal resource freeze the full authority tuple and exact selection.
    for (const table of [
      "session_attempt_personal_resource_admissions",
      "session_attempt_personal_resource_snapshots",
      "personal_resource_once_consumption_receipts",
    ]) {
      expect(source).toContain(`CREATE TABLE "${table}"`);
      expect(source).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
      expect(source).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
      expect(source).toContain(`REVOKE ALL ON TABLE "${table}" FROM opengeni_app`);
    }
    expect(source).toContain(
      'PRIMARY KEY (\n    "attempt_id", "resource_kind", "resource_id"\n  )',
    );
    expect(source).toContain('"selection_sources" text[] NOT NULL');
    expect(source).toContain('"membership_authorization_revision" bigint NOT NULL');
    expect(source).toContain('"authority_generation" bigint NOT NULL');
    expect(source).toContain('"target_workspace_id" uuid NOT NULL');
    expect(source).toContain('"session_visibility" text NOT NULL');
    expect(source).toContain('"session_authority_epoch" integer NOT NULL');
    expect(source).toContain('"grant_generation" bigint NOT NULL');
    expect(source).toContain('"grant_mode" text NOT NULL');
    expect(source).toContain('"grant_context" text NOT NULL');
    expect(source).toContain("session_attempt_personal_resource_snapshots_admission_fk");
    expect(source).toContain("session_attempt_personal_resource_snapshots_authority_fk");
    expect(source).toContain("session_attempt_personal_resource_snapshots_grant_fk");
    expect(source).toContain("session_attempt_personal_resource_snapshots_workspace_chk");
    expect(source).toContain("session_attempt_personal_resource_snapshots_grant_fence_chk");

    // Selection is server-read from the immutable session and exact rig version,
    // then deduplicated across direct and transitive provenance.
    expect(source).toContain("session_row.variable_set_id");
    expect(source).toContain("session_row.rig_id");
    expect(source).toContain("session_row.rig_version_id");
    expect(source).toContain("jsonb_array_elements_text");
    expect(source).toContain("WITH ORDINALITY default_id(value, ordinality)");
    expect(source).toContain("'session_variable_set'::text");
    expect(source).toContain("'session_rig'::text");
    expect(source).toContain("'rig_default_variable_set:'");
    expect(source).toContain(
      "array_agg(selection_source ORDER BY selection_source) AS selection_sources",
    );
    expect(source).toContain("GROUP BY resource_kind, resource_id, action");

    // The owner is derived from immutable turn provenance, then checked as one
    // active organization member with current target-workspace membership.
    expect(source).toContain("turn_row.initiating_human_subject_id");
    expect(source).toContain("turn_row.initiator_kind = 'subject'");
    expect(source).toContain("membership.subject_id = initiating_subject");
    expect(source).toContain("membership.status = 'active'");
    expect(source).toContain("membership.revoked_at IS NULL");
    expect(source).toContain("membership.personal_workspace_id IS NOT NULL");
    expect(source).toContain("workspace_membership.workspace_id = NEW.workspace_id");
    expect(source).toContain("workspace_membership.subject_id = initiating_subject");
    expect(source).toContain("member_row.authorization_revision");
    expect(source).toContain(
      "resource_row.owner_organization_membership_id IS DISTINCT FROM member_row.id",
    );
    expect(source).toContain(
      "resource_row.resource_workspace_id IS DISTINCT FROM member_row.personal_workspace_id",
    );
    expect(source).toContain(
      "resource_row.origin_workspace_id IS DISTINCT FROM member_row.personal_workspace_id",
    );

    // Admission is attached to accepted attempt insertion and checks exact
    // session visibility/epoch/owner before any resource grant is considered.
    expect(source).toContain("RETURNS trigger");
    expect(source).toContain("AFTER INSERT ON %I.session_turn_attempts");
    expect(source).toContain("NEW.authority_visibility IS DISTINCT FROM session_row.visibility");
    expect(source).toContain("NEW.authority_epoch IS DISTINCT FROM session_row.authority_epoch");
    expect(source).toContain(
      "NEW.authority_owner_organization_membership_id\n          IS DISTINCT FROM session_row.owner_organization_membership_id",
    );
    const selectionCountIndex = source.indexOf("SELECT count(*)::integer INTO resource_total");
    const emptySelectionIndex = source.indexOf("IF resource_total = 0 THEN");
    const authorityFenceIndex = source.indexOf("IF NEW.execution_generation <= 0");
    expect(selectionCountIndex).toBeGreaterThan(-1);
    expect(emptySelectionIndex).toBeGreaterThan(selectionCountIndex);
    expect(authorityFenceIndex).toBeGreaterThan(emptySelectionIndex);
    expect(source).toContain("authority.status = 'active'");
    expect(source).toContain("authority.revoked_at IS NULL");

    // Grants are exact for target workspace, action, visibility, generation and
    // expiration. Session/once modes require the exact session+epoch; always is
    // explicitly unfenced from a session and epoch.
    expect(source).toContain("grant_value.workspace_id = NEW.workspace_id");
    expect(source).toContain("grant_value.action = resource_row.action");
    expect(source).toContain("grant_value.context = session_row.visibility");
    expect(source).toContain("grant_value.status = 'active'");
    expect(source).toContain("grant_value.mode IN ('once', 'session')");
    expect(source).toContain("grant_value.session_id = NEW.session_id");
    expect(source).toContain("grant_value.authority_epoch = session_row.authority_epoch");
    expect(source).toContain("grant_value.mode = 'always'");
    expect(source).toContain("grant_value.session_id IS NULL");
    expect(source).toContain("grant_value.authority_epoch IS NULL");
    expect(source).toContain("FOR UPDATE");
    expect(source).toContain("rig_version.workspace_id = member_row.personal_workspace_id");
    expect(source).toContain("rig_version.workspace_id = snapshot.origin_workspace_id");

    // A once grant is changed exactly once under its row lock and gets one
    // durable exact-attempt receipt. Retry/replay resolves only through that
    // receipt; another attempt cannot adopt an already-consumed grant.
    expect(source).toContain('"grant_id" uuid PRIMARY KEY');
    expect(source).toContain("SET status = 'consumed', updated_at = clock_timestamp()");
    expect(source).toContain("AND generation = grant_row.generation");
    expect(source).toContain("AND status = 'active'");
    expect(source).toContain("IF affected <> 1 THEN");
    expect(source).toContain("USING ERRCODE = '40001'");
    expect(source).toContain("snapshot.grant_mode = 'once'");
    expect(source).toContain("grant_value.status = 'consumed'");
    expect(source).toContain("receipt.attempt_id = snapshot.attempt_id");
    expect(source).toContain("receipt.authority_generation = snapshot.authority_generation");
    expect(source).toContain("receipt.grant_generation = snapshot.grant_generation");

    // The sole runtime surface is identifier-only exact-attempt revalidation;
    // it is SECURITY DEFINER, non-public, app-executable, and fail-closed on
    // attempt, membership/workspace, resource, authority, visibility or grant drift.
    expect(source).toContain(
      "CREATE OR REPLACE FUNCTION %1$I.resolve_session_attempt_personal_resources",
    );
    expect(source).toContain("LANGUAGE plpgsql\n    SECURITY DEFINER");
    expect(source).toContain(
      "REVOKE ALL ON FUNCTION resolve_session_attempt_personal_resources(uuid, uuid, uuid)\n  FROM PUBLIC",
    );
    expect(source).toContain(
      "GRANT EXECUTE ON FUNCTION resolve_session_attempt_personal_resources(uuid, uuid, uuid)\n      TO opengeni_app",
    );
    expect(source).toContain("attempt.state IN ('claimed', 'running')");
    expect(source).toContain("attempt.quiesced_at IS NULL");
    expect(source).toContain(
      "membership.authorization_revision\n                = snapshot.membership_authorization_revision",
    );
    expect(source).toContain("authority.generation = snapshot.authority_generation");
    expect(source).toContain("session_value.visibility = snapshot.session_visibility");
    expect(source).toContain("session_value.authority_epoch = snapshot.session_authority_epoch");
    expect(source).toContain("personal-resource authority snapshot is no longer live");

    const runtimePosture = await readFile(runtimePostureUrl, "utf8");
    const provisionRolesSource = await readFile(provisionRolesUrl, "utf8");
    expect(runtimePosture).toContain(
      '"resolve_session_attempt_personal_resources(uuid, uuid, uuid)"',
    );
    for (const table of [
      "session_attempt_personal_resource_admissions",
      "session_attempt_personal_resource_snapshots",
      "personal_resource_once_consumption_receipts",
    ]) {
      expect(runtimePosture).toContain(`"${table}"`);
    }
    expect(provisionRolesSource).toContain(
      "resolve_session_attempt_personal_resources(uuid,uuid,uuid)",
    );
    expect(provisionRolesSource).toContain(
      "REVOKE ALL ON FUNCTION %I.resolve_session_attempt_personal_resources(uuid, uuid, uuid) FROM PUBLIC",
    );
    expect(provisionRolesSource).toContain(
      "GRANT EXECUTE ON FUNCTION %I.resolve_session_attempt_personal_resources(uuid, uuid, uuid) TO %I",
    );
    expect(provisionRolesSource).toContain(
      "opengeni_private.personal_resource_delegation_capability_active(text)",
    );
    expect(runtimePosture).toContain('"personal_resource_delegation_capability_active(text)"');
    expect(runtimePosture).toContain('"personal_resource_delegation_capabilities"');
  });

  for (const order of ["migrate-then-provision", "provision-then-migrate"] as const) {
    test(`converges helper ACLs after ${order} without breaking ordinary app-role RLS`, async () => {
      const appPassword = "apppw";
      const blank = await acquireBlankTestDatabase(`migration-0241-capability-${order}`);
      if (!blank) return;

      if (order === "migrate-then-provision") {
        await migrate(blank.databaseUrl);
        await provisionRoles(blank.databaseUrl, {
          appPassword,
          rlsStrategy: "force",
        });
      } else {
        await provisionRoles(blank.databaseUrl, {
          appPassword,
          rlsStrategy: "force",
        });
        await migrate(blank.databaseUrl);
      }

      const admin = postgres(blank.databaseUrl, {
        max: 4,
        prepare: false,
        onnotice: () => undefined,
      });
      const appUrl = new URL(blank.databaseUrl);
      appUrl.username = "opengeni_app";
      appUrl.password = appPassword;
      const app = postgres(appUrl.toString(), {
        max: 1,
        prepare: false,
        onnotice: () => undefined,
      });
      try {
        const [posture] = await admin<
          Array<{
            sameOwner: boolean;
            securityDefiner: boolean;
            hardenedSearchPath: boolean;
            appExecute: boolean;
            publicExecute: boolean;
            appTableAccess: boolean;
          }>
        >`
            select
              p.proowner = c.relowner as "sameOwner",
              p.prosecdef as "securityDefiner",
              coalesce(p.proconfig @> array['search_path=pg_catalog']::text[], false)
                as "hardenedSearchPath",
              has_function_privilege(
                'opengeni_app', p.oid, 'EXECUTE'
              ) as "appExecute",
              exists (
                select 1
                from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
                where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
              ) as "publicExecute",
              has_table_privilege(
                'opengeni_app', c.oid, 'SELECT, INSERT, UPDATE, DELETE'
              ) as "appTableAccess"
            from pg_proc p
            join pg_namespace pn on pn.oid = p.pronamespace
            join pg_class c
              on c.relname = 'personal_resource_delegation_capabilities'
            join pg_namespace cn
              on cn.oid = c.relnamespace and cn.nspname = 'opengeni_private'
            where pn.nspname = 'opengeni_private'
              and p.proname = 'personal_resource_delegation_capability_active'
              and pg_catalog.oidvectortypes(p.proargtypes) = 'text'
          `;
        expect(posture).toEqual({
          sameOwner: true,
          securityDefiner: true,
          hardenedSearchPath: true,
          appExecute: true,
          publicExecute: false,
          appTableAccess: false,
        });

        const ids = await createFixture(admin, blank.databaseUrl, "once", {
          directOnly: true,
        });
        await admin`
            insert into workspace_variable_sets (account_id, workspace_id, name)
            values (${ids.account}, ${ids.targetWorkspace}, ${`target-${order}`})
          `;
        await setRuntimeScope(app, ids);

        const [capability] = await app<
          Array<{ anyActive: boolean; admitActive: boolean; resolveActive: boolean }>
        >`
            select
              opengeni_private.personal_resource_delegation_capability_active()
                as "anyActive",
              opengeni_private.personal_resource_delegation_capability_active('admit')
                as "admitActive",
              opengeni_private.personal_resource_delegation_capability_active('resolve')
                as "resolveActive"
          `;
        expect(capability).toEqual({
          anyActive: false,
          admitActive: false,
          resolveActive: false,
        });

        await app`
            insert into rigs (account_id, workspace_id, name)
            values (${ids.account}, ${ids.targetWorkspace}, ${`ordinary-${order}`})
          `;
        const [variableSets] = await app<Array<{ count: number }>>`
            select count(*)::int as count
            from workspace_variable_sets
            where account_id = ${ids.account}
              and workspace_id = ${ids.targetWorkspace}
          `;
        expect(variableSets?.count).toBe(1);
        await expect(
          Promise.resolve(
            app`select * from opengeni_private.personal_resource_delegation_capabilities`,
          ),
        ).rejects.toThrow(/permission denied/iu);

        await insertAttempt(
          app,
          ids,
          ids.attemptA,
          `workflow-${order}`,
          `run-${order}`,
          `activity-${order}`,
        );
        expect(
          await app`
              select * from resolve_session_attempt_personal_resources(
                ${ids.account}, ${ids.targetWorkspace}, ${ids.attemptA}
              )
            `,
        ).toHaveLength(1);
      } finally {
        await app.end({ timeout: 5 });
        await admin.end({ timeout: 5 });
        await blank.release();
      }
    }, 180_000);
  }

  test("admits an ordinary attempt with no selected personal resources or personal authority", async () => {
    const blank = await acquireBlankTestDatabase("migration-0241-empty-personal-selection");
    if (!blank) return;

    await migrate(blank.databaseUrl);
    const sql = postgres(blank.databaseUrl, {
      max: 4,
      prepare: false,
      onnotice: () => undefined,
    });
    const client = createDb(blank.databaseUrl, { max: 1 });
    try {
      const [account] = await sql<Array<{ id: string }>>`
        insert into managed_accounts (name)
        values ('empty personal selection account')
        returning id
      `;
      const [workspace] = await sql<Array<{ id: string }>>`
        insert into workspaces (account_id, name)
        values (${account!.id}, 'empty personal selection workspace')
        returning id
      `;
      await sql`
        insert into workspace_inference_controls (workspace_id, account_id)
        values (${workspace!.id}, ${account!.id})
      `;
      const sessionId = crypto.randomUUID();
      const turnId = crypto.randomUUID();
      const attemptId = crypto.randomUUID();

      await createSession(client.db, {
        requestedSessionId: sessionId,
        accountId: account!.id,
        workspaceId: workspace!.id,
        initialMessage: "ordinary attempt",
        resources: [],
        metadata: {},
        model: "codex/gpt-5.6-sol",
        sandboxBackend: "modal",
      });
      await sql`
        insert into session_turns (
          id, account_id, workspace_id, session_id, trigger_event_id,
          temporal_workflow_id, status, position, prompt, model,
          reasoning_effort, sandbox_backend
        ) values (
          ${turnId}, ${account!.id}, ${workspace!.id}, ${sessionId}, ${crypto.randomUUID()},
          'ordinary-workflow', 'running', 1, 'ordinary attempt', 'codex/gpt-5.6-sol',
          'low', 'modal'
        )
      `;
      await sql`
        insert into session_turn_attempts (
          id, account_id, workspace_id, session_id, turn_id, execution_generation,
          state, temporal_workflow_id, temporal_workflow_run_id, temporal_activity_id,
          verified_control_revision, mcp_approval_policies
        ) values (
          ${attemptId}, ${account!.id}, ${workspace!.id}, ${sessionId}, ${turnId}, 0,
          'running', 'ordinary-workflow', 'ordinary-run', 'ordinary-activity', 0,
          '{}'::jsonb
        )
      `;
      await sql`
        update session_turns
        set active_attempt_id = ${attemptId}
        where id = ${turnId}
      `;

      const [attempt] = await sql<
        Array<{
          authorityOwnerOrganizationMembershipId: string | null;
          authorityVisibility: string;
          executionGeneration: number;
        }>
      >`
        select
          authority_owner_organization_membership_id as "authorityOwnerOrganizationMembershipId",
          authority_visibility as "authorityVisibility",
          execution_generation as "executionGeneration"
        from session_turn_attempts
        where id = ${attemptId}
      `;
      expect(attempt).toEqual({
        authorityOwnerOrganizationMembershipId: null,
        authorityVisibility: "workspace_shared",
        executionGeneration: 0,
      });

      for (const table of [
        "session_attempt_personal_resource_admissions",
        "session_attempt_personal_resource_snapshots",
        "personal_resource_once_consumption_receipts",
      ] as const) {
        const [row] = await sql.unsafe<Array<{ count: number }>>(
          `select count(*)::int as count from ${table} where attempt_id = $1`,
          [attemptId],
        );
        expect(row?.count).toBe(0);
      }
    } finally {
      await client.close();
      await sql.end({ timeout: 5 });
    }
  }, 180_000);

  test("rejects cross-workspace rig versions at admission and resolution", async () => {
    const blank = await acquireBlankTestDatabase("migration-0241-rig-version-workspace-fence");
    if (!blank) return;

    const appPassword = "apppw";
    await migrate(blank.databaseUrl);
    await provisionRoles(blank.databaseUrl, {
      appPassword,
      rlsStrategy: "force",
    });
    const admin = postgres(blank.databaseUrl, {
      max: 4,
      prepare: false,
      onnotice: () => undefined,
    });
    const appUrl = new URL(blank.databaseUrl);
    appUrl.username = "opengeni_app";
    appUrl.password = appPassword;
    const app = postgres(appUrl.toString(), {
      max: 1,
      prepare: false,
      onnotice: () => undefined,
    });
    try {
      const ids = await createFixture(admin, blank.databaseUrl, "session");
      await setRuntimeScope(app, ids);
      await admin`
        update rig_versions
        set active = false
        where id = ${ids.rigVersion}
      `;
      const [mismatchedVersion] = await app<Array<{ id: string }>>`
        insert into rig_versions (
          account_id, workspace_id, rig_id, version, default_variable_set_ids, active
        ) values (
          ${ids.account}, ${ids.targetWorkspace}, ${ids.rig}, 2, '[]'::jsonb, true
        ) returning id
      `;
      expect(mismatchedVersion?.id).toBeTruthy();

      await app`
        update sessions
        set rig_version_id = ${mismatchedVersion!.id}
        where id = ${ids.session}
      `;
      await expect(
        insertAttempt(
          app,
          ids,
          ids.attemptA,
          "workflow-mismatched-admission",
          "run-mismatched-admission",
          "activity-mismatched-admission",
        ),
      ).rejects.toThrow("personal resource identity changed during admission");

      await admin`
        update rig_versions
        set active = false
        where id = ${mismatchedVersion!.id}
      `;
      await admin`
        update rig_versions
        set active = true
        where id = ${ids.rigVersion}
      `;
      await app`
        update sessions
        set rig_version_id = ${ids.rigVersion}
        where id = ${ids.session}
      `;
      await insertAttempt(
        app,
        ids,
        ids.attemptA,
        "workflow-valid-admission",
        "run-valid-admission",
        "activity-valid-admission",
      );
      await admin`
        update session_attempt_personal_resource_snapshots
        set resource_version_id = ${mismatchedVersion!.id}
        where attempt_id = ${ids.attemptA}
          and resource_kind = 'rig'
      `;
      await expect(
        Promise.resolve(
          app`
            select * from resolve_session_attempt_personal_resources(
              ${ids.account}, ${ids.targetWorkspace}, ${ids.attemptA}
            )
          `,
        ),
      ).rejects.toThrow("personal-resource authority snapshot is no longer live");
    } finally {
      await app.end({ timeout: 5 });
      await admin.end({ timeout: 5 });
    }
  }, 180_000);

  test("atomically snapshots direct/transitive selections and replays one once receipt", async () => {
    const blank = await acquireBlankTestDatabase("migration-0241-personal-resource-replay");
    if (!blank) return;

    const sql = postgres(blank.databaseUrl, { max: 4, onnotice: () => undefined });
    try {
      await migrate(blank.databaseUrl);
      const ids = await createFixture(sql, blank.databaseUrl, "once");

      await insertAttempt(sql, ids, ids.attemptA, "workflow-a", "run-a", "activity-a");
      await sql`
        insert into session_turn_attempts (
          id, account_id, workspace_id, session_id, turn_id, execution_generation,
          temporal_workflow_id, temporal_workflow_run_id, temporal_activity_id,
          verified_control_revision, authority_epoch, authority_visibility,
          authority_owner_organization_membership_id, mcp_approval_policies,
          connector_action_policies
        ) values (
          ${ids.attemptA}, ${ids.account}, ${ids.targetWorkspace}, ${ids.session},
          ${ids.turn}, 1, 'workflow-a', 'run-a', 'activity-a', 1, 1,
          'workspace_shared', ${ids.membership}, '{}'::jsonb, '[]'::jsonb
        ) on conflict (id) do nothing
      `;

      const snapshots = await sql<
        Array<{
          kind: string;
          id: string;
          versionId: string | null;
          sources: string[];
          mode: string;
        }>
      >`
        select resource_kind as kind, resource_id as id,
          resource_version_id as "versionId", selection_sources as sources,
          grant_mode as mode
        from session_attempt_personal_resource_snapshots
        where attempt_id = ${ids.attemptA}
        order by resource_kind, resource_id
      `;
      expect(snapshots).toHaveLength(3);
      expect(snapshots).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "rig",
            id: ids.rig,
            versionId: ids.rigVersion,
            sources: ["session_rig"],
            mode: "once",
          }),
          expect.objectContaining({
            kind: "variable_set",
            id: ids.directVariableSet,
            sources: ["session_variable_set"],
            mode: "once",
          }),
          expect.objectContaining({
            kind: "variable_set",
            id: ids.defaultVariableSet,
            sources: ["rig_default_variable_set:1"],
            mode: "once",
          }),
        ]),
      );

      const [admission] = await sql<Array<{ count: number; revision: string }>>`
        select resource_count as count,
          membership_authorization_revision::text as revision
        from session_attempt_personal_resource_admissions
        where attempt_id = ${ids.attemptA}
      `;
      expect(admission).toEqual({ count: 3, revision: "7" });

      const receipts = await sql<Array<{ grantId: string; attemptId: string }>>`
        select grant_id as "grantId", attempt_id as "attemptId"
        from personal_resource_once_consumption_receipts
        order by grant_id
      `;
      expect(receipts).toHaveLength(3);
      expect(new Set(receipts.map((receipt) => receipt.attemptId))).toEqual(
        new Set([ids.attemptA]),
      );

      await setRuntimeScope(sql, ids);
      const resolved = await sql<Array<{ kind: string; id: string }>>`
        select resource_kind as kind, resource_id as id
        from resolve_session_attempt_personal_resources(
          ${ids.account}, ${ids.targetWorkspace}, ${ids.attemptA}
        )
      `;
      expect(resolved).toHaveLength(3);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  test("serializes concurrent once use and fails closed after live authority drift", async () => {
    const blank = await acquireBlankTestDatabase("migration-0241-personal-resource-concurrency");
    if (!blank) return;

    const admin = postgres(blank.databaseUrl, { max: 6, onnotice: () => undefined });
    const scoped = postgres(blank.databaseUrl, { max: 1, onnotice: () => undefined });
    const client = createDb(blank.databaseUrl, { max: 1 });
    try {
      await migrate(blank.databaseUrl);
      const ids = await createFixture(admin, blank.databaseUrl, "once", {
        directOnly: true,
      });

      const attemptA = insertAttempt(
        admin,
        ids,
        ids.attemptA,
        "workflow-a",
        "run-a",
        "activity-a",
        true,
      );
      const retryA = insertAttempt(
        admin,
        ids,
        ids.attemptA,
        "workflow-a",
        "run-a",
        "activity-a",
        true,
      );
      const results = await Promise.allSettled([attemptA, retryA]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(0);

      const [receipt] = await admin<Array<{ attemptId: string }>>`
        select attempt_id as "attemptId"
        from personal_resource_once_consumption_receipts
      `;
      expect(receipt?.attemptId).toBe(ids.attemptA);
      expect(
        await admin`
          select * from session_attempt_personal_resource_snapshots
          where attempt_id = ${ids.attemptA}
        `,
      ).toHaveLength(1);

      await admin`
        update session_turn_attempts
        set state = 'closed', outcome = 'completed', closed_at = clock_timestamp(),
          quiesced_at = clock_timestamp()
        where id = ${ids.attemptA}
      `;
      await expect(
        insertAttempt(admin, ids, ids.attemptB, "workflow-b", "run-b", "activity-b"),
      ).rejects.toThrow("matching personal-resource grant required");

      const drift = await createFixture(admin, blank.databaseUrl, "once", {
        directOnly: true,
      });
      await insertAttempt(
        admin,
        drift,
        drift.attemptA,
        "workflow-drift",
        "run-drift",
        "activity-drift",
      );

      await setRuntimeScope(scoped, drift);
      const resolve = async () =>
        await scoped`
          select * from resolve_session_attempt_personal_resources(
            ${drift.account}, ${drift.targetWorkspace}, ${drift.attemptA}
          )
        `;
      expect(await resolve()).toHaveLength(1);

      await admin`
        update organization_memberships
        set authorization_revision = authorization_revision + 1
        where id = ${drift.membership}
      `;
      await expect(resolve()).rejects.toThrow("snapshot is no longer live");
      await admin`
        update organization_memberships
        set authorization_revision = 7
        where id = ${drift.membership}
      `;

      await admin`
        delete from workspace_memberships
        where account_id = ${drift.account}
          and workspace_id = ${drift.targetWorkspace}
          and subject_id = ${drift.subject}
      `;
      await expect(resolve()).rejects.toThrow("snapshot is no longer live");
      await admin`
        insert into workspace_memberships (account_id, workspace_id, subject_id)
        values (${drift.account}, ${drift.targetWorkspace}, ${drift.subject})
      `;

      await admin`
        update organization_user_resource_authorities
        set generation = generation + 1
        where id = ${drift.directAuthority}
      `;
      await expect(resolve()).rejects.toThrow("snapshot is no longer live");
      await admin`
        update organization_user_resource_authorities
        set generation = 11
        where id = ${drift.directAuthority}
      `;

      await admin`
        update organization_user_resource_grants
        set status = 'revoked', revoked_at = clock_timestamp()
        where id = ${drift.directGrant}
      `;
      await expect(resolve()).rejects.toThrow("snapshot is no longer live");
      await admin`
        update organization_user_resource_grants
        set status = 'consumed', revoked_at = null
        where id = ${drift.directGrant}
      `;

      await transitionSessionVisibility(client.db, {
        workspaceId: drift.targetWorkspace,
        sessionId: drift.session,
        actorSubjectId: drift.subject,
        targetVisibility: "user_private",
        expectedAuthorityEpoch: 1,
        operationKey: `delegation-${crypto.randomUUID()}`,
      });
      await expect(resolve()).rejects.toThrow("snapshot is no longer live");
    } finally {
      await client.close();
      await scoped.end({ timeout: 5 });
      await admin.end({ timeout: 5 });
    }
  });

  test("admits exact session and always grant fences", async () => {
    const blank = await acquireBlankTestDatabase("migration-0241-personal-resource-fences");
    if (!blank) return;

    const sql = postgres(blank.databaseUrl, { max: 4, onnotice: () => undefined });
    try {
      await migrate(blank.databaseUrl);
      for (const mode of ["session", "always"] as const) {
        const ids = await createFixture(sql, blank.databaseUrl, mode, {
          directOnly: true,
        });
        await insertAttempt(
          sql,
          ids,
          ids.attemptA,
          `workflow-${mode}`,
          `run-${mode}`,
          `activity-${mode}`,
        );
        const [snapshot] = await sql<
          Array<{
            mode: string;
            grantSessionId: string | null;
            grantAuthorityEpoch: number | null;
          }>
        >`
          select grant_mode as mode, grant_session_id as "grantSessionId",
            grant_authority_epoch as "grantAuthorityEpoch"
          from session_attempt_personal_resource_snapshots
          where attempt_id = ${ids.attemptA}
        `;
        expect(snapshot?.mode).toBe(mode);
        expect(snapshot?.grantSessionId).toBe(mode === "always" ? null : ids.session);
        expect(snapshot?.grantAuthorityEpoch).toBe(mode === "always" ? null : 1);
        await setRuntimeScope(sql, ids);
        expect(
          await sql`
            select * from resolve_session_attempt_personal_resources(
              ${ids.account}, ${ids.targetWorkspace}, ${ids.attemptA}
            )
          `,
        ).toHaveLength(1);
      }
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});

type FixtureIds = {
  account: string;
  personalWorkspace: string;
  targetWorkspace: string;
  membership: string;
  subject: string;
  directVariableSet: string;
  defaultVariableSet: string;
  rig: string;
  rigVersion: string;
  directAuthority: string;
  directGrant: string;
  session: string;
  turn: string;
  attemptA: string;
  attemptB: string;
};

async function createFixture(
  sql: postgres.Sql,
  databaseUrl: string,
  mode: "once" | "session" | "always",
  options: { directOnly?: boolean } = {},
): Promise<FixtureIds> {
  const subject = `human:${crypto.randomUUID()}`;
  const [account] = await sql<Array<{ id: string }>>`
    insert into managed_accounts (name) values (${`delegation-${crypto.randomUUID()}`}) returning id
  `;
  const [personalWorkspace] = await sql<Array<{ id: string }>>`
    insert into workspaces (account_id, name)
    values (${account!.id}, 'personal') returning id
  `;
  const [targetWorkspace] = await sql<Array<{ id: string }>>`
    insert into workspaces (account_id, name)
    values (${account!.id}, 'target') returning id
  `;
  await sql`
    insert into workspace_inference_controls (workspace_id, account_id)
    values
      (${personalWorkspace!.id}, ${account!.id}),
      (${targetWorkspace!.id}, ${account!.id})
  `;
  const [membership] = await sql<Array<{ id: string }>>`
    insert into organization_memberships (
      account_id, subject_id, status, personal_workspace_id, authorization_revision
    ) values (${account!.id}, ${subject}, 'active', ${personalWorkspace!.id}, 7)
    returning id
  `;
  await sql`
    insert into workspace_memberships (account_id, workspace_id, subject_id)
    values (${account!.id}, ${targetWorkspace!.id}, ${subject})
  `;

  const [directVariableSet] = await sql<Array<{ id: string }>>`
    insert into workspace_variable_sets (account_id, workspace_id, name)
    values (${account!.id}, ${personalWorkspace!.id}, 'direct') returning id
  `;
  const [defaultVariableSet] = await sql<Array<{ id: string }>>`
    insert into workspace_variable_sets (account_id, workspace_id, name)
    values (${account!.id}, ${personalWorkspace!.id}, 'default') returning id
  `;
  const [rig] = await sql<Array<{ id: string }>>`
    insert into rigs (account_id, workspace_id, name)
    values (${account!.id}, ${personalWorkspace!.id}, 'personal-rig') returning id
  `;
  const defaultIds = options.directOnly ? [] : [defaultVariableSet!.id];
  const [rigVersion] = await sql<Array<{ id: string }>>`
    insert into rig_versions (
      account_id, workspace_id, rig_id, version, default_variable_set_ids, active
    ) values (
      ${account!.id}, ${personalWorkspace!.id}, ${rig!.id}, 1,
      ${sql.json(defaultIds)}, true
    ) returning id
  `;

  const resourceRows = options.directOnly
    ? ([["variable_set", directVariableSet!.id, "direct"]] as const)
    : ([
        ["variable_set", directVariableSet!.id, "direct"],
        ["variable_set", defaultVariableSet!.id, "default"],
        ["rig", rig!.id, "rig"],
      ] as const);
  const authorities = new Map<string, string>();
  const grants = new Map<string, string>();
  for (const [kind, resourceId, label] of resourceRows) {
    const [authority] = await sql<Array<{ id: string }>>`
      insert into organization_user_resource_authorities (
        account_id, organization_membership_id, resource_kind, resource_id,
        origin_workspace_id, generation, status
      ) values (
        ${account!.id}, ${membership!.id}, ${kind}, ${resourceId},
        ${personalWorkspace!.id}, 11, 'active'
      ) returning id
    `;
    authorities.set(label, authority!.id);
  }
  await sql`
    update workspace_variable_sets set authority_scope = 'user',
      authority_id = ${authorities.get("direct")!},
      owner_organization_membership_id = ${membership!.id},
      origin_workspace_id = ${personalWorkspace!.id}
    where id = ${directVariableSet!.id}
  `;
  if (!options.directOnly) {
    await sql`
      update workspace_variable_sets set authority_scope = 'user',
        authority_id = ${authorities.get("default")!},
        owner_organization_membership_id = ${membership!.id},
        origin_workspace_id = ${personalWorkspace!.id}
      where id = ${defaultVariableSet!.id}
    `;
    await sql`
      update rigs set authority_scope = 'user', authority_id = ${authorities.get("rig")!},
        owner_organization_membership_id = ${membership!.id},
        origin_workspace_id = ${personalWorkspace!.id}
      where id = ${rig!.id}
    `;
  }

  const requestedSessionId = crypto.randomUUID();
  const client = createDb(databaseUrl, { max: 1 });
  let session: string;
  try {
    const created = await createSession(client.db, {
      requestedSessionId,
      accountId: account!.id,
      workspaceId: targetWorkspace!.id,
      initialMessage: "test",
      resources: [],
      metadata: {},
      createdBy: { kind: "subject", subjectId: subject },
      subjectId: subject,
      model: "test-model",
      sandboxBackend: "modal",
      variableSetId: directVariableSet!.id,
      rigId: options.directOnly ? null : rig!.id,
      rigVersionId: options.directOnly ? null : rigVersion!.id,
      firstPartyMcpTools: [],
    });
    session = created.id;
  } finally {
    await client.close();
  }
  const [turn] = await sql<Array<{ id: string }>>`
    insert into session_turns (
      account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
      status, position, prompt, model, reasoning_effort, latency_mode,
      sandbox_backend, initiator_kind, initiator_subject_id,
      initiating_human_subject_id
    ) values (
      ${account!.id}, ${targetWorkspace!.id}, ${session}, ${crypto.randomUUID()},
      'workflow', 'running', 1, 'test', 'test-model', 'medium', 'standard',
      'modal', 'subject', ${subject}, ${subject}
    ) returning id
  `;

  for (const [label, authorityId] of authorities) {
    const action = label === "rig" ? "rig.use" : "variable_set.use";
    const [grant] = await sql<Array<{ id: string }>>`
      insert into organization_user_resource_grants (
        account_id, authority_id, owner_organization_membership_id, workspace_id,
        session_id, action, mode, context, authority_epoch, generation, status
      ) values (
        ${account!.id}, ${authorityId}, ${membership!.id}, ${targetWorkspace!.id},
        ${mode === "always" ? null : session}, ${action}, ${mode}, 'workspace_shared',
        ${mode === "always" ? null : 1}, 13, 'active'
      ) returning id
    `;
    grants.set(label, grant!.id);
  }

  return {
    account: account!.id,
    personalWorkspace: personalWorkspace!.id,
    targetWorkspace: targetWorkspace!.id,
    membership: membership!.id,
    subject,
    directVariableSet: directVariableSet!.id,
    defaultVariableSet: defaultVariableSet!.id,
    rig: rig!.id,
    rigVersion: rigVersion!.id,
    directAuthority: authorities.get("direct")!,
    directGrant: grants.get("direct")!,
    session,
    turn: turn!.id,
    attemptA: crypto.randomUUID(),
    attemptB: crypto.randomUUID(),
  };
}

async function insertAttempt(
  sql: postgres.Sql,
  ids: FixtureIds,
  attemptId: string,
  workflowId: string,
  runId: string,
  activityId: string,
  onConflict = false,
) {
  const conflict = onConflict ? sql`on conflict (id) do nothing` : sql``;
  return await sql`
    insert into session_turn_attempts (
      id, account_id, workspace_id, session_id, turn_id, execution_generation,
      temporal_workflow_id, temporal_workflow_run_id, temporal_activity_id,
      verified_control_revision, authority_epoch, authority_visibility,
      authority_owner_organization_membership_id, mcp_approval_policies,
      connector_action_policies
    ) values (
      ${attemptId}, ${ids.account}, ${ids.targetWorkspace}, ${ids.session}, ${ids.turn},
      1, ${workflowId}, ${runId}, ${activityId}, 1, 1, 'workspace_shared',
      ${ids.membership}, '{}'::jsonb, '[]'::jsonb
    )
    ${conflict}
  `;
}

async function setRuntimeScope(sql: postgres.Sql, ids: FixtureIds) {
  await sql`select set_config('opengeni.account_id', ${ids.account}, false)`;
  await sql`select set_config('opengeni.workspace_id', ${ids.targetWorkspace}, false)`;
  await sql`select set_config('opengeni.subject_id', ${ids.subject}, false)`;
  await sql`select set_config('opengeni.initiating_human_subject_id', ${ids.subject}, false)`;
}
