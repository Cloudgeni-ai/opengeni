import { describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { createDb, createSession } from "../src";
import { migrate } from "../src/migrate";

const migrationName = "0249_personal_resource_delegation_authority_correction.sql";
const commonAuthorityMigrationName = "0253_common_user_resource_authority_lifecycle.sql";
const connectionAuthorityMigrationName = "0256_connection_authority_delegation.sql";
const connectionAuthorityActivationMigrationName =
  "0264_connection_authority_runtime_activation.sql";
const scheduledConnectionAuthorityMigrationName = "0275_scheduled_connection_authority.sql";
const migrationUrl = new URL(`../drizzle/${migrationName}`, import.meta.url);
const migration0241Url = new URL(
  "../drizzle/0241_atomic_personal_resource_delegation.sql",
  import.meta.url,
);
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const explicitAdminDatabaseUrl = process.env.OPENGENI_MIGRATION_0249_TEST_DATABASE_ADMIN_URL;

describe("migration 0249 personal-resource delegation authority correction", () => {
  test("is a forward-only rolling replacement of only the admission and resolver functions", async () => {
    const source = await readFile(migrationUrl, "utf8");
    const migration0241 = await readFile(migration0241Url);
    const executableSource = source.replace(/^--.*$/gmu, "");

    expect(source.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(createHash("sha256").update(migration0241).digest("hex")).toBe(
      "4a8e3752decc0a497f8eb00de223923747bf2994a0f76ccb977ce7f3ced9e5be",
    );
    expect(executableSource.match(/CREATE OR REPLACE FUNCTION/gu)).toHaveLength(2);
    expect(executableSource).toContain(
      "CREATE OR REPLACE FUNCTION %1$I.admit_session_attempt_personal_resources()",
    );
    expect(executableSource).toContain(
      "CREATE OR REPLACE FUNCTION %1$I.resolve_session_attempt_personal_resources(",
    );
    expect(executableSource).not.toMatch(
      /^\s*(?:CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TRIGGER|CREATE\s+TRIGGER|GRANT\s|REVOKE\s)/imu,
    );
    expect(executableSource.match(/SECURITY DEFINER/gu)).toHaveLength(2);
    expect(executableSource.match(/SET search_path = %1\$I, pg_catalog/gu)).toHaveLength(2);

    expect(source).toContain("OR turn_row.status <> 'running'");
    expect(source).toContain("AND turn_value.status = 'running'");
    expect(source).not.toContain(
      "('running', 'requires_action', 'recovering', 'waiting_capacity')",
    );
    expect(source).toContain(
      "IF member_row.personal_workspace_id IS DISTINCT FROM NEW.workspace_id THEN",
    );
    expect(source).toContain("membership.personal_workspace_id = snapshot.workspace_id");
    expect(source).toContain("workspace_membership.workspace_id = snapshot.workspace_id");
    expect(source).toContain("workspace_membership.subject_id = membership.subject_id");
  });

  test("blank databases admit and resolve the exact personal owner without a workspace membership", async () => {
    await withBlankDatabase("migration-0249-blank-personal", async (sql, databaseUrl) => {
      await migrate(databaseUrl);
      const ids = await createFixture(sql, databaseUrl, {
        target: "personal",
        workspaceMembership: false,
      });

      expect(await countWorkspaceMemberships(sql, ids)).toBe(0);
      expect(ids.authorityOwnerMembershipId).toBeNull();
      await insertAttempt(sql, ids, ids.attemptId);
      await setRuntimeScope(sql, ids);
      expect(await resolve(sql, ids)).toHaveLength(1);
      expect(await countWorkspaceMemberships(sql, ids)).toBe(0);
    });
  }, 180_000);

  test("ordinary targets require membership for both admission and resolution", async () => {
    await withBlankDatabase("migration-0249-ordinary-membership", async (sql, databaseUrl) => {
      await migrate(databaseUrl);
      const ids = await createFixture(sql, databaseUrl, {
        target: "ordinary",
        workspaceMembership: false,
      });

      await expect(insertAttempt(sql, ids, ids.attemptId)).rejects.toThrow(
        "initiating human lacks target-workspace membership",
      );
      await addWorkspaceMembership(sql, ids);
      await insertAttempt(sql, ids, ids.attemptId);
      await setRuntimeScope(sql, ids);
      expect(await resolve(sql, ids)).toHaveLength(1);

      await sql`
        delete from workspace_memberships
        where account_id = ${ids.accountId}
          and workspace_id = ${ids.targetWorkspaceId}
          and subject_id = ${ids.subjectId}
      `;
      await expect(resolve(sql, ids)).rejects.toThrow(
        "personal-resource authority snapshot is no longer live",
      );
      await addWorkspaceMembership(sql, ids);
      expect(await resolve(sql, ids)).toHaveLength(1);
    });
  }, 180_000);

  test("admission and resolution reject every constructible non-running owner state", async () => {
    await withBlankDatabase("migration-0249-running-attempt-only", async (sql, databaseUrl) => {
      await migrate(databaseUrl);
      const nonRunningStatuses = ["requires_action", "recovering", "waiting_capacity"] as const;

      await sql`
        alter table session_turn_attempts
        disable trigger session_attempt_personal_document_admission
      `;
      try {
        for (const status of nonRunningStatuses) {
          const ids = await createFixture(sql, databaseUrl, {
            target: "ordinary",
            workspaceMembership: true,
          });
          await expect(insertAttempt(sql, ids, ids.attemptId, status)).rejects.toThrow(
            "personal-resource admission requires the exact current uninterrupted attempt",
          );
        }
      } finally {
        await sql`
          alter table session_turn_attempts
          enable trigger session_attempt_personal_document_admission
        `;
      }

      const ids = await createFixture(sql, databaseUrl, {
        target: "ordinary",
        workspaceMembership: true,
      });
      await insertAttempt(sql, ids, ids.attemptId);
      await setRuntimeScope(sql, ids);
      expect(await resolve(sql, ids)).toHaveLength(1);

      for (const status of nonRunningStatuses) {
        await setLifecycleStatus(sql, ids, status);
        const [stored] = await sql<Array<{ status: string; activeAttemptId: string | null }>>`
          select status, active_attempt_id as "activeAttemptId"
          from session_turns where id = ${ids.turnId}
        `;
        expect(stored).toEqual({ status, activeAttemptId: ids.attemptId });
        await expect(resolve(sql, ids)).rejects.toThrow(
          "personal-resource resolve requires the exact current uninterrupted attempt",
        );
      }
    });
  }, 180_000);

  test("upgrades an existing 0241 database without rewriting its migration", async () => {
    await withBlankDatabase("migration-0249-upgrade", async (sql, databaseUrl) => {
      await sql.unsafe(`
        create table schema_migrations (
          name text primary key,
          applied_at timestamptz not null default now()
        )
      `);
      await sql`
        insert into schema_migrations (name)
        values
          (${migrationName}),
          (${commonAuthorityMigrationName}),
          (${connectionAuthorityMigrationName}),
          (${connectionAuthorityActivationMigrationName}),
          (${scheduledConnectionAuthorityMigrationName})
      `;
      await migrate(databaseUrl);
      await sql`
        delete from schema_migrations
        where name in (
          ${migrationName},
          ${commonAuthorityMigrationName},
          ${connectionAuthorityMigrationName},
          ${connectionAuthorityActivationMigrationName},
          ${scheduledConnectionAuthorityMigrationName}
        )
      `;

      const ids = await createFixture(sql, databaseUrl, {
        target: "personal",
        workspaceMembership: false,
      });
      await expect(insertAttempt(sql, ids, ids.attemptId)).rejects.toThrow(
        "initiating human lacks target-workspace membership",
      );

      await migrate(databaseUrl);
      const receipts = await sql<Array<{ name: string }>>`
        select name
        from schema_migrations
        where name in (
          ${migrationName},
          ${commonAuthorityMigrationName},
          ${connectionAuthorityMigrationName},
          ${connectionAuthorityActivationMigrationName},
          ${scheduledConnectionAuthorityMigrationName}
        )
        order by name
      `;
      expect(receipts.map((receipt) => receipt.name)).toEqual([
        migrationName,
        commonAuthorityMigrationName,
        connectionAuthorityMigrationName,
        connectionAuthorityActivationMigrationName,
        scheduledConnectionAuthorityMigrationName,
      ]);
      expect(await countWorkspaceMemberships(sql, ids)).toBe(0);
      await insertAttempt(sql, ids, ids.attemptId);
      await setRuntimeScope(sql, ids);
      expect(await resolve(sql, ids)).toHaveLength(1);
    });
  }, 180_000);
});

type FixtureIds = {
  accountId: string;
  targetWorkspaceId: string;
  authorityOwnerMembershipId: string | null;
  subjectId: string;
  sessionId: string;
  turnId: string;
  attemptId: string;
};

async function createFixture(
  sql: postgres.Sql,
  databaseUrl: string,
  options: { target: "personal" | "ordinary"; workspaceMembership: boolean },
): Promise<FixtureIds> {
  const subjectId = `human:${crypto.randomUUID()}`;
  const [account] = await sql<Array<{ id: string }>>`
    insert into managed_accounts (name)
    values (${`delegation-0249-${crypto.randomUUID()}`})
    returning id
  `;
  const [personalWorkspace] = await sql<Array<{ id: string }>>`
    insert into workspaces (account_id, name)
    values (${account!.id}, 'personal')
    returning id
  `;
  const [ordinaryWorkspace] =
    options.target === "ordinary"
      ? await sql<Array<{ id: string }>>`
          insert into workspaces (account_id, name)
          values (${account!.id}, 'ordinary')
          returning id
        `
      : [personalWorkspace!];
  const targetWorkspaceId = ordinaryWorkspace!.id;

  await sql`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${personalWorkspace!.id}, ${account!.id})
  `;
  if (targetWorkspaceId !== personalWorkspace!.id) {
    await sql`
      insert into workspace_inference_controls (workspace_id, account_id)
      values (${targetWorkspaceId}, ${account!.id})
    `;
  }

  const [membership] = await sql<Array<{ id: string }>>`
    insert into organization_memberships (
      account_id, subject_id, status, personal_workspace_id, authorization_revision
    ) values (${account!.id}, ${subjectId}, 'active', ${personalWorkspace!.id}, 7)
    returning id
  `;
  if (options.workspaceMembership) {
    await sql`
      insert into workspace_memberships (account_id, workspace_id, subject_id)
      values (${account!.id}, ${targetWorkspaceId}, ${subjectId})
    `;
  }

  const [variableSet] = await sql<Array<{ id: string }>>`
    insert into workspace_variable_sets (account_id, workspace_id, name)
    values (${account!.id}, ${personalWorkspace!.id}, 'personal variable set')
    returning id
  `;
  const [authority] = await sql<Array<{ id: string }>>`
    insert into organization_user_resource_authorities (
      account_id, organization_membership_id, resource_kind, resource_id,
      origin_workspace_id, generation, status
    ) values (
      ${account!.id}, ${membership!.id}, 'variable_set', ${variableSet!.id},
      ${personalWorkspace!.id}, 11, 'active'
    ) returning id
  `;
  await sql`
    update workspace_variable_sets
    set authority_scope = 'user', authority_id = ${authority!.id},
      owner_organization_membership_id = ${membership!.id},
      origin_workspace_id = ${personalWorkspace!.id}
    where id = ${variableSet!.id}
  `;

  const client = createDb(databaseUrl, { max: 1 });
  let sessionId: string;
  try {
    const session = await createSession(client.db, {
      requestedSessionId: crypto.randomUUID(),
      accountId: account!.id,
      workspaceId: targetWorkspaceId,
      initialMessage: "migration 0249 authority fixture",
      resources: [],
      metadata: {},
      createdBy: { kind: "subject", subjectId },
      subjectId,
      model: "test-model",
      sandboxBackend: "modal",
      variableSetId: variableSet!.id,
      firstPartyMcpTools: [],
    });
    sessionId = session.id;
  } finally {
    await client.close();
  }
  const [sessionAuthority] = await sql<Array<{ ownerOrganizationMembershipId: string | null }>>`
    select owner_organization_membership_id as "ownerOrganizationMembershipId"
    from sessions where id = ${sessionId}
  `;

  const [turn] = await sql<Array<{ id: string }>>`
    insert into session_turns (
      account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
      status, position, prompt, model, reasoning_effort, latency_mode,
      sandbox_backend, initiator_kind, initiator_subject_id,
      initiating_human_subject_id
    ) values (
      ${account!.id}, ${targetWorkspaceId}, ${sessionId}, ${crypto.randomUUID()},
      'migration-0249-workflow', 'running', 1, 'test', 'test-model', 'medium',
      'standard', 'modal', 'subject', ${subjectId}, ${subjectId}
    ) returning id
  `;
  await sql`
    insert into organization_user_resource_grants (
      account_id, authority_id, owner_organization_membership_id, workspace_id,
      session_id, action, mode, context, authority_epoch, generation, status
    ) values (
      ${account!.id}, ${authority!.id}, ${membership!.id}, ${targetWorkspaceId},
      ${sessionId}, 'variable_set.use', 'session', 'workspace_shared', 1, 13, 'active'
    )
  `;

  return {
    accountId: account!.id,
    targetWorkspaceId,
    authorityOwnerMembershipId: sessionAuthority?.ownerOrganizationMembershipId ?? null,
    subjectId,
    sessionId,
    turnId: turn!.id,
    attemptId: crypto.randomUUID(),
  };
}

async function insertAttempt(
  sql: postgres.Sql,
  ids: FixtureIds,
  attemptId: string,
  turnStatus = "running",
) {
  return await sql.begin(async (tx) => {
    await tx.unsafe("set local opengeni.session_inference_claim = '1'");
    await tx`
      update sessions
      set active_turn_id = ${ids.turnId}, status = ${turnStatus}
      where id = ${ids.sessionId}
        and account_id = ${ids.accountId}
        and workspace_id = ${ids.targetWorkspaceId}
    `;
    await tx`
      update session_turns
      set active_attempt_id = ${attemptId}, execution_generation = 1,
        status = ${turnStatus}
      where id = ${ids.turnId}
        and account_id = ${ids.accountId}
        and workspace_id = ${ids.targetWorkspaceId}
        and session_id = ${ids.sessionId}
    `;
    return await tx`
      insert into session_turn_attempts (
        id, account_id, workspace_id, session_id, turn_id, execution_generation,
        temporal_workflow_id, temporal_workflow_run_id, temporal_activity_id,
        verified_control_revision, authority_epoch, authority_visibility,
        authority_owner_organization_membership_id, mcp_approval_policies,
        connector_action_policies
      ) values (
        ${attemptId}, ${ids.accountId}, ${ids.targetWorkspaceId}, ${ids.sessionId},
        ${ids.turnId}, 1, 'migration-0249-workflow', ${`run-${attemptId}`},
        ${`activity-${attemptId}`}, 1, 1, 'workspace_shared',
        ${ids.authorityOwnerMembershipId}, '{}'::jsonb, '[]'::jsonb
      )
    `;
  });
}

async function setLifecycleStatus(sql: postgres.Sql, ids: FixtureIds, status: string) {
  await sql.begin(async (tx) => {
    await tx.unsafe("set local opengeni.session_inference_claim = '1'");
    await tx`update sessions set status = ${status} where id = ${ids.sessionId}`;
    await tx`update session_turns set status = ${status} where id = ${ids.turnId}`;
  });
}

async function addWorkspaceMembership(sql: postgres.Sql, ids: FixtureIds) {
  await sql`
    insert into workspace_memberships (account_id, workspace_id, subject_id)
    values (${ids.accountId}, ${ids.targetWorkspaceId}, ${ids.subjectId})
  `;
}

async function countWorkspaceMemberships(sql: postgres.Sql, ids: FixtureIds): Promise<number> {
  const [row] = await sql<Array<{ count: number }>>`
    select count(*)::int as count
    from workspace_memberships
    where account_id = ${ids.accountId}
      and workspace_id = ${ids.targetWorkspaceId}
      and subject_id = ${ids.subjectId}
  `;
  return row?.count ?? -1;
}

async function setRuntimeScope(sql: postgres.Sql, ids: FixtureIds) {
  await sql`select set_config('opengeni.account_id', ${ids.accountId}, false)`;
  await sql`select set_config('opengeni.workspace_id', ${ids.targetWorkspaceId}, false)`;
  await sql`select set_config('opengeni.subject_id', ${ids.subjectId}, false)`;
  await sql`select set_config('opengeni.initiating_human_subject_id', ${ids.subjectId}, false)`;
}

async function resolve(sql: postgres.Sql, ids: FixtureIds) {
  return await sql`
    select * from resolve_session_attempt_personal_resources(
      ${ids.accountId}, ${ids.targetWorkspaceId}, ${ids.attemptId}
    )
  `;
}

async function withBlankDatabase(
  label: string,
  callback: (sql: postgres.Sql, databaseUrl: string) => Promise<void>,
): Promise<void> {
  const blank = await acquireMigrationTestDatabase(label);
  if (!blank) return;
  const sql = postgres(blank.databaseUrl, {
    max: 4,
    prepare: false,
    onnotice: () => undefined,
  });
  try {
    await callback(sql, blank.databaseUrl);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => undefined);
    await blank.release();
  }
}

async function acquireMigrationTestDatabase(label: string): Promise<BlankTestDatabase | null> {
  if (!explicitAdminDatabaseUrl) {
    const blank = await acquireBlankTestDatabase(label);
    if (!blank && requireRealDatabase) {
      throw new Error(
        `[migration-0249-personal-resource-delegation-authority-correction] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable for ${label}`,
      );
    }
    return blank;
  }

  const databaseName = `opengeni_0249_${label.replaceAll(/[^a-zA-Z0-9]/g, "_")}_${crypto
    .randomUUID()
    .replaceAll("-", "")}`.slice(0, 63);
  const control = postgres(explicitAdminDatabaseUrl, { max: 1, prepare: false });
  await control.unsafe(`create database ${quoteIdentifier(databaseName)}`);
  const databaseUrl = new URL(explicitAdminDatabaseUrl);
  databaseUrl.pathname = `/${databaseName}`;
  let released = false;
  return {
    databaseUrl: databaseUrl.toString(),
    release: async () => {
      if (released) return;
      released = true;
      try {
        await control`
          select pg_terminate_backend(pid)
          from pg_stat_activity
          where datname = ${databaseName} and pid <> pg_backend_pid()
        `;
        await control.unsafe(`drop database if exists ${quoteIdentifier(databaseName)}`);
      } finally {
        await control.end({ timeout: 5 }).catch(() => undefined);
      }
    },
  };
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
