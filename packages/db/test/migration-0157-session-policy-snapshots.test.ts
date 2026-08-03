import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import {
  activatePreferenceRegistryRevision,
  activateWorkspaceInstructionPolicyRevision,
  claimSessionWorkForAttempt,
  createDb,
  createPreferenceRegistryProposal,
  createSession,
  createWorkspaceInstructionPolicyDraft,
  deactivatePreferenceRegistry,
  getOrCreatePreferenceRegistrySnapshot,
  getOrCreateWorkspaceInstructionPolicySnapshot,
  getPreferenceRegistryFullContent,
  getSession,
  initializeSessionStartAtomically,
  migrate,
  provisionRoles,
  withWorkspaceRls,
  type DbClient,
} from "../src";
import * as schema from "../src/schema";

const migrationPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../drizzle/0157_session_policy_role_snapshots.sql",
);

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
let app: postgres.Sql | null = null;
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

type WorkspaceFixture = { accountId: string; workspaceId: string };
type AttemptFixture = WorkspaceFixture & {
  sessionId: string;
  turnId: string;
  attemptId: string;
  executionGeneration: number;
};

beforeAll(async () => {
  const explicitAdminUrl = process.env.OPENGENI_POLICY_GOVERNANCE_TEST_ADMIN_URL;
  const explicitAppUrl = process.env.OPENGENI_POLICY_GOVERNANCE_TEST_APP_URL;
  if (explicitAdminUrl && explicitAppUrl) {
    const appPassword = decodeURIComponent(new URL(explicitAppUrl).password);
    await migrate(explicitAdminUrl);
    await provisionRoles(explicitAdminUrl, { appPassword, rlsStrategy: "force" });
    const admin = postgres(explicitAdminUrl, { max: 4, prepare: false });
    shared = {
      admin,
      adminUrl: explicitAdminUrl,
      appUrl: explicitAppUrl,
      release: async () => {
        await admin.end();
      },
    };
  } else {
    shared = await acquireSharedTestDatabase("migration-0157-policy-snapshots");
  }
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error("real PostgreSQL is required for migration 0157 proof");
    }
    console.warn("[migration-0157] PostgreSQL unavailable, skipping FORCE-RLS assertions");
    return;
  }
  client = createDb(shared.appUrl, { max: 4 });
  app = postgres(shared.appUrl, { max: 2, prepare: false });
}, 180_000);

afterAll(async () => {
  await app?.end().catch(() => undefined);
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

async function freshWorkspace(name: string, accountId?: string): Promise<WorkspaceFixture> {
  const resolvedAccountId =
    accountId ??
    (
      await shared!.admin<{ id: string }[]>`
        insert into managed_accounts (name) values (${`${name}-account`}) returning id
      `
    )[0]!.id;
  const [workspace] = await shared!.admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${resolvedAccountId}, ${`${name}-workspace`}) returning id
  `;
  await shared!.admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${resolvedAccountId})
  `;
  return { accountId: resolvedAccountId, workspaceId: workspace!.id };
}

async function createPolicySession(
  workspace: WorkspaceFixture,
  input: { policyRole?: string; metadata?: Record<string, unknown>; label: string },
) {
  return await createSession(client!.db, {
    ...workspace,
    initialMessage: input.label,
    resources: [],
    tools: [],
    metadata: input.metadata ?? {},
    model: "test-model",
    sandboxBackend: "none",
    ...(input.policyRole ? { policyRole: input.policyRole } : {}),
  });
}

async function seedAttempt(
  workspace: WorkspaceFixture,
  sessionId: string,
  subjectId: string,
  options: {
    initiatorKind?: "subject" | "service";
    initiatingHumanSubjectId?: string | null;
    acceptedAt?: Date;
  } = {},
): Promise<AttemptFixture> {
  const turnId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  const initiatorKind = options.initiatorKind ?? "subject";
  const initiatingHumanSubjectId =
    options.initiatingHumanSubjectId ?? (initiatorKind === "subject" ? subjectId : null);
  await shared!.admin`
    insert into session_turns (
      id, account_id, workspace_id, session_id, trigger_event_id,
      temporal_workflow_id, status, source, position, prompt, model,
      reasoning_effort, sandbox_backend, execution_generation,
      initiator_kind, initiator_subject_id, initiator_context,
      initiating_human_subject_id, created_at
    ) values (
      ${turnId}, ${workspace.accountId}, ${workspace.workspaceId}, ${sessionId},
      ${crypto.randomUUID()}, ${`policy-snapshot-${turnId}`}, 'running', 'user', 1,
      'policy snapshot fixture', 'test-model', 'medium', 'none', 1,
      ${initiatorKind}, ${subjectId}, ${shared!.admin.json({ source: "test" })},
      ${initiatingHumanSubjectId}, ${options.acceptedAt ?? new Date()}
    )
  `;
  await shared!.admin`
    insert into session_turn_attempts (
      id, account_id, workspace_id, session_id, turn_id, execution_generation,
      state, temporal_workflow_id, temporal_workflow_run_id,
      temporal_activity_id, verified_control_revision, mcp_approval_policies
    ) values (
      ${attemptId}, ${workspace.accountId}, ${workspace.workspaceId}, ${sessionId},
      ${turnId}, 1, 'running', ${`policy-snapshot-${turnId}`},
      ${`run-${attemptId}`}, ${`activity-${attemptId}`}, 0, '{}'::jsonb
    )
  `;
  await shared!.admin`
    update session_turns set active_attempt_id = ${attemptId} where id = ${turnId}
  `;
  await shared!.admin`
    update sessions set active_turn_id = ${turnId}, status = 'running' where id = ${sessionId}
  `;
  return {
    ...workspace,
    sessionId,
    turnId,
    attemptId,
    executionGeneration: 1,
  };
}

async function activatePolicy(
  workspace: WorkspaceFixture,
  input: {
    kind: "charter" | "policy";
    scope: "global" | "role";
    roleKey: string | null;
    content: string;
    expectedCurrentRevisionId?: string | null;
  },
) {
  const revision = await createWorkspaceInstructionPolicyDraft(client!.db, {
    ...workspace,
    kind: input.kind,
    scope: input.scope,
    roleKey: input.roleKey,
    content: input.content,
    provenanceSource: "human",
    provenanceSourceId: null,
    supersedesRevisionId: input.expectedCurrentRevisionId ?? null,
    createdBySubjectId: "policy-admin",
  });
  await activateWorkspaceInstructionPolicyRevision(client!.db, {
    ...workspace,
    revisionId: revision.id,
    expectedCurrentRevisionId: input.expectedCurrentRevisionId ?? null,
    actorSubjectId: "policy-admin",
    reason: `activate ${input.content}`,
  });
  return revision;
}

async function expectSqlState(operation: () => Promise<unknown>, expectedCode: string) {
  let caught: unknown;
  try {
    await operation();
  } catch (error) {
    caught = error;
  }
  expect(caught).toMatchObject({ code: expectedCode });
}

describe("migration 0157 session policy role and exact-attempt snapshots", () => {
  test("declares the bounded rolling boundary without membership, document, or knowledge authority", async () => {
    const sql = await readFile(migrationPath, "utf8");
    expect(sql.split(/\r?\n/, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(sql).toContain("SET LOCAL lock_timeout = '5s'");
    expect(sql).toContain("SET LOCAL statement_timeout = '10min'");
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "policy_role" text');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "initiating_human_subject_id" text');
    expect(sql).toContain('VALIDATE CONSTRAINT "sessions_policy_role_chk"');
    expect(sql).toContain('VALIDATE CONSTRAINT "session_turns_initiating_human_subject_id_chk"');
    expect(sql).toContain('CREATE TABLE "workspace_instruction_policy_snapshots"');
    expect(sql).toContain("workspace_instruction_policy_get_or_create_snapshot");
    expect(sql).toContain("preference_registry_canonical_snapshot_at");
    expect(sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("workspace_instruction_policy_snapshots_immutable");
    expect(sql).not.toContain("workspace_memberships");
    expect(sql).not.toContain("knowledge_");
    expect(sql).not.toContain("documents");
  });

  test("freezes exact active heads and never derives policy role from mutable metadata when bound", async () => {
    if (!shared || !client || !app) return;
    const workspace = await freshWorkspace("policy-snapshot");
    const crossWorkspace = await freshWorkspace("policy-snapshot-cross", workspace.accountId);

    const charterV1 = await activatePolicy(workspace, {
      kind: "charter",
      scope: "global",
      roleKey: null,
      content: "CHARTER_V1",
    });
    const globalPolicy = await activatePolicy(workspace, {
      kind: "policy",
      scope: "global",
      roleKey: null,
      content: "GLOBAL_POLICY",
    });
    const reviewerPolicy = await activatePolicy(workspace, {
      kind: "policy",
      scope: "role",
      roleKey: "reviewer",
      content: "REVIEWER_POLICY",
    });
    const operatorPolicy = await activatePolicy(workspace, {
      kind: "policy",
      scope: "role",
      roleKey: "operator",
      content: "OPERATOR_POLICY_MUST_NOT_APPLY",
    });

    const boundSession = await createPolicySession(workspace, {
      label: "bound reviewer",
      policyRole: "reviewer",
      metadata: { role: "operator", membershipRole: "owner" },
    });
    expect(boundSession.policyRole).toBe("reviewer");
    expect((await getSession(client.db, workspace.workspaceId, boundSession.id))?.policyRole).toBe(
      "reviewer",
    );
    await expectSqlState(
      async () =>
        await shared!
          .admin`update sessions set policy_role = 'operator' where id = ${boundSession.id}`,
      "55000",
    );

    const firstAttempt = await seedAttempt(workspace, boundSession.id, "human-reviewer");
    const firstSnapshot = await getOrCreateWorkspaceInstructionPolicySnapshot(
      client.db,
      firstAttempt,
    );
    expect(firstSnapshot.policyRole).toBe("reviewer");
    expect(firstSnapshot.roleSource).toBe("session_binding");
    expect(firstSnapshot.entries.map((entry) => entry.revisionId)).toEqual([
      charterV1.id,
      globalPolicy.id,
      reviewerPolicy.id,
    ]);
    expect(firstSnapshot.entries.map((entry) => entry.content)).toEqual([
      "CHARTER_V1",
      "GLOBAL_POLICY",
      "REVIEWER_POLICY",
    ]);
    expect(firstSnapshot.entries.some((entry) => entry.revisionId === operatorPolicy.id)).toBe(
      false,
    );

    const queuedSession = await createPolicySession(workspace, {
      label: "queued before charter v2",
      policyRole: "reviewer",
    });
    const queuedAcceptedAt = new Date();
    await new Promise((resolve) => setTimeout(resolve, 5));

    const charterV2 = await activatePolicy(workspace, {
      kind: "charter",
      scope: "global",
      roleKey: null,
      content: "CHARTER_V2",
      expectedCurrentRevisionId: charterV1.id,
    });
    const replayed = await getOrCreateWorkspaceInstructionPolicySnapshot(client.db, firstAttempt);
    expect(replayed.id).toBe(firstSnapshot.id);
    expect(replayed.entries[0]?.revisionId).toBe(charterV1.id);
    expect(replayed.entries[0]?.content).toBe("CHARTER_V1");

    const queuedAttempt = await seedAttempt(workspace, queuedSession.id, "human-reviewer", {
      acceptedAt: queuedAcceptedAt,
    });
    const queuedSnapshot = await getOrCreateWorkspaceInstructionPolicySnapshot(
      client.db,
      queuedAttempt,
    );
    expect(queuedSnapshot.entries[0]?.revisionId).toBe(charterV1.id);
    expect(queuedSnapshot.entries[0]?.content).toBe("CHARTER_V1");

    const nextSession = await createPolicySession(workspace, {
      label: "next reviewer",
      policyRole: "reviewer",
    });
    const nextAttempt = await seedAttempt(workspace, nextSession.id, "human-reviewer");
    const nextSnapshot = await getOrCreateWorkspaceInstructionPolicySnapshot(
      client.db,
      nextAttempt,
    );
    expect(nextSnapshot.entries[0]?.revisionId).toBe(charterV2.id);
    expect(nextSnapshot.entries[0]?.content).toBe("CHARTER_V2");

    await expectSqlState(
      async () =>
        await shared!.admin`
        update workspace_instruction_policy_snapshots
        set entry_hash = ${"0".repeat(64)}
        where id = ${firstSnapshot.id}
      `,
      "55000",
    );
    await expectSqlState(
      async () =>
        await app!`
        insert into workspace_instruction_policy_snapshots (
          account_id, workspace_id, session_id, turn_id, attempt_id,
          execution_generation, role_source, entries, entry_hash
        ) values (
          ${workspace.accountId}, ${workspace.workspaceId}, ${boundSession.id},
          ${firstAttempt.turnId}, ${crypto.randomUUID()}, 1, 'none', '[]'::jsonb,
          ${"0".repeat(64)}
        )
      `,
      "42501",
    );

    const crossVisible = await withWorkspaceRls(
      client.db,
      crossWorkspace.workspaceId,
      async (scopedDb) => await scopedDb.select().from(schema.workspaceInstructionPolicySnapshots),
    );
    expect(crossVisible).toEqual([]);
    const [posture] = await shared.admin<
      Array<{
        forceRls: boolean;
        canSelect: boolean;
        canInsert: boolean;
        canUpdate: boolean;
        canDelete: boolean;
        canExecute: boolean;
      }>
    >`
      select
        class.relforcerowsecurity as "forceRls",
        has_table_privilege('opengeni_app', 'workspace_instruction_policy_snapshots', 'SELECT') as "canSelect",
        has_table_privilege('opengeni_app', 'workspace_instruction_policy_snapshots', 'INSERT') as "canInsert",
        has_table_privilege('opengeni_app', 'workspace_instruction_policy_snapshots', 'UPDATE') as "canUpdate",
        has_table_privilege('opengeni_app', 'workspace_instruction_policy_snapshots', 'DELETE') as "canDelete",
        has_function_privilege(
          'opengeni_app',
          'workspace_instruction_policy_get_or_create_snapshot(uuid,uuid,uuid,uuid,uuid,integer)',
          'EXECUTE'
        ) as "canExecute"
      from pg_class class
      where class.oid = 'workspace_instruction_policy_snapshots'::regclass
    `;
    expect(posture).toEqual({
      forceRls: true,
      canSelect: true,
      canInsert: false,
      canUpdate: false,
      canDelete: false,
      canExecute: true,
    });

    const preferenceSnapshot = await getOrCreatePreferenceRegistrySnapshot(client.db, firstAttempt);
    await expectSqlState(
      async () =>
        await shared!
          .admin`delete from preference_registry_snapshots where id = ${preferenceSnapshot.id}`,
      "55000",
    );
    await shared.admin`delete from workspaces where id = ${workspace.workspaceId}`;
    const [remainingSnapshots] = await shared.admin<
      Array<{ policies: number; preferences: number }>
    >`
      select
        (select count(*)::integer from workspace_instruction_policy_snapshots
          where workspace_id = ${workspace.workspaceId}) as policies,
        (select count(*)::integer from preference_registry_snapshots
          where workspace_id = ${workspace.workspaceId}) as preferences
    `;
    expect(remainingSnapshots).toEqual({ policies: 0, preferences: 0 });
  });

  test("normalizes only metadata.role fallback and fails closed for invalid fallback", async () => {
    if (!shared || !client) return;
    const workspace = await freshWorkspace("policy-fallback");
    await activatePolicy(workspace, {
      kind: "policy",
      scope: "role",
      roleKey: "reviewer",
      content: "FALLBACK_REVIEWER_POLICY",
    });

    const fallbackSession = await createPolicySession(workspace, {
      label: "fallback reviewer",
      metadata: { role: "  ReVieWer  ", membershipRole: "owner" },
    });
    const fallbackAttempt = await seedAttempt(workspace, fallbackSession.id, "fallback-human");
    const fallbackSnapshot = await getOrCreateWorkspaceInstructionPolicySnapshot(
      client.db,
      fallbackAttempt,
    );
    expect(fallbackSnapshot.policyRole).toBe("reviewer");
    expect(fallbackSnapshot.roleSource).toBe("metadata_fallback");
    expect(fallbackSnapshot.entries.map((entry) => entry.content)).toEqual([
      "FALLBACK_REVIEWER_POLICY",
    ]);

    const invalidSession = await createPolicySession(workspace, {
      label: "invalid fallback",
      metadata: { role: "../../workspace-owner", membershipRole: "reviewer" },
    });
    const invalidAttempt = await seedAttempt(workspace, invalidSession.id, "invalid-human");
    const invalidSnapshot = await getOrCreateWorkspaceInstructionPolicySnapshot(
      client.db,
      invalidAttempt,
    );
    expect(invalidSnapshot.policyRole).toBeNull();
    expect(invalidSnapshot.roleSource).toBe("invalid_metadata_fallback");
    expect(invalidSnapshot.entries).toEqual([]);
  });

  test("claim atomically installs both governance snapshots for the accepted human turn", async () => {
    if (!shared || !client) return;
    const workspace = await freshWorkspace("policy-claim-snapshots");
    const subjectId = "claim-snapshot-human";
    const charter = await activatePolicy(workspace, {
      kind: "charter",
      scope: "global",
      roleKey: null,
      content: "CLAIM_CHARTER",
    });
    const proposal = await createPreferenceRegistryProposal(client.db, {
      ...workspace,
      actorSubjectId: subjectId,
      principalKind: "human_session",
      scope: "user",
      stableKey: "claim-review-style",
      title: "Claim review style",
      description: "Keep accepted-turn claims evidence-first.",
      content: "Lead with the exact accepted-turn evidence.",
      precedenceRank: 20,
      conflictStrategy: "override",
      conflictsWith: [],
      provenanceSource: "human",
      provenanceSourceId: null,
      expiresAt: null,
    });
    const [revision] = await shared.admin<{ id: string }[]>`
      select id
      from preference_registry_revisions
      where preference_id = ${proposal.id}
      order by revision desc
      limit 1
    `;
    await activatePreferenceRegistryRevision(client.db, {
      ...workspace,
      actorSubjectId: subjectId,
      principalKind: "human_session",
      preferenceId: proposal.id,
      revisionId: revision!.id,
      expectedCurrentRevisionId: null,
      expectedScopeVersion: proposal.scopeVersion,
      authorizeScope: (scope) => expect(scope).toBe("user"),
      reason: "Activate the claim snapshot preference",
    });

    const session = await createSession(client.db, {
      ...workspace,
      initialMessage: "claim the accepted turn",
      resources: [],
      tools: [],
      metadata: {},
      createdBy: { kind: "subject", subjectId, label: "Claim snapshot human" },
      model: "test-model",
      sandboxBackend: "none",
    });
    const started = await initializeSessionStartAtomically(client.db, {
      ...workspace,
      sessionId: session.id,
      reasoningEffortFallback: "medium",
      createdEventPayload: {},
    });
    expect(started.turn).not.toBeNull();
    const attemptId = crypto.randomUUID();
    const claimed = await claimSessionWorkForAttempt(client.db, workspace.workspaceId, {
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      attemptId,
      trigger: { kind: "next" },
    });
    expect(claimed.action).toBe("claimed");

    const snapshotRows = await shared.admin<
      Array<{ policyEntries: unknown; preferenceDescriptors: unknown }>
    >`
      select
        policy.entries as "policyEntries",
        preference.descriptors as "preferenceDescriptors"
      from workspace_instruction_policy_snapshots policy
      join preference_registry_snapshots preference
        on preference.account_id = policy.account_id
        and preference.workspace_id = policy.workspace_id
        and preference.session_id = policy.session_id
        and preference.turn_id = policy.turn_id
        and preference.attempt_id = policy.attempt_id
        and preference.execution_generation = policy.execution_generation
      where policy.attempt_id = ${attemptId}
    `;
    expect(snapshotRows).toHaveLength(1);
    expect(snapshotRows[0]!.policyEntries).toEqual([
      expect.objectContaining({ revisionId: charter.id, kind: "charter", scope: "global" }),
    ]);
    expect(snapshotRows[0]!.preferenceDescriptors).toEqual([
      expect.objectContaining({ stableKey: "claim-review-style", scope: "user" }),
    ]);
  });

  test("freezes accepted-time preferences for a service continuation's causal human", async () => {
    if (!shared || !client) return;
    const workspace = await freshWorkspace("policy-causal-preference");
    const causalHumanSubjectId = "causal-human";
    const proposal = await createPreferenceRegistryProposal(client.db, {
      ...workspace,
      actorSubjectId: causalHumanSubjectId,
      principalKind: "human_session",
      scope: "user",
      stableKey: "review-style",
      title: "Review style",
      description: "Prefer concise evidence-first review summaries.",
      content: "Lead with concrete evidence, then list only actionable findings.",
      precedenceRank: 25,
      conflictStrategy: "override",
      conflictsWith: [],
      provenanceSource: "human",
      provenanceSourceId: null,
      expiresAt: null,
    });
    const [revision] = await shared.admin<{ id: string }[]>`
      select id
      from preference_registry_revisions
      where preference_id = ${proposal.id}
      order by revision desc
      limit 1
    `;
    expect(revision?.id).toBeTruthy();
    await activatePreferenceRegistryRevision(client.db, {
      ...workspace,
      actorSubjectId: causalHumanSubjectId,
      principalKind: "human_session",
      preferenceId: proposal.id,
      revisionId: revision!.id,
      expectedCurrentRevisionId: null,
      expectedScopeVersion: proposal.scopeVersion,
      authorizeScope: (scope) => expect(scope).toBe("user"),
      reason: "Activate causal-human review preference",
    });

    const continuationSession = await createPolicySession(workspace, {
      label: "service continuation",
    });
    const acceptedAt = new Date();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await deactivatePreferenceRegistry(client.db, {
      ...workspace,
      actorSubjectId: causalHumanSubjectId,
      principalKind: "human_session",
      preferenceId: proposal.id,
      expectedCurrentRevisionId: revision!.id,
      expectedScopeVersion: proposal.scopeVersion,
      authorizeScope: (scope) => expect(scope).toBe("user"),
      reason: "Deactivate after the continuation was accepted",
    });

    const continuationAttempt = await seedAttempt(
      workspace,
      continuationSession.id,
      "goal-continuation",
      {
        initiatorKind: "service",
        initiatingHumanSubjectId: causalHumanSubjectId,
        acceptedAt,
      },
    );
    const snapshot = await getOrCreatePreferenceRegistrySnapshot(client.db, continuationAttempt);
    expect(snapshot.initiatingHumanSubjectId).toBe(causalHumanSubjectId);
    expect(snapshot.descriptors.map((descriptor) => descriptor.stableKey)).toEqual([
      "review-style",
    ]);
    const full = await getPreferenceRegistryFullContent(
      client.db,
      continuationAttempt,
      snapshot.descriptors[0]!.retrievalHandle,
    );
    expect(full.content).toBe("Lead with concrete evidence, then list only actionable findings.");
  });
});
