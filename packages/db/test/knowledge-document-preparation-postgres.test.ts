import { createScheduledTaskActivities } from "../../../apps/worker/src/activities/scheduled-tasks";
import type { ActivityServices } from "../../../apps/worker/src/activities/types";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import {
  createScheduledTask,
  createConnection,
  listScheduledTaskRuns,
  saveAgentLearningSettings,
  upsertKnowledgeProvider,
  upsertKnowledgeSource,
  appendKnowledgeSourceAclVersion,
  upsertKnowledgeSourceObject,
  appendKnowledgeDocumentVersion,
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
  "a saved scheduled %s source sync is retired and keeps its imported document",
  async (providerKey) => {
    const f = await fixture();
    const { accountId, workspaceId, documentId } = f.identity;
    const connectionDomain =
      providerKey === "google-drive" ? "googleapis.com" : "contracts.example.test";
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
      providerDomain: connectionDomain,
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
            providerDomain: connectionDomain,
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
    // Integration Knowledge sync is retired: saved source tasks never start a
    // run or fetch provider content, and the imported document stays intact.
    expect(dispatched).toEqual({
      action: "blocked",
      reason:
        providerKey === "google-drive"
          ? "google_drive_native_retired"
          : "knowledge_source_sync_retired",
    });
    expect(await listScheduledTaskRuns(client.db, workspaceId, task.id)).toEqual([]);
    const [imported] = await shared.admin`SELECT source_external_id,source_version,
      knowledge_source_identity FROM documents WHERE id=${documentId}`;
    expect(imported).toMatchObject({
      source_external_id: "acme-contract",
      source_version: "v1",
      knowledge_source_identity: object.id,
    });
    expect(version.documentId).toBe(documentId);
  },
);
