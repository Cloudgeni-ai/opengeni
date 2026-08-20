import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  activatePreferenceRegistryRevision,
  createPreferenceRegistryProposal,
  getCurrentPreferenceRegistryGovernanceMetadata,
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
  shared = await acquireSharedTestDatabase("core-preference-activation-authority");
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
      reasoningEffort: "medium",
      latencyMode: "standard",
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

function preferenceRequest(operationId = crypto.randomUUID()) {
  return {
    operationId,
    lane: "preference" as const,
    scope: "workspace" as const,
    content: "Always deploy staging from the main branch before tagging a release.",
    reason: "The user asked to remember this for the workspace.",
    stableKey: `remember.${crypto.randomUUID().replaceAll("-", "")}`,
    title: "Deploy staging from main",
    description: "User-directed deployment preference.",
  };
}

// Read the canonical descriptor set the accepted-attempt snapshot is built
// from. Going at the builder directly keeps the assertion on the thing that
// changed - how a descriptor reports the authority that activated it - instead
// of on turn-lifecycle scaffolding.
async function descriptorFor(f: Awaited<ReturnType<typeof fixture>>, stableKey: string) {
  const [row] = await shared!.admin<Array<{ canonical_descriptors: unknown }>>`
    select canonical_descriptors from preference_registry_canonical_snapshot_at(
      ${f.grant.accountId}::uuid,
      ${f.grant.workspaceId}::uuid,
      ${f.ownerSubjectId},
      now()
    )`;
  const descriptors = (row?.canonical_descriptors ?? []) as Array<{
    stableKey: string;
    activationAuthority: string | null;
    provenance: { trust: string };
  }>;
  return descriptors.find((d) => d.stableKey === stableKey) ?? null;
}

describe("preference descriptor activation authority (real PostgreSQL)", () => {
  // provenance.trust is the frozen creation-time fact and stays
  // untrusted_proposal for anything an agent proposed. activationAuthority is
  // the separate question the descriptor previously could not answer: did a
  // human actually confirm this, or did policy activate it automatically.
  test("a human-confirmed preference reports human_confirmed alongside an unchanged trust", async () => {
    if (!shared || !client) return;
    const f = await fixture("suggest");
    const router = createRememberRouter({ db: client.db });
    const request = preferenceRequest();
    const receipt = await router.remember({ attempt: f.attempt, request });
    expect(receipt.status).toBe("confirmation_required");
    if (receipt.status !== "confirmation_required") return;
    const answered = await answeredRememberInput(f, receipt.proposalId!, request.content);
    const confirmed = await router.confirm({
      attempt: f.attempt,
      request: {
        target: "proposal",
        operationId: crypto.randomUUID(),
        proposalId: receipt.proposalId!,
        decisionReceiptId: receipt.learning!.receiptId,
        humanInputRequestId: answered,
      },
    });
    expect(confirmed.status).toBe("activated");

    const descriptor = await descriptorFor(f, request.stableKey);
    expect(descriptor).not.toBeNull();
    expect(descriptor!.activationAuthority).toBe("human_confirmed");
    // The frozen fact is deliberately untouched by this change.
    expect(descriptor!.provenance.trust).toBe("untrusted_proposal");

    // The live Workspace State projection reads the same authority through the
    // definer accessor, because the receipts table stays closed to the runtime
    // role. This is a separate code path from the snapshot builder above.
    const metadata = await getCurrentPreferenceRegistryGovernanceMetadata(client.db, {
      workspaceId: f.grant.workspaceId,
      subjectId: f.ownerSubjectId,
    });
    const projected = metadata.descriptors.find((d) => d.revisionId === descriptor!.revisionId);
    expect(projected).toBeDefined();
    expect(projected!.activationAuthority).toBe("human_confirmed");
  }, 180_000);

  test("an automatically activated preference reports automatic", async () => {
    if (!shared || !client) return;
    const f = await fixture("automatic");
    const router = createRememberRouter({ db: client.db });
    const request = preferenceRequest();
    const receipt = await router.remember({ attempt: f.attempt, request });
    expect(receipt.status).toBe("activated");

    const descriptor = await descriptorFor(f, request.stableKey);
    expect(descriptor).not.toBeNull();
    expect(descriptor!.activationAuthority).toBe("automatic");
    expect(descriptor!.provenance.trust).toBe("untrusted_proposal");
  }, 180_000);

  // A preference that became active outside governed learning has no receipt
  // describing it, and must report null rather than inferring one.
  test("a preference activated outside governed learning reports null", async () => {
    if (!shared || !client) return;
    const f = await fixture("automatic");
    const stableKey = `human-authored-${crypto.randomUUID().slice(0, 8)}`;
    const proposal = await createPreferenceRegistryProposal(client.db, {
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      actorSubjectId: f.ownerSubjectId,
      principalKind: "human_session",
      scope: "workspace",
      stableKey,
      title: "Authored directly by a human",
      description: "Activated through the ordinary registry lifecycle.",
      content: "Prefer concise summaries.",
      precedenceRank: 0,
      conflictStrategy: "override",
      conflictsWith: [],
      provenanceSource: "human",
      provenanceSourceId: null,
      expiresAt: null,
    });
    const [revision] = await shared.admin<{ id: string }[]>`
      select id from preference_registry_revisions
      where preference_id = ${proposal.id} order by revision desc limit 1`;
    await activatePreferenceRegistryRevision(client.db, {
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      actorSubjectId: f.ownerSubjectId,
      principalKind: "human_session",
      preferenceId: proposal.id,
      revisionId: revision!.id,
      expectedCurrentRevisionId: null,
      expectedScopeVersion: proposal.scopeVersion,
      authorizeScope: () => undefined,
      reason: "Activate a preference outside governed learning",
    });

    const descriptor = await descriptorFor(f, stableKey);
    expect(descriptor).not.toBeNull();
    expect(descriptor!.activationAuthority).toBeNull();
    // The frozen creation-time fact still reads from the revision itself.
    expect(descriptor!.provenance.trust).toBe("workspace_managed");
  }, 180_000);
});
