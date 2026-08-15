import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  activateCompanyProfileRevision,
  bootstrapWorkspace,
  CompanyProfileConflictError,
  createDb,
  createSession,
  dbSql,
  FORCE_RLS_TABLES,
  getOrCreateCompanyProfileSnapshot,
  listCompanyProfile,
  nestedPostgresSqlState,
  RUNTIME_FULL_DML_TABLES,
  RUNTIME_READ_INSERT_TABLES,
  RUNTIME_READ_ONLY_TABLES,
  rollbackCompanyProfileLearning,
  updateCompanyProfile,
  withRlsContext,
  writeCompanyProfileLearning,
  type DbClient,
} from "../src";

const migrationPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../drizzle/0201_company_profile_authority.sql",
);

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("migration-0201-company-profile");
  if (!shared && requireRealDatabase) {
    throw new Error(
      "[migration-0201-company-profile] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
    );
  }
  if (!shared) return;
  client = createDb(shared.appUrl, { max: 4 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

async function seedAttempt(input: {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  acceptedAt?: Date;
}) {
  const turnId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  await shared!.admin.begin(async (tx) => {
    await tx`
      insert into session_turns (
        id, account_id, workspace_id, session_id, trigger_event_id,
        temporal_workflow_id, status, source, position, prompt, model,
        reasoning_effort, sandbox_backend, execution_generation,
        initiator_kind, initiator_subject_id, initiator_context,
        initiating_human_subject_id, created_at
      ) values (
        ${turnId}, ${input.accountId}, ${input.workspaceId}, ${input.sessionId},
        ${crypto.randomUUID()}, ${`company-profile-${turnId}`}, 'running', 'user', 1,
        'company profile snapshot fixture', 'test-model', 'medium', 'none', 1,
        'subject', 'human:profile-admin', ${shared!.admin.json({ source: "test" })},
        'human:profile-admin', ${input.acceptedAt ?? new Date()}
      )
    `;
    await tx`
      update sessions set active_turn_id = ${turnId}, status = 'running'
      where id = ${input.sessionId}`;
    await tx`update session_turns set active_attempt_id = ${attemptId} where id = ${turnId}`;
    await tx`
      insert into session_turn_attempts (
        id, account_id, workspace_id, session_id, turn_id, execution_generation,
        state, temporal_workflow_id, temporal_workflow_run_id,
        temporal_activity_id, verified_control_revision, mcp_approval_policies
      ) values (
        ${attemptId}, ${input.accountId}, ${input.workspaceId}, ${input.sessionId},
        ${turnId}, 1, 'running', ${`company-profile-${turnId}`},
        ${`run-${attemptId}`}, ${`activity-${attemptId}`}, 0, '{}'::jsonb
      )
    `;
  });
  return { ...input, turnId, attemptId, executionGeneration: 1 };
}

describe("migration 0201 company-profile authority", () => {
  test("declares one bounded rolling authority without a second knowledge store", async () => {
    const migration = await readFile(migrationPath, "utf8");
    expect(migration.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(migration).toContain('CREATE TABLE "company_profile_revisions"');
    expect(migration).toContain('CREATE TABLE "company_profile_heads"');
    expect(migration).toContain('CREATE TABLE "company_profile_activation_events"');
    expect(migration).toContain('CREATE TABLE "company_profile_snapshots"');
    expect(migration).toContain("company_profile_get_or_create_snapshot");
    expect(migration).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration).toContain("company_profile_revisions_immutable");
    expect(migration).toContain(
      "octet_length(convert_to(\"content_json\", 'UTF8')) BETWEEN 1 AND 28672",
    );
    expect(migration).not.toMatch(
      /\b(?:FROM|JOIN|INSERT INTO|UPDATE)\s+(?:documents|knowledge_memories|preference_registry_preferences)\b/iu,
    );
    for (const table of [
      "company_profile_activation_events",
      "company_profile_heads",
      "company_profile_revisions",
      "company_profile_snapshots",
    ] as const) {
      expect(FORCE_RLS_TABLES).toContain(table);
    }
    expect(RUNTIME_FULL_DML_TABLES).not.toContain("company_profile_heads");
    expect(RUNTIME_READ_ONLY_TABLES).toContain("company_profile_heads");
    expect(RUNTIME_READ_ONLY_TABLES).toContain("company_profile_activation_events");
    expect(RUNTIME_READ_INSERT_TABLES).toContain("company_profile_revisions");
    expect(RUNTIME_READ_ONLY_TABLES).toContain("company_profile_snapshots");
    expect(migration).toContain("company_profile_heads_lifecycle_only");
    expect(migration).toContain("company_profile_apply_activation");
    expect(migration).not.toContain(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE company_profile_heads TO opengeni_app",
    );
  });

  test("isolates organizations, converges learning writes, freezes accepted turns, and rolls back", async () => {
    if (!shared || !client) return;
    const accountExternalId = `company-profile-account-${crypto.randomUUID()}`;
    const firstAccess = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId,
      accountName: "Company profile account",
      workspaceExternalSource: "test",
      workspaceExternalId: `company-profile-workspace-a-${crypto.randomUUID()}`,
      workspaceName: "Company profile A",
      subjectId: "human:profile-admin",
    });
    const secondAccess = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId,
      accountName: "Company profile account",
      workspaceExternalSource: "test",
      workspaceExternalId: `company-profile-workspace-b-${crypto.randomUUID()}`,
      workspaceName: "Company profile B",
      subjectId: "human:profile-admin",
    });
    const foreignAccess = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: `company-profile-foreign-${crypto.randomUUID()}`,
      accountName: "Foreign account",
      workspaceExternalSource: "test",
      workspaceExternalId: `company-profile-foreign-workspace-${crypto.randomUUID()}`,
      workspaceName: "Foreign workspace",
      subjectId: "human:profile-admin",
    });
    const first = firstAccess.workspaceGrants[0]!;
    const second = secondAccess.workspaceGrants[0]!;
    const foreign = foreignAccess.workspaceGrants[0]!;

    const initial = await updateCompanyProfile(client.db, {
      accountId: first.accountId,
      workspaceId: first.workspaceId,
      profile: {
        identity: "CloudGeni builds OpenGeni.",
        mission: "Make durable autonomous work dependable.",
        products: [{ key: "opengeni", content: "Autonomous work platform." }],
        customers: [],
        goals: [],
        constraints: [],
      },
      expectedCurrentRevisionId: null,
      expectedActivationVersion: 0,
      actorSubjectId: first.subjectId,
      principalKind: "human_session",
      reason: "Initial organization profile",
    });
    expect(initial.head?.revisionId).toBe(initial.revision?.id);
    const sharedInventory = await listCompanyProfile(client.db, {
      accountId: second.accountId,
      workspaceId: second.workspaceId,
      limit: 50,
    });
    expect(sharedInventory.current?.revisionId).toBe(initial.revision?.id);
    expect(sharedInventory.activeRevision?.id).toBe(initial.revision?.id);
    const foreignInventory = await listCompanyProfile(client.db, {
      accountId: foreign.accountId,
      workspaceId: foreign.workspaceId,
      limit: 50,
    });
    expect(foreignInventory.current).toBeNull();
    expect(foreignInventory.activeRevision).toBeNull();

    let directHeadDmlFailure: unknown;
    try {
      await withRlsContext(
        client.db,
        { accountId: first.accountId, workspaceId: first.workspaceId },
        async (scopedDb) =>
          await scopedDb.execute(dbSql`
            update company_profile_heads
            set activated_at = activated_at
            where account_id = ${first.accountId}::uuid
          `),
      );
    } catch (error) {
      directHeadDmlFailure = error;
    }
    expect(nestedPostgresSqlState(directHeadDmlFailure)).toBe("42501");

    await expect(
      updateCompanyProfile(client.db, {
        accountId: first.accountId,
        workspaceId: first.workspaceId,
        profile: initial.revision!.profile,
        expectedCurrentRevisionId: null,
        expectedActivationVersion: 0,
        actorSubjectId: first.subjectId,
        principalKind: "human_session",
        reason: "Stale update",
      }),
    ).rejects.toBeInstanceOf(CompanyProfileConflictError);

    const proposalOperationId = crypto.randomUUID();
    const proposal = await writeCompanyProfileLearning(client.db, {
      operationId: proposalOperationId,
      accountId: first.accountId,
      workspaceId: first.workspaceId,
      actorSubjectId: "agent:profile",
      actorKind: "agent",
      authority: "proposal",
      subject: {
        kind: "company_goal",
        content: "Ship dependable recovery.",
        stableKey: "recovery",
      },
      sourceId: `durable-learning-attempt:${proposalOperationId}`,
    });
    expect(proposal.outcome).toBe("proposed");
    expect(proposal.head).toBeNull();
    expect(
      await writeCompanyProfileLearning(client.db, {
        operationId: proposalOperationId,
        accountId: first.accountId,
        workspaceId: first.workspaceId,
        actorSubjectId: "agent:profile",
        actorKind: "agent",
        authority: "proposal",
        subject: {
          kind: "company_goal",
          content: "Ship dependable recovery.",
          stableKey: "recovery",
        },
        sourceId: `durable-learning-attempt:${proposalOperationId}`,
      }),
    ).toEqual(proposal);

    const activatedProposal = await activateCompanyProfileRevision(client.db, {
      accountId: first.accountId,
      workspaceId: first.workspaceId,
      revisionId: proposal.revision.id,
      expectedCurrentRevisionId: initial.revision!.id,
      expectedActivationVersion: initial.head!.activationVersion,
      actorSubjectId: first.subjectId,
      principalKind: "human_session",
      reason: "Approve routed company goal",
    });
    expect(activatedProposal.head?.revisionId).toBe(proposal.revision.id);

    for (let index = 0; index < 51; index += 1) {
      const operationId = crypto.randomUUID();
      await writeCompanyProfileLearning(client.db, {
        operationId,
        accountId: first.accountId,
        workspaceId: first.workspaceId,
        actorSubjectId: "agent:profile",
        actorKind: "agent",
        authority: "proposal",
        subject: {
          kind: "company_goal",
          content: `Bounded newer proposal ${index}`,
          stableKey: `newer-${index}`,
        },
        sourceId: `durable-learning-attempt:${operationId}`,
      });
    }
    const boundedInventory = await listCompanyProfile(client.db, {
      accountId: first.accountId,
      workspaceId: first.workspaceId,
      limit: 50,
    });
    expect(boundedInventory.revisions).toHaveLength(50);
    expect(boundedInventory.revisions.some(({ id }) => id === proposal.revision.id)).toBe(false);
    expect(boundedInventory.current?.revisionId).toBe(proposal.revision.id);
    expect(boundedInventory.activeRevision?.id).toBe(proposal.revision.id);

    const session = await createSession(client.db, {
      accountId: first.accountId,
      workspaceId: first.workspaceId,
      initialMessage: "snapshot company profile",
      resources: [],
      tools: [],
      metadata: {},
      model: "test-model",
      sandboxBackend: "none",
    });
    const acceptedAt = new Date();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const activeOperationId = crypto.randomUUID();
    const activeWrite = await writeCompanyProfileLearning(client.db, {
      operationId: activeOperationId,
      accountId: first.accountId,
      workspaceId: first.workspaceId,
      actorSubjectId: "agent:profile",
      actorKind: "agent",
      authority: "active",
      subject: {
        kind: "company_constraint",
        content: "Never create a second prompt authority.",
        stableKey: "one-authority",
      },
      sourceId: `durable-learning-attempt:${activeOperationId}`,
    });
    expect(activeWrite.rollbackToken).not.toBeNull();
    const queuedAttempt = await seedAttempt({
      accountId: first.accountId,
      workspaceId: first.workspaceId,
      sessionId: session.id,
      acceptedAt,
    });
    const frozen = await getOrCreateCompanyProfileSnapshot(client.db, queuedAttempt);
    expect(frozen.profile?.id).toBe(proposal.revision.id);
    expect(frozen.profile?.profile.goals).toEqual([
      { key: "recovery", content: "Ship dependable recovery." },
    ]);
    expect(frozen.profile?.profile.constraints).toEqual([]);

    const rolledBack = await rollbackCompanyProfileLearning(client.db, {
      operationId: crypto.randomUUID(),
      accountId: first.accountId,
      workspaceId: first.workspaceId,
      actorSubjectId: "agent:profile",
      actorKind: "agent",
      token: activeWrite.rollbackToken!,
      reason: "Undo routed constraint",
    });
    expect(rolledBack.head?.revisionId).toBe(proposal.revision.id);

    const absenceWriteOperationId = crypto.randomUUID();
    const absenceWrite = await writeCompanyProfileLearning(client.db, {
      operationId: absenceWriteOperationId,
      accountId: foreign.accountId,
      workspaceId: foreign.workspaceId,
      actorSubjectId: "agent:profile",
      actorKind: "agent",
      authority: "active",
      subject: {
        kind: "company_identity",
        content: "Temporary routed identity",
        stableKey: null,
      },
      sourceId: `durable-learning-attempt:${absenceWriteOperationId}`,
    });
    const absenceRollbackOperationId = crypto.randomUUID();
    const absenceRollbackInput = {
      operationId: absenceRollbackOperationId,
      accountId: foreign.accountId,
      workspaceId: foreign.workspaceId,
      actorSubjectId: "agent:profile",
      actorKind: "agent" as const,
      token: absenceWrite.rollbackToken!,
      reason: "Simulate router receipt crash after authority commit",
    };
    const absenceRollback = await rollbackCompanyProfileLearning(client.db, absenceRollbackInput);
    const absenceRollbackReplay = await rollbackCompanyProfileLearning(
      client.db,
      absenceRollbackInput,
    );
    expect(absenceRollback.head).toBeNull();
    expect(absenceRollbackReplay).toEqual(absenceRollback);

    let directOwnerHeadFailure: unknown;
    try {
      await shared.admin`
        update company_profile_heads
        set activated_at = activated_at
        where account_id = ${first.accountId}
      `;
    } catch (error) {
      directOwnerHeadFailure = error;
    }
    expect(nestedPostgresSqlState(directOwnerHeadFailure)).toBe("55000");

    let immutableFailure: unknown;
    try {
      await shared.admin`
        update company_profile_revisions
        set content_hash = ${"0".repeat(64)}
        where id = ${initial.revision!.id}
      `;
    } catch (error) {
      immutableFailure = error;
    }
    expect(nestedPostgresSqlState(immutableFailure)).toBe("55000");
  });
});
