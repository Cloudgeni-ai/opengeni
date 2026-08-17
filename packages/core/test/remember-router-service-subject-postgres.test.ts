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
  shared = await acquireSharedTestDatabase("core-remember-service-subject");
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
  const ownerUserId = `remember-service-${suffix}`;
  const ownerSubjectId = `user:${ownerUserId}`;
  const access = await ensureManagedAccessForUser(client.db, {
    userId: ownerUserId,
    email: `${ownerUserId}@example.test`,
    name: "Remember service-subject owner",
  });
  const grant = access.workspaceGrants[0]!;
  const session = await withSessionRlsActorContext({ subjectId: ownerSubjectId }, async () =>
    createSession(client!.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "remember under a service subject",
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
        ${crypto.randomUUID()}, ${`remember-service-${turnId}`}, 'running', 'user', 1,
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
        ${turnId}, 1, 'running', ${`remember-service-${turnId}`}, ${`run-${attemptId}`},
        ${`activity-${attemptId}`}, 0, '{}'::jsonb
      )
    `;
  });
  return {
    ownerSubjectId,
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

describe("remember router under the first-party MCP service subject (real PostgreSQL)", () => {
  // The API executes agent-attempt MCP calls inside
  // withSessionRlsActorContext({ subjectId: <service grant subject>,
  // initiatingHumanSubjectId: <frozen human> }) (apps/api/src/app.ts,
  // withAccessGrantSessionRlsContext). The onboarding-proposal trigger used to
  // compare the proposal's frozen human against `opengeni.subject_id`, which on
  // this path is the service subject, so every real rule call failed with
  // SQLSTATE 23514 while the in-process router (no actor context) passed.
  test("a user-directed rule proposes under the service subject + frozen human context", async () => {
    if (!shared || !client) return;
    const f = await fixture();
    const router = createRememberRouter({ db: client.db });
    const rule = await withSessionRlsActorContext(
      {
        subjectId: "worker:first-party-mcp",
        initiatingHumanSubjectId: f.ownerSubjectId,
      },
      async () =>
        router.remember({
          attempt: f.attempt,
          request: {
            operationId: crypto.randomUUID(),
            lane: "instruction_policy",
            scope: "workspace",
            content: "Never push directly to main.",
            reason: "The user said this is a hard rule.",
          },
        }),
    );
    expect(rule.status).toBe("confirmation_required");
    if (rule.status !== "confirmation_required") return;
    expect(rule.proposalId).not.toBeNull();
    expect(rule.humanInput.questions[0]!.prompt).toContain("mandatory workspace rule");
  }, 180_000);

  // A direct human writer (subject GUC = the human, no initiating-human GUC)
  // must keep working after the trigger change falls back to
  // `opengeni.subject_id`.
  test("a user-directed rule still proposes under a direct human subject context", async () => {
    if (!shared || !client) return;
    const f = await fixture();
    const router = createRememberRouter({ db: client.db });
    const rule = await withSessionRlsActorContext({ subjectId: f.ownerSubjectId }, async () =>
      router.remember({
        attempt: f.attempt,
        request: {
          operationId: crypto.randomUUID(),
          lane: "instruction_policy",
          scope: "workspace",
          content: "Always request a review before merging.",
          reason: "The user said this is a hard rule.",
        },
      }),
    );
    expect(rule.status).toBe("confirmation_required");
    if (rule.status !== "confirmation_required") return;
    expect(rule.proposalId).not.toBeNull();
  }, 180_000);
});
