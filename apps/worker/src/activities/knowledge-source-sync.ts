import { createHash } from "node:crypto";
import { heartbeat } from "@temporalio/activity";
import { KnowledgeSourceSyncRunSummary } from "@opengeni/contracts";
import {
  GoogleDriveConnectionMetadata,
  GOOGLE_DRIVE_PROVIDER_DOMAIN,
  type GoogleDriveSelectedSource,
} from "@opengeni/contracts/google-drive";
import {
  googleDriveKnowledgeScope,
  inventoryGoogleDriveSource,
  type GoogleDriveInventoryEntry,
  type GoogleDriveInventoryPage,
  type GoogleDriveInventoryProviderItem,
  type GoogleDriveInventoryStopReason,
} from "@opengeni/documents/google-drive";
import { addDocumentToBase, ensureDefaultBase, getDocumentBase } from "@opengeni/documents";
import {
  appendKnowledgeDocumentVersion,
  appendKnowledgeSourceAclVersion,
  beginKnowledgeSyncRun,
  buildConnectionTokenResolver,
  checkpointKnowledgeSourceSync,
  claimKnowledgeSourceSyncLease,
  completeKnowledgeSyncRun,
  completeKnowledgeSourceSyncWakeWithoutLease,
  deauthorizeKnowledgeSourceRetrieval,
  enqueueKnowledgeSourceSyncIndexObligation,
  ensureKnowledgeSourceBlobFile,
  getConnectionMetadata,
  getKnowledgeDocumentVersionObservationForSyncAuthority,
  getKnowledgeSyncRunForSyncAuthority,
  getKnowledgeSourceAclForSyncAuthority,
  getKnowledgeSourceForSyncAuthority,
  getKnowledgeSourceObjectForSyncAuthority,
  getKnowledgeSourceSyncIndexObligationForVersion,
  getScheduledTask,
  reconcileKnowledgeSourceSyncCompleteScan,
  reconcileKnowledgeSourceSyncLiveGeneration,
  recordKnowledgeSourceSyncItemOutcomes,
  recordKnowledgeSourceSyncObjectObservations,
  recordUsageEvent,
  releaseKnowledgeSourceSyncLeaseForRetry,
  restoreKnowledgeSourceObject,
  retryKnowledgeSourceSyncIndexObligation,
  settleKnowledgeSourceSyncLease,
  settleKnowledgeSourceSyncIndexObligation,
  updateKnowledgeSourceDocumentObservationMetadata,
  updateScheduledTaskRun,
  upsertKnowledgeSourceObject,
  type Database,
} from "@opengeni/db";
import { readResponseJsonBounded } from "@opengeni/network";
import { createDocumentActivities } from "./documents";
import type {
  ControlActivityServices,
  RunKnowledgeSourceSyncBatchInput,
  RunKnowledgeSourceSyncBatchResult,
} from "./types";
import type { KnowledgeSourceSyncDriver } from "./knowledge-source-sync-driver";

const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";
const DRIVE_JSON_MAX_BYTES = 2 * 1024 * 1024;

export function createKnowledgeSourceSyncActivities(
  services: () => Promise<ControlActivityServices>,
  resolveDocumentServices?: () => Promise<import("@opengeni/documents").DocumentServices>,
) {
  const documentActivities = createDocumentActivities(services, resolveDocumentServices);
  return {
    runKnowledgeSourceSyncBatch: async (
      input: RunKnowledgeSourceSyncBatchInput,
    ): Promise<RunKnowledgeSourceSyncBatchResult> => {
      const { settings, db, objectStorage, observability } = await services();
      if (!objectStorage) throw new Error("object storage is not configured");
      const task = await getScheduledTask(db, input.workspaceId, input.taskId);
      if (
        !task ||
        task.accountId !== input.accountId ||
        task.action.kind !== "knowledge_source_sync" ||
        task.action.sourceId !== input.sourceId ||
        task.status !== "active"
      ) {
        return await failWithoutProvider("schedule_inactive_or_changed");
      }
      const action = task.action;
      if (
        action.controlWorkspaceId !== input.workspaceId ||
        action.sourceConfigGeneration <= 0 ||
        !action.providerCoordinationKey
      ) {
        return await failWithoutProvider("authority_changed");
      }
      const lease = await claimKnowledgeSourceSyncLease(db, {
        ...input,
        overlapPolicy: input.overlapPolicy,
      });
      if (lease.action !== "claimed") {
        observability.incrementCounter({
          name: "opengeni_knowledge_source_sync_runs_total",
          labels: { provider: "google_drive", outcome: lease.action },
        });
        return { action: lease.action };
      }

      let knowledgeRunId: string | null = null;
      let activeSourceSyncGeneration: number | null = null;
      const startedAt = Date.now();
      const summary: KnowledgeSourceSyncRunSummary = {
        phase: "queued",
        scanned: 0,
        imported: 0,
        unchanged: 0,
        skipped: 0,
        failed: 0,
        bytes: 0,
        providerRequests: 0,
        elapsedMs: 0,
        indexed: 0,
        aclPending: 0,
        retryable: false,
        limitReached: null as
          | "items"
          | "bytes"
          | "file_bytes"
          | "provider_requests"
          | "elapsed_time"
          | null,
        checkpointed: false,
        reconnectRequired: false,
        failures: [],
      };
      try {
        summary.phase = "inventory";
        const resolved = await getKnowledgeSourceForSyncAuthority(db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sourceId: input.sourceId,
          initiatingSubjectId: action.initiatingSubjectId,
        });
        if (!resolved || resolved.source.lifecycleState !== "active") {
          throw new SyncFailure("authority_changed", false);
        }
        if (JSON.stringify(resolved.source.scope) !== JSON.stringify(action.destination)) {
          throw new SyncFailure("authority_changed", false);
        }
        const liveState = await reconcileKnowledgeSourceSyncLiveGeneration(db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sourceId: input.sourceId,
          scheduledTaskRunId: input.scheduledTaskRunId,
          initiatingSubjectId: action.initiatingSubjectId,
          sourceConfigGeneration: action.sourceConfigGeneration,
          sourceLifecycleGeneration: action.sourceLifecycleGeneration,
          liveSourceSyncGeneration: resolved.source.syncGeneration,
        });
        activeSourceSyncGeneration = resolved.source.syncGeneration;
        const syncOperationId = `scheduled-task-run:${input.scheduledTaskRunId}`;
        const replayedRun = await getKnowledgeSyncRunForSyncAuthority(db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sourceId: input.sourceId,
          operationId: syncOperationId,
          initiatingSubjectId: action.initiatingSubjectId,
        });
        if (replayedRun && replayedRun.state !== "started") {
          const replayedSummary = KnowledgeSourceSyncRunSummary.parse(replayedRun.metadata);
          const settlementInput: Parameters<typeof settleKnowledgeSourceSyncLease>[1] = {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sourceId: input.sourceId,
            scheduledTaskRunId: input.scheduledTaskRunId,
            knowledgeSyncRunId: replayedRun.id,
            status: replayedRun.state === "succeeded" ? "succeeded" : "failed",
            summary: replayedSummary,
            error: replayedRun.errorCode,
            sourceConfigGeneration: action.sourceConfigGeneration,
            sourceLifecycleGeneration: action.sourceLifecycleGeneration,
            sourceSyncGeneration: replayedRun.inputSyncGeneration,
            completedSourceSyncGeneration:
              replayedRun.state === "succeeded" ? replayedRun.inputSyncGeneration + 1 : null,
          };
          const settled =
            replayedRun.state === "failed" && replayedSummary.reconnectRequired
              ? await deauthorizeAndSettleKnowledgeSourceSyncFailure(db, {
                  deauthorization: {
                    accountId: input.accountId,
                    workspaceId: input.workspaceId,
                    sourceId: input.sourceId,
                    audience: action.destination,
                    operationId: `knowledge-sync-deauthorize:${input.sourceId}:${action.connection.connectionVersion}:${replayedRun.errorCode ?? "connection_reconnect_required"}`,
                    reasonCode: "connection_reconnect_required",
                    actor: {
                      kind: "service",
                      subjectId: "knowledge-source-sync",
                      initiatingHumanSubjectId: action.initiatingSubjectId,
                    },
                  },
                  settlement: settlementInput,
                })
              : await settleKnowledgeSourceSyncLease(db, settlementInput);
          await recordConnectorUsage("completed", replayedSummary.scanned, "item");
          await recordConnectorUsage("items", replayedSummary.imported, "item");
          await recordConnectorUsage("bytes", replayedSummary.bytes, "byte");
          return {
            action: replayedRun.state === "succeeded" ? "complete" : "failed",
            bufferedWake: settled.bufferedWake,
            bufferedScheduledTaskRunId: settled.bufferedScheduledTaskRunId,
          };
        }
        const connection = await getConnectionMetadata(
          db,
          input.workspaceId,
          action.connection.connectionId,
          action.initiatingSubjectId,
        );
        if (
          !connection ||
          connection.accountId !== input.accountId ||
          connection.subjectId !== action.connection.ownerSubjectId ||
          connection.providerDomain.toLowerCase() !==
            action.connection.providerDomain.toLowerCase() ||
          connection.kind !== action.connection.kind ||
          connection.version < action.connection.connectionVersion ||
          connection.status !== "active"
        ) {
          throw new SyncFailure("connection_reconnect_required", true, true);
        }
        if (connection.providerDomain !== GOOGLE_DRIVE_PROVIDER_DOMAIN) {
          throw new SyncFailure("provider_rejected", false);
        }
        const metadata = GoogleDriveConnectionMetadata.parse(connection.metadata);
        if (metadata.lifecycle?.state && metadata.lifecycle.state !== "active") {
          throw new SyncFailure("connection_reconnect_required", true, true);
        }
        const selectedSource = selectedDriveSource(metadata, resolved.source.externalSourceId);
        if (!selectedSource || !selectedSource.syncEnabled) {
          throw new SyncFailure("authority_changed", false);
        }
        if (selectedSource.configGeneration !== action.sourceConfigGeneration) {
          throw new SyncFailure("authority_changed", false);
        }
        if (
          !selectedSource.destination ||
          JSON.stringify(googleDriveKnowledgeScope(selectedSource.destination)) !==
            JSON.stringify(action.destination)
        ) {
          throw new SyncFailure("authority_changed", false);
        }

        const token = await buildConnectionTokenResolver(
          db,
          settings,
        )({
          workspaceId: input.workspaceId,
          subjectId: action.initiatingSubjectId,
          serverId: "knowledge-source-sync",
          connectionRef: {
            connectionId: connection.id,
            providerDomain: connection.providerDomain,
            kind: connection.kind,
            subjectScope: "subject",
          },
          destinationUrl: "https://www.googleapis.com",
        });
        if (token.status !== "ok") {
          throw new SyncFailure("connection_reconnect_required", true, true);
        }

        let aclGeneration = resolved.source.currentAclGeneration;
        let acl = aclGeneration
          ? await getKnowledgeSourceAclForSyncAuthority(db, {
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              sourceId: input.sourceId,
              generation: aclGeneration,
              initiatingSubjectId: action.initiatingSubjectId,
            })
          : null;
        const actor = {
          kind: "service" as const,
          subjectId: "knowledge-source-sync",
          initiatingHumanSubjectId: action.initiatingSubjectId,
        };
        if (!acl) {
          acl = await appendKnowledgeSourceAclVersion(db, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sourceId: input.sourceId,
            audience: action.destination,
            expectedSourceLifecycleGeneration: resolved.source.lifecycleGeneration,
            expectedAclGeneration: 0,
            aclVersion: "opengeni-destination-v1",
            agentAccess: false,
            operationId: `source-initial-acl:${input.sourceId}`,
            reasonCode: "initial_destination_acl",
            actor,
          });
          aclGeneration = acl.generation;
        }

        const knowledgeRun =
          replayedRun ??
          (await beginKnowledgeSyncRun(db, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sourceId: input.sourceId,
            expectedSourceLifecycleGeneration: resolved.source.lifecycleGeneration,
            expectedSyncGeneration: resolved.source.syncGeneration,
            inputCursor: null,
            operationId: syncOperationId,
            actor,
          }));
        knowledgeRunId = knowledgeRun.id;

        const driver = googleDriveSyncDriver({
          actionProviderCoordinationKey: action.providerCoordinationKey,
          metadata,
          selectedSource,
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          initiatingSubjectId: action.initiatingSubjectId,
          authorization: token.headers.Authorization ?? token.headers.authorization,
          limits: action.limits,
        });
        const inventory = await driver.inventory(lease.state.executionCheckpoint);
        summary.providerRequests = inventory.providerRequests;
        summary.elapsedMs = inventory.elapsedMs;

        const base = selectedSource.destination.collectionId
          ? await getDocumentBase(db, input.workspaceId, selectedSource.destination.collectionId)
          : await ensureDefaultBase(db, {
              accountId: input.accountId,
              workspaceId: input.workspaceId,
            });
        if (!base) throw new SyncFailure("authority_changed", false);

        await recordKnowledgeSourceSyncObjectObservations(db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sourceId: input.sourceId,
          scheduledTaskRunId: input.scheduledTaskRunId,
          scanGeneration: liveState.activeScanGeneration,
          observations: inventory.entries.map((entry) => ({
            externalObjectId: entry.externalObjectId,
            providerRevision: entry.externalVersionId,
            metadataHash: entryMetadataHash(entry),
          })),
        });

        const ensureVersionIndexed = async (details: {
          entry: GoogleDriveInventoryEntry;
          object: {
            id: string;
            lifecycleGeneration: number;
          };
          version: {
            id: string;
            versionGeneration: number;
            documentId: string | null;
          };
          indexRequired: boolean;
          obligation?: Awaited<ReturnType<typeof getKnowledgeSourceSyncIndexObligationForVersion>>;
        }) => {
          if (!details.version.documentId) {
            throw new SyncFailure("authority_changed", false);
          }
          let obligation =
            details.obligation ??
            (await getKnowledgeSourceSyncIndexObligationForVersion(db, {
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              knowledgeDocumentVersionId: details.version.id,
              initiatingSubjectId: action.initiatingSubjectId,
            }));
          if (!obligation) {
            obligation = await enqueueKnowledgeSourceSyncIndexObligation(db, {
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              scheduledTaskRunId: input.scheduledTaskRunId,
              sourceId: input.sourceId,
              sourceSyncGeneration: knowledgeRun.inputSyncGeneration,
              initiatingSubjectId: action.initiatingSubjectId,
              externalObjectId: details.entry.externalObjectId,
              knowledgeSourceObjectId: details.object.id,
              knowledgeDocumentVersionId: details.version.id,
              documentId: details.version.documentId,
              sourceConfigGeneration: action.sourceConfigGeneration,
              sourceLifecycleGeneration: action.sourceLifecycleGeneration,
              objectLifecycleGeneration: details.object.lifecycleGeneration,
              objectVersionGeneration: details.version.versionGeneration,
              citationLocator: driver.citationLocator(details.entry),
            });
          }
          if (obligation.documentId !== details.version.documentId) {
            throw new SyncFailure("authority_changed", false);
          }
          if (obligation.status === "indexed") return obligation;
          if (obligation.status === "failed") {
            const retried = await retryKnowledgeSourceSyncIndexObligation(db, {
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              obligationId: obligation.id,
              scheduledTaskRunId: input.scheduledTaskRunId,
            });
            if (retried === "invalidated") {
              throw new SyncFailure("authority_changed", false);
            }
            obligation = { ...obligation, status: retried };
            if (retried === "indexed") return obligation;
          }
          if (obligation.status !== "pending") {
            throw new SyncFailure("authority_changed", false);
          }
          if (details.indexRequired) {
            summary.phase = "index";
            try {
              await documentActivities.indexDocument({
                accountId: input.accountId,
                workspaceId: input.workspaceId,
                documentId: details.version.documentId,
                authorityKind: action.destination.kind,
                authorityWorkspaceId: action.destination.workspaceId,
                authoritySubjectId: action.destination.subjectId,
              });
            } catch {
              await settleKnowledgeSourceSyncIndexObligation(db, {
                accountId: input.accountId,
                workspaceId: input.workspaceId,
                obligationId: obligation.id,
                status: "failed",
                failureCode: "indexing_failed",
              }).catch(() => undefined);
              throw new SyncFailure("indexing_failed", true);
            }
          }
          const settlement = await settleKnowledgeSourceSyncIndexObligation(db, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            obligationId: obligation.id,
            status: "indexed",
          });
          if (settlement === "invalidated") {
            throw new SyncFailure("authority_changed", false);
          }
          return { ...obligation, status: "indexed" };
        };

        const outcomes = [];
        for (const entry of inventory.entries) {
          heartbeat({ sourceId: input.sourceId, externalObjectId: entry.externalObjectId });
          summary.scanned += 1;
          if (entry.transfer.action === "skip") {
            summary.skipped += 1;
            outcomes.push({
              externalObjectId: entry.externalObjectId,
              outcome: "skipped" as const,
              reasonCode: entry.transfer.reason,
            });
            continue;
          }
          if (entry.transfer.action === "traverse") continue;
          try {
            const existingObject = await getKnowledgeSourceObjectForSyncAuthority(db, {
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              sourceId: input.sourceId,
              externalObjectId: entry.externalObjectId,
              initiatingSubjectId: action.initiatingSubjectId,
            });
            let object =
              existingObject ??
              (await upsertKnowledgeSourceObject(db, {
                accountId: input.accountId,
                workspaceId: input.workspaceId,
                sourceId: input.sourceId,
                externalObjectId: entry.externalObjectId,
                operationId: `source-object:${input.sourceId}:${entry.externalObjectId}`,
                actor,
              }));
            if (object.lifecycleState !== "active") {
              const restored = await restoreKnowledgeSourceObject(db, {
                accountId: input.accountId,
                workspaceId: input.workspaceId,
                targetId: object.id,
                expectedGeneration: object.lifecycleGeneration,
                operationId: `knowledge-sync-object-restore:${object.id}:${liveState.activeScanGeneration}`,
                reasonCode: "authoritative_scan_observed",
                actor,
              });
              object = {
                ...object,
                lifecycleState: "active",
                lifecycleGeneration: restored.lifecycleGeneration,
              };
            }
            const currentObservation = object.currentVersionId
              ? await getKnowledgeDocumentVersionObservationForSyncAuthority(db, {
                  accountId: input.accountId,
                  workspaceId: input.workspaceId,
                  versionId: object.currentVersionId,
                  initiatingSubjectId: action.initiatingSubjectId,
                })
              : null;
            const currentVersion = currentObservation?.version ?? null;
            const metadataHash = entryMetadataHash(entry);
            const observedProviderRevision =
              typeof currentObservation?.sourceMetadata.providerRevision === "string"
                ? currentObservation.sourceMetadata.providerRevision
                : null;
            const observedMetadataHash =
              typeof currentObservation?.sourceMetadata.metadataHash === "string"
                ? currentObservation.sourceMetadata.metadataHash
                : null;
            const observedSourceLifecycleGeneration = Number(
              currentObservation?.sourceMetadata.sourceLifecycleGeneration ?? 0,
            );
            const observedObjectLifecycleGeneration = Number(
              currentObservation?.sourceMetadata.objectLifecycleGeneration ?? 0,
            );
            const currentObligation = currentVersion
              ? await getKnowledgeSourceSyncIndexObligationForVersion(db, {
                  accountId: input.accountId,
                  workspaceId: input.workspaceId,
                  knowledgeDocumentVersionId: currentVersion.id,
                  initiatingSubjectId: action.initiatingSubjectId,
                })
              : null;
            if (
              currentVersion &&
              currentVersion.documentId &&
              observedProviderRevision === entry.externalVersionId &&
              observedMetadataHash === metadataHash &&
              currentVersion.aclGeneration === aclGeneration &&
              observedSourceLifecycleGeneration === resolved.source.lifecycleGeneration &&
              observedObjectLifecycleGeneration === object.lifecycleGeneration &&
              currentObligation?.status !== "invalidated"
            ) {
              await updateKnowledgeSourceDocumentObservationMetadata(db, {
                accountId: input.accountId,
                workspaceId: input.workspaceId,
                initiatingSubjectId: action.initiatingSubjectId,
                sourceId: input.sourceId,
                expectedSourceLifecycleGeneration: resolved.source.lifecycleGeneration,
                objectId: object.id,
                expectedObjectLifecycleGeneration: object.lifecycleGeneration,
                versionId: currentVersion.id,
                documentId: currentVersion.documentId,
                title: entry.title,
                sourceUri: entry.sourceUri,
                sourceVersion: entry.externalVersionId ?? currentVersion.contentSha256,
                sourceUpdatedAt: entry.modifiedTime,
              });
              const obligation = await ensureVersionIndexed({
                entry,
                object,
                version: currentVersion,
                indexRequired: true,
                obligation: currentObligation,
              });
              summary.unchanged += 1;
              outcomes.push({
                externalObjectId: entry.externalObjectId,
                outcome: "unchanged" as const,
                contentSha256: currentVersion.contentSha256,
                providerRevision: entry.externalVersionId,
                metadataHash,
                aclEligibility: "pending" as const,
                indexObligationId: obligation.id,
              });
              continue;
            }
            summary.phase = "transfer";
            const bytes = await driver.fetchContent(entry, action.limits.maxFileBytes);
            const contentSha256 = createHash("sha256").update(bytes).digest("hex");
            const observationKey = createHash("sha256")
              .update(
                JSON.stringify({
                  externalObjectId: entry.externalObjectId,
                  providerRevision: entry.externalVersionId,
                  metadataHash,
                  contentSha256,
                  aclGeneration,
                  sourceLifecycleGeneration: resolved.source.lifecycleGeneration,
                  objectLifecycleGeneration: object.lifecycleGeneration,
                }),
              )
              .digest("hex");
            if (
              currentVersion?.contentSha256 === contentSha256 &&
              currentVersion.documentId &&
              currentVersion.fileId
            ) {
              const version = await appendKnowledgeDocumentVersion(db, {
                accountId: input.accountId,
                workspaceId: input.workspaceId,
                objectId: object.id,
                expectedSourceLifecycleGeneration: resolved.source.lifecycleGeneration,
                expectedObjectLifecycleGeneration: object.lifecycleGeneration,
                expectedVersionGeneration: object.versionGeneration,
                externalVersionId: entry.externalVersionId ?? contentSha256,
                contentSha256,
                ingestionKey: `${entry.externalObjectId}:${observationKey}`,
                sourceCursor: null,
                sourceMetadata: {
                  title: entry.title,
                  mimeType: entry.mimeType,
                  driveId: entry.driveId,
                  providerRevision: entry.externalVersionId,
                  metadataHash,
                  aclEligibility: "pending",
                  sourceLifecycleGeneration: resolved.source.lifecycleGeneration,
                  objectLifecycleGeneration: object.lifecycleGeneration,
                },
                sourceCreatedAt: entry.createdTime,
                sourceUpdatedAt: entry.modifiedTime,
                aclVersionId: acl.id,
                aclGeneration: aclGeneration!,
                documentId: currentVersion.documentId,
                fileId: currentVersion.fileId,
                locationMetadata: { sourceUri: entry.sourceUri },
                documentObservationMetadata: {
                  title: entry.title,
                  sourceUri: entry.sourceUri,
                  sourceVersion: entry.externalVersionId ?? contentSha256,
                  sourceUpdatedAt: entry.modifiedTime,
                },
                operationId: `document-observation:${object.id}:${observationKey}`,
                reasonCode: "source_metadata_observed",
                actor,
              });
              await updateKnowledgeSourceDocumentObservationMetadata(db, {
                accountId: input.accountId,
                workspaceId: input.workspaceId,
                initiatingSubjectId: action.initiatingSubjectId,
                sourceId: input.sourceId,
                expectedSourceLifecycleGeneration: resolved.source.lifecycleGeneration,
                objectId: object.id,
                expectedObjectLifecycleGeneration: object.lifecycleGeneration,
                versionId: version.id,
                documentId: currentVersion.documentId,
                title: entry.title,
                sourceUri: entry.sourceUri,
                sourceVersion: entry.externalVersionId ?? contentSha256,
                sourceUpdatedAt: entry.modifiedTime,
              });
              const obligation = await ensureVersionIndexed({
                entry,
                object,
                version,
                indexRequired: (currentObservation?.documentChunkCount ?? 0) === 0,
              });
              summary.unchanged += 1;
              summary.indexed += 1;
              summary.aclPending += 1;
              outcomes.push({
                externalObjectId: entry.externalObjectId,
                outcome: "unchanged" as const,
                contentSha256,
                sizeBytes: bytes.byteLength,
                providerRevision: entry.externalVersionId,
                metadataHash,
                aclEligibility: "pending" as const,
                indexObligationId: obligation.id,
              });
              continue;
            }
            const fileId = deterministicUuid(
              `knowledge-blob:${input.accountId}:${input.workspaceId}:${contentSha256}`,
            );
            const objectKey = `workspaces/${input.workspaceId}/knowledge/blobs/${contentSha256}`;
            await objectStorage.putObject({
              key: objectKey,
              contentType: entry.transfer.contentType,
              body: bytes,
              sha256: contentSha256,
            });
            const file = await ensureKnowledgeSourceBlobFile(db, {
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              fileId,
              filename: entry.transfer.filename,
              safeFilename: safeFilename(entry.transfer.filename),
              contentType: entry.transfer.contentType,
              sizeBytes: bytes.byteLength,
              sha256: contentSha256,
              bucket: objectStorage.bucket,
              objectKey,
            });
            const document = await addDocumentToBase(db, {
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              baseId: base.id,
              fileId: file.id,
              title: entry.title,
              sourceKind: "document",
              sourceUri: entry.sourceUri,
              sourceExternalId: entry.externalObjectId,
              sourceTitle: entry.title,
              sourceCreatedAt: entry.createdTime ?? undefined,
              sourceUpdatedAt: entry.modifiedTime ?? undefined,
              sourceVersion: entry.externalVersionId ?? contentSha256,
              knowledgeSourceIdentity: deterministicUuid(
                `knowledge-source-version:${object.id}:${observationKey}`,
              ),
              authorityKind: action.destination.kind,
              createdBy: action.initiatingSubjectId,
              initiatingSubjectId: action.initiatingSubjectId,
              organizationAuthorityGranted: action.destination.kind === "organization",
              agentAccess: false,
              curationStatus: "none",
              access: { viewerSubjectId: action.initiatingSubjectId },
            });
            const version = await appendKnowledgeDocumentVersion(db, {
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              objectId: object.id,
              expectedSourceLifecycleGeneration: resolved.source.lifecycleGeneration,
              expectedObjectLifecycleGeneration: object.lifecycleGeneration,
              expectedVersionGeneration: object.versionGeneration,
              externalVersionId: entry.externalVersionId ?? contentSha256,
              contentSha256,
              ingestionKey: `${entry.externalObjectId}:${observationKey}`,
              sourceCursor: null,
              sourceMetadata: {
                title: entry.title,
                mimeType: entry.mimeType,
                driveId: entry.driveId,
                providerRevision: entry.externalVersionId,
                metadataHash,
                aclEligibility: "pending",
                sourceLifecycleGeneration: resolved.source.lifecycleGeneration,
                objectLifecycleGeneration: object.lifecycleGeneration,
              },
              sourceCreatedAt: entry.createdTime,
              sourceUpdatedAt: entry.modifiedTime,
              aclVersionId: acl.id,
              aclGeneration: aclGeneration!,
              documentId: document.id,
              fileId: file.id,
              locationMetadata: { sourceUri: entry.sourceUri },
              operationId: `document-version:${object.id}:${observationKey}`,
              reasonCode: "source_content_observed",
              actor,
            });
            const obligation = await ensureVersionIndexed({
              entry,
              object,
              version,
              indexRequired: true,
            });
            summary.indexed += 1;
            summary.imported += 1;
            summary.aclPending += 1;
            summary.bytes += bytes.byteLength;
            outcomes.push({
              externalObjectId: entry.externalObjectId,
              outcome: "imported" as const,
              contentSha256,
              sizeBytes: bytes.byteLength,
              providerRevision: entry.externalVersionId,
              metadataHash,
              aclEligibility: "pending" as const,
              indexObligationId: obligation.id,
            });
          } catch (error) {
            const message = boundedError(error);
            const itemFailure =
              error instanceof SyncFailure
                ? error
                : new SyncFailure("item_processing_failed", false);
            summary.failed += 1;
            summary.retryable ||= itemFailure.retryable;
            if (summary.failures.length < action.limits.maxFailureDetails) {
              summary.failures.push({
                externalObjectId: entry.externalObjectId,
                code: itemFailure.code,
                retryable: itemFailure.retryable,
                message,
              });
            }
            outcomes.push({
              externalObjectId: entry.externalObjectId,
              outcome: "failed" as const,
              reasonCode: itemFailure.code,
              detail: message,
              providerRevision: entry.externalVersionId,
              metadataHash: entryMetadataHash(entry),
              aclEligibility: "pending" as const,
            });
          }
        }
        await recordKnowledgeSourceSyncItemOutcomes(db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          scheduledTaskRunId: input.scheduledTaskRunId,
          knowledgeSyncRunId: knowledgeRun.id,
          sourceId: input.sourceId,
          sourceConfigGeneration: action.sourceConfigGeneration,
          sourceLifecycleGeneration: action.sourceLifecycleGeneration,
          outcomes,
        });

        if (inventory.status === "paused" && inventory.checkpoint) {
          if (
            inventory.stopReason === "provider_error" ||
            inventory.stopReason === "incomplete_search"
          ) {
            throw new SyncFailure(
              inventory.stopReason === "provider_error"
                ? "provider_unavailable"
                : "provider_payload_invalid",
              inventory.stopReason === "provider_error",
            );
          }
          if (inventory.stopReason !== "elapsed_time_limit") {
            summary.limitReached = inventoryLimit(inventory.stopReason);
            throw new SyncFailure("resource_limit", false);
          }
          summary.checkpointed = true;
          summary.phase = "checkpoint";
          await checkpointKnowledgeSourceSync(db, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sourceId: input.sourceId,
            scheduledTaskRunId: input.scheduledTaskRunId,
            sourceConfigGeneration: action.sourceConfigGeneration,
            sourceLifecycleGeneration: action.sourceLifecycleGeneration,
            executionCheckpoint: inventory.checkpoint as unknown as Record<string, unknown>,
          });
          return { action: "continue" };
        }

        const tombstonedExternalObjectIds = await reconcileKnowledgeSourceSyncCompleteScan(db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sourceId: input.sourceId,
          scheduledTaskRunId: input.scheduledTaskRunId,
          initiatingSubjectId: action.initiatingSubjectId,
          sourceSyncGeneration: knowledgeRun.inputSyncGeneration,
          sourceConfigGeneration: action.sourceConfigGeneration,
          sourceLifecycleGeneration: action.sourceLifecycleGeneration,
          scanGeneration: liveState.activeScanGeneration,
        });
        if (tombstonedExternalObjectIds.length > 0) {
          summary.skipped += tombstonedExternalObjectIds.length;
          await recordKnowledgeSourceSyncItemOutcomes(db, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            scheduledTaskRunId: input.scheduledTaskRunId,
            knowledgeSyncRunId: knowledgeRun.id,
            sourceId: input.sourceId,
            sourceConfigGeneration: action.sourceConfigGeneration,
            sourceLifecycleGeneration: action.sourceLifecycleGeneration,
            outcomes: tombstonedExternalObjectIds.map((externalObjectId) => ({
              externalObjectId,
              outcome: "tombstoned" as const,
              reasonCode: "authoritative_scan_absent",
              aclEligibility: "denied" as const,
            })),
          });
        }

        await completeKnowledgeSyncRun(db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          initiatingSubjectId: action.initiatingSubjectId,
          runId: knowledgeRun.id,
          state: "succeeded",
          outputCursor: null,
          watermark: new Date().toISOString(),
          metadata: summary,
          reasonCode: "scheduled_source_sync",
        });
        summary.phase = "completed";
        summary.elapsedMs = Date.now() - startedAt;
        const settled = await settleKnowledgeSourceSyncLease(db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sourceId: input.sourceId,
          scheduledTaskRunId: input.scheduledTaskRunId,
          knowledgeSyncRunId: knowledgeRun.id,
          status: "succeeded",
          summary,
          sourceConfigGeneration: action.sourceConfigGeneration,
          sourceLifecycleGeneration: action.sourceLifecycleGeneration,
          sourceSyncGeneration: knowledgeRun.inputSyncGeneration,
          completedSourceSyncGeneration: knowledgeRun.inputSyncGeneration + 1,
        });
        await recordConnectorUsage("completed", summary.scanned, "item");
        await recordConnectorUsage("items", summary.imported, "item");
        await recordConnectorUsage("bytes", summary.bytes, "byte");
        observability.incrementCounter({
          name: "opengeni_knowledge_source_sync_runs_total",
          labels: { provider: "google_drive", outcome: "succeeded" },
        });
        observability.incrementCounter({
          name: "opengeni_knowledge_source_sync_items_total",
          labels: { provider: "google_drive", outcome: "imported" },
          amount: summary.imported,
        });
        for (const outcome of ["unchanged", "skipped", "failed"] as const) {
          observability.incrementCounter({
            name: "opengeni_knowledge_source_sync_items_total",
            labels: { provider: "google_drive", outcome },
            amount: summary[outcome],
          });
        }
        observability.incrementCounter({
          name: "opengeni_knowledge_source_sync_bytes_total",
          labels: { provider: "google_drive" },
          amount: summary.bytes,
        });
        return {
          action: "complete",
          bufferedWake: settled.bufferedWake,
          bufferedScheduledTaskRunId: settled.bufferedScheduledTaskRunId,
        };
      } catch (error) {
        const failure =
          error instanceof SyncFailure ? error : new SyncFailure("internal_failure", false);
        summary.phase = "failed";
        summary.retryable ||= failure.retryable;
        summary.elapsedMs = Date.now() - startedAt;
        summary.reconnectRequired = failure.reconnectRequired;
        summary.failed = Math.max(summary.failed, 1);
        if (summary.failures.length === 0) {
          summary.failures.push({
            externalObjectId: input.sourceId,
            code: failure.code,
            retryable: failure.retryable,
            message: boundedError(error),
          });
        }
        if (knowledgeRunId) {
          await completeKnowledgeSyncRun(db, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            initiatingSubjectId: task.action.initiatingSubjectId,
            runId: knowledgeRunId,
            state: "failed",
            metadata: summary,
            errorCode: failure.code,
            reasonCode: "scheduled_source_sync_failed",
          }).catch(() => undefined);
        }
        const settlementInput: Parameters<typeof settleKnowledgeSourceSyncLease>[1] = {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sourceId: input.sourceId,
          scheduledTaskRunId: input.scheduledTaskRunId,
          knowledgeSyncRunId: knowledgeRunId,
          status: "failed",
          summary,
          error: failure.code,
          sourceConfigGeneration: action.sourceConfigGeneration,
          sourceLifecycleGeneration: action.sourceLifecycleGeneration,
          sourceSyncGeneration: activeSourceSyncGeneration ?? lease.state.sourceSyncGeneration,
          // Failed or incomplete provider walks are not authoritative scans.
          // A later scheduled run must restart from the root under a fresh
          // observation generation before it can infer object absence.
          executionCheckpoint: null,
        };
        const settled = failure.reconnectRequired
          ? await deauthorizeAndSettleKnowledgeSourceSyncFailure(db, {
              deauthorization: {
                accountId: input.accountId,
                workspaceId: input.workspaceId,
                sourceId: input.sourceId,
                audience: action.destination,
                operationId: `knowledge-sync-deauthorize:${input.sourceId}:${action.connection.connectionVersion}:${failure.code}`,
                reasonCode: "connection_reconnect_required",
                actor: {
                  kind: "service",
                  subjectId: "knowledge-source-sync",
                  initiatingHumanSubjectId: action.initiatingSubjectId,
                },
              },
              settlement: settlementInput,
            })
          : await settleKnowledgeSourceSyncLease(db, settlementInput);
        await recordConnectorUsage("completed", summary.scanned, "item");
        await recordConnectorUsage("items", summary.imported, "item");
        await recordConnectorUsage("bytes", summary.bytes, "byte");
        observability.incrementCounter({
          name: "opengeni_knowledge_source_sync_runs_total",
          labels: { provider: "google_drive", outcome: "failed" },
        });
        for (const outcome of ["imported", "unchanged", "skipped", "failed"] as const) {
          observability.incrementCounter({
            name: "opengeni_knowledge_source_sync_items_total",
            labels: { provider: "google_drive", outcome },
            amount: summary[outcome],
          });
        }
        observability.incrementCounter({
          name: "opengeni_knowledge_source_sync_bytes_total",
          labels: { provider: "google_drive" },
          amount: summary.bytes,
        });
        return {
          action: "failed",
          bufferedWake: settled.bufferedWake,
          bufferedScheduledTaskRunId: settled.bufferedScheduledTaskRunId,
        };
      }

      async function failWithoutProvider(code: string): Promise<RunKnowledgeSourceSyncBatchResult> {
        const terminalSummary = {
          phase: "failed" as const,
          scanned: 0,
          imported: 0,
          unchanged: 0,
          skipped: 0,
          failed: 1,
          bytes: 0,
          providerRequests: 0,
          elapsedMs: 0,
          indexed: 0,
          aclPending: 0,
          retryable: false,
          limitReached: null,
          checkpointed: false,
          reconnectRequired: false,
          failures: [
            {
              externalObjectId: input.sourceId,
              code: "authority_changed" as const,
              retryable: false,
              message: code,
            },
          ],
        };
        await updateScheduledTaskRun(db, input.workspaceId, input.scheduledTaskRunId, {
          status: "failed",
          actionKind: "knowledge_source_sync",
          knowledgeSummary: terminalSummary,
          completedAt: new Date(),
          error: code,
        }).catch(() => undefined);
        await completeKnowledgeSourceSyncWakeWithoutLease(db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sourceId: input.sourceId,
          scheduledTaskRunId: input.scheduledTaskRunId,
        }).catch(() => undefined);
        await recordConnectorUsage("completed", 0, "item").catch(() => undefined);
        observability.incrementCounter({
          name: "opengeni_knowledge_source_sync_runs_total",
          labels: { provider: "unknown", outcome: "failed_preflight" },
        });
        return { action: "failed", bufferedWake: false };
      }

      async function recordConnectorUsage(
        kind: "completed" | "items" | "bytes",
        quantity: number,
        unit: string,
      ) {
        if (quantity === 0 && kind !== "completed") return;
        await recordUsageEvent(db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          eventType: `knowledge_source_sync.${kind}`,
          quantity: kind === "completed" ? 1 : quantity,
          unit,
          sourceResourceType: "scheduled_task_run",
          sourceResourceId: input.scheduledTaskRunId,
          initiator: { kind: "service", subjectId: "knowledge-source-sync" },
          initiatorContext: {
            scheduledTaskId: input.taskId,
            scheduledTaskRunId: input.scheduledTaskRunId,
          },
          origin: "scheduled_task",
          idempotencyKey: `usage:knowledge_source_sync.${kind}:${input.scheduledTaskRunId}`,
        });
      }
    },
  };
}

/**
 * Permission loss must fail closed, while the exact source lease must never be
 * stranded by a deauthorization error. If deauthorization fails, release the
 * lease without settling the wake/run and surface the error so Temporal retries
 * this DB-only safety obligation. Terminal settlement is allowed only after
 * deauthorization succeeds.
 */
export async function deauthorizeAndSettleKnowledgeSourceSyncFailure(
  db: Database,
  input: {
    deauthorization: Parameters<typeof deauthorizeKnowledgeSourceRetrieval>[1];
    settlement: Parameters<typeof settleKnowledgeSourceSyncLease>[1];
  },
): Promise<Awaited<ReturnType<typeof settleKnowledgeSourceSyncLease>>> {
  try {
    await deauthorizeKnowledgeSourceRetrieval(db, input.deauthorization);
  } catch (error) {
    await releaseKnowledgeSourceSyncLeaseForRetry(db, {
      accountId: input.settlement.accountId,
      workspaceId: input.settlement.workspaceId,
      sourceId: input.settlement.sourceId,
      scheduledTaskRunId: input.settlement.scheduledTaskRunId,
    });
    throw error;
  }
  return await settleKnowledgeSourceSyncLease(db, input.settlement);
}

function googleDriveSyncDriver(input: {
  actionProviderCoordinationKey: string;
  metadata: ReturnType<typeof GoogleDriveConnectionMetadata.parse>;
  selectedSource: GoogleDriveSelectedSource;
  accountId: string;
  workspaceId: string;
  initiatingSubjectId: string;
  authorization: string | undefined;
  limits: {
    maxItems: number;
    maxBytes: number;
    maxFileBytes: number;
    maxProviderRequests: number;
    maxElapsedSeconds: number;
  };
}): KnowledgeSourceSyncDriver<GoogleDriveInventoryEntry, GoogleDriveInventoryStopReason> {
  return {
    providerKey: "google_drive",
    providerDomain: GOOGLE_DRIVE_PROVIDER_DOMAIN,
    providerCoordinationKey: input.actionProviderCoordinationKey,
    inventory: async (executionCheckpoint) => {
      const inventory = await inventoryGoogleDriveSource({
        googlePermissionId: input.metadata.googlePermissionId,
        googleEmail: input.metadata.googleEmail,
        source: input.selectedSource,
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        connectionSubjectId: input.initiatingSubjectId,
        limits: {
          maxItems: input.limits.maxItems,
          maxKnownBytes: input.limits.maxBytes,
          maxApiRequests: input.limits.maxProviderRequests,
          maxElapsedMs: input.limits.maxElapsedSeconds * 1_000,
          maxFileBytes: input.limits.maxFileBytes,
          maxFolders: Math.min(input.limits.maxItems * 2, 2_000),
          pageSize: Math.min(input.limits.maxItems, 100),
        },
        checkpoint: executionCheckpoint as never,
        listChildren: async (request) => await listDriveChildren(request, input.authorization),
      });
      return {
        status: inventory.status,
        stopReason: inventory.stopReason,
        entries: inventory.entries,
        checkpoint: inventory.checkpoint as Record<string, unknown> | null,
        providerRequests: inventory.run.apiRequestCount,
        elapsedMs: inventory.run.elapsedMs,
      };
    },
    fetchContent: async (entry, maxBytes) =>
      await fetchDriveBytes(entry, input.authorization, maxBytes),
    citationLocator: (entry) => ({
      version: 1,
      providerKey: "google-drive",
      providerCoordinationKey: input.actionProviderCoordinationKey,
      externalObjectId: entry.externalObjectId,
      sourceUri: entry.sourceUri,
    }),
  };
}

function selectedDriveSource(
  metadata: ReturnType<typeof GoogleDriveConnectionMetadata.parse>,
  externalSourceId: string,
): GoogleDriveSelectedSource | null {
  const sources =
    metadata.selectedSources ?? (metadata.selectedSource ? [metadata.selectedSource] : []);
  return sources.find((source) => source.id === externalSourceId) ?? null;
}

async function listDriveChildren(
  input: { folderId: string; driveId: string | null; pageToken: string | null; pageSize: number },
  authorization: string | undefined,
): Promise<GoogleDriveInventoryPage> {
  if (!authorization) throw new SyncFailure("connection_reconnect_required", true, true);
  const url = new URL(`${DRIVE_API_BASE}/files`);
  url.searchParams.set(
    "q",
    `'${input.folderId.replaceAll("'", "\\'")}' in parents and trashed = false`,
  );
  url.searchParams.set("pageSize", String(input.pageSize));
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("includeItemsFromAllDrives", "true");
  url.searchParams.set(
    "fields",
    "nextPageToken,incompleteSearch,files(id,name,mimeType,driveId,parents,modifiedTime,createdTime,version,md5Checksum,size,webViewLink,trashed)",
  );
  if (input.pageToken) url.searchParams.set("pageToken", input.pageToken);
  if (input.driveId) {
    url.searchParams.set("corpora", "drive");
    url.searchParams.set("driveId", input.driveId);
  }
  const response = await fetch(url, {
    headers: { authorization, accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new SyncFailure("connection_reconnect_required", true, true);
    }
    throw new SyncFailure(
      "provider_unavailable",
      response.status >= 500 || response.status === 429,
    );
  }
  const payload = (await readResponseJsonBounded(
    response,
    DRIVE_JSON_MAX_BYTES,
    "Google Drive file list",
  )) as Record<string, unknown>;
  const rawFiles = Array.isArray(payload.files) ? payload.files : [];
  return {
    items: rawFiles.map(parseDriveProviderItem),
    nextPageToken: typeof payload.nextPageToken === "string" ? payload.nextPageToken : null,
    incompleteSearch: payload.incompleteSearch === true,
  };
}

function parseDriveProviderItem(value: unknown): GoogleDriveInventoryProviderItem {
  const row = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    id: requiredString(row.id, "id"),
    name: requiredString(row.name, "name"),
    mimeType: requiredString(row.mimeType, "mimeType"),
    driveId: optionalString(row.driveId),
    parents: Array.isArray(row.parents)
      ? row.parents.filter((item): item is string => typeof item === "string")
      : [],
    modifiedTime: optionalString(row.modifiedTime),
    createdTime: optionalString(row.createdTime),
    version: optionalString(row.version),
    md5Checksum: optionalString(row.md5Checksum),
    size: optionalString(row.size),
    webViewLink: optionalString(row.webViewLink),
    trashed: row.trashed === true,
  };
}

async function fetchDriveBytes(
  entry: GoogleDriveInventoryEntry,
  authorization: string | undefined,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!authorization) throw new SyncFailure("connection_reconnect_required", true, true);
  const url =
    entry.transfer.action === "export"
      ? new URL(`${DRIVE_API_BASE}/files/${encodeURIComponent(entry.externalObjectId)}/export`)
      : new URL(`${DRIVE_API_BASE}/files/${encodeURIComponent(entry.externalObjectId)}`);
  if (entry.transfer.action === "export") {
    url.searchParams.set("mimeType", entry.transfer.contentType);
  } else {
    url.searchParams.set("alt", "media");
    url.searchParams.set("supportsAllDrives", "true");
  }
  const response = await fetch(url, {
    headers: { authorization },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new SyncFailure("connection_reconnect_required", true, true);
    }
    throw new SyncFailure(
      "provider_unavailable",
      response.status >= 500 || response.status === 429,
    );
  }
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new SyncFailure("content_too_large", false);
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new SyncFailure("content_too_large", false);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new SyncFailure("content_too_large", false);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function deterministicUuid(value: string): string {
  const bytes = createHash("sha256").update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function safeFilename(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|\0-\x1f]/g, "_")
    .trim();
  return (normalized || "document").slice(0, 240);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`invalid_google_drive_${label}`);
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1000);
}

function entryMetadataHash(entry: GoogleDriveInventoryEntry): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        externalObjectId: entry.externalObjectId,
        externalVersionId: entry.externalVersionId,
        title: entry.title,
        mimeType: entry.mimeType,
        driveId: entry.driveId,
        modifiedTime: entry.modifiedTime,
        createdTime: entry.createdTime,
        sourceUri: entry.sourceUri,
      }),
    )
    .digest("hex");
}

function inventoryLimit(
  reason: "api_request_limit" | "elapsed_time_limit" | "item_limit" | "known_byte_limit" | null,
): KnowledgeSourceSyncRunSummary["limitReached"] {
  if (reason === "api_request_limit") return "provider_requests";
  if (reason === "elapsed_time_limit") return "elapsed_time";
  if (reason === "item_limit") return "items";
  if (reason === "known_byte_limit") return "bytes";
  return null;
}

type SyncFailureCode = KnowledgeSourceSyncRunSummary["failures"][number]["code"];

class SyncFailure extends Error {
  constructor(
    readonly code: SyncFailureCode,
    readonly retryable: boolean,
    readonly reconnectRequired = false,
  ) {
    super(code);
    this.name = "KnowledgeSourceSyncFailure";
  }
}
