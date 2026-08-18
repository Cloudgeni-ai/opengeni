import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  activateWorkspaceLearningPolicyRevision,
  createDb,
  createSession,
  createWorkspaceLearningPolicyRevision,
  ensureManagedAccessForUser,
  withSessionRlsActorContext,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { createRememberRouter } from "../src/domain/remember";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("core-remember-rule-precision");
  if (!shared && requireRealDatabase) throw new Error("PostgreSQL is unavailable");
  if (shared) client = createDb(shared.appUrl, { max: 8 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

async function fixture() {
  if (!shared || !client) throw new Error("test database unavailable");
  const suffix = crypto.randomUUID();
  const ownerUserId = `rule-precision-${suffix}`;
  const ownerSubjectId = `user:${ownerUserId}`;
  const access = await ensureManagedAccessForUser(client.db, {
    userId: ownerUserId,
    email: `${ownerUserId}@example.test`,
    name: "Rule precision owner",
  });
  const grant = access.workspaceGrants[0]!;
  const session = await withSessionRlsActorContext({ subjectId: ownerSubjectId }, async () =>
    createSession(client!.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "rule baseline precision",
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
    workspaceMode: "suggest",
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
    reason: "Enable suggest learning in this fixture.",
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
        ${crypto.randomUUID()}, ${`rule-precision-${turnId}`}, 'running', 'user', 1,
        'remember', 'test-model', 'medium', 'none', 1, 'subject',
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
        ${turnId}, 1, 'running', ${`rule-precision-${turnId}`}, ${`run-${attemptId}`},
        ${`activity-${attemptId}`}, 0, '{}'::jsonb
      )
    `;
  });
  return {
    grant,
    ownerSubjectId,
    session,
    attempt: {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      turnId,
      attemptId,
      executionGeneration: 1,
    },
  };
}

async function answeredRememberInput(
  f: Awaited<ReturnType<typeof fixture>>,
  targetId: string,
  content: string,
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
          prompt: "Save this as a mandatory workspace rule for everyone in this workspace?",
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
      ${shared!.admin.json({ outcome: "answered", answers: [{ questionId, values: ["save"] }] })}::jsonb,
      ${f.ownerSubjectId}, now()
    )
  `;
  return id;
}

describe("remember rule baseline timestamp precision (real PostgreSQL)", () => {
  // The governed-learning SQL controller writes head activated_at with
  // clock_timestamp() (microseconds); the draft trigger compares the stored
  // baseline_activated_at against it exactly. The proposal insert must copy the
  // stored value losslessly instead of round-tripping through a millisecond
  // JS Date, or every rule remember after a governed activation fails.
  test("a rule proposes and confirms against a microsecond-precision active head", async () => {
    if (!shared || !client) return;
    const f = await fixture();
    const router = createRememberRouter({ db: client.db });
    const first = await router.remember({
      attempt: f.attempt,
      request: {
        operationId: crypto.randomUUID(),
        lane: "instruction_policy",
        scope: "workspace",
        content: "Never push directly to main.",
        reason: "Hard rule stated by the user.",
      },
    });
    expect(first.status).toBe("confirmation_required");
    if (first.status !== "confirmation_required") return;
    const answered = await answeredRememberInput(
      f,
      first.proposalId!,
      "Never push directly to main.",
    );
    const confirmed = await router.confirm({
      attempt: f.attempt,
      request: {
        target: "proposal",
        operationId: crypto.randomUUID(),
        proposalId: first.proposalId!,
        decisionReceiptId: first.learning!.receiptId,
        humanInputRequestId: answered,
      },
    });
    expect(confirmed.status).toBe("activated");
    // Force the exact shape the governed-learning controller produces: a head
    // whose activated_at carries non-zero microseconds. (clock_timestamp() does
    // this 999 times out of 1000; make it deterministic.)
    await shared.admin`
      update workspace_instruction_policy_heads
      set activated_at = date_trunc('milliseconds', activated_at) + interval '370 microseconds'
      where workspace_id = ${f.grant.workspaceId}
    `;
    const [head] = await shared.admin<Array<{ micros: number }>>`
      select extract(microseconds from activated_at)::int % 1000 as micros
      from workspace_instruction_policy_heads where workspace_id = ${f.grant.workspaceId}
    `;
    expect(head?.micros).toBe(370);

    const second = await router.remember({
      attempt: f.attempt,
      request: {
        operationId: crypto.randomUUID(),
        lane: "instruction_policy",
        scope: "workspace",
        content: "Always request review before merging.",
        reason: "Hard rule stated by the user.",
      },
    });
    expect(second.status).toBe("confirmation_required");
    if (second.status !== "confirmation_required") return;
    const answeredSecond = await answeredRememberInput(
      f,
      second.proposalId!,
      "Always request review before merging.",
    );
    const confirmedSecond = await router.confirm({
      attempt: f.attempt,
      request: {
        target: "proposal",
        operationId: crypto.randomUUID(),
        proposalId: second.proposalId!,
        decisionReceiptId: second.learning!.receiptId,
        humanInputRequestId: answeredSecond,
      },
    });
    expect(confirmedSecond.status).toBe("activated");
    if (confirmedSecond.status !== "activated") return;
    expect(confirmedSecond.activation).toMatchObject({
      destination: "instruction_policy",
      authorityKind: "human_confirmed",
    });
  }, 180_000);
});
