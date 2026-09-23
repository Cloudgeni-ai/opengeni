import { createScheduledTaskActivities } from "../../../apps/worker/src/activities/scheduled-tasks";
import type { ActivityServices } from "../../../apps/worker/src/activities/types";
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import {
  createScheduledTask,
  createConnection,
  ensureKnowledgeSourceSyncState,
  recordGoogleDriveObjectAclEvidence,
  listScheduledTaskRuns,
  claimSessionWorkForAttempt,
  freezeAgentLearningPolicy,
  readScheduledKnowledgeSource,
  saveAgentLearningSettings,
  claimKnowledgeIndexJobs,
  readKnowledgeIndexSource,
  deferKnowledgeIndexJob,
  upsertKnowledgeProvider,
  upsertKnowledgeSource,
  appendKnowledgeSourceAclVersion,
  upsertKnowledgeSourceObject,
  appendKnowledgeDocumentVersion,
  reviewKnowledgeEntry,
  createDb,
  claimKnowledgeDocumentPreparation,
  completeKnowledgeDocumentPreparation,
  getKnowledgeEntry,
  saveKnowledgeEntry,
  archiveKnowledgeEntry,
  type KnowledgeContext,
} from "../src";
let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("knowledge-document-preparation");
  if (!acquired) throw new Error("Document preparation verification requires PostgreSQL");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 6 });
}, 900_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);
async function fixture() {
  const accountId = crypto.randomUUID(),
    workspaceId = crypto.randomUUID(),
    fileId = crypto.randomUUID(),
    baseId = crypto.randomUUID(),
    documentId = crypto.randomUUID();
  await shared.admin`INSERT INTO managed_accounts(id,name) VALUES(${accountId},'Preparation test')`;
  await shared.admin`INSERT INTO workspaces(id,account_id,name) VALUES(${workspaceId},${accountId},'Sources')`;
  const [personal] =
    await shared.admin`INSERT INTO workspaces(account_id,name) VALUES(${accountId},'Personal') RETURNING id`;
  await shared.admin`INSERT INTO organization_memberships(account_id,subject_id,status,personal_workspace_id)
    VALUES(${accountId},'user:reader','active',${personal!.id})`;
  await shared.admin`INSERT INTO workspace_memberships(account_id,workspace_id,subject_id,permissions)
    VALUES(${accountId},${workspaceId},'user:reader','["*"]')`;
  await shared.admin`INSERT INTO files(id,account_id,workspace_id,status,filename,safe_filename,content_type,size_bytes,bucket,object_key)
    VALUES(${fileId},${accountId},${workspaceId},'ready','Acme.txt','Acme.txt','text/plain',100,'test',${fileId})`;
  await shared.admin`INSERT INTO document_bases(id,account_id,workspace_id,name) VALUES(${baseId},${accountId},${workspaceId},'Customer contracts')`;
  await shared.admin`INSERT INTO documents(id,account_id,workspace_id,origin_workspace_id,base_id,file_id,status,title,
    authority_kind,authority_workspace_id,created_by) VALUES(${documentId},${accountId},${workspaceId},${workspaceId},${baseId},${fileId},
    'indexing','Acme contract','workspace',${workspaceId},'user:reader')`;
  const identity = { accountId, workspaceId, documentId, fileId };
  const context: KnowledgeContext = {
    accountId,
    workspaceId,
    actor: {
      kind: "human",
      principalKind: "human_session",
      subjectId: "user:reader",
      writeScopes: ["workspace"],
      settingsScopes: ["workspace"],
      review: true,
    },
  };
  const input = {
    ...identity,
    title: "Acme contract",
    content: "Acme 🚀\u0000  \nExact contract wording.  ",
    sourceVersion: "a".repeat(64),
  };
  return { identity, context, input };
}
test("native document preparation retains one exact canonical source and queues its search projection", async () => {
  const f = await fixture();
  const claim = await claimKnowledgeDocumentPreparation(client.db, f.identity);
  if (claim.status !== "prepare") throw new Error("Expected preparation");
  const request = { ...f.input, leaseId: claim.leaseId };
  const result = await completeKnowledgeDocumentPreparation(client.db, request);
  if (result.status !== "retained") throw new Error("Expected retained source");
  expect(result.receipt.outcome).toBe("published");
  const entry = await getKnowledgeEntry(client.db, f.context, claim.entryId);
  expect(entry?.revision.entry.content).toBe(f.input.content);
  expect(entry?.revision.entry.source?.fileId).toBe(f.identity.fileId);
  const [counts] =
    await shared.admin`SELECT (SELECT count(*)::int FROM knowledge_index_jobs WHERE revision_id=${result.receipt.revisionId}) AS jobs,
    (SELECT count(*)::int FROM document_chunks WHERE document_id=${f.identity.documentId}) AS old_chunks`;
  expect(counts).toEqual({ jobs: 1, old_chunks: 0 });
  const replay = await completeKnowledgeDocumentPreparation(client.db, request);
  expect(replay.status === "retained" && replay.receipt.replayed).toBe(true);
  await expect(
    completeKnowledgeDocumentPreparation(client.db, { ...request, content: "changed" }),
  ).rejects.toBeDefined();
  const next = await claimKnowledgeDocumentPreparation(client.db, f.identity);
  if (next.status !== "prepare") throw new Error("Expected preparation");
  expect(
    await completeKnowledgeDocumentPreparation(client.db, { ...f.input, leaseId: next.leaseId }),
  ).toEqual({
    status: "unchanged",
    entryId: claim.entryId,
    revisionId: result.receipt.revisionId,
  });
});
test("document preparation rejects stale leases and never overwrites a concurrent correction or restores an archive", async () => {
  const f = await fixture();
  const first = await claimKnowledgeDocumentPreparation(client.db, f.identity);
  const second = await claimKnowledgeDocumentPreparation(client.db, f.identity);
  if (first.status !== "prepare" || second.status !== "prepare")
    throw new Error("Expected preparation");
  await expect(
    completeKnowledgeDocumentPreparation(client.db, { ...f.input, leaseId: first.leaseId }),
  ).rejects.toBeDefined();
  const saved = await completeKnowledgeDocumentPreparation(client.db, {
    ...f.input,
    leaseId: second.leaseId,
  });
  if (saved.status !== "retained") throw new Error("Expected retained source");
  const current = await getKnowledgeEntry(client.db, f.context, saved.receipt.entryId);
  if (!current) throw new Error("Source missing");
  const stale = await claimKnowledgeDocumentPreparation(client.db, f.identity);
  if (stale.status !== "prepare") throw new Error("Expected preparation");
  const edited = await saveKnowledgeEntry(client.db, f.context, {
    operationId: crypto.randomUUID(),
    entryId: current.id,
    expectedVersion: current.version,
    entry: { ...current.revision.entry, title: "Corrected contract title" },
  });
  await expect(
    completeKnowledgeDocumentPreparation(client.db, { ...f.input, leaseId: stale.leaseId }),
  ).rejects.toBeDefined();
  await archiveKnowledgeEntry(client.db, f.context, {
    operationId: crypto.randomUUID(),
    entryId: edited.entryId,
    expectedVersion: edited.version,
  });
  const archived = await claimKnowledgeDocumentPreparation(client.db, f.identity);
  if (archived.status !== "prepare") throw new Error("Expected preparation");
  const result = await completeKnowledgeDocumentPreparation(client.db, {
    ...f.input,
    leaseId: archived.leaseId,
    content: "new source text",
  });
  expect(result.status).toBe("unchanged");
  const [row] =
    await shared.admin`SELECT archived FROM knowledge_entries WHERE id=${edited.entryId}`;
  expect(row?.archived).toBe(true);
  await expect(
    claimKnowledgeDocumentPreparation(client.db, { ...f.identity, accountId: crypto.randomUUID() }),
  ).rejects.toBeDefined();
});

test.each(["contract-system", "google-drive"])(
  "scheduled %s preparation freezes task review and keeps source access independent",
  async (providerKey) => {
    const f = await fixture();
    const { accountId, workspaceId, documentId } = f.identity;
    const sourceContext = {
      accountId,
      workspaceId,
      actor: {
        kind: "human" as const,
        subjectId: "user:reader",
        initiatingHumanSubjectId: "user:reader",
      },
    };
    const scope = { kind: "workspace" as const, workspaceId, subjectId: null };
    const provider = await upsertKnowledgeProvider(client.db, {
      ...sourceContext,
      scope,
      operationId: "test-provider",
      providerKey,
      externalTenantId: accountId,
    });
    const source = await upsertKnowledgeSource(client.db, {
      ...sourceContext,
      scope,
      operationId: "test-source",
      providerId: provider.id,
      externalSourceId: "contracts",
      sourceKind: "contracts",
    });
    const acl = await appendKnowledgeSourceAclVersion(client.db, {
      ...sourceContext,
      operationId: "test-acl",
      sourceId: source.id,
      audience: scope,
      expectedSourceLifecycleGeneration: 1,
      expectedAclGeneration: 0,
      agentAccess: true,
      reasonCode: "initial",
    });
    const object = await upsertKnowledgeSourceObject(client.db, {
      ...sourceContext,
      operationId: "test-object",
      sourceId: source.id,
      externalObjectId: "acme-contract",
    });
    const version = await appendKnowledgeDocumentVersion(client.db, {
      ...sourceContext,
      operationId: "test-version",
      objectId: object.id,
      expectedSourceLifecycleGeneration: 1,
      expectedObjectLifecycleGeneration: 1,
      expectedVersionGeneration: 0,
      externalVersionId: "v1",
      contentSha256: f.input.sourceVersion,
      documentId,
      fileId: f.identity.fileId,
      ingestionKey: "acme-v1",
      sourceMetadata: { providerRevision: "v1" },
      aclVersionId: acl.id,
      aclGeneration: 1,
      reasonCode: "observed",
    });
    await shared.admin`UPDATE documents SET source_external_id='acme-contract',
      source_version='v1',knowledge_source_identity=${object.id} WHERE id=${documentId}`;
    const connection = await createConnection(client.db, {
      accountId,
      workspaceId,
      subjectId: "user:reader",
      providerDomain: "googleapis.com",
      kind: "oauth2",
      credentialEncrypted: "test-only-credential",
      grantedScopes: ["https://www.googleapis.com/auth/drive.readonly"],
      metadata: {
        accessMode: "readonly",
        googlePermissionId: "source-owner",
        googleEmail: "reader@example.test",
        lifecycle: { state: "active" },
      },
      createdBySubjectId: "user:reader",
    });
    const task = await createScheduledTask(client.db, {
      accountId,
      workspaceId,
      name: "Import contract updates",
      status: "active",
      schedule: { type: "manual" },
      temporalScheduleId: `knowledge-preparation-${documentId}`,
      runMode: "new_session_per_run",
      overlapPolicy: "buffer_one",
      agentConfig: {
        prompt: "Import",
        resources: [],
        tools: [],
        metadata: {},
        knowledgeSource: {
          kind: "knowledge_source_sync",
          sourceId: source.id,
          sourceGeneration: source.syncGeneration,
          sourceLifecycleGeneration: 1,
          sourceConfigGeneration: 1,
          controlWorkspaceId: workspaceId,
          providerCoordinationKey: `test:${source.id}`,
          destination: scope,
          initiatingSubjectId: "user:reader",
          allDescendants: true,
          connection: {
            connectionId: connection.id,
            connectionVersion: connection.version,
            providerDomain: "googleapis.com",
            kind: "oauth2",
            ownerSubjectId: "user:reader",
          },
          limits: {
            maxItems: 10,
            maxBytes: 10000,
            maxFileBytes: 10000,
            maxProviderRequests: 10,
            maxElapsedSeconds: 10,
            maxConcurrency: 1,
            maxFailureDetails: 10,
          },
        },
      },
      action: { kind: "agent_turn" },
      createdBy: { kind: "subject", subjectId: "user:reader" },
      metadata: {},
    });
    await saveAgentLearningSettings(client.db, f.context, {
      scope: "workspace",
      source: { kind: "scheduled_task", id: task.id },
      operationId: crypto.randomUUID(),
      expectedVersion: 0,
      settings: { knowledge: "review_first" },
    });
    await shared.admin`INSERT INTO workspace_inference_controls(account_id,workspace_id) VALUES(${accountId},${workspaceId}) ON CONFLICT DO NOTHING`;
    const activities = createScheduledTaskActivities(
      async () =>
        ({
          settings: testSettings({ databaseUrl: shared.appUrl, sandboxBackend: "none" }),
          db: client.db,
          bus: new MemoryEventBus(),
        }) as unknown as ActivityServices,
    );
    const dispatched = await activities.dispatchScheduledTaskRun({
      workspaceId,
      taskId: task.id,
      triggerType: "scheduled",
      producerKey: `import:${documentId}`,
    });
    if (dispatched.action !== "start") throw new Error(JSON.stringify(dispatched));
    const [run] = await listScheduledTaskRuns(client.db, workspaceId, task.id);
    if (!run) throw new Error("Expected ordinary source run");
    const attemptId = crypto.randomUUID();
    const turn = await claimSessionWorkForAttempt(client.db, workspaceId, {
      sessionId: dispatched.sessionId,
      workflowId: dispatched.workflowId,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    if (turn.action !== "claimed") throw new Error("Expected source agent turn");
    const agent: KnowledgeContext = {
      accountId,
      workspaceId,
      actor: {
        kind: "agent",
        sessionId: dispatched.sessionId,
        turnId: turn.turn.id,
        attemptId,
        executionGeneration: turn.turn.executionGeneration,
      },
    };
    await freezeAgentLearningPolicy(client.db, agent);
    await ensureKnowledgeSourceSyncState(client.db, task);
    const [obligation] =
      await shared.admin`INSERT INTO knowledge_source_sync_index_obligations(account_id,workspace_id,scheduled_task_run_id,
    source_id,source_sync_generation,initiating_subject_id,external_object_id,knowledge_source_object_id,
    knowledge_document_version_id,document_id,source_config_generation,source_lifecycle_generation,object_lifecycle_generation,
    object_version_generation,citation_locator,acl_eligibility)
    VALUES(${accountId},${workspaceId},${run.id},${source.id},${source.syncGeneration},'user:reader','acme-contract',${object.id},${version.id},
    ${documentId},1,1,1,1,'{}','eligible') RETURNING id`;
    await saveAgentLearningSettings(client.db, f.context, {
      scope: "workspace",
      source: { kind: "scheduled_task", id: task.id },
      operationId: crypto.randomUUID(),
      expectedVersion: 1,
      settings: { knowledge: "automatic" },
    });
    const claim = await claimKnowledgeDocumentPreparation(client.db, f.identity);
    if (claim.status !== "prepare") throw new Error("Expected preparation");
    const result = await completeKnowledgeDocumentPreparation(client.db, {
      ...f.input,
      leaseId: claim.leaseId,
    });
    if (result.status !== "retained") throw new Error("Expected retained source");
    expect(result.receipt.outcome).toBe("pending");
    expect(await getKnowledgeEntry(client.db, f.context, claim.entryId)).toBeNull();
    const [batch] =
      await shared.admin`SELECT scheduled_task_run_id FROM knowledge_review_batches WHERE id=${result.receipt.reviewBatchId}`;
    expect(batch?.scheduled_task_run_id).toBe(run.id);
    const approval = () =>
      reviewKnowledgeEntry(client.db, f.context, {
        operationId: crypto.randomUUID(),
        entryId: claim.entryId,
        expectedVersion: result.receipt.version,
        revisionId: result.receipt.revisionId,
        decision: "approve",
      });
    if (providerKey === "google-drive") {
      expect((await readScheduledKnowledgeSource(client.db, agent, {})).items).toEqual([]);
      await expect(approval()).rejects.toBeDefined();
      // Content preparation and human review cannot fabricate missing Drive ACL
      // evidence. Neither retrieval nor embedding may use this source yet.
      expect(await getKnowledgeEntry(client.db, f.context, claim.entryId)).toBeNull();
      const jobs = await claimKnowledgeIndexJobs(client.db, {
        model: "test",
        dimensions: 3,
        limit: 20,
      });
      const job = jobs.find((item) => item.revisionId === result.receipt.revisionId);
      if (!job) throw new Error("Expected queued projection");
      expect(await readKnowledgeIndexSource(client.db, job)).toBeNull();
      await shared.admin`UPDATE knowledge_source_sync_index_obligations SET status='indexed'
        WHERE id=${obligation!.id}`;
      await recordGoogleDriveObjectAclEvidence(client.db, {
        accountId,
        workspaceId,
        obligationId: obligation!.id,
        connectionId: connection.id,
        connectionVersion: connection.version,
        sourceGooglePermissionId: "source-owner",
        sourceSyncGeneration: source.syncGeneration,
        sourceConfigGeneration: 1,
        sourceLifecycleGeneration: 1,
        objectLifecycleGeneration: 1,
        objectVersionGeneration: 1,
        providerRevision: "v1",
        driveId: null,
        aclRevision: "verified-source-owner",
        eligibility: "eligible",
        observedAt: new Date(Date.now() - 1000).toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        citationLocator: {},
        operationId: "verify-acl",
        principals: [],
      });
      await approval();
      expect(
        (await getKnowledgeEntry(client.db, agent, claim.entryId))?.revision.entry.content,
      ).toBe(f.input.content);
      const approvedJob = (
        await claimKnowledgeIndexJobs(client.db, { model: "test", dimensions: 3, limit: 20 })
      ).find((item) => item.revisionId === result.receipt.revisionId);
      if (!approvedJob) throw new Error("Expected approved source projection");
      expect((await readKnowledgeIndexSource(client.db, approvedJob))?.entry.content).toBe(
        f.input.content,
      );
    } else {
      const sourcePage = await readScheduledKnowledgeSource(client.db, agent, {});
      expect(sourcePage.items).toHaveLength(1);
      expect(sourcePage.items[0]).toMatchObject({
        entryId: claim.entryId,
        revisionId: result.receipt.revisionId,
        pending: true,
      });
      const sourceText = await readScheduledKnowledgeSource(client.db, agent, {
        entryId: claim.entryId,
      });
      expect(sourceText.items[0]).toMatchObject({ content: f.input.content });
      expect(await getKnowledgeEntry(client.db, agent, claim.entryId)).toBeNull();
      await approval();
      expect(
        (await getKnowledgeEntry(client.db, f.context, claim.entryId))?.revision.entry.content,
      ).toBe(f.input.content);
      const jobs = await claimKnowledgeIndexJobs(client.db, {
        model: "test",
        dimensions: 3,
        limit: 20,
      });
      const job = jobs.find((item) => item.revisionId === result.receipt.revisionId);
      if (!job) throw new Error("Expected approved source projection");
      expect((await readKnowledgeIndexSource(client.db, job))?.entry.content).toBe(f.input.content);
      await deferKnowledgeIndexJob(client.db, job);
      expect(
        (
          await claimKnowledgeIndexJobs(client.db, { model: "test", dimensions: 3, limit: 20 })
        ).some((item) => item.revisionId === result.receipt.revisionId),
      ).toBe(false);
      // Completing the source adapter's external access observation wakes the
      // existing deferred projection; it must not wait for its retry deadline.
      await shared.admin`UPDATE knowledge_source_sync_index_obligations SET status='indexed',acl_eligibility='eligible'
        WHERE account_id=${accountId} AND document_id=${documentId} AND scheduled_task_run_id=${run.id}`;
      const awakened = (
        await claimKnowledgeIndexJobs(client.db, { model: "test", dimensions: 3, limit: 20 })
      ).find((item) => item.revisionId === result.receipt.revisionId);
      if (!awakened) throw new Error("Expected source completion to wake projection");
      expect((await readKnowledgeIndexSource(client.db, awakened))?.entry.content).toBe(
        f.input.content,
      );
    }
  },
);
