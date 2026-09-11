import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";
import { createDb, withSessionRlsActorContext } from "../src/database";
import {
  createSession,
  createScheduledTask,
  getScheduledTask,
  createScheduledTaskRun,
  ensureKnowledgeSourceSyncState,
  recordKnowledgeSourceSyncWake,
  claimKnowledgeSourceSyncLease,
  getFile,
  createWorkspaceLearningPolicyRevision,
  activateWorkspaceLearningPolicyRevision,
} from "../src";
import { applySkillLifecycle, listSkillRecords } from "../src/skills";
import { createRememberRouter } from "../../core/test/fixtures/pre-knowledge/remember";
import {
  upsertKnowledgeProvider,
  upsertKnowledgeSource,
  appendKnowledgeSourceAclVersion,
  upsertKnowledgeSourceObject,
  appendKnowledgeDocumentVersion,
  upsertKnowledgeEntity,
  upsertKnowledgeFact,
  appendKnowledgeClaim,
  appendKnowledgeClaimEvidence,
  appendKnowledgeClaimReview,
  recordKnowledgeLifecycleEvent,
} from "../src/scoped-knowledge";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import {
  listAgentInstructionReviews,
  reviewAgentInstruction,
  getAgentInstruction,
  confirmLegacyKnowledge,
  confirmLegacyInstruction,
  recoverLegacyKnowledgeConfirmations,
  getAgentLearningSettings,
  getKnowledgeEntry,
  listKnowledgeEntries,
  type KnowledgeContext,
} from "../src/knowledge-entries";
import { knowledgeMigrationId } from "../src/knowledge-migration";
import { toPostgresLosslessText } from "../src/lossless-json";

const migration = "0460_unified_knowledge.sql";
const sourceTaskId = crypto.randomUUID();
let owned: OwnerMigratedTestDatabase | null = null;
let app: ReturnType<typeof createDb>;
let scoped: { providerId: string; versionId: string; entityId: string; claimId: string };
const accountId = crypto.randomUUID();
const workspaceId = crypto.randomUUID();
const subjectId = `user:${crypto.randomUUID()}`;
const sharedId = crypto.randomUUID();
const personalId = crypto.randomUUID();
const legacyId = crypto.randomUUID();
const fileId = crypto.randomUUID();
const oldPersonalFileId = crypto.randomUUID();
const oldMultipleOwnerFileId = crypto.randomUUID();
const secondFileOwner = `user:${crypto.randomUUID()}`;
const oldSharedFileId = crypto.randomUUID();
const documentId = crypto.randomUUID();
const unpreparedDocumentId = crypto.randomUUID();
const baseId = crypto.randomUUID();
const exactText = `Acme renewal\u0000 with an unpaired surrogate \ud800 and literal \\u0000`;
const longSource = Array.from({ length: 22_000 }, (_, i) => `term${i} definition${i}`).join(" ");
const human: KnowledgeContext = {
  accountId,
  workspaceId,
  actor: {
    kind: "human",
    principalKind: "human_session",
    subjectId,
    writeScopes: ["workspace", "personal"],
    settingsScopes: ["workspace", "personal"],
    review: true,
  },
};

const legacySkillId = crypto.randomUUID();
const legacySkillRevisionId = crypto.randomUUID();
const legacySkillReceiptId = crypto.randomUUID();
let legacyInstructionRevisionId: string;
let answeredInstruction: {
  revisionId: string;
  proposalId: string;
  decisionReceiptId: string;
  humanInputRequestId: string;
};
const legacyInstructionText = "Explain customer-facing changes in plain language.";
let legacyConfirmation: {
  agent: KnowledgeContext;
  claimId: string;
  requestId: string;
  wrongRequestId: string;
  operationId: string;
  exact: string;
};
async function seedLegacyConfirmation(db: ReturnType<typeof createDb>["db"]) {
  await owned!
    .admin`INSERT INTO workspace_inference_controls(workspace_id,account_id) VALUES(${workspaceId},${accountId})`;
  for (const id of [oldPersonalFileId, oldSharedFileId, oldMultipleOwnerFileId])
    await owned!
      .admin`INSERT INTO files(id,account_id,workspace_id,status,filename,safe_filename,content_type,size_bytes,bucket,object_key)
    VALUES(${id},${accountId},${workspaceId},'ready','Legacy.txt','Legacy.txt','text/plain',20,'test',${id})`;
  await withSessionRlsActorContext({ subjectId }, () =>
    createSession(db, {
      accountId,
      workspaceId,
      initialMessage: "Private research",
      memoryScope: "user",
      scopeSubjectId: subjectId,
      resources: [
        { kind: "file", fileId: oldPersonalFileId },
        { kind: "file", fileId: oldMultipleOwnerFileId },
        { kind: "file", fileId: oldSharedFileId },
      ],
      metadata: {},
      model: "test-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      createdBy: { kind: "subject", subjectId },
      createdByContext: {},
    }),
  );
  await withSessionRlsActorContext({ subjectId: secondFileOwner }, () =>
    createSession(db, {
      accountId,
      workspaceId,
      initialMessage: "Another private reader",
      memoryScope: "user",
      scopeSubjectId: secondFileOwner,
      resources: [{ kind: "file", fileId: oldMultipleOwnerFileId }],
      metadata: {},
      model: "test-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      createdBy: { kind: "subject", subjectId: secondFileOwner },
      createdByContext: {},
    }),
  );
  await withSessionRlsActorContext({ subjectId }, () =>
    createSession(db, {
      accountId,
      workspaceId,
      initialMessage: "Shared original",
      resources: [{ kind: "file", fileId: oldSharedFileId }],
      metadata: {},
      model: "test-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      createdBy: { kind: "subject", subjectId },
      createdByContext: {},
    }),
  );
  const exact =
    "Acme renewal includes a 30-day cancellation window.\nKeep the original punctuation: € → ✓.";
  const learningRevision = await createWorkspaceLearningPolicyRevision(db, {
    accountId,
    workspaceId,
    workspaceMode: "suggest",
    actorSubjectId: subjectId,
    principalKind: "human_session",
  });
  await activateWorkspaceLearningPolicyRevision(db, {
    accountId,
    workspaceId,
    revisionId: learningRevision.id,
    expectedCurrentRevisionId: null,
    expectedActivationVersion: 0,
    actorSubjectId: subjectId,
    principalKind: "human_session",
    reason: "Legacy review policy",
  });
  const session = await withSessionRlsActorContext(
    { subjectId, initiatingHumanSubjectId: subjectId },
    () =>
      createSession(db, {
        accountId,
        workspaceId,
        initialMessage: "Remember the contract terms",
        resources: [],
        metadata: {},
        model: "test-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
        createdBy: { kind: "subject", subjectId },
        createdByContext: {},
      }),
  );
  const turnId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  await owned!.admin.begin(async (tx) => {
    await tx`SELECT set_config('opengeni.account_id',${accountId},true),set_config('opengeni.workspace_id',${workspaceId},true),set_config('opengeni.subject_id',${subjectId},true)`;
    await tx`SELECT set_config('opengeni.session_inference_claim','1',true), set_config('opengeni.session_variable_set_attachments_v1','1',true)`;
    await tx`INSERT INTO session_turns(id,account_id,workspace_id,session_id,trigger_event_id,temporal_workflow_id,
      status,source,position,prompt,model,reasoning_effort,sandbox_backend,execution_generation,
      initiator_kind,initiator_subject_id,initiator_context,initiating_human_subject_id)
      VALUES(${turnId},${accountId},${workspaceId},${session.id},${crypto.randomUUID()},${`migration-${turnId}`},
        'running','user',1,'Remember','test-model','medium','none',1,'subject',${subjectId},'{}',${subjectId})`;
    await tx`UPDATE sessions SET active_turn_id=${turnId},status='running' WHERE id=${session.id}`;
    await tx`UPDATE session_turns SET active_attempt_id=${attemptId} WHERE id=${turnId}`;
    await tx`INSERT INTO session_turn_attempts(id,account_id,workspace_id,session_id,turn_id,execution_generation,state,
      temporal_workflow_id,temporal_workflow_run_id,temporal_activity_id,verified_control_revision,mcp_approval_policies)
      VALUES(${attemptId},${accountId},${workspaceId},${session.id},${turnId},1,'running',${`migration-${turnId}`},
        ${`run-${attemptId}`},${`activity-${attemptId}`},0,'{}')`;
  });
  const attempt = {
    accountId,
    workspaceId,
    sessionId: session.id,
    turnId,
    attemptId,
    executionGeneration: 1,
  };
  // Seed history produced by older deployments whose migrator could lock
  // immutable claims. The new owner-role recovery is tested after FORCE returns.
  await owned!.admin`ALTER TABLE knowledge_claims NO FORCE ROW LEVEL SECURITY`;
  await owned!.admin`ALTER TABLE knowledge_claim_evidence NO FORCE ROW LEVEL SECURITY`;
  await owned!.admin`ALTER TABLE knowledge_change_proposals NO FORCE ROW LEVEL SECURITY`;
  await owned!.admin`ALTER TABLE knowledge_claim_reviews NO FORCE ROW LEVEL SECURITY`;
  await owned!.admin`ALTER TABLE task_notes NO FORCE ROW LEVEL SECURITY`;
  const proposed = await createRememberRouter({ db }).remember({
    attempt,
    request: {
      operationId: crypto.randomUUID(),
      lane: "knowledge",
      scope: "workspace",
      content: exact,
      reason: "Explicit user request",
      subject: "Acme",
    },
  });
  // The current read mapper knows the new nullable column. It carries no data
  // in this pre-cutover fixture; remove it before exercising the real migration.
  await owned!
    .admin`ALTER TABLE workspace_instruction_policy_revisions ADD COLUMN agent_learning_context jsonb`;
  const instruction = await createRememberRouter({ db }).remember({
    attempt,
    request: {
      operationId: crypto.randomUUID(),
      lane: "instruction_policy",
      scope: "workspace",
      content: legacyInstructionText,
      reason: "User asked for this workspace instruction",
      target: { kind: "policy", scope: "global", roleKey: null },
    },
  });
  if (!("proposalId" in instruction) || !instruction.proposalId)
    throw new Error("Expected legacy instruction proposal");
  const [native] = await owned!
    .admin`SELECT draft_revision_id FROM workspace_instruction_policy_onboarding_proposals
    WHERE account_id=${accountId} AND source_id=${instruction.proposalId}`;
  if (!native) throw new Error("Expected native inactive instruction revision");
  legacyInstructionRevisionId = native.draft_revision_id;
  // Reproduce an actual pre-0433 pending preference. Only its original nullable
  // folder guard is disabled while seeding; the cutover and review use real roles.
  await owned!.admin.begin(async (seed) => {
    await seed`ALTER TABLE preference_registry_revisions DISABLE TRIGGER skill_guard_legacy_revision`;
    const skillProposalId = crypto.randomUUID();
    const skillEventId = crypto.randomUUID();
    await seed`INSERT INTO knowledge_change_proposals(id,account_id,scope_kind,scope_workspace_id,scope_subject_id,
    scope_key,target_kind,target_scope,target_key,content,content_hash,claim_id,evidence_id,operation_id,input_hash,
    actor_kind,actor_subject_id,initiating_human_subject_id)
    SELECT ${skillProposalId}::uuid,account_id,scope_kind,scope_workspace_id,scope_subject_id,scope_key,
      'preference','workspace','legacy-review-skill',content,content_hash,claim_id,evidence_id,${skillProposalId},input_hash,
      actor_kind,actor_subject_id,initiating_human_subject_id FROM knowledge_change_proposals WHERE id=${instruction.proposalId}::uuid`;
    await seed`INSERT INTO preference_registry_preferences(id,account_id,stable_key,scope,scope_workspace_id,created_by_subject_id)
    VALUES(${legacySkillId},${accountId},'legacy-review-skill','workspace',${workspaceId},${subjectId})`;
    await seed`INSERT INTO preference_registry_revisions(id,account_id,preference_id,title,description,content,content_hash,
    conflict_strategy,provenance_source,provenance_source_id,trust,created_by_subject_id)
    VALUES(${legacySkillRevisionId},${accountId},${legacySkillId},'Customer writing','How to explain customer-facing changes',
      ${legacyInstructionText},encode(sha256(convert_to(${legacyInstructionText},'UTF8')),'hex'),
      'inform','knowledge_proposal',${skillProposalId},'untrusted_proposal',${subjectId})`;
    await seed`INSERT INTO preference_registry_events(id,account_id,preference_id,type,version,new_revision_id,
    new_scope,new_workspace_id,actor_subject_id,reason)
    VALUES(${skillEventId},${accountId},${legacySkillId},'proposal_created',1,${legacySkillRevisionId},'workspace',${workspaceId},${subjectId},'User requested')`;
    await seed`INSERT INTO company_brain_preference_proposal_receipts(id,account_id,workspace_id,operation_id,input_hash,
    knowledge_proposal_id,preference_id,revision_id,creation_event_id,session_id,turn_id,attempt_id,execution_generation,
    actor_subject_id,initiating_human_subject_id)
    VALUES(${legacySkillReceiptId},${accountId},${workspaceId},${crypto.randomUUID()},${"a".repeat(64)},${skillProposalId},
      ${legacySkillId},${legacySkillRevisionId},${skillEventId},${session.id},${turnId},${attemptId},1,${subjectId},${subjectId})`;

    await seed`SET CONSTRAINTS ALL IMMEDIATE`;
    await seed`ALTER TABLE preference_registry_revisions ENABLE TRIGGER skill_guard_legacy_revision`;
  });
  const confirmedInstruction = await createRememberRouter({ db }).remember({
    attempt,
    request: {
      operationId: crypto.randomUUID(),
      lane: "instruction_policy",
      scope: "workspace",
      content: "Be clear about uncertainty when explaining research.",
      reason: "Explicit user instruction",
      target: { kind: "charter", scope: "global", roleKey: null },
    },
  });
  if (
    !("proposalId" in confirmedInstruction) ||
    !confirmedInstruction.proposalId ||
    !confirmedInstruction.learning ||
    !("humanInput" in confirmedInstruction) ||
    !confirmedInstruction.humanInput
  )
    throw new Error("Expected confirmable instruction: " + JSON.stringify(confirmedInstruction));
  const [confirmedNative] = await owned!
    .admin`SELECT draft_revision_id FROM workspace_instruction_policy_onboarding_proposals WHERE account_id=${accountId} AND source_id=${confirmedInstruction.proposalId}`;
  const confirmationId = crypto.randomUUID();
  answeredInstruction = {
    revisionId: confirmedNative!.draft_revision_id,
    proposalId: confirmedInstruction.proposalId,
    decisionReceiptId: confirmedInstruction.learning.receiptId,
    humanInputRequestId: confirmationId,
  };
  await owned!
    .admin`INSERT INTO session_human_input_requests(id,account_id,workspace_id,session_id,turn_id,turn_generation,
    creation_attempt_id,tool_call_id,status,questions,allow_skip,response,responded_by,responded_at)
    VALUES(${confirmationId},${accountId},${workspaceId},${session.id},${turnId},1,${attemptId},${`call-${confirmationId}`},'answered',
      ${owned!.admin.json(confirmedInstruction.humanInput.questions)},false,
      ${owned!.admin.json({ outcome: "answered", answers: [{ questionId: `remember:${confirmedInstruction.proposalId}`, values: ["save"] }] })},${subjectId},now())`;
  await owned!
    .admin`ALTER TABLE workspace_instruction_policy_revisions DROP COLUMN agent_learning_context`;
  await owned!.admin`ALTER TABLE knowledge_claims FORCE ROW LEVEL SECURITY`;
  await owned!.admin`ALTER TABLE knowledge_claim_evidence FORCE ROW LEVEL SECURITY`;
  await owned!.admin`ALTER TABLE knowledge_change_proposals FORCE ROW LEVEL SECURITY`;
  await owned!.admin`ALTER TABLE knowledge_claim_reviews FORCE ROW LEVEL SECURITY`;
  await owned!.admin`ALTER TABLE task_notes FORCE ROW LEVEL SECURITY`;
  if (
    !("claimId" in proposed) ||
    !("humanInput" in proposed) ||
    !proposed.claimId ||
    !proposed.humanInput
  )
    throw new Error("Legacy fixture did not propose knowledge");
  const requestId = crypto.randomUUID();
  const wrongRequestId = crypto.randomUUID();
  for (const [id, responder] of [
    [requestId, subjectId],
    [wrongRequestId, "user:unrelated"],
  ] as const) {
    await owned!
      .admin`INSERT INTO session_human_input_requests(id,account_id,workspace_id,session_id,turn_id,turn_generation,
      creation_attempt_id,tool_call_id,status,questions,allow_skip,response,responded_by,responded_at)
      VALUES(${id},${accountId},${workspaceId},${session.id},${turnId},1,${attemptId},${`call-${id}`},'answered',
        ${owned!.admin.json(proposed.humanInput.questions)},false,
        ${owned!.admin.json({ outcome: "answered", answers: [{ questionId: `remember:${proposed.claimId}`, values: ["save"] }] })},${responder},now())`;
  }
  legacyConfirmation = {
    agent: {
      accountId,
      workspaceId,
      actor: { kind: "agent", sessionId: session.id, turnId, attemptId, executionGeneration: 1 },
    },
    claimId: proposed.claimId,
    requestId,
    wrongRequestId,
    operationId: crypto.randomUUID(),
    exact,
  };
}

beforeAll(async () => {
  owned = await acquireOwnerMigratedTestDatabase("unified-knowledge-owner");
  if (!owned) throw new Error("Knowledge migration verification requires PostgreSQL");
  // A test-only ledger sentinel lets the real runner build the exact prior
  // release, without a production bypass or edits to published migrations.
  const owner = postgres(owned.ownerUrl, { max: 1, onnotice: () => undefined });
  try {
    await owner`CREATE TABLE schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())`;
    await owner`INSERT INTO schema_migrations(name) VALUES(${migration})`;
    await migrate(owned.ownerUrl);
    await owned.admin`INSERT INTO managed_accounts(id,name) VALUES(${accountId},'Acme migration')`;
    await owned.admin`INSERT INTO workspaces(id,account_id,name,settings)
      VALUES(${workspaceId},${accountId},'Migration workspace','{"memoryEnabled":false}')`;
    for (const [id, scope, text] of [
      [sharedId, "workspace", exactText],
      [personalId, "user", "Private Acme contract"],
      [legacyId, "legacy", "Unresolved owner must stay hidden"],
    ] as const) {
      await owned.admin`INSERT INTO knowledge_memories(id,account_id,workspace_id,status,text,text_codec_version,
        scope,scope_type,scope_subject_id,namespace_key,labels)
        VALUES(${id},${accountId},${workspaceId},'active',${toPostgresLosslessText(text)},1,
          ${scope === "workspace" ? "workspace" : scope === "user" ? `user:${subjectId}` : "unknown-old-label"},
          ${scope},${scope === "user" ? subjectId : null},'acme',ARRAY['customer'])`;
    }
    await owned.admin`INSERT INTO files(id,account_id,workspace_id,status,filename,safe_filename,content_type,size_bytes,bucket,object_key)
      VALUES(${fileId},${accountId},${workspaceId},'ready','Acme.pdf','Acme.pdf','application/pdf',500,'test',${fileId})`;
    await owned.admin`INSERT INTO document_bases(id,account_id,workspace_id,name) VALUES(${baseId},${accountId},${workspaceId},'Customer contracts')`;
    await owned.admin`INSERT INTO documents(id,account_id,workspace_id,origin_workspace_id,base_id,file_id,status,title,
      authority_kind,authority_workspace_id) VALUES(${documentId},${accountId},${workspaceId},${workspaceId},${baseId},${fileId},
      'ready','Acme contract','workspace',${workspaceId})`;
    await owned.admin`INSERT INTO files(id,account_id,workspace_id,status,filename,safe_filename,content_type,size_bytes,bucket,object_key)
      VALUES(${unpreparedDocumentId},${accountId},${workspaceId},'ready','Failed.pdf','Failed.pdf','application/pdf',500,'test',${unpreparedDocumentId})`;
    await owned.admin`INSERT INTO documents(id,account_id,workspace_id,origin_workspace_id,base_id,file_id,status,title,
      authority_kind,authority_workspace_id) VALUES(${unpreparedDocumentId},${accountId},${workspaceId},${workspaceId},${baseId},${unpreparedDocumentId},
      'failed','Unprepared contract','workspace',${workspaceId})`;
    await owned!.admin`UPDATE knowledge_memories SET source_refs=${owned!.admin.json([
      { kind: "document", id: documentId, metadata: {} },
      { kind: "document", id: unpreparedDocumentId, metadata: {} },
      {
        kind: "external",
        id: "unavailable-external-id",
        uri: "https://example.test/acme",
        metadata: {},
      },
    ])} WHERE id=${sharedId}`;
    const embedding = `[${Array.from({ length: 3072 }, (_, i) => (i === 0 ? 1 : 0)).join(",")}]`;
    await owned.admin`INSERT INTO document_chunks(account_id,workspace_id,document_id,base_id,file_id,chunk_index,text,
      authority_kind,authority_workspace_id,embedding,embedding_model)
      VALUES(${accountId},${workspaceId},${documentId},${baseId},${fileId},0,${longSource},'workspace',${workspaceId},${embedding}::vector,'test')`;
    const legacy = createDb(owned.ownerUrl, { max: 1, rlsStrategy: "force" });
    try {
      const context = {
        accountId,
        workspaceId,
        actor: { kind: "human" as const, subjectId, initiatingHumanSubjectId: subjectId },
      };
      const scope = { kind: "workspace" as const, workspaceId, subjectId: null };
      const provider = await upsertKnowledgeProvider(legacy.db, {
        ...context,
        scope,
        operationId: "migration-provider",
        providerKey: "contract-system",
        externalTenantId: "acme",
      });
      const source = await upsertKnowledgeSource(legacy.db, {
        ...context,
        scope,
        operationId: "migration-source",
        providerId: provider.id,
        externalSourceId: "contracts",
        sourceKind: "contracts",
      });
      const nativeTask = await createScheduledTask(legacy.db, {
        id: sourceTaskId,
        accountId,
        workspaceId,
        name: "Read contracts every morning",
        status: "active",
        schedule: { type: "interval", everySeconds: 86400 },
        temporalScheduleId: `source-${sourceTaskId}`,
        runMode: "new_session_per_run",
        overlapPolicy: "buffer_one",
        action: {
          kind: "knowledge_source_sync",
          sourceId: source.id,
          sourceGeneration: source.syncGeneration,
          sourceLifecycleGeneration: source.lifecycleGeneration,
          sourceConfigGeneration: 1,
          controlWorkspaceId: workspaceId,
          providerCoordinationKey: "contracts:acme",
          connection: {
            connectionId: crypto.randomUUID(),
            connectionVersion: 1,
            providerDomain: "example.test",
            kind: "oauth2",
            ownerSubjectId: subjectId,
          },
          destination: scope,
          initiatingSubjectId: subjectId,
          allDescendants: true,
          limits: {
            maxItems: 10,
            maxBytes: 1000,
            maxFileBytes: 1000,
            maxProviderRequests: 10,
            maxElapsedSeconds: 30,
            maxConcurrency: 1,
            maxFailureDetails: 5,
          },
        },
        agentConfig: {
          prompt: "Knowledge source synchronization",
          resources: [],
          tools: [],
          metadata: {},
        },
        metadata: {},
      });
      await ensureKnowledgeSourceSyncState(legacy.db, nativeTask);
      const nativeRun = await createScheduledTaskRun(legacy.db, {
        workspaceId,
        taskId: sourceTaskId,
        triggerType: "scheduled",
        producerKey: "pre-cutover-source",
      });
      await recordKnowledgeSourceSyncWake(legacy.db, {
        accountId,
        workspaceId,
        sourceId: source.id,
        scheduledTaskId: sourceTaskId,
        scheduledTaskRunId: nativeRun.id,
        cause: "scheduled",
        producerKey: "pre-cutover-source",
        sourceConfigGeneration: 1,
        sourceLifecycleGeneration: source.lifecycleGeneration,
      });
      await claimKnowledgeSourceSyncLease(legacy.db, {
        accountId,
        workspaceId,
        sourceId: source.id,
        scheduledTaskRunId: nativeRun.id,
        overlapPolicy: "buffer_one",
      });
      const acl = await appendKnowledgeSourceAclVersion(legacy.db, {
        ...context,
        operationId: "migration-acl",
        sourceId: source.id,
        audience: scope,
        expectedSourceLifecycleGeneration: 1,
        expectedAclGeneration: 0,
        agentAccess: true,
        reasonCode: "initial",
      });
      const object = await upsertKnowledgeSourceObject(legacy.db, {
        ...context,
        operationId: "migration-object",
        sourceId: source.id,
        externalObjectId: "acme-agreement",
      });
      const version = await appendKnowledgeDocumentVersion(legacy.db, {
        ...context,
        operationId: "migration-version",
        objectId: object.id,
        expectedSourceLifecycleGeneration: 1,
        expectedObjectLifecycleGeneration: 1,
        expectedVersionGeneration: 0,
        externalVersionId: "v1",
        contentSha256: "a".repeat(64),
        ingestionKey: "acme-v1",
        aclVersionId: acl.id,
        aclGeneration: 1,
        reasonCode: "observed",
      });
      const entity = await upsertKnowledgeEntity(legacy.db, {
        ...context,
        scope,
        operationId: "migration-entity",
        entityType: "company",
        normalizedKey: "acme",
        displayName: "Acme Corporation",
      });
      const fact = await upsertKnowledgeFact(legacy.db, {
        ...context,
        operationId: "migration-fact",
        subjectEntityId: entity.id,
        predicateKey: "renewal-date",
        object: { kind: "text", value: "1 December" },
      });
      const claim = await appendKnowledgeClaim(legacy.db, {
        ...context,
        operationId: "migration-claim",
        factId: fact.id,
        origin: "explicit",
        confidenceBps: 10000,
        effectiveAt: new Date(0).toISOString(),
        extractionMethod: "human",
      });
      await appendKnowledgeClaimEvidence(legacy.db, {
        ...context,
        operationId: "migration-evidence",
        claimId: claim.id,
        documentVersionId: version.id,
        polarity: "supports",
        locator: "Renewal section",
        contentHash: "b".repeat(64),
      });
      await appendKnowledgeClaimReview(legacy.db, {
        ...context,
        operationId: "migration-review",
        claimId: claim.id,
        state: "approved",
        reason: "Checked against the agreement",
      });
      await seedLegacyConfirmation(legacy.db);
      scoped = {
        providerId: provider.id,
        versionId: version.id,
        entityId: entity.id,
        claimId: claim.id,
      };
    } finally {
      await legacy.close();
    }
    await owner`DELETE FROM schema_migrations WHERE name=${migration}`;
  } finally {
    await owner.end({ timeout: 5 });
  }
  await migrate(owned.ownerUrl);
  await provisionRoles(owned.adminUrl, { appPassword: owned.appPassword, rlsStrategy: "force" });
  const appUrl = new URL(owned.adminUrl);
  appUrl.username = "opengeni_app";
  appUrl.password = owned.appPassword;
  app = createDb(appUrl.toString(), { max: 4, rlsStrategy: "force" });
}, 900_000);
afterAll(async () => {
  await app?.close();
  await owned?.release();
}, 180_000);

test("converts source schedules into ordinary agent revisions without changing source or schedule identity", async () => {
  const task = await getScheduledTask(app.db, workspaceId, sourceTaskId);
  expect(task).toMatchObject({
    id: sourceTaskId,
    status: "paused",
    action: { kind: "agent_turn" },
    schedule: { type: "interval", everySeconds: 86400 },
    runMode: "new_session_per_run",
    agentConfig: {
      knowledgeSource: {
        initiatingSubjectId: subjectId,
        destination: { kind: "workspace", workspaceId },
      },
    },
  });
  expect(task?.agentConfig.prompt).toContain("knowledge_source_fetch");
  expect(task?.authorityRevision).toBeGreaterThan(1);
  const [run] = await owned!
    .admin`SELECT action_kind,status,error FROM scheduled_task_runs WHERE task_id=${sourceTaskId}`;
  expect(run).toEqual({
    action_kind: "knowledge_source_sync",
    status: "failed",
    error: "knowledge_source_agent_cutover",
  });
  const [state] = await owned!
    .admin`SELECT lease_id,pending_wake_count,buffered_wake FROM knowledge_source_sync_states WHERE scheduled_task_id=${sourceTaskId}`;
  expect(state).toEqual({ lease_id: null, pending_wake_count: 0, buffered_wake: false });
});

describe("0460 owner-role conversion", () => {
  test("revokes every old Memory writer after conversion", async () => {
    const rows = await owned!.admin`SELECT
      has_table_privilege('opengeni_app','knowledge_memories','INSERT,UPDATE,DELETE') AS can_write,
      has_function_privilege('opengeni_app','evaluate_governed_learning_proposal(uuid,uuid,uuid,uuid,uuid,integer,uuid,uuid,uuid,uuid,uuid)','EXECUTE') AS old_evaluator,
      has_function_privilege('opengeni_app','activate_governed_learning_decision(uuid,uuid,uuid,uuid)','EXECUTE') AS old_activation,
      has_function_privilege('opengeni_app','activate_human_confirmed_learning_decision(uuid,uuid,uuid,uuid,uuid)','EXECUTE') AS old_human_activation,
      has_function_privilege('opengeni_app','materialize_remember_knowledge_memory(uuid,uuid,uuid)','EXECUTE') AS materialize,
      has_function_privilege('opengeni_app','confirm_remember_knowledge_claim(uuid,uuid,uuid,uuid,integer,uuid,uuid,uuid)','EXECUTE') AS old_confirm,
      has_function_privilege('opengeni_app','knowledge_memory_apply_operation(jsonb,text,text,text,uuid,uuid,uuid,integer)','EXECUTE') AS old_save,
      has_table_privilege('opengeni_app','workspace_learning_policy_revisions','INSERT') AS old_learning_revision,
      has_function_privilege('opengeni_app','workspace_learning_policy_apply_activation(uuid,text,uuid,uuid,uuid,uuid,bigint,text,text,text)','EXECUTE') AS old_learning_activation`;
    expect(rows[0]).toEqual({
      can_write: false,
      old_evaluator: false,
      old_activation: false,
      old_human_activation: false,
      materialize: false,
      old_confirm: false,
      old_save: false,
      old_learning_revision: false,
      old_learning_activation: false,
    });
    const failure = await owned!.admin
      .begin(async (tx) => {
        await tx`SELECT set_config('opengeni.account_id',${accountId},true),set_config('opengeni.workspace_id',${workspaceId},true),set_config('opengeni.subject_id',${subjectId},true)`;
        await tx`UPDATE knowledge_memories SET text='changed' WHERE id=${sharedId}`;
      })
      .then(
        () => null,
        (caught) => caught,
      );
    expect(failure?.code).toBe("55000");
  });
  test("backfills personal chat originals without reclassifying an explicitly shared file", async () => {
    expect(await getFile(app.db, workspaceId, oldPersonalFileId)).toBeNull();
    expect(await getFile(app.db, workspaceId, oldMultipleOwnerFileId)).toBeNull();
    expect((await getFile(app.db, workspaceId, oldSharedFileId))?.scope).toBe("workspace");
    await withSessionRlsActorContext(
      { subjectId, privateFileOwnerSubjectId: subjectId },
      async () => {
        expect((await getFile(app.db, workspaceId, oldPersonalFileId))?.scope).toBe("personal");
        expect((await getFile(app.db, workspaceId, oldMultipleOwnerFileId))?.scope).toBe(
          "personal",
        );
      },
    );
    await withSessionRlsActorContext(
      { subjectId: "user:other", privateFileOwnerSubjectId: "user:other" },
      async () => {
        expect(await getFile(app.db, workspaceId, oldPersonalFileId)).toBeNull();
      },
    );
  });
  test("a legacy original used by multiple private chats stays restricted to those owners", async () => {
    await withSessionRlsActorContext(
      { subjectId: secondFileOwner, privateFileOwnerSubjectId: secondFileOwner },
      async () => {
        expect((await getFile(app.db, workspaceId, oldMultipleOwnerFileId))?.scope).toBe(
          "personal",
        );
        expect(await getFile(app.db, workspaceId, oldPersonalFileId)).toBeNull();
      },
    );
    await withSessionRlsActorContext(
      { subjectId: "user:other", privateFileOwnerSubjectId: "user:other" },
      async () => {
        expect(await getFile(app.db, workspaceId, oldMultipleOwnerFileId)).toBeNull();
      },
    );
  });
  test("retired Memory settings cannot silently disagree with Agent learning", async () => {
    await owned!
      .admin`UPDATE workspaces SET settings=settings||'{"memoryEnabled":false,"testSetting":true}'::jsonb WHERE id=${workspaceId}`;
    const error = await owned!
      .admin`UPDATE workspaces SET settings=settings||'{"memoryEnabled":true}'::jsonb WHERE id=${workspaceId}`.then(
      () => null,
      (caught) => caught,
    );
    expect(error?.code).toBe("0A000");
    expect((await getAgentLearningSettings(app.db, human, "workspace")).settings.knowledge).toBe(
      "off",
    );
  });
  test("old pending preferences remain inactive, reviewable Skills with exact original history", async () => {
    const revisionId = knowledgeMigrationId("pending-skill-revision", legacySkillReceiptId);
    const [skill] = await listSkillRecords(
      app.db,
      { accountId, workspaceId, subjectId },
      { skillId: legacySkillId },
    );
    expect(skill).toMatchObject({
      id: legacySkillId,
      status: "proposed",
      activeRevisionId: null,
      pendingRevisionIds: [revisionId],
      title: "customer-writing",
    });
    expect(
      skill?.files
        .find((file) => file.path === "SKILL.md")
        ?.content.endsWith(legacyInstructionText),
    ).toBe(true);
    const [original] = await owned!
      .admin`SELECT content,skill_files FROM preference_registry_revisions WHERE id=${legacySkillRevisionId}`;
    expect(original).toEqual({ content: legacyInstructionText, skill_files: null });
    const receipt = await applySkillLifecycle(
      app.db,
      {
        accountId,
        workspaceId,
        actor: { kind: "human", subjectId, principalKind: "human_session" },
      },
      {
        operation: "approve",
        operationId: crypto.randomUUID(),
        skillId: legacySkillId,
        revisionId,
        expectedRevisionId: null,
        expectedScopeVersion: 1,
        reason: "Reviewed the migrated Skill",
      },
    );
    expect(receipt).toMatchObject({ skillId: legacySkillId, revisionId, outcome: "applied" });
    const [active] = await listSkillRecords(
      app.db,
      { accountId, workspaceId, subjectId },
      { skillId: legacySkillId },
    );
    expect(active).toMatchObject({ activeRevisionId: revisionId, pendingRevisionIds: [] });
  });

  test("pending native instructions remain reviewable without copying or rewriting their revision", async () => {
    const pending = await listAgentInstructionReviews(app.db, human);
    expect(
      pending.entries.find((item) => item.revisionId === legacyInstructionRevisionId)?.content,
    ).toBe(legacyInstructionText);
    const before = await getAgentInstruction(app.db, human, {
      kind: "policy",
      scope: "global",
      roleKey: null,
    });
    expect(before.content).toBeNull();
    const receipt = await reviewAgentInstruction(app.db, human, {
      operationId: crypto.randomUUID(),
      revisionId: legacyInstructionRevisionId,
      decision: "approve",
      reason: "Reviewed imported proposal",
    });
    expect(receipt.outcome).toBe("published");
    const active = await getAgentInstruction(app.db, human, {
      kind: "policy",
      scope: "global",
      roleKey: null,
    });
    expect(active.content).toBe(legacyInstructionText);
    expect(
      (await listAgentInstructionReviews(app.db, human)).entries.map((entry) => entry.revisionId),
    ).toEqual([answeredInstruction.revisionId]);
    const [native] = await owned!
      .admin`SELECT content,agent_learning_context FROM workspace_instruction_policy_revisions
      WHERE id=${legacyInstructionRevisionId}`;
    expect(native?.content).toBe(legacyInstructionText);
    expect(native?.agent_learning_context).toBeNull();
  });
  test("recovers an old confirmation into the exact migrated Knowledge without a second Memory", async () => {
    const f = legacyConfirmation;
    const entryId = knowledgeMigrationId("claim", f.claimId);
    const pending = await getKnowledgeEntry(app.db, human, entryId, { view: "needs_review" });
    expect(pending?.revision.entry.content).toBe(f.exact);
    expect(await getKnowledgeEntry(app.db, f.agent, entryId)).toBeNull();
    await expect(
      confirmLegacyKnowledge(app.db, f.agent, {
        operationId: crypto.randomUUID(),
        claimId: f.claimId,
        humanInputRequestId: f.wrongRequestId,
      }),
    ).rejects.toBeDefined();
    const input = {
      operationId: f.operationId,
      claimId: f.claimId,
      humanInputRequestId: f.requestId,
    };
    const recovered = await recoverLegacyKnowledgeConfirmations(app.db, f.agent);
    expect(recovered.instructionReceipts).toHaveLength(1);
    expect(recovered.instructionReceipts[0]).toMatchObject({
      revisionId: answeredInstruction.revisionId,
      outcome: "published",
    });
    expect(
      (
        await getAgentInstruction(app.db, human, {
          kind: "charter",
          scope: "global",
          roleKey: null,
        })
      ).content,
    ).toBe("Be clear about uncertainty when explaining research.");
    expect(
      (await recoverLegacyKnowledgeConfirmations(app.db, f.agent)).instructionReceipts[0]?.replayed,
    ).toBe(true);
    await expect(
      confirmLegacyInstruction(app.db, f.agent, {
        operationId: crypto.randomUUID(),
        proposalId: answeredInstruction.proposalId,
        decisionReceiptId: answeredInstruction.decisionReceiptId,
        humanInputRequestId: answeredInstruction.humanInputRequestId,
      }),
    ).rejects.toBeDefined();
    expect(recovered.receipts).toHaveLength(1);
    expect(recovered.unavailable).toBe(0);
    const receipt = await confirmLegacyKnowledge(app.db, f.agent, input);
    expect(receipt.outcome).toBe("published");
    expect(receipt.entryId).toBe(entryId);
    expect((await getKnowledgeEntry(app.db, f.agent, entryId))?.revision.entry.content).toBe(
      f.exact,
    );
    expect((await confirmLegacyKnowledge(app.db, f.agent, input)).replayed).toBe(true);
    const [count] = await owned!
      .admin`SELECT count(*)::int AS n FROM remember_knowledge_memory_materializations`;
    expect(count?.n).toBe(0);
  });

  test("copies exact content and groups without broadening private or legacy scopes", async () => {
    const shared = await getKnowledgeEntry(app.db, human, sharedId);
    expect(shared?.revision.entry.content).toBe(exactText);
    expect(shared?.revision.entry.groupIds.length).toBe(2);
    expect(shared?.revision.entry.evidence).toEqual([
      {
        entryId: knowledgeMigrationId("document", documentId),
        revisionId: knowledgeMigrationId("revision", knowledgeMigrationId("document", documentId)),
        location: {},
      },
    ]);
    const [audit] = await owned!
      .admin`SELECT legacy_snapshot FROM knowledge_entry_revisions WHERE entry_id=${sharedId}`;
    expect(audit!.legacy_snapshot.source_refs).toContainEqual({
      kind: "document",
      id: unpreparedDocumentId,
      metadata: {},
    });
    expect((await getKnowledgeEntry(app.db, human, personalId))?.scope).toBe("personal");
    expect(await getKnowledgeEntry(app.db, human, legacyId)).toBeNull();
    const other = {
      ...human,
      actor: { ...human.actor, subjectId: "user:someone-else" },
    } as KnowledgeContext;
    expect(await getKnowledgeEntry(app.db, other, personalId)).toBeNull();
    expect((await getAgentLearningSettings(app.db, human, "workspace")).settings.knowledge).toBe(
      "off",
    );
  });
  test("retains every source passage and indexes large sources without duplicating results", async () => {
    const sourceId = knowledgeMigrationId("document", documentId);
    const source = await getKnowledgeEntry(app.db, human, sourceId);
    expect(source?.revision.entry.content).toBe(longSource);
    expect(source?.revision.entry.source).toMatchObject({
      fileId,
      documentId,
      retention: "passages",
    });
    expect(
      (await listKnowledgeEntries(app.db, human, { query: "definition21999" })).entries.map(
        (entry) => entry.id,
      ),
    ).toEqual([sourceId]);
    const [indexed] = await owned!
      .admin`SELECT count(*)::integer AS count FROM knowledge_entry_search WHERE entry_id=${sourceId}`;
    expect(indexed?.count).toBeGreaterThan(1);
  });
  test("imports the entity/claim graph with pinned evidence and preserves provider revocation", async () => {
    const claimId = knowledgeMigrationId("claim", scoped.claimId);
    const versionId = knowledgeMigrationId("document-version", scoped.versionId);
    const claim = await getKnowledgeEntry(app.db, human, claimId);
    expect(claim?.revision.entry.content).toBe("Acme Corporation · renewal-date: 1 December");
    expect(claim?.revision.entry.groupIds).toEqual([
      knowledgeMigrationId("entity", scoped.entityId),
    ]);
    expect(claim?.revision.entry.evidence).toEqual([
      {
        entryId: versionId,
        revisionId: knowledgeMigrationId("revision", versionId),
        location: { passage: "Renewal section" },
      },
    ]);
    expect(
      (await getKnowledgeEntry(app.db, human, versionId))?.revision.entry.source?.retention,
    ).toBe("reference");
    const [audit] = await owned!
      .admin`SELECT legacy_snapshot FROM knowledge_entry_revisions WHERE entry_id=${claimId}`;
    expect(audit?.legacy_snapshot.reviews[0].reason).toBe("Checked against the agreement");
    await recordKnowledgeLifecycleEvent(app.db, {
      accountId,
      workspaceId,
      operationId: "revoke-import-source",
      actor: { kind: "human", subjectId, initiatingHumanSubjectId: subjectId },
      targetKind: "provider",
      targetId: scoped.providerId,
      eventType: "revoked",
      expectedGeneration: 1,
      reasonCode: "connection-revoked",
    });
    expect(await getKnowledgeEntry(app.db, human, versionId)).toBeNull();
    expect(await getKnowledgeEntry(app.db, human, claimId)).toBeNull();
    expect((await listKnowledgeEntries(app.db, human, { query: "renewal-date" })).entries).toEqual(
      [],
    );
  });
  test("restores FORCE RLS and keeps a rerun idempotent", async () => {
    const before = await owned!.admin`SELECT count(*)::integer AS count FROM knowledge_entries`;
    await app.close();
    await migrate(owned!.ownerUrl);
    const after = await owned!.admin`SELECT count(*)::integer AS count FROM knowledge_entries`;
    expect(after[0]?.count).toBe(before[0]?.count);
    const rows = await owned!
      .admin`SELECT relname,relforcerowsecurity FROM pg_class WHERE relname IN
      ('knowledge_memories','documents','document_chunks','knowledge_entries','knowledge_entry_revisions','knowledge_entry_search')`;
    expect(rows.length).toBe(6);
    expect(rows.every((row) => row.relforcerowsecurity)).toBe(true);
  });
});
