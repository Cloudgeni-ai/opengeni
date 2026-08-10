import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  appendKnowledgeDocumentVersion,
  appendKnowledgeSourceAclVersion,
  beginKnowledgeSyncRun,
  checkpointKnowledgeSourceSync,
  claimKnowledgeSourceSyncLease,
  completeKnowledgeSyncRun,
  createDb,
  deauthorizeKnowledgeSourceRetrieval,
  createScheduledTask,
  createScheduledTaskRun,
  enqueueKnowledgeSourceSyncIndexObligation,
  ensureKnowledgeSourceBlobFile,
  ensureKnowledgeSourceSyncState,
  getKnowledgeSourceForSyncAuthority,
  getKnowledgeSourceSyncIndexObligationForVersion,
  listKnowledgeSourceSyncTasksForConnection,
  reconcileKnowledgeSourceSyncCompleteScan,
  reconcileKnowledgeSourceSyncLiveGeneration,
  recordKnowledgeSourceSyncObjectObservations,
  recordKnowledgeSourceSyncWake,
  settleKnowledgeSourceSyncLease,
  migrate,
  recordKnowledgeLifecycleEvent,
  recordKnowledgeSourceSyncAclEvidence,
  restoreKnowledgeSourceObject,
  retryKnowledgeSourceSyncIndexObligation,
  settleKnowledgeSourceSyncIndexObligation,
  updateKnowledgeSourceDocumentObservationMetadata,
  upsertKnowledgeProvider,
  upsertKnowledgeSource,
  upsertKnowledgeSourceObject,
  type DbClient,
} from "@opengeni/db";
import { addDocumentToBase, ensureDefaultBase } from "@opengeni/documents";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";
import { createScheduledTaskActivities } from "../src/activities/scheduled-tasks";
import { deauthorizeAndSettleKnowledgeSourceSyncFailure } from "../src/activities/knowledge-source-sync";
import type { ControlActivityServices } from "../src/activities/types";

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

async function acquireDatabase(): Promise<SharedTestDatabase | null> {
  const adminUrl = process.env.OPENGENI_TEST_POSTGRES_ADMIN_URL;
  const appUrl = process.env.OPENGENI_TEST_POSTGRES_APP_URL;
  if (!adminUrl && !appUrl) {
    return await acquireSharedTestDatabase("worker-knowledge-source-schedule-dispatch");
  }
  if (!adminUrl || !appUrl) {
    throw new Error(
      "OPENGENI_TEST_POSTGRES_ADMIN_URL and OPENGENI_TEST_POSTGRES_APP_URL must be set together",
    );
  }
  const nativeAdmin = postgres(adminUrl, { max: 4 });
  return {
    admin: nativeAdmin,
    adminUrl,
    appUrl,
    release: async () => await nativeAdmin.end().catch(() => undefined),
  };
}

beforeAll(async () => {
  shared = await acquireDatabase();
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error(
        "[worker-knowledge-source-schedule-dispatch] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
      );
    }
    available = false;
    console.warn("[worker-knowledge-source-schedule-dispatch] PostgreSQL unavailable, skipping");
    return;
  }
  admin = shared.admin;
  client = createDb(shared.appUrl);
  await migrate(shared.adminUrl);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
});

describe("knowledge-source schedule dispatch", () => {
  test("creates deterministic sync work without a session or agent-run usage", async () => {
    if (!available) return;
    const [account] = await admin<{ id: string }[]>`
      insert into managed_accounts (name) values ('knowledge dispatch') returning id`;
    const [workspace] = await admin<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${account!.id}, 'knowledge dispatch') returning id`;
    const actor = {
      kind: "human" as const,
      subjectId: "user:alice",
      initiatingHumanSubjectId: "user:alice",
    };
    const scope = {
      kind: "workspace" as const,
      workspaceId: workspace!.id,
      subjectId: null,
    };
    const provider = await upsertKnowledgeProvider(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      scope,
      providerKey: "test-drive",
      externalTenantId: "tenant-1",
      operationId: "provider-1",
      actor,
    });
    const source = await upsertKnowledgeSource(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      scope,
      providerId: provider.id,
      externalSourceId: "folder-1",
      sourceKind: "test-folder",
      operationId: "source-1",
      actor,
    });
    const task = await createScheduledTask(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      name: "Sync test source",
      status: "active",
      schedule: { type: "manual" },
      temporalScheduleId: `scheduled-task-${crypto.randomUUID()}`,
      runMode: "new_session_per_run",
      overlapPolicy: "buffer_one",
      action: {
        kind: "knowledge_source_sync",
        sourceId: source.id,
        sourceGeneration: source.syncGeneration,
        sourceLifecycleGeneration: source.lifecycleGeneration,
        sourceConfigGeneration: 1,
        controlWorkspaceId: workspace!.id,
        providerCoordinationKey: "example:test-source",
        destination: scope,
        initiatingSubjectId: actor.subjectId,
        allDescendants: true,
        connection: {
          connectionId: crypto.randomUUID(),
          connectionVersion: 1,
          providerDomain: "example.test",
          kind: "oauth2",
          ownerSubjectId: actor.subjectId,
        },
        limits: {
          maxItems: 10,
          maxBytes: 1_000,
          maxFileBytes: 1_000,
          maxProviderRequests: 10,
          maxElapsedSeconds: 10,
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
    const activities = createScheduledTaskActivities(
      async () =>
        ({
          settings: testSettings({ databaseUrl: shared!.appUrl }),
          db: client.db,
          bus: new MemoryEventBus(),
          objectStorage: null,
          observability: {} as ControlActivityServices["observability"],
          wakeSessionWorkflow: null,
          signalSessionAttemptQuiesced: null,
          inspectSessionAttemptActivity: null,
        }) satisfies ControlActivityServices,
    );
    const result = await activities.dispatchScheduledTaskRun({
      workspaceId: workspace!.id,
      taskId: task.id,
      triggerType: "scheduled",
      producerKey: "knowledge-dispatch-1",
    });
    expect(result).toMatchObject({
      action: "knowledge_source_sync",
      sourceId: source.id,
      overlapPolicy: "buffer_one",
    });
    const [facts] = await admin<
      Array<{ sessions: number; agentUsage: number; syncUsage: number; syncStates: number }>
    >`
      select
        (select count(*)::int from sessions where workspace_id = ${workspace!.id}) as sessions,
        (select count(*)::int from usage_events where workspace_id = ${workspace!.id}
          and event_type = 'agent_run.created') as "agentUsage",
        (select count(*)::int from usage_events where workspace_id = ${workspace!.id}
          and event_type = 'knowledge_source_sync.fired') as "syncUsage",
        (select count(*)::int from knowledge_source_sync_states
          where workspace_id = ${workspace!.id}) as "syncStates"`;
    expect(facts).toEqual({ sessions: 0, agentUsage: 0, syncUsage: 1, syncStates: 1 });
  }, 60_000);

  test("discovers every connection task beyond 500 rows on a stable created_at/id keyset", async () => {
    if (!available) return;
    const [account] = await admin<{ id: string }[]>`
      insert into managed_accounts (name) values ('knowledge pagination') returning id`;
    const [workspace] = await admin<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${account!.id}, 'knowledge pagination') returning id`;
    const connectionId = crypto.randomUUID();
    const sourceId = crypto.randomUUID();
    const action = {
      kind: "knowledge_source_sync",
      sourceId,
      sourceGeneration: 0,
      sourceLifecycleGeneration: 1,
      sourceConfigGeneration: 1,
      controlWorkspaceId: workspace!.id,
      providerCoordinationKey: "example:pagination",
      destination: { kind: "workspace", workspaceId: workspace!.id, subjectId: null },
      initiatingSubjectId: "user:alice",
      allDescendants: true,
      connection: {
        connectionId,
        connectionVersion: 1,
        providerDomain: "example.test",
        kind: "oauth2",
        ownerSubjectId: "user:alice",
      },
      limits: {
        maxItems: 10,
        maxBytes: 1_000,
        maxFileBytes: 1_000,
        maxProviderRequests: 10,
        maxElapsedSeconds: 10,
        maxConcurrency: 1,
        maxFailureDetails: 5,
      },
    };
    await admin`
      insert into scheduled_tasks (
        account_id, workspace_id, name, schedule, temporal_schedule_id,
        run_mode, overlap_policy, action, agent_config, metadata, created_at, updated_at
      )
      select ${account!.id}, ${workspace!.id}, 'Knowledge task ' || n,
        '{"type":"manual"}'::jsonb, 'knowledge-pagination-' || n,
        'new_session_per_run', 'buffer_one', ${admin.json(action)},
        '{"prompt":"Knowledge source synchronization","resources":[],"tools":[],"metadata":{}}'::jsonb,
        '{}'::jsonb, '2026-08-09T00:00:00Z'::timestamptz,
        '2026-08-09T00:00:00Z'::timestamptz
      from generate_series(1, 501) n`;
    const tasks = await listKnowledgeSourceSyncTasksForConnection(
      client.db,
      workspace!.id,
      connectionId,
      37,
    );
    expect(tasks).toHaveLength(501);
    expect(new Set(tasks.map((task) => task.id)).size).toBe(501);
    expect(tasks.every((task) => task.action.connection.connectionId === connectionId)).toBe(true);
  }, 60_000);

  test("repairs failed indexing, converges metadata, remints restored authority, and releases on deauth failure", async () => {
    if (!available) return;
    const [account] = await admin<{ id: string }[]>`
      insert into managed_accounts (name) values ('knowledge repair seams') returning id`;
    const [workspace] = await admin<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${account!.id}, 'knowledge repair seams') returning id`;
    await admin`
      insert into workspace_memberships (
        account_id, workspace_id, subject_id, subject_label, role, permissions
      ) values (
        ${account!.id}, ${workspace!.id}, 'user:alice', 'Alice', 'member', '[]'::jsonb
      )`;
    const actor = {
      kind: "human" as const,
      subjectId: "user:alice",
      initiatingHumanSubjectId: "user:alice",
    };
    const scope = {
      kind: "workspace" as const,
      workspaceId: workspace!.id,
      subjectId: null,
    };
    const provider = await upsertKnowledgeProvider(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      scope,
      providerKey: "test-drive-repairs",
      externalTenantId: "tenant-repairs",
      operationId: "provider-repairs",
      actor,
    });
    const source = await upsertKnowledgeSource(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      scope,
      providerId: provider.id,
      externalSourceId: "folder-repairs",
      sourceKind: "test-folder",
      operationId: "source-repairs",
      actor,
    });
    const acl = await appendKnowledgeSourceAclVersion(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      sourceId: source.id,
      audience: scope,
      expectedSourceLifecycleGeneration: source.lifecycleGeneration,
      expectedAclGeneration: 0,
      aclVersion: "repairs-acl-1",
      agentAccess: false,
      operationId: "repairs-acl-1",
      reasonCode: "source_selected",
      actor,
    });
    const task = await createScheduledTask(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      name: "Sync repair source",
      status: "active",
      schedule: { type: "manual" },
      temporalScheduleId: `scheduled-task-${crypto.randomUUID()}`,
      runMode: "new_session_per_run",
      overlapPolicy: "buffer_one",
      action: {
        kind: "knowledge_source_sync",
        sourceId: source.id,
        sourceGeneration: 0,
        sourceLifecycleGeneration: source.lifecycleGeneration,
        sourceConfigGeneration: 1,
        controlWorkspaceId: workspace!.id,
        providerCoordinationKey: "example:repairs",
        destination: scope,
        initiatingSubjectId: actor.subjectId,
        allDescendants: true,
        connection: {
          connectionId: crypto.randomUUID(),
          connectionVersion: 1,
          providerDomain: "example.test",
          kind: "oauth2",
          ownerSubjectId: actor.subjectId,
        },
        limits: {
          maxItems: 10,
          maxBytes: 1_000,
          maxFileBytes: 1_000,
          maxProviderRequests: 10,
          maxElapsedSeconds: 10,
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
    await ensureKnowledgeSourceSyncState(client.db, task);
    const summary = {
      phase: "failed" as const,
      scanned: 1,
      imported: 0,
      unchanged: 0,
      skipped: 0,
      failed: 1,
      bytes: 0,
      providerRequests: 1,
      elapsedMs: 1,
      indexed: 0,
      aclPending: 1,
      retryable: true,
      limitReached: null,
      checkpointed: false,
      reconnectRequired: false,
      failures: [],
    };
    const claimRun = async (producerKey: string) => {
      const run = await createScheduledTaskRun(client.db, {
        workspaceId: workspace!.id,
        taskId: task.id,
        triggerType: "retry",
        producerKey,
      });
      await recordKnowledgeSourceSyncWake(client.db, {
        accountId: account!.id,
        workspaceId: workspace!.id,
        sourceId: source.id,
        scheduledTaskId: task.id,
        scheduledTaskRunId: run.id,
        cause: "retry",
        producerKey,
        sourceConfigGeneration: 1,
        sourceLifecycleGeneration: source.lifecycleGeneration,
      });
      const lease = await claimKnowledgeSourceSyncLease(client.db, {
        accountId: account!.id,
        workspaceId: workspace!.id,
        sourceId: source.id,
        scheduledTaskRunId: run.id,
        overlapPolicy: "buffer_one",
      });
      expect(lease.action).toBe("claimed");
      return run;
    };
    const firstRun = await claimRun("repairs-first");
    const base = await ensureDefaultBase(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
    });
    const file = await ensureKnowledgeSourceBlobFile(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      fileId: crypto.randomUUID(),
      filename: "repairs.txt",
      safeFilename: "repairs.txt",
      contentType: "text/plain",
      sizeBytes: 7,
      sha256: "7".repeat(64),
      bucket: "test",
      objectKey: `workspaces/${workspace!.id}/knowledge/blobs/${"7".repeat(64)}`,
    });
    const object = await upsertKnowledgeSourceObject(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      sourceId: source.id,
      externalObjectId: "repairs-object",
      operationId: "repairs-object",
      actor,
    });
    const document = await addDocumentToBase(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      baseId: base.id,
      fileId: file.id,
      title: "Old title",
      sourceKind: "document",
      sourceUri: "https://example.test/old",
      sourceExternalId: "repairs-object",
      sourceVersion: "v1",
      authorityKind: "workspace",
      initiatingSubjectId: actor.subjectId,
      createdBy: actor.subjectId,
      agentAccess: false,
      knowledgeSourceIdentity: crypto.randomUUID(),
      access: { viewerSubjectId: actor.subjectId },
    });
    const version1 = await appendKnowledgeDocumentVersion(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      objectId: object.id,
      expectedSourceLifecycleGeneration: source.lifecycleGeneration,
      expectedObjectLifecycleGeneration: object.lifecycleGeneration,
      expectedVersionGeneration: 0,
      externalVersionId: "v1",
      contentSha256: "7".repeat(64),
      ingestionKey: "repairs:v1",
      sourceMetadata: {
        providerRevision: "v1",
        metadataHash: "8".repeat(64),
        sourceLifecycleGeneration: source.lifecycleGeneration,
        objectLifecycleGeneration: object.lifecycleGeneration,
      },
      aclVersionId: acl.id,
      aclGeneration: acl.generation,
      documentId: document.id,
      fileId: file.id,
      operationId: "repairs-version-1",
      reasonCode: "source_content_observed",
      actor,
    });
    await admin`
      insert into document_chunks (
        account_id, workspace_id, document_id, base_id, file_id, chunk_index, text,
        metadata, authority_kind, authority_workspace_id, embedding, embedding_model
      ) values (
        ${account!.id}, ${workspace!.id}, ${document.id}, ${base.id}, ${file.id},
        0, 'existing authoritative chunk', jsonb_build_object(
          'documentTitle', 'Old title',
          'sourceUri', 'https://example.test/old',
          'sourceTitle', 'Old title',
          'sourceUpdatedAt', '2026-08-08T12:00:00.000Z',
          'sourceVersion', 'v0',
          'unrelated', jsonb_build_object('preserved', true)
        ), 'workspace', ${workspace!.id},
        array_fill(0::real, ARRAY[3072])::vector, 'test'
      )`;
    await admin`update documents set chunk_count = 1 where id = ${document.id}`;
    const obligation1 = await enqueueKnowledgeSourceSyncIndexObligation(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      scheduledTaskRunId: firstRun.id,
      sourceId: source.id,
      sourceSyncGeneration: 0,
      initiatingSubjectId: actor.subjectId,
      externalObjectId: object.externalObjectId,
      knowledgeSourceObjectId: object.id,
      knowledgeDocumentVersionId: version1.id,
      documentId: document.id,
      sourceConfigGeneration: 1,
      sourceLifecycleGeneration: source.lifecycleGeneration,
      objectLifecycleGeneration: object.lifecycleGeneration,
      objectVersionGeneration: version1.versionGeneration,
      citationLocator: { sourceUri: "https://example.test/old" },
    });
    await settleKnowledgeSourceSyncIndexObligation(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      obligationId: obligation1.id,
      status: "failed",
      failureCode: "indexing_failed",
    });
    await settleKnowledgeSourceSyncLease(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      sourceId: source.id,
      scheduledTaskRunId: firstRun.id,
      status: "failed",
      summary,
      error: "indexing_failed",
      sourceConfigGeneration: 1,
      sourceLifecycleGeneration: source.lifecycleGeneration,
      sourceSyncGeneration: 0,
    });

    const secondRun = await claimRun("repairs-second");
    expect(
      await retryKnowledgeSourceSyncIndexObligation(client.db, {
        accountId: account!.id,
        workspaceId: workspace!.id,
        obligationId: obligation1.id,
        scheduledTaskRunId: secondRun.id,
      }),
    ).toBe("pending");
    const [retried] = await admin<
      Array<{ status: string; failureCode: string | null; scheduledTaskRunId: string }>
    >`
      select status, failure_code as "failureCode",
        scheduled_task_run_id as "scheduledTaskRunId"
      from knowledge_source_sync_index_obligations where id = ${obligation1.id}`;
    expect(retried).toEqual({
      status: "pending",
      failureCode: null,
      scheduledTaskRunId: secondRun.id,
    });

    await expect(
      deauthorizeAndSettleKnowledgeSourceSyncFailure(client.db, {
        deauthorization: {
          accountId: account!.id,
          workspaceId: workspace!.id,
          sourceId: source.id,
          audience: {
            kind: "personal",
            workspaceId: workspace!.id,
            subjectId: "user:someone-else",
          },
          operationId: "repairs-invalid-deauthorization",
          reasonCode: "connection_reconnect_required",
          actor,
        },
        settlement: {
          accountId: account!.id,
          workspaceId: workspace!.id,
          sourceId: source.id,
          scheduledTaskRunId: secondRun.id,
          status: "failed",
          summary: { ...summary, reconnectRequired: true },
          error: "connection_reconnect_required",
          sourceConfigGeneration: 1,
          sourceLifecycleGeneration: source.lifecycleGeneration,
          sourceSyncGeneration: 0,
          executionCheckpoint: null,
        },
      }),
    ).rejects.toThrow();
    const [released] = await admin<
      Array<{ leaseId: string | null; status: string; wakeCompleted: boolean }>
    >`
      select state.lease_id as "leaseId", run.status,
        (wake.completed_at is not null) as "wakeCompleted"
      from knowledge_source_sync_states state
      join scheduled_task_runs run on run.id = ${secondRun.id}
      join knowledge_source_sync_wakes wake on wake.scheduled_task_run_id = run.id
      where state.source_id = ${source.id}`;
    expect(released).toEqual({ leaseId: null, status: "queued", wakeCompleted: false });
    const reclaimed = await claimKnowledgeSourceSyncLease(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      sourceId: source.id,
      scheduledTaskRunId: secondRun.id,
      overlapPolicy: "buffer_one",
    });
    expect(reclaimed.action).toBe("claimed");
    await settleKnowledgeSourceSyncLease(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      sourceId: source.id,
      scheduledTaskRunId: secondRun.id,
      status: "failed",
      summary,
      error: "test_cleanup",
      sourceConfigGeneration: 1,
      sourceLifecycleGeneration: source.lifecycleGeneration,
      sourceSyncGeneration: 0,
    });

    const version2Input = {
      accountId: account!.id,
      workspaceId: workspace!.id,
      objectId: object.id,
      expectedSourceLifecycleGeneration: source.lifecycleGeneration,
      expectedObjectLifecycleGeneration: object.lifecycleGeneration,
      expectedVersionGeneration: version1.versionGeneration,
      externalVersionId: "v1",
      contentSha256: version1.contentSha256,
      ingestionKey: "repairs:v1:metadata-2",
      sourceMetadata: {
        providerRevision: "v1",
        metadataHash: "9".repeat(64),
        sourceLifecycleGeneration: source.lifecycleGeneration,
        objectLifecycleGeneration: object.lifecycleGeneration,
      },
      aclVersionId: acl.id,
      aclGeneration: acl.generation,
      documentId: document.id,
      fileId: file.id,
      locationMetadata: { sourceUri: "https://example.test/new" },
      documentObservationMetadata: {
        title: "New title",
        sourceUri: "https://example.test/new",
        sourceVersion: "v1",
        sourceUpdatedAt: "2026-08-09T12:00:00.000Z",
      },
      operationId: "repairs-version-2",
      reasonCode: "source_metadata_observed",
      actor,
    };
    const version2 = await appendKnowledgeDocumentVersion(client.db, version2Input);
    const [metadata] = await admin<
      Array<{ title: string; sourceUri: string; sourceVersion: string; sourceUpdatedAt: string }>
    >`
      select title, source_uri as "sourceUri", source_version as "sourceVersion",
        source_updated_at::text as "sourceUpdatedAt"
      from documents where id = ${document.id}`;
    expect(metadata).toMatchObject({
      title: "New title",
      sourceUri: "https://example.test/new",
      sourceVersion: "v1",
    });
    const [metadataOnlyChunk] = await admin<
      Array<{
        metadata: {
          documentTitle: string;
          sourceUri: string;
          sourceTitle: string;
          sourceUpdatedAt: string | null;
          sourceVersion: string;
          unrelated: { preserved: boolean };
        };
      }>
    >`select metadata from document_chunks where document_id = ${document.id}`;
    expect(metadataOnlyChunk?.metadata).toEqual({
      documentTitle: "New title",
      sourceUri: "https://example.test/new",
      sourceTitle: "New title",
      sourceUpdatedAt: "2026-08-09T12:00:00.000Z",
      sourceVersion: "v1",
      unrelated: { preserved: true },
    });

    // Simulate an old binary's append-before-metadata crash. The exact
    // observation retry converges the shared Document and its existing chunks
    // without minting another version or replacing unrelated chunk metadata.
    await admin`
      update documents set title = 'stale', source_uri = 'https://example.test/stale'
      where id = ${document.id}`;
    await admin`
      update document_chunks set metadata = metadata || jsonb_build_object(
        'documentTitle', 'stale',
        'sourceUri', 'https://example.test/stale',
        'sourceTitle', 'stale',
        'sourceUpdatedAt', null,
        'sourceVersion', 'stale',
        'crashReplayMarker', 'preserve-me'
      ) where document_id = ${document.id}`;
    await updateKnowledgeSourceDocumentObservationMetadata(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      initiatingSubjectId: actor.subjectId,
      sourceId: source.id,
      expectedSourceLifecycleGeneration: source.lifecycleGeneration,
      objectId: object.id,
      expectedObjectLifecycleGeneration: object.lifecycleGeneration,
      versionId: version2.id,
      documentId: document.id,
      title: "New title",
      sourceUri: "https://example.test/new",
      sourceVersion: "v1",
      sourceUpdatedAt: "2026-08-09T12:00:00.000Z",
    });
    const [convergedMetadata] = await admin<Array<{ title: string; sourceUri: string }>>`
      select title, source_uri as "sourceUri" from documents where id = ${document.id}`;
    expect(convergedMetadata).toEqual({
      title: "New title",
      sourceUri: "https://example.test/new",
    });
    const [crashReplayChunk] = await admin<
      Array<{
        metadata: {
          documentTitle: string;
          sourceUri: string;
          sourceTitle: string;
          sourceUpdatedAt: string | null;
          sourceVersion: string;
          unrelated: { preserved: boolean };
          crashReplayMarker: string;
        };
      }>
    >`select metadata from document_chunks where document_id = ${document.id}`;
    expect(crashReplayChunk?.metadata).toEqual({
      documentTitle: "New title",
      sourceUri: "https://example.test/new",
      sourceTitle: "New title",
      sourceUpdatedAt: "2026-08-09T12:00:00.000Z",
      sourceVersion: "v1",
      unrelated: { preserved: true },
      crashReplayMarker: "preserve-me",
    });
    await expect(
      updateKnowledgeSourceDocumentObservationMetadata(client.db, {
        accountId: account!.id,
        workspaceId: workspace!.id,
        initiatingSubjectId: actor.subjectId,
        sourceId: source.id,
        expectedSourceLifecycleGeneration: source.lifecycleGeneration,
        objectId: object.id,
        expectedObjectLifecycleGeneration: object.lifecycleGeneration,
        versionId: version1.id,
        documentId: document.id,
        title: "Stale authority title",
        sourceUri: "https://example.test/stale-authority",
        sourceVersion: "stale-authority",
        sourceUpdatedAt: null,
      }),
    ).rejects.toThrow("no longer current");
    const [afterStaleAuthority] = await admin<
      Array<{
        title: string;
        sourceUri: string;
        metadata: {
          documentTitle: string;
          sourceUri: string;
          sourceTitle: string;
          sourceUpdatedAt: string | null;
          sourceVersion: string;
          unrelated: { preserved: boolean };
          crashReplayMarker: string;
        };
      }>
    >`
      select document.title, document.source_uri as "sourceUri", chunk.metadata
      from documents document
      join document_chunks chunk on chunk.document_id = document.id
      where document.id = ${document.id}`;
    expect(afterStaleAuthority).toEqual({
      title: "New title",
      sourceUri: "https://example.test/new",
      metadata: {
        documentTitle: "New title",
        sourceUri: "https://example.test/new",
        sourceTitle: "New title",
        sourceUpdatedAt: "2026-08-09T12:00:00.000Z",
        sourceVersion: "v1",
        unrelated: { preserved: true },
        crashReplayMarker: "preserve-me",
      },
    });

    const readRetiredAuthoritySnapshot = async () =>
      await admin<
        Array<{
          title: string;
          sourceUri: string | null;
          sourceTitle: string | null;
          sourceVersion: string | null;
          sourceUpdatedAt: string | null;
          metadata: Record<string, unknown>;
        }>
      >`
        select document.title, document.source_uri as "sourceUri",
          document.source_title as "sourceTitle",
          document.source_version as "sourceVersion",
          document.source_updated_at::text as "sourceUpdatedAt", chunk.metadata
        from documents document
        join document_chunks chunk on chunk.document_id = document.id
        where document.id = ${document.id}
        order by chunk.chunk_index`;
    const seedRetiredAuthoritySnapshot = async (kind: "object" | "source") => {
      const title = `${kind} retirement sentinel`;
      const sourceUri = `https://example.test/${kind}-retired`;
      const sourceVersion = `${kind}-retired-version`;
      const sourceUpdatedAt =
        kind === "object" ? "2026-08-09T13:00:00.000Z" : "2026-08-09T14:00:00.000Z";
      await admin`
        update documents set title = ${title}, source_uri = ${sourceUri},
          source_title = ${title}, source_version = ${sourceVersion},
          source_updated_at = ${sourceUpdatedAt}::timestamptz, chunk_count = 1
        where id = ${document.id}`;
      await admin`delete from document_chunks where document_id = ${document.id}`;
      await admin`
        insert into document_chunks (
          account_id, workspace_id, document_id, base_id, file_id, chunk_index, text,
          metadata, authority_kind, authority_workspace_id, embedding, embedding_model
        ) values (
          ${account!.id}, ${workspace!.id}, ${document.id}, ${base.id}, ${file.id},
          0, ${`${kind} retirement authoritative chunk`}, jsonb_build_object(
            'documentTitle', ${title}::text,
            'sourceUri', ${sourceUri}::text,
            'sourceTitle', ${title}::text,
            'sourceUpdatedAt', ${sourceUpdatedAt}::text,
            'sourceVersion', ${sourceVersion}::text,
            'unrelated', jsonb_build_object('preserved', true, 'retirement', ${kind}::text)
          ), 'workspace', ${workspace!.id},
          array_fill(0::real, ARRAY[3072])::vector, 'test'
        )`;
      return JSON.stringify(await readRetiredAuthoritySnapshot());
    };

    await recordKnowledgeLifecycleEvent(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      targetKind: "object",
      targetId: object.id,
      eventType: "deleted",
      expectedGeneration: object.lifecycleGeneration,
      operationId: "repairs-object-delete",
      reasonCode: "authoritative_scan_absent",
      actor,
    });
    const objectRetiredAuthoritySnapshot = await seedRetiredAuthoritySnapshot("object");
    await expect(
      updateKnowledgeSourceDocumentObservationMetadata(client.db, {
        accountId: account!.id,
        workspaceId: workspace!.id,
        initiatingSubjectId: actor.subjectId,
        sourceId: source.id,
        expectedSourceLifecycleGeneration: source.lifecycleGeneration,
        objectId: object.id,
        expectedObjectLifecycleGeneration: object.lifecycleGeneration,
        versionId: version2.id,
        documentId: document.id,
        title: "Object retirement mutation",
        sourceUri: "https://example.test/object-retirement-mutation",
        sourceVersion: "object-retirement-mutation",
        sourceUpdatedAt: null,
      }),
    ).rejects.toThrow("no longer active");
    await expect(appendKnowledgeDocumentVersion(client.db, version2Input)).rejects.toThrow(
      "no longer active",
    );
    expect(JSON.stringify(await readRetiredAuthoritySnapshot())).toBe(
      objectRetiredAuthoritySnapshot,
    );
    const restoredObject = await restoreKnowledgeSourceObject(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      targetId: object.id,
      expectedGeneration: object.lifecycleGeneration + 1,
      operationId: "repairs-object-restore",
      reasonCode: "authoritative_scan_observed",
      actor,
    });
    const version3Input = {
      accountId: account!.id,
      workspaceId: workspace!.id,
      objectId: object.id,
      expectedSourceLifecycleGeneration: source.lifecycleGeneration,
      expectedObjectLifecycleGeneration: restoredObject.lifecycleGeneration,
      expectedVersionGeneration: version2.versionGeneration,
      externalVersionId: version2.externalVersionId,
      contentSha256: version2.contentSha256,
      ingestionKey: `repairs:v1:object-lifecycle-${restoredObject.lifecycleGeneration}`,
      sourceMetadata: {
        providerRevision: "v1",
        metadataHash: "9".repeat(64),
        sourceLifecycleGeneration: source.lifecycleGeneration,
        objectLifecycleGeneration: restoredObject.lifecycleGeneration,
      },
      aclVersionId: acl.id,
      aclGeneration: acl.generation,
      documentId: document.id,
      fileId: file.id,
      documentObservationMetadata: {
        title: "Restored object title",
        sourceUri: "https://example.test/restored-object",
        sourceVersion: "v1",
        sourceUpdatedAt: "2026-08-09T12:30:00.000Z",
      },
      operationId: "repairs-version-3",
      reasonCode: "source_metadata_observed",
      actor,
    };
    const version3 = await appendKnowledgeDocumentVersion(client.db, version3Input);
    expect(version3.id).not.toBe(version2.id);
    expect(version3.versionGeneration).toBe(version2.versionGeneration + 1);
    const [oldObligation] = await admin<Array<{ status: string }>>`
      select status from knowledge_source_sync_index_obligations where id = ${obligation1.id}`;
    expect(oldObligation?.status).toBe("invalidated");

    const deletedSource = await recordKnowledgeLifecycleEvent(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      targetKind: "source",
      targetId: source.id,
      eventType: "deleted",
      expectedGeneration: source.lifecycleGeneration,
      operationId: "repairs-source-delete",
      reasonCode: "source_deselected",
      actor,
    });
    const sourceRetiredAuthoritySnapshot = await seedRetiredAuthoritySnapshot("source");
    await expect(
      updateKnowledgeSourceDocumentObservationMetadata(client.db, {
        accountId: account!.id,
        workspaceId: workspace!.id,
        initiatingSubjectId: actor.subjectId,
        sourceId: source.id,
        expectedSourceLifecycleGeneration: source.lifecycleGeneration,
        objectId: object.id,
        expectedObjectLifecycleGeneration: restoredObject.lifecycleGeneration,
        versionId: version3.id,
        documentId: document.id,
        title: "Source retirement mutation",
        sourceUri: "https://example.test/source-retirement-mutation",
        sourceVersion: "source-retirement-mutation",
        sourceUpdatedAt: null,
      }),
    ).rejects.toThrow("no longer active");
    await expect(appendKnowledgeDocumentVersion(client.db, version3Input)).rejects.toThrow(
      "no longer active",
    );
    expect(JSON.stringify(await readRetiredAuthoritySnapshot())).toBe(
      sourceRetiredAuthoritySnapshot,
    );
    const restoredSource = await recordKnowledgeLifecycleEvent(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      targetKind: "source",
      targetId: source.id,
      eventType: "restored",
      expectedGeneration: deletedSource.lifecycleGeneration,
      operationId: "repairs-source-restore",
      reasonCode: "source_explicitly_reenabled",
      actor,
    });
    const version4 = await appendKnowledgeDocumentVersion(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      objectId: object.id,
      expectedSourceLifecycleGeneration: restoredSource.lifecycleGeneration,
      expectedObjectLifecycleGeneration: restoredObject.lifecycleGeneration,
      expectedVersionGeneration: version3.versionGeneration,
      externalVersionId: version3.externalVersionId,
      contentSha256: version3.contentSha256,
      ingestionKey: `repairs:v1:source-lifecycle-${restoredSource.lifecycleGeneration}`,
      sourceMetadata: {
        providerRevision: "v1",
        metadataHash: "9".repeat(64),
        sourceLifecycleGeneration: restoredSource.lifecycleGeneration,
        objectLifecycleGeneration: restoredObject.lifecycleGeneration,
      },
      aclVersionId: acl.id,
      aclGeneration: acl.generation,
      documentId: document.id,
      fileId: file.id,
      operationId: "repairs-version-4",
      reasonCode: "source_metadata_observed",
      actor,
    });
    expect(version4.id).not.toBe(version3.id);
    expect(version4.versionGeneration).toBe(version3.versionGeneration + 1);
  }, 120_000);

  test("keeps blob dedupe separate from source identity and fences delayed ACL evidence", async () => {
    if (!available) return;
    const [account] = await admin<{ id: string }[]>`
      insert into managed_accounts (name) values ('knowledge authority') returning id`;
    const [workspace] = await admin<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${account!.id}, 'knowledge authority') returning id`;
    await admin`
      insert into workspace_memberships (
        account_id, workspace_id, subject_id, subject_label, role, permissions
      ) values (
        ${account!.id}, ${workspace!.id}, 'user:alice', 'Alice', 'member', '[]'::jsonb
      )`;
    const actor = {
      kind: "human" as const,
      subjectId: "user:alice",
      initiatingHumanSubjectId: "user:alice",
    };
    const scope = {
      kind: "workspace" as const,
      workspaceId: workspace!.id,
      subjectId: null,
    };
    const provider = await upsertKnowledgeProvider(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      scope,
      providerKey: "test-drive-authority",
      externalTenantId: "tenant-authority",
      operationId: "provider-authority",
      actor,
    });
    const source = await upsertKnowledgeSource(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      scope,
      providerId: provider.id,
      externalSourceId: "folder-authority",
      sourceKind: "test-folder",
      operationId: "source-authority",
      actor,
    });
    const acl = await appendKnowledgeSourceAclVersion(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      sourceId: source.id,
      audience: scope,
      expectedSourceLifecycleGeneration: source.lifecycleGeneration,
      expectedAclGeneration: 0,
      aclVersion: "acl-1",
      agentAccess: false,
      operationId: "source-authority-acl",
      reasonCode: "source_selected",
      actor,
    });
    const task = await createScheduledTask(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      name: "Sync authority source",
      status: "active",
      schedule: { type: "manual" },
      temporalScheduleId: `scheduled-task-${crypto.randomUUID()}`,
      runMode: "new_session_per_run",
      overlapPolicy: "buffer_one",
      action: {
        kind: "knowledge_source_sync",
        sourceId: source.id,
        sourceGeneration: source.syncGeneration,
        sourceLifecycleGeneration: source.lifecycleGeneration,
        sourceConfigGeneration: 1,
        controlWorkspaceId: workspace!.id,
        providerCoordinationKey: "example:authority-source",
        destination: scope,
        initiatingSubjectId: actor.subjectId,
        allDescendants: true,
        connection: {
          connectionId: crypto.randomUUID(),
          connectionVersion: 1,
          providerDomain: "example.test",
          kind: "oauth2",
          ownerSubjectId: actor.subjectId,
        },
        limits: {
          maxItems: 10,
          maxBytes: 1_000,
          maxFileBytes: 1_000,
          maxProviderRequests: 10,
          maxElapsedSeconds: 10,
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
    await ensureKnowledgeSourceSyncState(client.db, task);
    const run = await createScheduledTaskRun(client.db, {
      workspaceId: workspace!.id,
      taskId: task.id,
      triggerType: "manual",
      producerKey: "authority-run",
    });
    const base = await ensureDefaultBase(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
    });
    const sharedFile = await ensureKnowledgeSourceBlobFile(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      fileId: crypto.randomUUID(),
      filename: "same.txt",
      safeFilename: "same.txt",
      contentType: "text/plain",
      sizeBytes: 4,
      sha256: "0".repeat(64),
      bucket: "test",
      objectKey: `workspaces/${workspace!.id}/knowledge/blobs/${"0".repeat(64)}`,
    });
    const firstObject = await upsertKnowledgeSourceObject(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      sourceId: source.id,
      externalObjectId: "object-a",
      operationId: "source-object-a",
      actor,
    });
    const secondObject = await upsertKnowledgeSourceObject(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      sourceId: source.id,
      externalObjectId: "object-b",
      operationId: "source-object-b",
      actor,
    });
    const firstDocument = await addDocumentToBase(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      baseId: base.id,
      fileId: sharedFile.id,
      title: "Object A",
      sourceKind: "document",
      sourceExternalId: "object-a",
      sourceVersion: "v1",
      authorityKind: "workspace",
      initiatingSubjectId: actor.subjectId,
      createdBy: actor.subjectId,
      agentAccess: false,
      knowledgeSourceIdentity: crypto.randomUUID(),
      access: { viewerSubjectId: actor.subjectId },
    });
    const secondDocument = await addDocumentToBase(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      baseId: base.id,
      fileId: sharedFile.id,
      title: "Object B",
      sourceKind: "document",
      sourceExternalId: "object-b",
      sourceVersion: "v1",
      authorityKind: "workspace",
      initiatingSubjectId: actor.subjectId,
      createdBy: actor.subjectId,
      agentAccess: false,
      knowledgeSourceIdentity: crypto.randomUUID(),
      access: { viewerSubjectId: actor.subjectId },
    });
    expect(firstDocument.id).not.toBe(secondDocument.id);
    expect(firstDocument.fileId).toBe(secondDocument.fileId);

    const secondVersion = await appendKnowledgeDocumentVersion(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      objectId: secondObject.id,
      expectedSourceLifecycleGeneration: source.lifecycleGeneration,
      expectedObjectLifecycleGeneration: secondObject.lifecycleGeneration,
      expectedVersionGeneration: 0,
      externalVersionId: "v1",
      contentSha256: "0".repeat(64),
      ingestionKey: "object-b:v1",
      aclVersionId: acl.id,
      aclGeneration: acl.generation,
      documentId: secondDocument.id,
      fileId: sharedFile.id,
      operationId: "object-b-version-1",
      reasonCode: "source_content_observed",
      actor,
    });
    expect(secondVersion.documentId).toBe(secondDocument.id);

    const firstVersion = await appendKnowledgeDocumentVersion(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      objectId: firstObject.id,
      expectedSourceLifecycleGeneration: source.lifecycleGeneration,
      expectedObjectLifecycleGeneration: firstObject.lifecycleGeneration,
      expectedVersionGeneration: 0,
      externalVersionId: "v1",
      contentSha256: "0".repeat(64),
      ingestionKey: "object-a:v1",
      aclVersionId: acl.id,
      aclGeneration: acl.generation,
      documentId: firstDocument.id,
      fileId: sharedFile.id,
      operationId: "object-a-version-1",
      reasonCode: "source_content_observed",
      actor,
    });
    const firstObligation = await enqueueKnowledgeSourceSyncIndexObligation(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      scheduledTaskRunId: run.id,
      sourceId: source.id,
      sourceSyncGeneration: source.syncGeneration,
      initiatingSubjectId: actor.subjectId,
      externalObjectId: "object-a",
      knowledgeSourceObjectId: firstObject.id,
      knowledgeDocumentVersionId: firstVersion.id,
      documentId: firstDocument.id,
      sourceConfigGeneration: 1,
      sourceLifecycleGeneration: source.lifecycleGeneration,
      objectLifecycleGeneration: firstObject.lifecycleGeneration,
      objectVersionGeneration: firstVersion.versionGeneration,
      citationLocator: { provider: "test", object: "object-a" },
    });
    await settleKnowledgeSourceSyncIndexObligation(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      obligationId: firstObligation.id,
      status: "indexed",
    });
    await recordKnowledgeSourceSyncAclEvidence(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      obligationId: firstObligation.id,
      sourceSyncGeneration: source.syncGeneration,
      sourceConfigGeneration: 1,
      sourceLifecycleGeneration: source.lifecycleGeneration,
      objectLifecycleGeneration: firstObject.lifecycleGeneration,
      objectVersionGeneration: firstVersion.versionGeneration,
      eligibility: "eligible",
      evidence: { test: true },
    });
    await admin`
      insert into document_chunks (
        account_id, workspace_id, document_id, base_id, file_id, chunk_index, text,
        metadata, authority_kind, authority_workspace_id, embedding, embedding_model
      ) values (
        ${account!.id}, ${workspace!.id}, ${firstDocument.id}, ${base.id}, ${sharedFile.id},
        0, 'stale chunk', '{}'::jsonb, 'workspace', ${workspace!.id},
        array_fill(0::real, ARRAY[3072])::vector, 'test'
      )`;

    const replacementFile = await ensureKnowledgeSourceBlobFile(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      fileId: crypto.randomUUID(),
      filename: "changed.txt",
      safeFilename: "changed.txt",
      contentType: "text/plain",
      sizeBytes: 7,
      sha256: "1".repeat(64),
      bucket: "test",
      objectKey: `workspaces/${workspace!.id}/knowledge/blobs/${"1".repeat(64)}`,
    });
    const replacementDocument = await addDocumentToBase(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      baseId: base.id,
      fileId: replacementFile.id,
      title: "Object A v2",
      sourceKind: "document",
      sourceExternalId: "object-a",
      sourceVersion: "v2",
      authorityKind: "workspace",
      initiatingSubjectId: actor.subjectId,
      createdBy: actor.subjectId,
      agentAccess: false,
      knowledgeSourceIdentity: crypto.randomUUID(),
      access: { viewerSubjectId: actor.subjectId },
    });
    const replacementVersion = await appendKnowledgeDocumentVersion(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      objectId: firstObject.id,
      expectedSourceLifecycleGeneration: source.lifecycleGeneration,
      expectedObjectLifecycleGeneration: firstObject.lifecycleGeneration,
      expectedVersionGeneration: firstVersion.versionGeneration,
      externalVersionId: "v2",
      contentSha256: "1".repeat(64),
      ingestionKey: "object-a:v2",
      aclVersionId: acl.id,
      aclGeneration: acl.generation,
      documentId: replacementDocument.id,
      fileId: replacementFile.id,
      operationId: "object-a-version-2",
      reasonCode: "source_content_observed",
      actor,
    });
    await admin`
      insert into document_chunks (
        account_id, workspace_id, document_id, base_id, file_id, chunk_index, text,
        metadata, authority_kind, authority_workspace_id, embedding, embedding_model
      ) values (
        ${account!.id}, ${workspace!.id}, ${firstDocument.id}, ${base.id}, ${sharedFile.id},
        0, 'late stale chunk', '{}'::jsonb, 'workspace', ${workspace!.id},
        array_fill(0::real, ARRAY[3072])::vector, 'test'
      )`;
    expect(
      await settleKnowledgeSourceSyncIndexObligation(client.db, {
        accountId: account!.id,
        workspaceId: workspace!.id,
        obligationId: firstObligation.id,
        status: "indexed",
      }),
    ).toBe("invalidated");
    const [retired] = await admin<
      Array<{ agentAccess: boolean; chunkCount: number; chunks: number; obligationStatus: string }>
    >`
      select document.agent_access as "agentAccess", document.chunk_count as "chunkCount",
        (select count(*)::int from document_chunks where document_id = document.id) as chunks,
        obligation.status as "obligationStatus"
      from documents document
      join knowledge_source_sync_index_obligations obligation
        on obligation.document_id = document.id
      where document.id = ${firstDocument.id}`;
    expect(retired).toEqual({
      agentAccess: false,
      chunkCount: 0,
      chunks: 0,
      obligationStatus: "invalidated",
    });
    await expect(
      recordKnowledgeSourceSyncAclEvidence(client.db, {
        accountId: account!.id,
        workspaceId: workspace!.id,
        obligationId: firstObligation.id,
        sourceSyncGeneration: source.syncGeneration,
        sourceConfigGeneration: 1,
        sourceLifecycleGeneration: source.lifecycleGeneration,
        objectLifecycleGeneration: firstObject.lifecycleGeneration,
        objectVersionGeneration: firstVersion.versionGeneration,
        eligibility: "eligible",
        evidence: { delayed: true },
      }),
    ).rejects.toThrow("authority changed");

    const replacementObligation = await enqueueKnowledgeSourceSyncIndexObligation(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      scheduledTaskRunId: run.id,
      sourceId: source.id,
      sourceSyncGeneration: source.syncGeneration,
      initiatingSubjectId: actor.subjectId,
      externalObjectId: "object-a",
      knowledgeSourceObjectId: firstObject.id,
      knowledgeDocumentVersionId: replacementVersion.id,
      documentId: replacementDocument.id,
      sourceConfigGeneration: 1,
      sourceLifecycleGeneration: source.lifecycleGeneration,
      objectLifecycleGeneration: firstObject.lifecycleGeneration,
      objectVersionGeneration: replacementVersion.versionGeneration,
      citationLocator: { provider: "test", object: "object-a" },
    });
    await settleKnowledgeSourceSyncIndexObligation(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      obligationId: replacementObligation.id,
      status: "indexed",
    });
    await recordKnowledgeLifecycleEvent(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      targetKind: "source",
      targetId: source.id,
      eventType: "deleted",
      expectedGeneration: source.lifecycleGeneration,
      operationId: "source-authority-delete",
      reasonCode: "schedule_deleted",
      actor,
    });
    await expect(
      recordKnowledgeSourceSyncAclEvidence(client.db, {
        accountId: account!.id,
        workspaceId: workspace!.id,
        obligationId: replacementObligation.id,
        sourceSyncGeneration: source.syncGeneration,
        sourceConfigGeneration: 1,
        sourceLifecycleGeneration: source.lifecycleGeneration,
        objectLifecycleGeneration: firstObject.lifecycleGeneration,
        objectVersionGeneration: replacementVersion.versionGeneration,
        eligibility: "eligible",
        evidence: { delayed: true },
      }),
    ).rejects.toThrow("authority changed");
  }, 60_000);

  test("rolls live generations, repairs retry seams, reconciles complete scans, and requires fresh ACL evidence", async () => {
    if (!available) return;
    const [account] = await admin<{ id: string }[]>`
      insert into managed_accounts (name) values ('knowledge sync protocol') returning id`;
    const [workspace] = await admin<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${account!.id}, 'knowledge sync protocol') returning id`;
    await admin`
      insert into workspace_memberships (
        account_id, workspace_id, subject_id, subject_label, role, permissions
      ) values (
        ${account!.id}, ${workspace!.id}, 'user:protocol', 'Protocol', 'member', '[]'::jsonb
      )`;
    const actor = {
      kind: "human" as const,
      subjectId: "user:protocol",
      initiatingHumanSubjectId: "user:protocol",
    };
    const scope = {
      kind: "workspace" as const,
      workspaceId: workspace!.id,
      subjectId: null,
    };
    const provider = await upsertKnowledgeProvider(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      scope,
      providerKey: "test-drive-protocol",
      externalTenantId: "tenant-protocol",
      operationId: "provider-protocol",
      actor,
    });
    const source = await upsertKnowledgeSource(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      scope,
      providerId: provider.id,
      externalSourceId: "folder-protocol",
      sourceKind: "test-folder",
      operationId: "source-protocol",
      actor,
    });
    let acl = await appendKnowledgeSourceAclVersion(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      sourceId: source.id,
      audience: scope,
      expectedSourceLifecycleGeneration: source.lifecycleGeneration,
      expectedAclGeneration: 0,
      aclVersion: "protocol-acl-1",
      agentAccess: false,
      operationId: "protocol-acl-1",
      reasonCode: "source_selected",
      actor,
    });
    const task = await createScheduledTask(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      name: "Sync protocol source",
      status: "active",
      schedule: { type: "manual" },
      temporalScheduleId: `scheduled-task-${crypto.randomUUID()}`,
      runMode: "new_session_per_run",
      overlapPolicy: "buffer_one",
      action: {
        kind: "knowledge_source_sync",
        sourceId: source.id,
        sourceGeneration: 0,
        sourceLifecycleGeneration: source.lifecycleGeneration,
        sourceConfigGeneration: 1,
        controlWorkspaceId: workspace!.id,
        providerCoordinationKey: "example:protocol",
        destination: scope,
        initiatingSubjectId: actor.subjectId,
        allDescendants: true,
        connection: {
          connectionId: crypto.randomUUID(),
          connectionVersion: 1,
          providerDomain: "example.test",
          kind: "oauth2",
          ownerSubjectId: actor.subjectId,
        },
        limits: {
          maxItems: 10,
          maxBytes: 1_000,
          maxFileBytes: 1_000,
          maxProviderRequests: 10,
          maxElapsedSeconds: 10,
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
    await ensureKnowledgeSourceSyncState(client.db, task);
    const base = await ensureDefaultBase(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
    });
    const file = await ensureKnowledgeSourceBlobFile(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      fileId: crypto.randomUUID(),
      filename: "protocol.txt",
      safeFilename: "protocol.txt",
      contentType: "text/plain",
      sizeBytes: 8,
      sha256: "2".repeat(64),
      bucket: "test",
      objectKey: `workspaces/${workspace!.id}/knowledge/blobs/${"2".repeat(64)}`,
    });
    const summary = {
      phase: "completed" as const,
      scanned: 1,
      imported: 1,
      unchanged: 0,
      skipped: 0,
      failed: 0,
      bytes: 8,
      providerRequests: 1,
      elapsedMs: 1,
      indexed: 1,
      aclPending: 1,
      retryable: false,
      limitReached: null,
      checkpointed: false,
      reconnectRequired: false,
      failures: [],
    };
    const admitRun = async (label: string) => {
      const live = await getKnowledgeSourceForSyncAuthority(client.db, {
        accountId: account!.id,
        workspaceId: workspace!.id,
        sourceId: source.id,
        initiatingSubjectId: actor.subjectId,
      });
      expect(live).not.toBeNull();
      const run = await createScheduledTaskRun(client.db, {
        workspaceId: workspace!.id,
        taskId: task.id,
        triggerType: "manual",
        producerKey: `protocol-${label}`,
      });
      await recordKnowledgeSourceSyncWake(client.db, {
        accountId: account!.id,
        workspaceId: workspace!.id,
        sourceId: source.id,
        scheduledTaskId: task.id,
        scheduledTaskRunId: run.id,
        cause: "manual",
        producerKey: `protocol-${label}`,
        sourceConfigGeneration: 1,
        sourceLifecycleGeneration: source.lifecycleGeneration,
      });
      const lease = await claimKnowledgeSourceSyncLease(client.db, {
        accountId: account!.id,
        workspaceId: workspace!.id,
        sourceId: source.id,
        scheduledTaskRunId: run.id,
        overlapPolicy: "buffer_one",
      });
      expect(lease.action).toBe("claimed");
      if (lease.action !== "claimed") throw new Error("lease not claimed");
      const state = await reconcileKnowledgeSourceSyncLiveGeneration(client.db, {
        accountId: account!.id,
        workspaceId: workspace!.id,
        sourceId: source.id,
        scheduledTaskRunId: run.id,
        initiatingSubjectId: actor.subjectId,
        sourceConfigGeneration: 1,
        sourceLifecycleGeneration: source.lifecycleGeneration,
        liveSourceSyncGeneration: live!.source.syncGeneration,
      });
      const knowledgeRun = await beginKnowledgeSyncRun(client.db, {
        accountId: account!.id,
        workspaceId: workspace!.id,
        sourceId: source.id,
        expectedSourceLifecycleGeneration: source.lifecycleGeneration,
        expectedSyncGeneration: live!.source.syncGeneration,
        inputCursor: null,
        operationId: `protocol-run:${label}`,
        actor,
      });
      return { run, state, knowledgeRun };
    };

    const first = await admitRun("first");
    const objectA = await upsertKnowledgeSourceObject(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      sourceId: source.id,
      externalObjectId: "protocol-a",
      operationId: "protocol-object-a",
      actor,
    });
    const documentA = await addDocumentToBase(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      baseId: base.id,
      fileId: file.id,
      title: "Protocol A",
      sourceKind: "document",
      sourceExternalId: "protocol-a",
      sourceVersion: "v1",
      authorityKind: "workspace",
      initiatingSubjectId: actor.subjectId,
      createdBy: actor.subjectId,
      agentAccess: false,
      knowledgeSourceIdentity: crypto.randomUUID(),
      access: { viewerSubjectId: actor.subjectId },
    });
    const versionA = await appendKnowledgeDocumentVersion(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      objectId: objectA.id,
      expectedSourceLifecycleGeneration: source.lifecycleGeneration,
      expectedObjectLifecycleGeneration: objectA.lifecycleGeneration,
      expectedVersionGeneration: 0,
      externalVersionId: "v1",
      contentSha256: "2".repeat(64),
      ingestionKey: "protocol-a:v1:metadata-1",
      sourceMetadata: { providerRevision: "v1", metadataHash: "3".repeat(64) },
      aclVersionId: acl.id,
      aclGeneration: acl.generation,
      documentId: documentA.id,
      fileId: file.id,
      operationId: "protocol-a-version-1",
      reasonCode: "source_content_observed",
      actor,
    });
    // Crash window 1: the immutable version exists before its obligation.
    expect(
      await getKnowledgeSourceSyncIndexObligationForVersion(client.db, {
        accountId: account!.id,
        workspaceId: workspace!.id,
        knowledgeDocumentVersionId: versionA.id,
        initiatingSubjectId: actor.subjectId,
      }),
    ).toBeNull();
    const obligationA = await enqueueKnowledgeSourceSyncIndexObligation(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      scheduledTaskRunId: first.run.id,
      sourceId: source.id,
      sourceSyncGeneration: first.knowledgeRun.inputSyncGeneration,
      initiatingSubjectId: actor.subjectId,
      externalObjectId: "protocol-a",
      knowledgeSourceObjectId: objectA.id,
      knowledgeDocumentVersionId: versionA.id,
      documentId: documentA.id,
      sourceConfigGeneration: 1,
      sourceLifecycleGeneration: source.lifecycleGeneration,
      objectLifecycleGeneration: objectA.lifecycleGeneration,
      objectVersionGeneration: versionA.versionGeneration,
      citationLocator: { sourceUri: "https://example.test/a" },
    });
    // Crash window 2: retry observes a pending obligation after indexing but
    // before settlement and can settle the same durable identity.
    expect(obligationA.status).toBe("pending");
    expect(
      await settleKnowledgeSourceSyncIndexObligation(client.db, {
        accountId: account!.id,
        workspaceId: workspace!.id,
        obligationId: obligationA.id,
        status: "indexed",
      }),
    ).toBe("settled");
    await completeKnowledgeSyncRun(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      initiatingSubjectId: actor.subjectId,
      runId: first.knowledgeRun.id,
      state: "succeeded",
      metadata: summary,
      reasonCode: "scheduled_source_sync",
    });
    await settleKnowledgeSourceSyncLease(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      sourceId: source.id,
      scheduledTaskRunId: first.run.id,
      knowledgeSyncRunId: first.knowledgeRun.id,
      status: "succeeded",
      summary,
      sourceConfigGeneration: 1,
      sourceLifecycleGeneration: source.lifecycleGeneration,
      sourceSyncGeneration: 0,
      completedSourceSyncGeneration: 1,
    });
    await recordKnowledgeSourceSyncAclEvidence(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      obligationId: obligationA.id,
      sourceSyncGeneration: 0,
      sourceConfigGeneration: 1,
      sourceLifecycleGeneration: source.lifecycleGeneration,
      objectLifecycleGeneration: objectA.lifecycleGeneration,
      objectVersionGeneration: versionA.versionGeneration,
      eligibility: "eligible",
      evidence: { afterGenerationRollover: true },
    });

    const second = await admitRun("second");
    expect(second.knowledgeRun.inputSyncGeneration).toBe(1);
    const objectB = await upsertKnowledgeSourceObject(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      sourceId: source.id,
      externalObjectId: "protocol-b",
      operationId: "protocol-object-b",
      actor,
    });
    const documentB = await addDocumentToBase(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      baseId: base.id,
      fileId: file.id,
      title: "Protocol B",
      sourceKind: "document",
      sourceExternalId: "protocol-b",
      sourceVersion: "v1",
      authorityKind: "workspace",
      initiatingSubjectId: actor.subjectId,
      createdBy: actor.subjectId,
      agentAccess: false,
      knowledgeSourceIdentity: crypto.randomUUID(),
      access: { viewerSubjectId: actor.subjectId },
    });
    const versionB1 = await appendKnowledgeDocumentVersion(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      objectId: objectB.id,
      expectedSourceLifecycleGeneration: source.lifecycleGeneration,
      expectedObjectLifecycleGeneration: objectB.lifecycleGeneration,
      expectedVersionGeneration: 0,
      externalVersionId: "v1",
      contentSha256: "2".repeat(64),
      ingestionKey: "protocol-b:v1:metadata-1",
      sourceMetadata: { providerRevision: "v1", metadataHash: "4".repeat(64) },
      aclVersionId: acl.id,
      aclGeneration: acl.generation,
      documentId: documentB.id,
      fileId: file.id,
      operationId: "protocol-b-version-1",
      reasonCode: "source_content_observed",
      actor,
    });
    const obligationB1 = await enqueueKnowledgeSourceSyncIndexObligation(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      scheduledTaskRunId: second.run.id,
      sourceId: source.id,
      sourceSyncGeneration: 1,
      initiatingSubjectId: actor.subjectId,
      externalObjectId: "protocol-b",
      knowledgeSourceObjectId: objectB.id,
      knowledgeDocumentVersionId: versionB1.id,
      documentId: documentB.id,
      sourceConfigGeneration: 1,
      sourceLifecycleGeneration: source.lifecycleGeneration,
      objectLifecycleGeneration: objectB.lifecycleGeneration,
      objectVersionGeneration: versionB1.versionGeneration,
      citationLocator: { sourceUri: "https://example.test/b" },
    });
    await settleKnowledgeSourceSyncIndexObligation(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      obligationId: obligationB1.id,
      status: "indexed",
    });
    await completeKnowledgeSyncRun(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      initiatingSubjectId: actor.subjectId,
      runId: second.knowledgeRun.id,
      state: "succeeded",
      metadata: summary,
      reasonCode: "scheduled_source_sync",
    });
    await settleKnowledgeSourceSyncLease(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      sourceId: source.id,
      scheduledTaskRunId: second.run.id,
      knowledgeSyncRunId: second.knowledgeRun.id,
      status: "succeeded",
      summary,
      sourceConfigGeneration: 1,
      sourceLifecycleGeneration: source.lifecycleGeneration,
      sourceSyncGeneration: 1,
      completedSourceSyncGeneration: 2,
    });
    await recordKnowledgeSourceSyncAclEvidence(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      obligationId: obligationB1.id,
      sourceSyncGeneration: 1,
      sourceConfigGeneration: 1,
      sourceLifecycleGeneration: source.lifecycleGeneration,
      objectLifecycleGeneration: objectB.lifecycleGeneration,
      objectVersionGeneration: versionB1.versionGeneration,
      eligibility: "eligible",
      evidence: { secondRun: true },
    });
    await admin`
      insert into document_chunks (
        account_id, workspace_id, document_id, base_id, file_id, chunk_index, text,
        metadata, authority_kind, authority_workspace_id, embedding, embedding_model
      ) values (
        ${account!.id}, ${workspace!.id}, ${documentB.id}, ${base.id}, ${file.id},
        0, 'authorized protocol chunk', '{}'::jsonb, 'workspace', ${workspace!.id},
        array_fill(0::real, ARRAY[3072])::vector, 'test'
      )`;
    await admin`update documents set chunk_count = 1 where id = ${documentB.id}`;

    const third = await admitRun("third");
    await recordKnowledgeSourceSyncObjectObservations(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      sourceId: source.id,
      scheduledTaskRunId: third.run.id,
      scanGeneration: third.state.activeScanGeneration,
      observations: [
        { externalObjectId: "protocol-b", providerRevision: "v1", metadataHash: "4".repeat(64) },
      ],
    });
    await checkpointKnowledgeSourceSync(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      sourceId: source.id,
      scheduledTaskRunId: third.run.id,
      sourceConfigGeneration: 1,
      sourceLifecycleGeneration: source.lifecycleGeneration,
      executionCheckpoint: { partial: true },
    });
    const [beforeComplete] = await admin<Array<{ state: string }>>`
      select lifecycle_state as state from knowledge_source_objects where id = ${objectA.id}`;
    expect(beforeComplete?.state).toBe("active");
    expect(
      await reconcileKnowledgeSourceSyncCompleteScan(client.db, {
        accountId: account!.id,
        workspaceId: workspace!.id,
        sourceId: source.id,
        scheduledTaskRunId: third.run.id,
        initiatingSubjectId: actor.subjectId,
        sourceSyncGeneration: 2,
        sourceConfigGeneration: 1,
        sourceLifecycleGeneration: source.lifecycleGeneration,
        scanGeneration: third.state.activeScanGeneration,
      }),
    ).toEqual(["protocol-a"]);
    const [afterComplete] = await admin<Array<{ state: string; access: boolean }>>`
      select object.lifecycle_state as state, document.agent_access as access
      from knowledge_source_objects object
      join knowledge_document_versions version on version.id = object.current_version_id
      join documents document on document.id = version.document_id
      where object.id = ${objectA.id}`;
    expect(afterComplete).toEqual({ state: "deleted", access: false });

    acl = await deauthorizeKnowledgeSourceRetrieval(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      sourceId: source.id,
      audience: scope,
      operationId: "protocol-connection-paused",
      reasonCode: "connection_paused",
      actor,
    });
    const [revoked] = await admin<
      Array<{ access: boolean; chunks: number; obligation: string; aclGeneration: number }>
    >`
      select document.agent_access as access,
        (select count(*)::int from document_chunks where document_id = document.id) as chunks,
        obligation.status as obligation,
        source.current_acl_generation::int as "aclGeneration"
      from documents document
      join knowledge_source_sync_index_obligations obligation on obligation.document_id = document.id
      join knowledge_sources source on source.id = obligation.source_id
      where document.id = ${documentB.id}`;
    expect(revoked).toMatchObject({
      access: false,
      chunks: 0,
      obligation: "invalidated",
      aclGeneration: acl.generation,
    });
    await expect(
      recordKnowledgeSourceSyncAclEvidence(client.db, {
        accountId: account!.id,
        workspaceId: workspace!.id,
        obligationId: obligationB1.id,
        sourceSyncGeneration: 1,
        sourceConfigGeneration: 1,
        sourceLifecycleGeneration: source.lifecycleGeneration,
        objectLifecycleGeneration: objectB.lifecycleGeneration,
        objectVersionGeneration: versionB1.versionGeneration,
        eligibility: "eligible",
        evidence: { staleAfterPause: true },
      }),
    ).rejects.toThrow("authority changed");

    // Metadata/ACL-only observations may share provider revision, bytes,
    // document and file while retaining a new immutable version identity.
    const versionB2 = await appendKnowledgeDocumentVersion(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      objectId: objectB.id,
      expectedSourceLifecycleGeneration: source.lifecycleGeneration,
      expectedObjectLifecycleGeneration: objectB.lifecycleGeneration,
      expectedVersionGeneration: versionB1.versionGeneration,
      externalVersionId: "v1",
      contentSha256: "2".repeat(64),
      ingestionKey: "protocol-b:v1:metadata-2:acl-2",
      sourceMetadata: { providerRevision: "v1", metadataHash: "5".repeat(64) },
      aclVersionId: acl.id,
      aclGeneration: acl.generation,
      documentId: documentB.id,
      fileId: file.id,
      operationId: "protocol-b-version-2",
      reasonCode: "source_metadata_observed",
      actor,
    });
    expect(versionB2.id).not.toBe(versionB1.id);
    expect(versionB2.externalVersionId).toBe(versionB1.externalVersionId);
    expect(versionB2.documentId).toBe(versionB1.documentId);
    await admin`
      insert into document_chunks (
        account_id, workspace_id, document_id, base_id, file_id, chunk_index, text,
        metadata, authority_kind, authority_workspace_id, embedding, embedding_model
      ) values (
        ${account!.id}, ${workspace!.id}, ${documentB.id}, ${base.id}, ${file.id},
        0, 'freshly reindexed protocol chunk', '{}'::jsonb, 'workspace', ${workspace!.id},
        array_fill(0::real, ARRAY[3072])::vector, 'test'
      )`;
    await admin`update documents set chunk_count = 1 where id = ${documentB.id}`;
    const obligationB2 = await enqueueKnowledgeSourceSyncIndexObligation(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      scheduledTaskRunId: third.run.id,
      sourceId: source.id,
      sourceSyncGeneration: 2,
      initiatingSubjectId: actor.subjectId,
      externalObjectId: "protocol-b",
      knowledgeSourceObjectId: objectB.id,
      knowledgeDocumentVersionId: versionB2.id,
      documentId: documentB.id,
      sourceConfigGeneration: 1,
      sourceLifecycleGeneration: source.lifecycleGeneration,
      objectLifecycleGeneration: objectB.lifecycleGeneration,
      objectVersionGeneration: versionB2.versionGeneration,
      citationLocator: { sourceUri: "https://example.test/b" },
    });
    expect(
      await settleKnowledgeSourceSyncIndexObligation(client.db, {
        accountId: account!.id,
        workspaceId: workspace!.id,
        obligationId: obligationB2.id,
        status: "indexed",
      }),
    ).toBe("settled");
    await recordKnowledgeSourceSyncAclEvidence(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      obligationId: obligationB2.id,
      sourceSyncGeneration: 2,
      sourceConfigGeneration: 1,
      sourceLifecycleGeneration: source.lifecycleGeneration,
      objectLifecycleGeneration: objectB.lifecycleGeneration,
      objectVersionGeneration: versionB2.versionGeneration,
      eligibility: "eligible",
      evidence: { freshAfterPause: true },
    });
    const [reauthorized] = await admin<Array<{ access: boolean; chunks: number }>>`
      select agent_access as access,
        (select count(*)::int from document_chunks where document_id = document.id) as chunks
      from documents document where id = ${documentB.id}`;
    expect(reauthorized).toEqual({ access: true, chunks: 1 });
    const [metadataVersions] = await admin<Array<{ count: number }>>`
      select count(*)::int as count from knowledge_document_versions where object_id = ${objectB.id}`;
    expect(metadataVersions?.count).toBe(2);

    // A concurrent lifecycle transition must not strand a failed scheduled
    // run's lease after the source becomes non-active.
    await recordKnowledgeLifecycleEvent(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      targetKind: "source",
      targetId: source.id,
      eventType: "deleted",
      expectedGeneration: source.lifecycleGeneration,
      operationId: "protocol-source-deleted-during-run",
      reasonCode: "schedule_deleted",
      actor,
    });
    await settleKnowledgeSourceSyncLease(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      sourceId: source.id,
      scheduledTaskRunId: third.run.id,
      status: "failed",
      summary: { ...summary, phase: "failed", failed: 1 },
      error: "authority_changed",
      sourceConfigGeneration: 1,
      sourceLifecycleGeneration: source.lifecycleGeneration,
      sourceSyncGeneration: 2,
    });
    const [released] = await admin<Array<{ leaseId: string | null; status: string }>>`
      select state.lease_id as "leaseId", run.status
      from knowledge_source_sync_states state
      join scheduled_task_runs run on run.id = ${third.run.id}
      where state.source_id = ${source.id}`;
    expect(released).toEqual({ leaseId: null, status: "failed" });
  }, 120_000);
});
