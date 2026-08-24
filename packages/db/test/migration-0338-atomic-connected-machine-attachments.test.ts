import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import { createDb, createSession, initializeSessionStartAtomically } from "../src";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

describe("migration 0338 atomic Connected Machine attachments", () => {
  let blank: BlankTestDatabase | null = null;
  let admin: postgres.Sql | null = null;
  let app: postgres.Sql | null = null;

  beforeAll(async () => {
    blank = await acquireBlankTestDatabase("migration-0338-atomic-connected-machine");
    if (!blank) {
      if (requireRealDatabase) throw new Error("[migration-0338] PostgreSQL is required");
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

  test("declares a drained protocol extension and recovery-stable machine admission", async () => {
    const source = await Bun.file(
      new URL("../drizzle/0338_atomic_connected_machine_attachments.sql", import.meta.url),
    ).text();
    const migratorSource = await Bun.file(new URL("../src/migrate.ts", import.meta.url)).text();
    expect(source).toStartWith("-- deployment-mode: maintenance");
    expect(source).toContain("requires all configured OpenGeni application database sessions");
    expect(source).toContain("'connected_machine.use', 'session_active_sandbox'");
    expect(source).toContain("resource_count BETWEEN 1 AND 28");
    expect(source).toContain("zz_session_attempt_personal_machine_admission_v1");
    expect(source).toContain("snapshot.resource_kind = 'connected_machine'");
    expect(source).toContain("ALTER TABLE enrollments NO FORCE ROW LEVEL SECURITY");
    expect(source).toContain("ALTER TABLE enrollments FORCE ROW LEVEL SECURITY");
    expect(source).not.toContain("CREATE TEMP");
    expect(migratorSource).toContain(
      'ATOMIC_CONNECTED_MACHINE_CUTOVER_MIGRATION = "0338_atomic_connected_machine_attachments.sql"',
    );
    expect(migratorSource).toContain("!applied.has(ATOMIC_CONNECTED_MACHINE_CUTOVER_MIGRATION)");
  });

  test("attaches a selected personal machine once and reuses it on turn recovery", async () => {
    if (!blank || !admin || !app) return;
    const accountId = crypto.randomUUID();
    const personalWorkspaceId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    const subjectId = `human:${crypto.randomUUID()}`;
    const sessionId = crypto.randomUUID();

    await admin`insert into managed_accounts (id, name) values (${accountId}, 'machine attach')`;
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
      ) values (${accountId}, 1, ${"a".repeat(64)}, ${"b".repeat(64)}, 'migration-0338')`;

    const [machine] = await app.begin(async (sql) => {
      await sql`select set_config('opengeni.account_id', ${accountId}, true)`;
      await sql`select set_config('opengeni.workspace_id', ${workspaceId}, true)`;
      await sql`select set_config('opengeni.subject_id', ${subjectId}, true)`;
      return await sql<Array<{ enrollmentId: string; sandboxId: string }>>`
        select enrollment_id as "enrollmentId", sandbox_id as "sandboxId"
        from finalize_scoped_enrollment(
          ${accountId}::uuid, ${workspaceId}::uuid, 'user',
          ${`pubkey-${crypto.randomUUID()}`}, true, false, 'macos', 'arm64',
          'Owner machine', false
        )`;
    });
    if (!machine) throw new Error("personal machine fixture missing");

    const client = createDb(blank.databaseUrl, { max: 1 });
    try {
      await createSession(client.db, {
        requestedSessionId: sessionId,
        accountId,
        workspaceId,
        initialMessage: "use my machine once",
        resources: [],
        metadata: {},
        createdBy: { kind: "subject", subjectId },
        subjectId,
        model: "test-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "selfhosted",
        firstPartyMcpTools: [],
        initialPersonalResourceAttachmentIntent: {
          mode: "once",
          workspaceSharedAcknowledged: true,
          sharedOutputWarningVersion: 1,
        },
      });
      await admin`
        update sessions set active_sandbox_id = ${machine.sandboxId}
        where id = ${sessionId} and account_id = ${accountId}`;

      const started = await initializeSessionStartAtomically(client.db, {
        accountId,
        workspaceId,
        sessionId,
        reasoningEffortFallback: "medium",
        createdEventPayload: {},
      });
      expect(started.turn?.personalResources).toEqual({
        mode: "once",
        context: "workspace_shared",
        resourceCount: 1,
        resourceKinds: ["connected_machine"],
        sharedOutputWarningVersion: 1,
      });
      if (!started.turn) throw new Error("initial turn fixture missing");
      const turnId = started.turn.id;

      const [sessionAuthority] = await admin<
        Array<{ visibility: string; authorityEpoch: number; ownerMembershipId: string }>
      >`
        select visibility, authority_epoch::int as "authorityEpoch",
          owner_organization_membership_id as "ownerMembershipId"
        from sessions where id = ${sessionId}`;
      if (!sessionAuthority) throw new Error("session authority fixture missing");

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
              verified_control_revision, authority_epoch, authority_visibility,
              authority_owner_organization_membership_id, mcp_approval_policies,
              connector_action_policies, personal_resource_protocol_version
            ) values (
              ${attemptId}, ${accountId}, ${workspaceId}, ${sessionId}, ${turnId}, ${generation},
              'running', 'workflow', ${`run-${generation}`}, ${`activity-${generation}`}, 0,
              ${sessionAuthority.authorityEpoch}, ${sessionAuthority.visibility},
              ${sessionAuthority.ownerMembershipId}, '{}'::jsonb, '[]'::jsonb, 1
            )`;
        });
      };

      const firstAttemptId = crypto.randomUUID();
      await admitAttempt(firstAttemptId, 1);
      const [firstAuthorization] = await admin<Array<{ enrollmentId: string }>>`
        select enrollment_id as "enrollmentId"
        from session_attempt_connected_machine_authorizations
        where attempt_id = ${firstAttemptId}`;
      expect(firstAuthorization).toEqual({ enrollmentId: machine.enrollmentId });

      await admin.begin(async (sql) => {
        await sql.unsafe("set local opengeni.session_inference_claim = '1'");
        await sql`
          update session_turn_attempts set state = 'closed',
            outcome = 'interrupted_recoverable', closed_at = now()
          where id = ${firstAttemptId}`;
        await sql`
          update session_turns set active_attempt_id = null, status = 'recovering'
          where id = ${turnId}`;
      });
      const recoveryAttemptId = crypto.randomUUID();
      await admitAttempt(recoveryAttemptId, 2);
      const [recoveryAuthorization] = await admin<Array<{ enrollmentId: string }>>`
        select enrollment_id as "enrollmentId"
        from session_attempt_connected_machine_authorizations
        where attempt_id = ${recoveryAttemptId}`;
      expect(recoveryAuthorization).toEqual({ enrollmentId: machine.enrollmentId });

      const [grant] = await admin<Array<{ status: string; mode: string; owner: string }>>`
        select grant_value.status, grant_value.mode,
          snapshot.owner_organization_membership_id as owner
        from turn_personal_resource_snapshots snapshot
        join organization_user_resource_grants grant_value on grant_value.id = snapshot.grant_id
        where snapshot.turn_id = ${turnId} and snapshot.resource_kind = 'connected_machine'`;
      expect(grant).toEqual({ status: "consumed", mode: "once", owner: membership!.id });
    } finally {
      await client.close();
    }
  }, 900_000);
});
