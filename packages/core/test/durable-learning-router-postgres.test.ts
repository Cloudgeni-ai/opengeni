import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import {
  activateWorkspaceInstructionPolicyRevision,
  bootstrapWorkspace,
  createDb,
  createSession,
  createWorkspaceInstructionPolicyDraft,
  getPreferenceRegistryDetail,
  listCompanyProfile,
  listWorkspaceInstructionPolicyRevisions,
  updateCompanyProfile,
  type DbClient,
} from "@opengeni/db";
import { migrate } from "@opengeni/db/migrate";
import { provisionRoles } from "@opengeni/db/provision-roles";
import { createDurableLearningRouter } from "../src/domain/durable-learning-router";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

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
    shared = await acquireSharedTestDatabase("durable-learning-router-postgres");
  }
  if (!shared && requireRealDatabase) {
    throw new Error("OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable for router proof");
  }
  if (shared) client = createDb(shared.appUrl, { max: 8 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

async function seedAcceptedAttempt(input: {
  accountId: string;
  workspaceId: string;
  subjectId: string;
}) {
  const session = await createSession(client!.db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    initialMessage: "Confirmed durable learning",
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
      ${turnId}, ${input.accountId}, ${input.workspaceId}, ${session.id},
      ${crypto.randomUUID()}, ${`router-${turnId}`}, 'running', 'user', 1,
      'confirmed durable learning', 'test-model', 'medium', 'none', 1,
      'subject', ${input.subjectId}, ${shared!.admin.json({ source: "test" })},
      ${input.subjectId}
    )`;
  await shared!.admin`
    insert into session_turn_attempts (
      id, account_id, workspace_id, session_id, turn_id, execution_generation,
      state, temporal_workflow_id, temporal_workflow_run_id,
      temporal_activity_id, verified_control_revision, mcp_approval_policies
    ) values (
      ${attemptId}, ${input.accountId}, ${input.workspaceId}, ${session.id},
      ${turnId}, 1, 'running', ${`router-${turnId}`}, ${`run-${attemptId}`},
      ${`activity-${attemptId}`}, 0, '{}'::jsonb
    )`;
  await shared!.admin`
    update session_turns set active_attempt_id = ${attemptId} where id = ${turnId}`;
  await shared!.admin`
    update sessions set active_turn_id = ${turnId}, status = 'running' where id = ${session.id}`;
  return {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sessionId: session.id,
    turnId,
    attemptId,
    executionGeneration: 1,
  };
}

describe("durable-learning router PostgreSQL authorities", () => {
  test("writes and rolls back company goals, workspace instructions, and structured preferences", async () => {
    if (!shared || !client) return;
    const subjectId = `human:router-${crypto.randomUUID()}`;
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: `router-account-${crypto.randomUUID()}`,
      accountName: "Durable router account",
      workspaceExternalSource: "test",
      workspaceExternalId: `router-workspace-${crypto.randomUUID()}`,
      workspaceName: "Durable router workspace",
      subjectId,
    });
    const grant = access.workspaceGrants[0]!;
    const authority = await seedAcceptedAttempt({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      subjectId,
    });

    await updateCompanyProfile(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      profile: {
        identity: "CloudGeni",
        mission: "Ship dependable autonomous work.",
        products: [],
        customers: [],
        goals: [{ key: "baseline", content: "Preserve explicit authority." }],
        constraints: [],
      },
      expectedCurrentRevisionId: null,
      expectedActivationVersion: 0,
      actorSubjectId: subjectId,
      principalKind: "human_session",
      reason: "Router baseline",
    });
    const instructionTarget = { kind: "policy" as const, scope: "global" as const, roleKey: null };
    const baselineInstruction = await createWorkspaceInstructionPolicyDraft(client.db, {
      operationId: crypto.randomUUID(),
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      createdBySubjectId: subjectId,
      ...instructionTarget,
      content: "Preserve the current authority boundary.",
      provenanceSource: "human",
      provenanceSourceId: null,
      supersedesRevisionId: null,
    });
    await activateWorkspaceInstructionPolicyRevision(client.db, {
      operationId: crypto.randomUUID(),
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      revisionId: baselineInstruction.id,
      expectedCurrentRevisionId: null,
      expectedActivationVersion: 0,
      actorSubjectId: subjectId,
      reason: "Router baseline",
    });

    const router = createDurableLearningRouter({ db: client.db });
    const company = await router.write({
      operationId: crypto.randomUUID(),
      authority,
      confirmation: { state: "confirmed" },
      activation: "active",
      subject: {
        kind: "company_goal",
        stableKey: "confirmed-router",
        content: "Route confirmed learning through durable authorities.",
      },
    });
    expect(company).toMatchObject({
      outcome: "applied",
      resource: { surface: "company_profile", status: "active" },
      rollback: { supported: true },
      effectiveBoundary: "next_accepted_attempt",
    });
    const companyInventory = await listCompanyProfile(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      limit: 20,
    });
    expect(companyInventory.activeRevision).toMatchObject({
      createdBySubjectId: subjectId,
      provenance: {
        source: "durable_learning",
        sourceId: `durable-learning-attempt:${company.attemptId}`,
      },
    });
    expect(companyInventory.activeRevision?.profile.goals).toContainEqual({
      key: "confirmed-router",
      content: "Route confirmed learning through durable authorities.",
    });

    const instruction = await router.write({
      operationId: crypto.randomUUID(),
      authority,
      confirmation: { state: "confirmed" },
      activation: "active",
      subject: {
        kind: "workspace_instruction",
        target: instructionTarget,
        content: "Require explicit confirmation before every durable learning write.",
      },
    });
    expect(instruction).toMatchObject({
      outcome: "applied",
      resource: { surface: "workspace_instruction_policy", status: "active" },
      rollback: { supported: true },
    });
    const instructionInventory = await listWorkspaceInstructionPolicyRevisions(
      client.db,
      grant.workspaceId,
      { ...instructionTarget, limit: 20 },
    );
    const instructionHead = instructionInventory.activeHeads.find(
      (head) =>
        head.kind === instructionTarget.kind &&
        head.scope === instructionTarget.scope &&
        head.roleKey === instructionTarget.roleKey,
    );
    expect(
      instructionInventory.revisions.find(
        (revision) => revision.id === instructionHead?.revisionId,
      ),
    ).toMatchObject({
      content: "Require explicit confirmation before every durable learning write.",
      createdBySubjectId: subjectId,
      provenance: { source: "human", sourceId: null },
    });

    const preference = await router.write({
      operationId: crypto.randomUUID(),
      authority,
      confirmation: { state: "confirmed" },
      activation: "active",
      subject: {
        kind: "preference",
        action: "create",
        scope: "user",
        stableKey: "bounded-status-updates",
        title: "Bounded status updates",
        description: "Keep routine implementation updates bounded.",
        content: "Use short status updates during implementation.",
      },
    });
    expect(preference).toMatchObject({
      outcome: "applied",
      resource: { surface: "preference_registry", status: "active" },
      rollback: { supported: true },
    });
    const preferenceId = preference.resource!.id;
    expect(
      await getPreferenceRegistryDetail(client.db, {
        workspaceId: grant.workspaceId,
        subjectId,
        preferenceId,
      }),
    ).toMatchObject({
      preference: {
        status: "active",
        createdBySubjectId: subjectId,
        activeRevision: { createdBySubjectId: subjectId },
      },
    });

    const companyRollback = await router.rollback({
      operationId: crypto.randomUUID(),
      authority,
      confirmation: { state: "confirmed" },
      targetAttemptId: company.attemptId,
      rollbackToken: company.rollback.token,
      reason: "Revert the confirmed company goal.",
    });
    const instructionRollback = await router.rollback({
      operationId: crypto.randomUUID(),
      authority,
      confirmation: { state: "confirmed" },
      targetAttemptId: instruction.attemptId,
      rollbackToken: instruction.rollback.token,
      reason: "Revert the confirmed workspace instruction.",
    });
    const preferenceRollback = await router.rollback({
      operationId: crypto.randomUUID(),
      authority,
      confirmation: { state: "confirmed" },
      targetAttemptId: preference.attemptId,
      rollbackToken: preference.rollback.token,
      reason: "Revert the confirmed personal preference.",
    });
    for (const rollback of [companyRollback, instructionRollback, preferenceRollback]) {
      expect(rollback).toMatchObject({
        outcome: "rolled_back",
        rollback: { supported: false, token: null },
        effectiveBoundary: "next_accepted_attempt",
      });
    }

    expect(
      (
        await listCompanyProfile(client.db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          limit: 20,
        })
      ).activeRevision?.profile.goals,
    ).toEqual([{ key: "baseline", content: "Preserve explicit authority." }]);
    const rolledInstructionInventory = await listWorkspaceInstructionPolicyRevisions(
      client.db,
      grant.workspaceId,
      { ...instructionTarget, limit: 20 },
    );
    expect(
      rolledInstructionInventory.activeHeads.find(
        (head) =>
          head.kind === instructionTarget.kind &&
          head.scope === instructionTarget.scope &&
          head.roleKey === instructionTarget.roleKey,
      )?.revisionId,
    ).toBe(baselineInstruction.id);
    expect(
      await getPreferenceRegistryDetail(client.db, {
        workspaceId: grant.workspaceId,
        subjectId,
        preferenceId,
      }),
    ).toMatchObject({ preference: { status: "inactive", activeRevision: null } });
  });
});
