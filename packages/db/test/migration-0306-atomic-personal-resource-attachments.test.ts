import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import {
  createDb,
  createSession,
  initializeSessionStartAtomically,
  SessionCreateIdempotencyConflictError,
} from "../src";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

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
        ${personalWorkspaceId}, 11, 'active'
      ) returning id`;
    await admin`
      update workspace_variable_sets set authority_scope = 'user',
        authority_id = ${authority!.id},
        owner_organization_membership_id = ${membership!.id},
        origin_workspace_id = ${personalWorkspaceId}
      where id = ${variableSet!.id}`;

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
        variableSetId: variableSet!.id,
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
