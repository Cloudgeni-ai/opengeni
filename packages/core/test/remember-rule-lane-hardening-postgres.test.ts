import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  activateWorkspaceInstructionPolicyRevision,
  activateWorkspaceLearningPolicyRevision,
  createWorkspaceInstructionPolicyDraft,
  createDb,
  createSession,
  createWorkspaceLearningPolicyRevision,
  ensureManagedAccessForUser,
  getWorkspaceInstructionPolicyBaseline,
  withSessionRlsActorContext,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { RememberError, createRememberRouter } from "../src/domain/remember";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("core-remember-hardening");
  if (!shared && requireRealDatabase) throw new Error("PostgreSQL is unavailable");
  if (shared) client = createDb(shared.appUrl, { max: 8 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

async function fixture(mode: "off" | "suggest" | "automatic") {
  if (!shared || !client) throw new Error("test database unavailable");
  const suffix = crypto.randomUUID();
  const ownerUserId = `learning-router-${suffix}`;
  const ownerSubjectId = `user:${ownerUserId}`;
  const access = await ensureManagedAccessForUser(client.db, {
    userId: ownerUserId,
    email: `${ownerUserId}@example.test`,
    name: "Learning router owner",
  });
  const grant = access.workspaceGrants[0]!;
  const session = await withSessionRlsActorContext({ subjectId: ownerSubjectId }, async () =>
    createSession(client!.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "route governed learning",
      resources: [],
      metadata: {},
      model: "test-model",
      sandboxBackend: "none",
      createdBy: { kind: "subject", subjectId: ownerSubjectId },
      createdByContext: {},
    }),
  );
  const revision = await createWorkspaceLearningPolicyRevision(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    workspaceMode: mode,
    actorSubjectId: ownerSubjectId,
    principalKind: "human_session",
  });
  await activateWorkspaceLearningPolicyRevision(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    revisionId: revision.id,
    expectedCurrentRevisionId: null,
    expectedActivationVersion: 0,
    actorSubjectId: ownerSubjectId,
    principalKind: "human_session",
    reason: `Enable ${mode} learning in this fixture.`,
  });
  const turnId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  await shared.admin.begin(async (sql) => {
    await sql`select set_config('opengeni.session_inference_claim', '1', true)`;
    await sql`
      insert into session_turns (
        id, account_id, workspace_id, session_id, trigger_event_id,
        temporal_workflow_id, status, source, position, prompt, model,
        reasoning_effort, sandbox_backend, execution_generation,
        initiator_kind, initiator_subject_id, initiator_context,
        initiating_human_subject_id
      ) values (
        ${turnId}, ${grant.accountId}, ${grant.workspaceId}, ${session.id},
        ${crypto.randomUUID()}, ${`learning-router-${turnId}`}, 'running', 'user', 1,
        'route', 'test-model', 'medium', 'none', 1, 'subject',
        ${ownerSubjectId}, '{}'::jsonb, ${ownerSubjectId}
      )
    `;
    await sql`update sessions set active_turn_id = ${turnId}, status = 'running'
      where workspace_id = ${grant.workspaceId} and id = ${session.id}`;
    await sql`update session_turns set active_attempt_id = ${attemptId}
      where workspace_id = ${grant.workspaceId} and id = ${turnId}`;
    await sql`
      insert into session_turn_attempts (
        id, account_id, workspace_id, session_id, turn_id, execution_generation,
        state, temporal_workflow_id, temporal_workflow_run_id,
        temporal_activity_id, verified_control_revision, mcp_approval_policies
      ) values (
        ${attemptId}, ${grant.accountId}, ${grant.workspaceId}, ${session.id},
        ${turnId}, 1, 'running', ${`learning-router-${turnId}`}, ${`run-${attemptId}`},
        ${`activity-${attemptId}`}, 0, '{}'::jsonb
      )
    `;
  });
  const attempt = {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId: session.id,
    turnId,
    attemptId,
    executionGeneration: 1,
  };
  return { grant, ownerSubjectId, session, attempt };
}

async function answeredRememberInput(
  f: Awaited<ReturnType<typeof fixture>>,
  targetId: string,
  content: string,
  answer: string[] = ["save"],
  prompt = "Save this as a workspace preference for everyone in this workspace?",
): Promise<string> {
  const id = crypto.randomUUID();
  const questionId = `remember:${targetId}`;
  await shared!.admin`
    insert into session_human_input_requests (
      id, account_id, workspace_id, session_id, turn_id, turn_generation,
      creation_attempt_id, tool_call_id, status, questions, allow_skip,
      response, responded_by, responded_at
    ) values (
      ${id}, ${f.grant.accountId}, ${f.grant.workspaceId}, ${f.session.id},
      ${f.attempt.turnId}, 1, ${f.attempt.attemptId}, ${`call-${id}`}, 'answered',
      ${shared!.admin.json([
        {
          id: questionId,
          kind: "single_select",
          prompt,
          label: "Remember",
          helpText: content,
          options: [
            { id: "save", label: "Save" },
            { id: "skip", label: "Don't save" },
          ],
          required: true,
          allowOther: false,
        },
      ])}::jsonb,
      false,
      ${shared!.admin.json({ outcome: "answered", answers: [{ questionId, values: answer }] })}::jsonb,
      ${f.ownerSubjectId}, now()
    )
  `;
  return id;
}

async function seedActiveHead(f: Awaited<ReturnType<typeof fixture>>, content: string) {
  const existing = await createWorkspaceInstructionPolicyDraft(client!.db, {
    accountId: f.grant.accountId,
    workspaceId: f.grant.workspaceId,
    kind: "policy",
    scope: "global",
    roleKey: null,
    content,
    provenanceSource: "human",
    provenanceSourceId: null,
    supersedesRevisionId: null,
    createdBySubjectId: f.ownerSubjectId,
  });
  await activateWorkspaceInstructionPolicyRevision(client!.db, {
    accountId: f.grant.accountId,
    workspaceId: f.grant.workspaceId,
    revisionId: existing.id,
    expectedCurrentRevisionId: null,
    expectedActivationVersion: 0,
    actorSubjectId: f.ownerSubjectId,
    reason: "Seed an active head.",
  });
  return existing;
}

const RULE = "Never push directly to main.";
const RULE_PROMPT = "Save this as a mandatory workspace rule for everyone in this workspace?";

describe("remember rule-lane hardening (real PostgreSQL)", () => {
  // Item 2: the activation baseline used to be hashed into the proposal's
  // requestFingerprint, so an ordinary turn-recovery replay of the same
  // operationId recomputed a different fingerprint once the head moved and
  // failed as an operation-reuse conflict instead of idempotently returning the
  // existing proposal.
  test("replaying the same remember operation stays idempotent across a head change", async () => {
    if (!shared || !client) return;
    const f = await fixture("suggest");
    const seeded = await seedActiveHead(f, "Existing human policy.");
    const router = createRememberRouter({ db: client.db });
    const request = {
      operationId: crypto.randomUUID(),
      lane: "instruction_policy" as const,
      scope: "workspace" as const,
      content: RULE,
      reason: "Hard rule stated by the user.",
    };
    const first = await router.remember({ attempt: f.attempt, request });
    expect(first.status).toBe("confirmation_required");
    if (first.status !== "confirmation_required") return;

    // The head moves for an unrelated reason while this turn is still in
    // flight - exactly the state a turn-recovery replay wakes up into.
    const moved = await createWorkspaceInstructionPolicyDraft(client.db, {
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      kind: "policy",
      scope: "global",
      roleKey: null,
      content: "A newer human policy activated by someone else.",
      provenanceSource: "human",
      provenanceSourceId: null,
      supersedesRevisionId: seeded.id,
      createdBySubjectId: f.ownerSubjectId,
    });
    await activateWorkspaceInstructionPolicyRevision(client.db, {
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      revisionId: moved.id,
      expectedCurrentRevisionId: seeded.id,
      expectedActivationVersion: 1,
      actorSubjectId: f.ownerSubjectId,
      reason: "Someone else changed the policy mid-turn.",
    });
    const head = await getWorkspaceInstructionPolicyBaseline(client.db, {
      workspaceId: f.grant.workspaceId,
      target: { kind: "policy", scope: "global", roleKey: null },
    });
    expect(head.expectedActivationVersion).toBe(2);

    // The replay must return the same proposal rather than failing as an
    // operation-reuse conflict.
    const replay = await router.remember({ attempt: f.attempt, request });
    expect(replay.status).toBe("confirmation_required");
    if (replay.status !== "confirmation_required") return;
    expect(replay.proposalId).toBe(first.proposalId);
  }, 180_000);

  // Item 1: a moved head surfaced as an untyped error with no guidance.
  test("a stale baseline at confirm time is a typed, actionable failure", async () => {
    if (!shared || !client) return;
    const f = await fixture("suggest");
    await seedActiveHead(f, "Existing human policy.");
    const router = createRememberRouter({ db: client.db });
    const first = await router.remember({
      attempt: f.attempt,
      request: {
        operationId: crypto.randomUUID(),
        lane: "instruction_policy",
        scope: "workspace",
        content: RULE,
        reason: "Hard rule stated by the user.",
      },
    });
    expect(first.status).toBe("confirmation_required");
    if (first.status !== "confirmation_required") return;
    const second = await router.remember({
      attempt: f.attempt,
      request: {
        operationId: crypto.randomUUID(),
        lane: "instruction_policy",
        scope: "workspace",
        content: "Always request review before merging.",
        reason: "A second hard rule stated by the user.",
      },
    });
    expect(second.status).toBe("confirmation_required");
    if (second.status !== "confirmation_required") return;

    // Confirm the first: the head advances and strands the second proposal.
    const firstAnswer = await answeredRememberInput(
      f,
      first.proposalId!,
      RULE,
      ["save"],
      RULE_PROMPT,
    );
    await router.confirm({
      attempt: f.attempt,
      request: {
        target: "proposal",
        operationId: crypto.randomUUID(),
        proposalId: first.proposalId!,
        decisionReceiptId: first.learning!.receiptId,
        humanInputRequestId: firstAnswer,
      },
    });

    const secondAnswer = await answeredRememberInput(
      f,
      second.proposalId!,
      "Always request review before merging.",
      ["save"],
      RULE_PROMPT,
    );
    let failure: unknown;
    try {
      await router.confirm({
        attempt: f.attempt,
        request: {
          target: "proposal",
          operationId: crypto.randomUUID(),
          proposalId: second.proposalId!,
          decisionReceiptId: second.learning!.receiptId,
          humanInputRequestId: secondAnswer,
        },
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(RememberError);
    expect((failure as RememberError).code).toBe("baseline_stale");
    expect((failure as RememberError).message).toContain("remember again");
  }, 180_000);

  // Item 4: the evidence note is created before the governed write, so a failed
  // write used to leave a live note behind with nothing referencing it.
  test("a failed governed write archives its evidence note instead of orphaning it", async () => {
    if (!shared || !client) return;
    const f = await fixture("suggest");
    const router = createRememberRouter({
      db: client.db,
      learningRouter: {
        write: async () => {
          throw new Error("governed write exploded");
        },
      },
    });
    await expect(
      router.remember({
        attempt: f.attempt,
        request: {
          operationId: crypto.randomUUID(),
          lane: "instruction_policy",
          scope: "workspace",
          content: RULE,
          reason: "Hard rule stated by the user.",
        },
      }),
    ).rejects.toThrow("governed write exploded");

    const notes = await shared.admin<Array<{ status: string; text: string }>>`
      select status, text from task_notes
      where workspace_id = ${f.grant.workspaceId} and text = ${RULE}`;
    expect(notes).toHaveLength(1);
    expect(notes[0]!.status).toBe("archived");
  }, 180_000);
});
