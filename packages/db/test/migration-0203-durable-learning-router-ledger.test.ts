import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import {
  DurableLearningAttemptAuthorityError,
  DurableLearningAttemptReuseError,
  FORCE_RLS_TABLES,
  RUNTIME_READ_ONLY_TABLES,
  bootstrapWorkspace,
  createDb,
  createSession,
  dbSql,
  getDurableLearningAttemptWithReceipt,
  nestedPostgresSqlState,
  runDurableLearningAttempt,
  withRlsContext,
  type DbClient,
  type DurableLearningAuthorityResult,
  type DurableLearningLedgerRequest,
} from "../src";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

const migrationUrl = new URL("../drizzle/0203_durable_learning_router_ledger.sql", import.meta.url);
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

type Fixture = {
  accountId: string;
  workspaceId: string;
  subjectId: string;
  sessionId: string;
  turnId: string;
  attemptId: string;
  executionGeneration: number;
};

beforeAll(async () => {
  const explicitAdminUrl = process.env.OPENGENI_DURABLE_LEARNING_TEST_ADMIN_URL;
  const explicitAppUrl = process.env.OPENGENI_DURABLE_LEARNING_TEST_APP_URL;
  if (explicitAdminUrl && explicitAppUrl) {
    await migrate(explicitAdminUrl);
    await provisionRoles(explicitAdminUrl, {
      appPassword: decodeURIComponent(new URL(explicitAppUrl).password),
      rlsStrategy: "force",
    });
    const admin = postgres(explicitAdminUrl, { max: 8, prepare: false });
    shared = {
      admin,
      adminUrl: explicitAdminUrl,
      appUrl: explicitAppUrl,
      release: async () => await admin.end(),
    };
  } else {
    shared = await acquireSharedTestDatabase("migration-0203-durable-learning-router-ledger");
  }
  if (!shared && requireRealDatabase) {
    throw new Error("OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable for migration 0203");
  }
  if (shared) client = createDb(shared.appUrl, { max: 8 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

async function fixture(label: string): Promise<Fixture> {
  const subjectId = `human:durable-learning-${label}`;
  const access = await bootstrapWorkspace(client!.db, {
    accountExternalSource: "test",
    accountExternalId: `durable-learning-account-${label}-${crypto.randomUUID()}`,
    accountName: `Durable learning ${label}`,
    workspaceExternalSource: "test",
    workspaceExternalId: `durable-learning-workspace-${label}-${crypto.randomUUID()}`,
    workspaceName: `Durable learning ${label}`,
    subjectId,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(client!.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "Durable learning fixture",
    resources: [],
    metadata: {},
    model: "test-model",
    sandboxBackend: "none",
  });
  const turnId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  await shared!.admin`
    insert into session_turns (
      id, account_id, workspace_id, session_id, trigger_event_id,
      temporal_workflow_id, status, source, position, prompt, model,
      reasoning_effort, sandbox_backend, execution_generation,
      initiator_kind, initiator_subject_id, initiator_context,
      initiating_human_subject_id
    ) values (
      ${turnId}, ${grant.accountId}, ${grant.workspaceId}, ${session.id},
      ${crypto.randomUUID()}, ${`durable-learning-${turnId}`}, 'running', 'user', 1,
      'durable learning fixture', 'test-model', 'medium', 'none', 1,
      'subject', ${subjectId}, ${shared!.admin.json({ source: "test" })}, ${subjectId}
    )`;
  await shared!.admin`
    insert into session_turn_attempts (
      id, account_id, workspace_id, session_id, turn_id, execution_generation,
      state, temporal_workflow_id, temporal_workflow_run_id,
      temporal_activity_id, verified_control_revision, mcp_approval_policies
    ) values (
      ${attemptId}, ${grant.accountId}, ${grant.workspaceId}, ${session.id},
      ${turnId}, 1, 'running', ${`durable-learning-${turnId}`},
      ${`run-${attemptId}`}, ${`activity-${attemptId}`}, 0, '{}'::jsonb
    )`;
  await shared!.admin`
    update session_turns set active_attempt_id = ${attemptId} where id = ${turnId}`;
  await shared!.admin`
    update sessions set active_turn_id = ${turnId}, status = 'running' where id = ${session.id}`;
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId,
    sessionId: session.id,
    turnId,
    attemptId,
    executionGeneration: 1,
  };
}

function companyAttempt(input: Fixture, operationId: string, content = "Ship safe writes.") {
  const request: DurableLearningLedgerRequest = {
    operation: "write",
    attemptId: operationId,
    targetSurface: "company_profile",
    confirmation: { state: "confirmed" },
    subject: { kind: "company_goal", stableKey: "safe-writes", content },
  };
  return {
    operationId,
    authority: {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      attemptId: input.attemptId,
      executionGeneration: input.executionGeneration,
    },
    request,
    decision: {
      disposition: "route" as const,
      destination: "company_profile" as const,
      scope: { kind: "organization" as const },
      authority: "active" as const,
    },
  };
}

function workspaceInstructionAttempt(input: Fixture, operationId: string) {
  const request: DurableLearningLedgerRequest = {
    operation: "write",
    attemptId: operationId,
    targetSurface: "workspace_instruction_policy",
    confirmation: { state: "confirmed" },
    subject: {
      kind: "workspace_instruction",
      target: { kind: "policy", scope: "global", roleKey: null },
      content: "Require exact workspace authority.",
    },
  };
  return {
    operationId,
    authority: {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      attemptId: input.attemptId,
      executionGeneration: input.executionGeneration,
    },
    request,
    decision: {
      disposition: "route" as const,
      destination: "workspace_instruction_policy" as const,
      scope: { kind: "workspace" as const },
      authority: "active" as const,
    },
  };
}

function appliedCompanyResult(): DurableLearningAuthorityResult {
  return {
    outcome: "applied",
    resource: {
      surface: "company_profile",
      id: crypto.randomUUID(),
      version: "1",
      status: "active",
    },
    effectiveBoundary: "next_accepted_attempt",
    rollback: { supported: false, targetAttemptId: null, token: null },
  };
}

describe("migration 0203 durable-learning router ledger", () => {
  test("declares immutable, tenant-isolated, read-only runtime evidence without a competing store", async () => {
    const migration = await readFile(migrationUrl, "utf8");
    expect(migration.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: rolling");
    for (const table of [
      "durable_learning_attempt_receipts",
      "durable_learning_attempts",
    ] as const) {
      expect(migration).toContain(`CREATE TABLE "${table}"`);
      expect(FORCE_RLS_TABLES).toContain(table);
      expect(RUNTIME_READ_ONLY_TABLES).toContain(table);
    }
    expect(migration).toContain("durable_learning_begin_attempt");
    expect(migration).toContain("durable_learning_complete_attempt");
    expect(migration).toContain("durable_learning_attempts_immutable");
    expect(migration).toContain("durable_learning_attempt_receipts_immutable");
    expect(migration).toContain("FOR UPDATE OF execution_attempt");
    expect(migration).toContain("FOR SHARE OF session, turn, membership");
    expect(migration).toContain("opengeni.durable_learning_attempt_id");
    expect(migration).toContain("GRANT SELECT ON TABLE durable_learning_attempts");
    expect(migration).not.toMatch(
      /\b(?:INSERT INTO|UPDATE|DELETE FROM)\s+"?(?:documents|knowledge_memories|preference_registry_preferences)"?/iu,
    );
    expect(migration).not.toContain(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE durable_learning_attempts",
    );
  });

  test("replays exact input, rejects changed reuse, isolates tenants, and keeps evidence immutable", async () => {
    if (!shared || !client) return;
    const first = await fixture("replay");
    const foreign = await fixture("foreign");
    const operationId = crypto.randomUUID();
    let applies = 0;
    const original = await runDurableLearningAttempt(
      client.db,
      companyAttempt(first, operationId),
      async () => {
        applies += 1;
        return appliedCompanyResult();
      },
    );
    const replay = await runDurableLearningAttempt(
      client.db,
      companyAttempt(first, operationId),
      async () => {
        applies += 1;
        return appliedCompanyResult();
      },
    );
    expect(replay).toEqual(original);
    expect(applies).toBe(1);
    await expect(
      runDurableLearningAttempt(
        client.db,
        companyAttempt(first, operationId, "Changed immutable input."),
        async () => appliedCompanyResult(),
      ),
    ).rejects.toBeInstanceOf(DurableLearningAttemptReuseError);

    expect(
      await getDurableLearningAttemptWithReceipt(client.db, {
        accountId: first.accountId,
        workspaceId: first.workspaceId,
        attemptId: operationId,
      }),
    ).toMatchObject({ receipt: original, initiatingHumanSubjectId: first.subjectId });
    expect(
      await getDurableLearningAttemptWithReceipt(client.db, {
        accountId: foreign.accountId,
        workspaceId: foreign.workspaceId,
        attemptId: operationId,
      }),
    ).toBeNull();

    let directDmlFailure: unknown;
    try {
      await withRlsContext(
        client.db,
        { accountId: first.accountId, workspaceId: first.workspaceId },
        async (db) =>
          await db.execute(dbSql`
            update durable_learning_attempts
            set canonical_input = canonical_input
            where id = ${operationId}::uuid
          `),
      );
    } catch (error) {
      directDmlFailure = error;
    }
    expect(nestedPostgresSqlState(directDmlFailure)).toBe("42501");

    let directCompletionFailure: unknown;
    try {
      await withRlsContext(
        client.db,
        { accountId: first.accountId, workspaceId: first.workspaceId },
        async (db) =>
          await db.execute(dbSql`
            select receipt from durable_learning_complete_attempt(
              ${operationId}::uuid,
              ${original.inputHash},
              ${JSON.stringify(appliedCompanyResult())}::jsonb
            )
          `),
      );
    } catch (error) {
      directCompletionFailure = error;
    }
    expect(nestedPostgresSqlState(directCompletionFailure)).toBe("42501");
  });

  test("rejects stale or unauthorized attempts and rolls admission back with destination failure", async () => {
    if (!shared || !client) return;
    const unauthorized = await fixture("unauthorized");
    await shared.admin`
      update workspace_memberships
      set role = 'member', permissions = '[]'::jsonb
      where workspace_id = ${unauthorized.workspaceId}
        and subject_id = ${unauthorized.subjectId}`;
    const unauthorizedOperation = crypto.randomUUID();
    await expect(
      runDurableLearningAttempt(
        client.db,
        companyAttempt(unauthorized, unauthorizedOperation),
        async () => appliedCompanyResult(),
      ),
    ).rejects.toBeInstanceOf(DurableLearningAttemptAuthorityError);
    const [unauthorizedCount] = await shared.admin<{ count: number }[]>`
      select count(*)::int as count from durable_learning_attempts
      where id = ${unauthorizedOperation}`;
    expect(unauthorizedCount?.count).toBe(0);

    const workspaceUnauthorized = await fixture("workspace-unauthorized");
    await shared.admin`
      update workspace_memberships
      set role = 'owner', permissions = '[]'::jsonb
      where workspace_id = ${workspaceUnauthorized.workspaceId}
        and subject_id = ${workspaceUnauthorized.subjectId}`;
    await expect(
      runDurableLearningAttempt(
        client.db,
        workspaceInstructionAttempt(workspaceUnauthorized, crypto.randomUUID()),
        async () => ({
          ...appliedCompanyResult(),
          resource: {
            surface: "workspace_instruction_policy",
            id: crypto.randomUUID(),
            version: "1",
            status: "active",
          },
        }),
      ),
    ).rejects.toBeInstanceOf(DurableLearningAttemptAuthorityError);

    const stale = await fixture("stale");
    await shared.admin`
      update session_turn_attempts
      set state = 'closed', outcome = 'completed', closed_at = now()
      where id = ${stale.attemptId}`;
    await expect(
      runDurableLearningAttempt(client.db, companyAttempt(stale, crypto.randomUUID()), async () =>
        appliedCompanyResult(),
      ),
    ).rejects.toBeInstanceOf(DurableLearningAttemptAuthorityError);

    const atomic = await fixture("atomic");
    const failedOperation = crypto.randomUUID();
    await expect(
      runDurableLearningAttempt(client.db, companyAttempt(atomic, failedOperation), async () => {
        throw new Error("destination failed before receipt");
      }),
    ).rejects.toThrow("destination failed before receipt");
    const [failedCounts] = await shared.admin<{ attempts: number; receipts: number }[]>`
      select
        (select count(*)::int from durable_learning_attempts where id = ${failedOperation}) as attempts,
        (select count(*)::int from durable_learning_attempt_receipts where attempt_id = ${failedOperation}) as receipts`;
    expect(failedCounts).toMatchObject({ attempts: 0, receipts: 0 });
  });

  test("serializes concurrent identical attempts into one authority mutation and one receipt", async () => {
    if (!shared || !client) return;
    const current = await fixture("concurrent");
    const operationId = crypto.randomUUID();
    let applies = 0;
    const apply = async () => {
      applies += 1;
      await Bun.sleep(75);
      return appliedCompanyResult();
    };
    const [left, right] = await Promise.all([
      runDurableLearningAttempt(client.db, companyAttempt(current, operationId), apply),
      runDurableLearningAttempt(client.db, companyAttempt(current, operationId), apply),
    ]);
    expect(right).toEqual(left);
    expect(applies).toBe(1);
    const [concurrentCounts] = await shared.admin<{ attempts: number; receipts: number }[]>`
      select
        (select count(*)::int from durable_learning_attempts where id = ${operationId}) as attempts,
        (select count(*)::int from durable_learning_attempt_receipts where attempt_id = ${operationId}) as receipts`;
    expect(concurrentCounts).toMatchObject({ attempts: 1, receipts: 1 });
  });
});
