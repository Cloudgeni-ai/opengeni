import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  acquireBlankTestDatabase,
  acquireOwnerMigratedTestDatabase,
  type BlankTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";
import {
  createDb,
  createSession,
  getVariableSetValuesForRun,
  initializeSessionStartAtomically,
  readVariableSetSecretAtomically,
  SessionCreateIdempotencyConflictError,
} from "../src";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import {
  FORCE_RLS_TABLES,
  PROTECTED_NO_DIRECT_DML_TABLES,
  RUNTIME_TABLE_PRIVILEGES,
} from "../src/runtime-posture";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

async function expectSqlState(run: () => Promise<unknown>, code: string): Promise<void> {
  let captured: unknown;
  try {
    await run();
  } catch (error) {
    captured = error;
  }
  expect((captured as { code?: string } | undefined)?.code).toBe(code);
}

describe("migration 0306 atomic personal-resource attachments", () => {
  let blank: BlankTestDatabase | null = null;
  let admin: postgres.Sql | null = null;
  let app: postgres.Sql | null = null;

  beforeAll(async () => {
    blank = await acquireBlankTestDatabase("migration-0306-atomic-personal-resources");
    if (!blank) {
      if (requireRealDatabase) {
        throw new Error("[migration-0306] PostgreSQL is required but unavailable");
      }
      return;
    }
    await migrate(blank.databaseUrl);
    await provisionRoles(blank.databaseUrl, { appPassword: "apppw", rlsStrategy: "force" });
    admin = postgres(blank.databaseUrl, { max: 2, prepare: false, onnotice: () => undefined });
    const appUrl = new URL(blank.databaseUrl);
    appUrl.username = "opengeni_app";
    appUrl.password = "apppw";
    app = postgres(appUrl.toString(), { max: 1, prepare: false, onnotice: () => undefined });
  }, 900_000);

  afterAll(async () => {
    await app?.end({ timeout: 5 }).catch(() => undefined);
    await admin?.end({ timeout: 5 }).catch(() => undefined);
    await blank?.release();
  }, 180_000);

  test("declares the drained atomic once and recovery protocol", async () => {
    const source = await Bun.file(
      new URL("../drizzle/0306_atomic_personal_resource_attachments.sql", import.meta.url),
    ).text();
    expect(source).toStartWith("-- deployment-mode: maintenance");
    expect(source).toContain("requires an explicit application database role list");
    expect(source).toContain(
      "requires all configured OpenGeni application database sessions to be stopped",
    );
    expect(source).toContain("personal_resource_protocol_version = 1");
    expect(source).toContain("p_workspace_shared_acknowledged IS NOT TRUE");
    expect(source).toContain("p_shared_output_warning_version IS DISTINCT FROM 1");
    expect(source).toContain("turn_personal_resource_once_receipts");
    expect(source).toContain("snapshot.grant_mode = 'once' AND grant_value.status = 'consumed'");
    expect(source).toContain("once_receipt.turn_id = snapshot.turn_id");
    expect(source).toContain("once_receipt.turn_id = accepted.turn_id");
    expect(source).toContain("sessions_initial_personal_resource_intent_immutable");
    expect(source).not.toContain("CREATE TEMP");
    const workDrainWindow = source.slice(
      source.indexOf("-- The production migrator is a NOSUPERUSER/NOBYPASSRLS table owner"),
      source.indexOf("-- No active legacy once grant has an accepted logical-turn owner"),
    );
    const workDrainTables = [
      "sessions",
      "session_turns",
      "rigs",
      "rig_versions",
      "workspace_variable_sets",
    ];
    expect(
      Array.from(workDrainWindow.matchAll(/ALTER TABLE (\w+) NO FORCE ROW LEVEL SECURITY;/g)).map(
        (match) => match[1],
      ),
    ).toEqual(workDrainTables);
    expect(
      Array.from(workDrainWindow.matchAll(/ALTER TABLE (\w+) FORCE ROW LEVEL SECURITY;/g)).map(
        (match) => match[1],
      ),
    ).toEqual(workDrainTables);
    expect(source.indexOf(workDrainWindow)).toBeGreaterThan(
      source.indexOf("$atomic_personal_resource_writer_drain_after_lock$;"),
    );
    expect(
      source.indexOf(
        "ALTER TABLE sessions FORCE ROW LEVEL SECURITY;",
        source.indexOf(workDrainWindow),
      ),
    ).toBeLessThan(
      source.indexOf("ALTER TABLE organization_user_resource_grants NO FORCE ROW LEVEL SECURITY;"),
    );
    for (const table of [
      "turn_personal_resource_attachment_receipts",
      "turn_personal_resource_once_receipts",
      "turn_personal_resource_snapshots",
    ] as const) {
      expect(source).toContain(`CREATE TABLE ${table}`);
      expect(source).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      expect(source).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      expect(FORCE_RLS_TABLES).toContain(table);
      expect(PROTECTED_NO_DIRECT_DML_TABLES).toContain(table);
      expect(RUNTIME_TABLE_PRIVILEGES[table]).toBeUndefined();
    }
  });

  test("consumes once at logical-turn acceptance and admits the same snapshot on recovery", async () => {
    if (!blank || !admin || !app) return;
    const accountId = crypto.randomUUID();
    const personalWorkspaceId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    const subjectId = `human:${crypto.randomUUID()}`;
    const sessionId = crypto.randomUUID();

    await admin`
      insert into managed_accounts (id, name) values (${accountId}, 'atomic attachment')`;
    await admin`
      insert into workspaces (id, account_id, name) values
        (${personalWorkspaceId}, ${accountId}, 'personal'),
        (${workspaceId}, ${accountId}, 'shared')`;
    await admin`
      insert into workspace_inference_controls (workspace_id, account_id) values
        (${personalWorkspaceId}, ${accountId}), (${workspaceId}, ${accountId})`;
    const [membership] = await admin<Array<{ id: string }>>`
      insert into organization_memberships (
        account_id, subject_id, status, personal_workspace_id, authorization_revision
      ) values (${accountId}, ${subjectId}, 'active', ${personalWorkspaceId}, 7)
      returning id`;
    await admin`
      insert into workspace_memberships (account_id, workspace_id, subject_id)
      values (${accountId}, ${workspaceId}, ${subjectId})`;
    await admin`
      insert into session_tenancy_activations (
        account_id, activation_version, inventory_digest, parity_digest, activated_by
      ) values (${accountId}, 1, ${"a".repeat(64)}, ${"b".repeat(64)}, 'migration-0306')`;

    const [variableSet] = await admin<Array<{ id: string }>>`
      insert into workspace_variable_sets (account_id, workspace_id, name)
      values (${accountId}, ${personalWorkspaceId}, 'personal variables') returning id`;
    const [authority] = await admin<Array<{ id: string }>>`
      insert into organization_user_resource_authorities (
        account_id, organization_membership_id, resource_kind, resource_id,
        origin_workspace_id, generation, status
      ) values (
        ${accountId}, ${membership!.id}, 'variable_set', ${variableSet!.id},
        ${personalWorkspaceId}, 1, 'active'
      ) returning id`;
    await admin`
      update workspace_variable_sets set authority_scope = 'user',
        authority_id = ${authority!.id},
        owner_organization_membership_id = ${membership!.id},
        origin_workspace_id = ${personalWorkspaceId}
      where id = ${variableSet!.id}`;
    await admin`
      insert into workspace_variable_set_variables (
        account_id, workspace_id, variable_set_id, name, value_encrypted
      ) values (
        ${accountId}, ${personalWorkspaceId}, ${variableSet!.id},
        'PERSONAL_TOKEN', 'ciphertext:personal-token'
      )`;
    const [workspaceVariableSet] = await admin<Array<{ id: string }>>`
      insert into workspace_variable_sets (
        account_id, workspace_id, name, origin_workspace_id
      ) values (
        ${accountId}, ${workspaceId}, 'shared variables', ${workspaceId}
      ) returning id`;

    const client = createDb(blank.databaseUrl, { max: 1 });
    try {
      const createInput: Parameters<typeof createSession>[1] = {
        requestedSessionId: sessionId,
        accountId,
        workspaceId,
        initialMessage: "use my variables once",
        resources: [],
        metadata: {},
        createdBy: { kind: "subject", subjectId },
        subjectId,
        model: "test-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "modal",
        variableSetIds: [variableSet!.id, workspaceVariableSet!.id],
        variableSetId: workspaceVariableSet!.id,
        firstPartyMcpTools: [],
        createIdempotencyKey: `atomic-attachment-${sessionId}`,
        initialPersonalResourceAttachmentIntent: {
          mode: "once",
          workspaceSharedAcknowledged: true,
          sharedOutputWarningVersion: 1,
        },
      };
      await createSession(client.db, createInput);
      await expect(
        createSession(client.db, {
          ...createInput,
          initialPersonalResourceAttachmentIntent: {
            mode: "session",
            workspaceSharedAcknowledged: true,
            sharedOutputWarningVersion: 1,
          },
        }),
      ).rejects.toBeInstanceOf(SessionCreateIdempotencyConflictError);
      const started = await initializeSessionStartAtomically(client.db, {
        accountId,
        workspaceId,
        sessionId,
        reasoningEffortFallback: "medium",
        createdEventPayload: {},
      });
      expect(started.turn?.personalResources).toMatchObject({
        mode: "once",
        context: "workspace_shared",
        resourceCount: 1,
      });
      expect(started.events.map((event) => event.type)).toContain(
        "session.personal_resources.attached",
      );
      if (!started.turn) throw new Error("atomic initial turn was not returned");
      const turnId = started.turn.id;

      const replayed = await app.begin(async (sql) => {
        await sql`select set_config('opengeni.account_id', ${accountId}, true)`;
        await sql`select set_config('opengeni.workspace_id', ${workspaceId}, true)`;
        await sql`select set_config('opengeni.subject_id', ${subjectId}, true)`;
        return await sql<Array<{ mode: string; count: number; replay: boolean }>>`
          select grant_mode as mode, resource_count::int as count, replay
          from accept_turn_personal_resource_attachment(
            ${accountId}::uuid, ${workspaceId}::uuid, ${sessionId}::uuid, ${turnId}::uuid,
            'once', 1, true, 1
          )`;
      });
      expect(Array.from(replayed)).toEqual([{ mode: "once", count: 1, replay: true }]);
      await expectSqlState(
        async () =>
          await app!.begin(async (sql) => {
            await sql`select set_config('opengeni.account_id', ${accountId}, true)`;
            await sql`select set_config('opengeni.workspace_id', ${workspaceId}, true)`;
            await sql`select set_config('opengeni.subject_id', ${subjectId}, true)`;
            await sql`select * from accept_turn_personal_resource_attachment(
              ${accountId}::uuid, ${workspaceId}::uuid, ${sessionId}::uuid, ${turnId}::uuid,
              'once', 1, ${null}, 1
            )`;
          }),
        "42501",
      );

      const [evidence] = await admin<
        Array<{ grantStatus: string; protocol: number; onceReceipts: number }>
      >`
        select grant_value.status as "grantStatus",
          turn_value.personal_resource_protocol_version::int as protocol,
          (select count(*)::int from turn_personal_resource_once_receipts
            where turn_id = ${turnId}) as "onceReceipts"
        from session_turns turn_value
        join turn_personal_resource_snapshots snapshot on snapshot.turn_id = turn_value.id
        join organization_user_resource_grants grant_value on grant_value.id = snapshot.grant_id
        where turn_value.id = ${turnId}`;
      expect(evidence).toEqual({ grantStatus: "consumed", protocol: 1, onceReceipts: 1 });

      const admitAttempt = async (attemptId: string, generation: number) => {
        await admin!.begin(async (sql) => {
          await sql.unsafe("set local opengeni.session_inference_claim = '1'");
          await sql`
            update sessions set active_turn_id = ${turnId}, status = 'running'
            where id = ${sessionId}`;
          await sql`
            update session_turns set active_attempt_id = ${attemptId},
              execution_generation = ${generation}, status = 'running'
            where id = ${turnId}`;
          await sql`
            insert into session_turn_attempts (
              id, account_id, workspace_id, session_id, turn_id, execution_generation,
              state, temporal_workflow_id, temporal_workflow_run_id, temporal_activity_id,
              verified_control_revision, mcp_approval_policies,
              personal_resource_protocol_version
            ) values (
              ${attemptId}, ${accountId}, ${workspaceId}, ${sessionId}, ${turnId}, ${generation},
              'running', 'workflow', ${`run-${generation}`}, ${`activity-${generation}`}, 0,
              '{}'::jsonb, 1
            )`;
        });
      };

      const firstAttemptId = crypto.randomUUID();
      await admitAttempt(firstAttemptId, 1);
      const [firstAdmission] = await admin<Array<{ count: number }>>`
        select resource_count::int as count from session_attempt_personal_resource_admissions
        where attempt_id = ${firstAttemptId}`;
      expect(firstAdmission).toEqual({ count: 1 });

      const materialized = await getVariableSetValuesForRun(client.db, {
        accountId,
        workspaceId,
        variableSetId: variableSet!.id,
        authority: {
          kind: "agent_attempt",
          subjectId,
          sessionId,
          turnId,
          attemptId: firstAttemptId,
          executionGeneration: 1,
          initiatingHumanSubjectId: subjectId,
        },
      });
      expect(materialized).toMatchObject({
        variableSet: { id: variableSet!.id, scope: "user", generation: 1 },
        values: { PERSONAL_TOKEN: "ciphertext:personal-token" },
      });
      const secret = await readVariableSetSecretAtomically(client.db, {
        accountId,
        workspaceId,
        subjectId,
        variableSetId: variableSet!.id,
        name: "PERSONAL_TOKEN",
        actor: {
          kind: "agent_attempt",
          sessionId,
          turnId,
          attemptId: firstAttemptId,
          executionGeneration: 1,
        },
        decrypt: (valueEncrypted) => valueEncrypted,
      });
      expect(secret?.value).toBe("ciphertext:personal-token");

      await admin.begin(async (sql) => {
        await sql.unsafe("set local opengeni.session_inference_claim = '1'");
        await sql`
          update session_turn_attempts set state = 'closed',
            outcome = 'interrupted_recoverable', closed_at = now()
          where id = ${firstAttemptId}`;
        await sql`update session_turns set active_attempt_id = null, status = 'recovering'
          where id = ${turnId}`;
      });
      const recoveryAttemptId = crypto.randomUUID();
      await admitAttempt(recoveryAttemptId, 2);
      const [recoveryAdmission] = await admin<Array<{ count: number }>>`
        select resource_count::int as count from session_attempt_personal_resource_admissions
        where attempt_id = ${recoveryAttemptId}`;
      expect(recoveryAdmission).toEqual({ count: 1 });

      const authorizeRecoveryRead = async () =>
        await app!.begin(async (sql) => {
          await sql`select set_config('opengeni.account_id', ${accountId}, true)`;
          await sql`select set_config('opengeni.workspace_id', ${workspaceId}, true)`;
          await sql`select set_config('opengeni.subject_id', ${subjectId}, true)`;
          await sql`select set_config('opengeni.initiating_human_subject_id', ${subjectId}, true)`;
          await sql`select authorize_session_attempt_personal_resource_reads(
            ${accountId}::uuid, ${workspaceId}::uuid, ${recoveryAttemptId}::uuid
          )`;
        });
      await authorizeRecoveryRead();

      await admin`
        update organization_user_resource_authorities
        set status = 'revoked', revoked_at = now(), generation = generation + 1
        where id = ${authority!.id}`;
      await expectSqlState(authorizeRecoveryRead, "42501");
    } finally {
      await client.close();
    }
  }, 900_000);
});

describe("migration 0306 under a NOSUPERUSER NOBYPASSRLS owner", () => {
  let owned: OwnerMigratedTestDatabase | null = null;

  beforeAll(async () => {
    owned = await acquireOwnerMigratedTestDatabase("migration-0306-owner-drain");
    if (!owned) {
      if (requireRealDatabase) {
        throw new Error("[migration-0306-owner-drain] PostgreSQL is required but unavailable");
      }
      return;
    }
    await migrate(owned.ownerUrl);
  }, 900_000);

  afterAll(async () => {
    await owned?.release();
  }, 180_000);

  test("rejects active personal-resource work and rolls every drain table back to FORCE RLS", async () => {
    if (!owned) return;
    const { admin, ownerRole, ownerUrl } = owned;
    const [identity] = await admin<Array<{ superuser: boolean; bypassRls: boolean }>>`
      select rolsuper as superuser, rolbypassrls as "bypassRls"
      from pg_roles where rolname = ${ownerRole}`;
    expect(identity).toEqual({ superuser: false, bypassRls: false });

    const accountId = crypto.randomUUID();
    const personalWorkspaceId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    const subjectId = `human:${crypto.randomUUID()}`;
    const sessionId = crypto.randomUUID();
    await admin`
      insert into managed_accounts (id, name) values (${accountId}, '0306 owner drain')`;
    await admin`
      insert into workspaces (id, account_id, name) values
        (${personalWorkspaceId}, ${accountId}, '0306 personal'),
        (${workspaceId}, ${accountId}, '0306 shared')`;
    await admin`
      insert into workspace_inference_controls (workspace_id, account_id) values
        (${personalWorkspaceId}, ${accountId}), (${workspaceId}, ${accountId})`;
    const [membership] = await admin<Array<{ id: string }>>`
      insert into organization_memberships (
        account_id, subject_id, status, personal_workspace_id, authorization_revision
      ) values (${accountId}, ${subjectId}, 'active', ${personalWorkspaceId}, 3)
      returning id`;
    await admin`
      insert into workspace_memberships (account_id, workspace_id, subject_id)
      values (${accountId}, ${workspaceId}, ${subjectId})`;
    await admin`
      insert into session_tenancy_activations (
        account_id, activation_version, inventory_digest, parity_digest, activated_by
      ) values (${accountId}, 1, ${"c".repeat(64)}, ${"d".repeat(64)}, 'migration-0306-owner')`;
    const [variableSet] = await admin<Array<{ id: string }>>`
      insert into workspace_variable_sets (account_id, workspace_id, name)
      values (${accountId}, ${personalWorkspaceId}, '0306 owner variables') returning id`;
    const [authority] = await admin<Array<{ id: string }>>`
      insert into organization_user_resource_authorities (
        account_id, organization_membership_id, resource_kind, resource_id,
        origin_workspace_id, generation, status
      ) values (
        ${accountId}, ${membership!.id}, 'variable_set', ${variableSet!.id},
        ${personalWorkspaceId}, 4, 'active'
      ) returning id`;
    await admin`
      update workspace_variable_sets set authority_scope = 'user',
        authority_id = ${authority!.id},
        owner_organization_membership_id = ${membership!.id},
        origin_workspace_id = ${personalWorkspaceId}
      where id = ${variableSet!.id}`;

    const client = createDb(owned.adminUrl, { max: 1 });
    try {
      await createSession(client.db, {
        requestedSessionId: sessionId,
        accountId,
        workspaceId,
        initialMessage: "active personal-resource work",
        resources: [],
        metadata: {},
        createdBy: { kind: "subject", subjectId },
        subjectId,
        model: "test-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "modal",
        variableSetId: variableSet!.id,
        firstPartyMcpTools: [],
        createIdempotencyKey: `owner-drain-${sessionId}`,
      });
      const started = await initializeSessionStartAtomically(client.db, {
        accountId,
        workspaceId,
        sessionId,
        reasoningEffortFallback: "medium",
        createdEventPayload: {},
      });
      expect(started.turn?.status).toBe("queued");
    } finally {
      await client.close();
    }

    await admin`delete from schema_migrations
      where name = '0306_atomic_personal_resource_attachments.sql'`;
    await expectSqlState(async () => await migrate(ownerUrl), "55000");

    const posture = await admin<Array<{ name: string; forced: boolean }>>`
      select c.relname as name, c.relforcerowsecurity as forced
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = current_schema()
        and c.relname in (
          'sessions', 'session_turns', 'rigs', 'rig_versions', 'workspace_variable_sets'
        )
      order by c.relname`;
    expect(Array.from(posture)).toEqual([
      { name: "rig_versions", forced: true },
      { name: "rigs", forced: true },
      { name: "session_turns", forced: true },
      { name: "sessions", forced: true },
      { name: "workspace_variable_sets", forced: true },
    ]);
  }, 900_000);
});
