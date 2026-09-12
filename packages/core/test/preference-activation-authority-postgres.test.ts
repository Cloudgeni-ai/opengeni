import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  activatePreferenceRegistryRevision,
  getCurrentPreferenceRegistryGovernanceMetadata,
  createDb,
  createSession,
  saveAgentLearningSettings,
  ensureManagedAccessForUser,
  withSessionRlsActorContext,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { approveSkill, saveSkill } from "../src/domain/skills";

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
  await saveAgentLearningSettings(
    client.db,
    {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      actor: {
        kind: "human",
        principalKind: "human_session",
        subjectId: ownerSubjectId,
        settingsScopes: ["workspace"],
      },
    },
    {
      scope: "workspace",
      operationId: crypto.randomUUID(),
      expectedVersion: 0,
      settings: {
        knowledge: "automatic",
        instructions: "review_first",
        skills: mode === "suggest" ? "review_first" : mode,
      },
    },
  );
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

function skillRequest(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    accountId: f.grant.accountId,
    workspaceId: f.grant.workspaceId,
    actor: {
      kind: "agent" as const,
      sessionId: f.attempt.sessionId,
      turnId: f.attempt.turnId,
      attemptId: f.attempt.attemptId,
      executionGeneration: f.attempt.executionGeneration,
    },
    operationId: crypto.randomUUID(),
    skillId: crypto.randomUUID(),
    expectedRevisionId: null,
    expectedScopeVersion: 1,
    stableKey: `deployment-${crypto.randomUUID().slice(0, 8)}`,
    files: [
      {
        path: "SKILL.md",
        content:
          "---\nname: deployment-guidance\ndescription: Deployment guidance.\n---\nDeploy staging from main before tagging a release.",
      },
    ],
    reason: "Canonical Skill authority fixture",
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
    revisionId: string;
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
    const request = skillRequest(f);
    const receipt = await saveSkill(client.db, request);
    expect(receipt.outcome).toBe("pending");
    const confirmed = await approveSkill(client.db, {
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      actor: { kind: "human", subjectId: f.ownerSubjectId, principalKind: "human_session" },
      operationId: crypto.randomUUID(),
      skillId: receipt.skillId,
      revisionId: receipt.revisionId!,
      expectedRevisionId: null,
      expectedScopeVersion: 1,
      reason: "Human approves exact Skill revision",
    });
    expect(confirmed.outcome).toBe("applied");

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
    const request = skillRequest(f);
    const receipt = await saveSkill(client.db, request);
    expect(receipt.outcome).toBe("applied");

    const descriptor = await descriptorFor(f, request.stableKey);
    expect(descriptor).not.toBeNull();
    expect(descriptor!.activationAuthority).toBe("automatic");
    expect(descriptor!.provenance.trust).toBe("untrusted_proposal");
  }, 180_000);

  test("a files-bearing legacy activation without a retained authority receipt still reports null", async () => {
    if (!shared || !client) return;
    const f = await fixture("automatic");
    const preferenceId = crypto.randomUUID();
    const revisionId = crypto.randomUUID();
    const stableKey = `legacy-${crypto.randomUUID().slice(0, 8)}`;
    const content =
      "---\nname: legacy-guidance\ndescription: Legacy authority fixture.\n---\nPrefer concise summaries.";
    // Model migrated, files-bearing history without manufacturing a modern
    // write receipt. The legacy activation itself remains a supported human path.
    await shared.admin.begin(async (tx) => {
      await tx`INSERT INTO preference_registry_preferences(id,account_id,stable_key,scope,scope_workspace_id,created_by_subject_id)
        VALUES(${preferenceId},${f.grant.accountId},${stableKey},'workspace',${f.grant.workspaceId},${f.ownerSubjectId})`;
      await tx`INSERT INTO preference_registry_revisions(id,account_id,preference_id,title,description,content,content_hash,
        conflict_strategy,provenance_source,trust,created_by_subject_id,skill_files,skill_activation_mode)
        VALUES(${revisionId},${f.grant.accountId},${preferenceId},'legacy-guidance','Legacy authority fixture.',${content},
          encode(sha256(convert_to(${content},'UTF8')),'hex'),'override','human','workspace_managed',${f.ownerSubjectId},
          ${tx.json([{ path: "SKILL.md", content }])},'workspace_managed')`;
      await tx`INSERT INTO preference_registry_events(account_id,preference_id,type,version,new_revision_id,new_scope,new_workspace_id,actor_subject_id,reason)
        VALUES(${f.grant.accountId},${preferenceId},'proposal_created',1,${revisionId},'workspace',${f.grant.workspaceId},${f.ownerSubjectId},'Canonical legacy fixture')`;
    });
    await activatePreferenceRegistryRevision(client.db, {
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      actorSubjectId: f.ownerSubjectId,
      principalKind: "human_session",
      preferenceId,
      revisionId,
      expectedCurrentRevisionId: null,
      expectedScopeVersion: 1,
      authorizeScope: () => undefined,
      reason: "Activate retained canonical history",
    });
    const descriptor = await descriptorFor(f, stableKey);
    expect(descriptor).not.toBeNull();
    expect(descriptor!.activationAuthority).toBeNull();
    expect(descriptor!.provenance.trust).toBe("workspace_managed");
  }, 180_000);

  test("a human Skill save reports human_confirmed without Knowledge-backed activation", async () => {
    if (!shared || !client) return;
    const f = await fixture("automatic");
    const request = skillRequest(f);
    await saveSkill(client.db, {
      ...request,
      actor: { kind: "human", subjectId: f.ownerSubjectId, principalKind: "human_session" },
    });

    const descriptor = await descriptorFor(f, request.stableKey);
    expect(descriptor).not.toBeNull();
    expect(descriptor!.activationAuthority).toBe("human_confirmed");
    // The frozen creation-time fact still reads from the revision itself.
    expect(descriptor!.provenance.trust).toBe("workspace_managed");
  }, 180_000);
});
