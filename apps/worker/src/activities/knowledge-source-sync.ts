import { createHash } from "node:crypto";
import { heartbeat } from "@temporalio/activity";
import type { Settings } from "@opengeni/config";
import {
  KnowledgeSourceSyncRunSummary,
  type ScheduledTask,
  type ScopedKnowledgeScope,
} from "@opengeni/contracts";
import {
  ATLASSIAN_PROVIDER_DOMAIN,
  AtlassianConnectionMetadata,
  atlassianScopesAllowRead,
  type AtlassianSelectedSource,
} from "@opengeni/contracts/atlassian";
import {
  GoogleDriveConnectionMetadata,
  GOOGLE_DRIVE_PROVIDER_DOMAIN,
  googleDriveScopesAllowCapability,
  type GoogleDriveSelectedSource,
} from "@opengeni/contracts/google-drive";
import {
  googleDriveKnowledgeScope,
  inventoryGoogleDriveSource,
  type GoogleDriveInventoryEntry,
  type GoogleDriveInventoryCheckpoint,
  type GoogleDriveInventoryPage,
  type GoogleDriveInventoryProviderItem,
  type GoogleDriveInventoryStopReason,
} from "@opengeni/documents/google-drive";
import {
  atlassianKnowledgeScope,
  inventoryAtlassianSource,
  type AtlassianInventoryEntry,
  type AtlassianInventoryPage,
  type AtlassianInventoryStopReason,
} from "@opengeni/documents/atlassian";
import { addDocumentToBase, ensureDefaultBase, getDocumentBase } from "@opengeni/documents";
import {
  appendKnowledgeDocumentVersion,
  appendKnowledgeSourceAclVersion,
  beginKnowledgeSyncRun,
  beginGoogleDriveObjectAclRefresh,
  buildConnectionTokenResolver,
  checkpointKnowledgeSourceSync,
  claimKnowledgeSourceSyncLease,
  compareCanonicalDecimalProviderRevisions,
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
  listObservedKnowledgeSourceSyncExternalObjectIds,
  KnowledgeSourceSyncObservationFenceError,
  reconcileKnowledgeSourceSyncCompleteScan,
  reconcileKnowledgeSourceSyncLiveGeneration,
  recordGoogleDriveObjectAclEvidence,
  recordKnowledgeSourceSyncItemOutcomes,
  recordKnowledgeSourceSyncObjectObservations,
  recordUsageEvent,
  releaseKnowledgeSourceSyncLeaseForRetry,
  restoreKnowledgeSourceObject,
  retryKnowledgeSourceSyncIndexObligation,
  scopedKnowledgeScopeKey,
  settleKnowledgeSourceSyncLease,
  settleKnowledgeSourceSyncIndexObligation,
  updateKnowledgeSourceDocumentObservationMetadata,
  updateScheduledTaskRun,
  upsertKnowledgeSourceObject,
  type Database,
  type KnowledgeSourceSyncObjectObservationResult,
  type KnowledgeSourceSyncObservationFloor,
} from "@opengeni/db";
import { readResponseJsonBounded } from "@opengeni/network";
import { createDocumentActivities } from "./documents";
import type {
  ControlActivityServices,
  RunKnowledgeSourceSyncBatchInput,
  RunKnowledgeSourceSyncBatchResult,
} from "./types";
import type {
  KnowledgeSourceSyncAclEvidence,
  KnowledgeSourceSyncDriver,
} from "./knowledge-source-sync-driver";
import {
  advanceGoogleDriveChangesCursor,
  buildGoogleDriveChangesCursor,
  drainGoogleDriveChanges,
  GoogleDriveChangesProtocolError,
  GoogleDriveCursorInvalidError,
  googleDriveFullReconciliationDue,
  parseGoogleDriveChangesCheckpoint,
  parseGoogleDriveChangesCursor,
  resolveGoogleDriveChangesBoundaryId,
  type GoogleDriveChangesCheckpoint,
  type GoogleDriveChangesPage,
  type GoogleDriveSyncBudget,
} from "./google-drive-changes";

const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";
const DRIVE_JSON_MAX_BYTES = 2 * 1024 * 1024;
const GOOGLE_DRIVE_FULL_RECONCILIATION_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const GOOGLE_DRIVE_SYNC_INVOCATION_SLICE_MS = 30_000;
const GOOGLE_DRIVE_EXECUTION_CHECKPOINT_MAX_BYTES = 2 * 1024 * 1024;
const GOOGLE_DRIVE_ACL_FRESHNESS_MS = 26 * 60 * 60 * 1_000;
const GOOGLE_DRIVE_ACL_MAX_PRINCIPALS = 1_000;
const ATLASSIAN_API_BASE = "https://api.atlassian.com";
const ATLASSIAN_JSON_MAX_BYTES = 4 * 1024 * 1024;

type KnowledgeSyncEntry = GoogleDriveInventoryEntry | AtlassianInventoryEntry;
type KnowledgeSyncStopReason = GoogleDriveInventoryStopReason | AtlassianInventoryStopReason;

type GoogleDrivePermission = {
  id: string;
  type: "user" | "group" | "domain" | "anyone";
  role: "owner" | "organizer" | "fileOrganizer" | "writer" | "commenter" | "reader";
  emailAddress: string | null;
  domain: string | null;
  allowFileDiscovery: boolean | null;
  expirationTime: string | null;
  inherited: boolean;
};

type GoogleDrivePermissionsPage = {
  permissions: GoogleDrivePermission[];
  nextPageToken: string | null;
  denied: boolean;
};

export function knowledgeSyncObservationPolicy(kind: "google_drive" | "atlassian") {
  return kind === "google_drive"
    ? { revisionOrdering: "canonical_decimal" as const, filterWithDriveDurability: true }
    : { revisionOrdering: "first_observation" as const, filterWithDriveDurability: false };
}

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
      const providerLabel =
        action.connection.providerDomain === ATLASSIAN_PROVIDER_DOMAIN
          ? "atlassian"
          : "google_drive";
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
          labels: { provider: providerLabel, outcome: lease.action },
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
        if (
          scopedKnowledgeScopeKey(resolved.source.scope) !==
          scopedKnowledgeScopeKey(action.destination)
        ) {
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
            ...(replayedRun.state === "succeeded" &&
            replayedRun.metadata.providerCursor &&
            typeof replayedRun.metadata.providerCursor === "object"
              ? {
                  providerCursor: replayedRun.metadata.providerCursor as Record<string, unknown>,
                }
              : {}),
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
        const provider = await resolveKnowledgeSyncProvider({
          db,
          settings,
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          action,
          sourceId: input.sourceId,
          externalSourceId: resolved.source.externalSourceId,
        });
        const selectedDestination = provider.selectedDestination;
        const observationPolicy = knowledgeSyncObservationPolicy(provider.kind);

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

        const driver = provider.driver;
        const inventory = await driver.inventory(
          lease.state.executionCheckpoint,
          lease.state.providerCursor,
        );
        summary.providerRequests = inventory.providerRequests;
        summary.elapsedMs = inventory.elapsedMs;

        const base = selectedDestination.collectionId
          ? await getDocumentBase(db, input.workspaceId, selectedDestination.collectionId)
          : await ensureDefaultBase(db, {
              accountId: input.accountId,
              workspaceId: input.workspaceId,
            });
        if (!base) throw new SyncFailure("authority_changed", false);

        const durableObservations = await recordKnowledgeSourceSyncObjectObservations(db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sourceId: input.sourceId,
          scheduledTaskRunId: input.scheduledTaskRunId,
          initiatingSubjectId: action.initiatingSubjectId,
          scanGeneration: liveState.activeScanGeneration,
          executionCheckpointGeneration: lease.state.executionCheckpointGeneration,
          revisionOrdering: observationPolicy.revisionOrdering,
          observations: inventory.entries.map((entry) => ({
            externalObjectId: entry.externalObjectId,
            providerRevision: entry.externalVersionId,
            metadataHash: entryMetadataHash(entry),
          })),
        });
        const entriesToProcess = observationPolicy.filterWithDriveDurability
          ? inventory.entries.filter((entry, index) =>
              shouldProcessGoogleDriveDurableObservation({
                entry,
                observation: durableObservations[index]!,
                sourceLifecycleGeneration: resolved.source.lifecycleGeneration,
                aclGeneration: aclGeneration!,
              }),
            )
          : inventory.entries;
        const observationFloorsById = new Map<string, KnowledgeSourceSyncObservationFloor>();
        for (const observation of durableObservations) {
          observationFloorsById.set(observation.externalObjectId, {
            externalObjectId: observation.externalObjectId,
            providerRevision: observation.providerRevision,
            metadataHash: observation.metadataHash,
          });
        }
        const observationFloors = [...observationFloorsById.values()];
        const executionCheckpoint = mergeGoogleDriveDurableObservationFloors(
          inventory.checkpoint,
          observationFloors,
          action.limits.maxItems,
        );

        const ensureVersionIndexed = async (details: {
          entry: KnowledgeSyncEntry;
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
          if (obligation.status === "indexed" && !details.indexRequired) return obligation;
          if (obligation.status === "indexed" && details.indexRequired) {
            summary.phase = "index";
            try {
              const indexedDocument = await documentActivities.indexDocument({
                accountId: input.accountId,
                workspaceId: input.workspaceId,
                documentId: details.version.documentId,
                authorityKind: action.destination.kind,
                authorityWorkspaceId: action.destination.workspaceId,
                authoritySubjectId: action.destination.subjectId,
              });
              if (indexedDocument.status !== "ready") {
                throw new Error("document indexing did not complete");
              }
            } catch {
              throw new SyncFailure("indexing_failed", true);
            }
            return obligation;
          }
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
              const indexedDocument = await documentActivities.indexDocument({
                accountId: input.accountId,
                workspaceId: input.workspaceId,
                documentId: details.version.documentId,
                authorityKind: action.destination.kind,
                authorityWorkspaceId: action.destination.workspaceId,
                authoritySubjectId: action.destination.subjectId,
              });
              if (indexedDocument.status !== "ready") {
                throw new Error("document indexing did not complete");
              }
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

        const recordEntryAcl = async (details: {
          entry: KnowledgeSyncEntry;
          object: { id: string; lifecycleGeneration: number };
          version: { id: string; versionGeneration: number };
          obligation: { id: string; sourceSyncGeneration: number };
        }): Promise<{
          aclEligibility: "pending" | "eligible" | "denied";
          aclEvidence: Record<string, unknown> | null;
        }> => {
          if (!driver.readAcl || !provider.aclAuthority) {
            return { aclEligibility: "pending", aclEvidence: null };
          }
          await beginGoogleDriveObjectAclRefresh(db, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            obligationId: details.obligation.id,
            sourceSyncGeneration: details.obligation.sourceSyncGeneration,
            sourceConfigGeneration: action.sourceConfigGeneration,
            sourceLifecycleGeneration: action.sourceLifecycleGeneration,
            objectLifecycleGeneration: details.object.lifecycleGeneration,
            objectVersionGeneration: details.version.versionGeneration,
          });
          const remainingProviderRequests =
            action.limits.maxProviderRequests - summary.providerRequests;
          if (remainingProviderRequests < 1) {
            throw new SyncFailure("resource_limit", false);
          }
          const evidence = await driver.readAcl(details.entry, remainingProviderRequests);
          summary.providerRequests += evidence.providerRequests;
          if (summary.providerRequests > action.limits.maxProviderRequests) {
            throw new SyncFailure("resource_limit", false);
          }
          const recorded = await recordGoogleDriveObjectAclEvidence(db, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            obligationId: details.obligation.id,
            connectionId: provider.aclAuthority.connectionId,
            connectionVersion: provider.aclAuthority.connectionVersion,
            sourceGooglePermissionId: provider.aclAuthority.sourceGooglePermissionId,
            sourceSyncGeneration: details.obligation.sourceSyncGeneration,
            sourceConfigGeneration: action.sourceConfigGeneration,
            sourceLifecycleGeneration: action.sourceLifecycleGeneration,
            objectLifecycleGeneration: details.object.lifecycleGeneration,
            objectVersionGeneration: details.version.versionGeneration,
            providerRevision: evidence.providerRevision,
            driveId: evidence.driveId,
            aclRevision: evidence.aclRevision,
            eligibility: evidence.eligibility,
            observedAt: evidence.observedAt,
            expiresAt: evidence.expiresAt,
            citationLocator: driver.citationLocator(details.entry),
            operationId: `drive-acl:${details.obligation.id}:${evidence.aclRevision}`,
            principals: evidence.principals,
          });
          return {
            aclEligibility: evidence.eligibility,
            aclEvidence: {
              version: 1,
              provider: "google_drive",
              evidenceId: recorded.evidenceId,
              aclRevision: evidence.aclRevision,
              aclHash: recorded.aclHash,
              observedAt: evidence.observedAt,
              expiresAt: evidence.expiresAt,
            },
          };
        };

        const outcomes = [];
        for (const entry of entriesToProcess) {
          heartbeat({ sourceId: input.sourceId, externalObjectId: entry.externalObjectId });
          const observationFloor = observationFloorsById.get(entry.externalObjectId);
          if (!observationFloor) throw new SyncFailure("provider_payload_invalid", false);
          const syncObservation = {
            scheduledTaskRunId: input.scheduledTaskRunId,
            scanGeneration: liveState.activeScanGeneration,
            providerRevision: observationFloor.providerRevision,
            metadataHash: observationFloor.metadataHash,
          };
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
                syncObservation,
              });
              const obligation = await ensureVersionIndexed({
                entry,
                object,
                version: currentVersion,
                indexRequired: (currentObservation?.documentChunkCount ?? 0) === 0,
                obligation: currentObligation,
              });
              const objectAcl = await recordEntryAcl({
                entry,
                object,
                version: currentVersion,
                obligation,
              });
              summary.unchanged += 1;
              outcomes.push({
                externalObjectId: entry.externalObjectId,
                outcome: "unchanged" as const,
                contentSha256: currentVersion.contentSha256,
                providerRevision: entry.externalVersionId,
                metadataHash,
                aclEligibility: objectAcl.aclEligibility,
                aclEvidence: objectAcl.aclEvidence,
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
                syncObservation,
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
                syncObservation,
              });
              const obligation = await ensureVersionIndexed({
                entry,
                object,
                version,
                indexRequired: (currentObservation?.documentChunkCount ?? 0) === 0,
              });
              const objectAcl = await recordEntryAcl({ entry, object, version, obligation });
              summary.unchanged += 1;
              summary.indexed += 1;
              if (objectAcl.aclEligibility === "pending") summary.aclPending += 1;
              outcomes.push({
                externalObjectId: entry.externalObjectId,
                outcome: "unchanged" as const,
                contentSha256,
                sizeBytes: bytes.byteLength,
                providerRevision: entry.externalVersionId,
                metadataHash,
                aclEligibility: objectAcl.aclEligibility,
                aclEvidence: objectAcl.aclEvidence,
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
              syncObservation,
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
            const objectAcl = await recordEntryAcl({ entry, object, version, obligation });
            summary.indexed += 1;
            summary.imported += 1;
            if (objectAcl.aclEligibility === "pending") summary.aclPending += 1;
            summary.bytes += bytes.byteLength;
            outcomes.push({
              externalObjectId: entry.externalObjectId,
              outcome: "imported" as const,
              contentSha256,
              sizeBytes: bytes.byteLength,
              providerRevision: entry.externalVersionId,
              metadataHash,
              aclEligibility: objectAcl.aclEligibility,
              aclEvidence: objectAcl.aclEvidence,
              indexObligationId: obligation.id,
            });
          } catch (error) {
            if (error instanceof KnowledgeSourceSyncObservationFenceError) {
              throw new SyncFailure("provider_payload_invalid", false);
            }
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
          if (inventory.hardLimitReached) {
            summary.limitReached = inventoryLimit(inventory.stopReason);
            throw new SyncFailure("resource_limit", false);
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
            executionCheckpoint: executionCheckpoint as Record<string, unknown>,
            observationFence: {
              initiatingSubjectId: action.initiatingSubjectId,
              scanGeneration: liveState.activeScanGeneration,
              executionCheckpointGeneration: lease.state.executionCheckpointGeneration,
              observations: observationFloors,
            },
          });
          return { action: "continue" };
        }

        const tombstonedExternalObjectIds = inventory.authoritativeFullScan
          ? await reconcileKnowledgeSourceSyncCompleteScan(db, {
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              sourceId: input.sourceId,
              scheduledTaskRunId: input.scheduledTaskRunId,
              initiatingSubjectId: action.initiatingSubjectId,
              sourceSyncGeneration: knowledgeRun.inputSyncGeneration,
              sourceConfigGeneration: action.sourceConfigGeneration,
              sourceLifecycleGeneration: action.sourceLifecycleGeneration,
              scanGeneration: liveState.activeScanGeneration,
            })
          : [];
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
          metadata: { ...summary, providerCursor: inventory.providerCursor },
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
          providerCursor: inventory.providerCursor,
          observationFence: {
            initiatingSubjectId: action.initiatingSubjectId,
            scanGeneration: liveState.activeScanGeneration,
            executionCheckpointGeneration: lease.state.executionCheckpointGeneration,
            observations: observationFloors,
          },
        });
        await recordConnectorUsage("completed", summary.scanned, "item");
        await recordConnectorUsage("items", summary.imported, "item");
        await recordConnectorUsage("bytes", summary.bytes, "byte");
        observability.incrementCounter({
          name: "opengeni_knowledge_source_sync_runs_total",
          labels: { provider: providerLabel, outcome: "succeeded" },
        });
        observability.incrementCounter({
          name: "opengeni_knowledge_source_sync_items_total",
          labels: { provider: providerLabel, outcome: "imported" },
          amount: summary.imported,
        });
        for (const outcome of ["unchanged", "skipped", "failed"] as const) {
          observability.incrementCounter({
            name: "opengeni_knowledge_source_sync_items_total",
            labels: { provider: providerLabel, outcome },
            amount: summary[outcome],
          });
        }
        observability.incrementCounter({
          name: "opengeni_knowledge_source_sync_bytes_total",
          labels: { provider: providerLabel },
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
          labels: { provider: providerLabel, outcome: "failed" },
        });
        for (const outcome of ["imported", "unchanged", "skipped", "failed"] as const) {
          observability.incrementCounter({
            name: "opengeni_knowledge_source_sync_items_total",
            labels: { provider: providerLabel, outcome },
            amount: summary[outcome],
          });
        }
        observability.incrementCounter({
          name: "opengeni_knowledge_source_sync_bytes_total",
          labels: { provider: providerLabel },
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

export type GoogleDriveSyncProviderPort = {
  now?: () => number;
  getStartPageToken: (driveId: string | null) => Promise<string>;
  listChanges: (
    pageToken: string,
    driveId: string | null,
    pageSize: number,
  ) => Promise<GoogleDriveChangesPage>;
  getFile: (fileId: string) => Promise<GoogleDriveInventoryProviderItem | null>;
  listChildren: (input: {
    folderId: string;
    driveId: string | null;
    pageToken: string | null;
    pageSize: number;
  }) => Promise<GoogleDriveInventoryPage>;
  listPermissions?: (input: {
    fileId: string;
    pageToken: string | null;
    pageSize: number;
  }) => Promise<GoogleDrivePermissionsPage>;
};

async function resolveKnowledgeSyncProvider(input: {
  db: Database;
  settings: Settings;
  accountId: string;
  workspaceId: string;
  action: Extract<ScheduledTask["action"], { kind: "knowledge_source_sync" }>;
  sourceId: string;
  externalSourceId: string;
}): Promise<{
  kind: "google_drive" | "atlassian";
  selectedDestination: NonNullable<
    GoogleDriveSelectedSource["destination"] | AtlassianSelectedSource["destination"]
  >;
  driver: KnowledgeSourceSyncDriver<KnowledgeSyncEntry, KnowledgeSyncStopReason>;
  aclAuthority: {
    connectionId: string;
    connectionVersion: number;
    sourceGooglePermissionId: string;
  } | null;
}> {
  const { action } = input;
  const connection = await getConnectionMetadata(
    input.db,
    input.workspaceId,
    action.connection.connectionId,
    action.initiatingSubjectId,
  );
  if (
    !connection ||
    connection.accountId !== input.accountId ||
    connection.subjectId !== action.connection.ownerSubjectId ||
    connection.providerDomain.toLowerCase() !== action.connection.providerDomain.toLowerCase() ||
    connection.kind !== action.connection.kind ||
    connection.version < action.connection.connectionVersion ||
    connection.status !== "active"
  ) {
    throw new SyncFailure("connection_reconnect_required", true, true);
  }

  const googleInitial =
    connection.providerDomain === GOOGLE_DRIVE_PROVIDER_DOMAIN
      ? GoogleDriveConnectionMetadata.safeParse(connection.metadata)
      : null;
  const atlassianInitial =
    connection.providerDomain === ATLASSIAN_PROVIDER_DOMAIN
      ? AtlassianConnectionMetadata.safeParse(connection.metadata)
      : null;
  const initialAtlassianMetadata = atlassianInitial?.success ? atlassianInitial.data : null;
  if (!googleInitial?.success && !initialAtlassianMetadata) {
    throw new SyncFailure("provider_rejected", false);
  }
  if (
    googleInitial?.success &&
    !googleDriveScopesAllowCapability(connection.grantedScopes, "recursive_source_sync")
  ) {
    throw new SyncFailure("connection_reconnect_required", true, true);
  }
  if (atlassianInitial?.success && !atlassianScopesAllowRead(connection.grantedScopes)) {
    throw new SyncFailure("connection_reconnect_required", true, true);
  }
  const initialLifecycle = googleInitial?.success
    ? googleInitial.data.lifecycle
    : initialAtlassianMetadata!.lifecycle;
  if (initialLifecycle?.state && initialLifecycle.state !== "active") {
    throw new SyncFailure("connection_reconnect_required", true, true);
  }
  const initialSource = googleInitial?.success
    ? selectedDriveSource(googleInitial.data, input.externalSourceId)
    : selectedAtlassianSource(initialAtlassianMetadata!, input.externalSourceId);
  if (
    !initialSource ||
    !initialSource.syncEnabled ||
    initialSource.configGeneration !== action.sourceConfigGeneration ||
    !initialSource.destination ||
    scopedKnowledgeScopeKey(
      googleInitial?.success
        ? googleDriveKnowledgeScope(initialSource.destination)
        : atlassianKnowledgeScope(initialSource.destination),
    ) !== scopedKnowledgeScopeKey(action.destination)
  ) {
    throw new SyncFailure("authority_changed", false);
  }

  const token = await buildConnectionTokenResolver(
    input.db,
    input.settings,
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
    destinationUrl:
      connection.providerDomain === ATLASSIAN_PROVIDER_DOMAIN
        ? ATLASSIAN_API_BASE
        : "https://www.googleapis.com",
  });
  if (token.status !== "ok") {
    throw new SyncFailure("connection_reconnect_required", true, true);
  }
  const resolvedConnection = await getConnectionMetadata(
    input.db,
    input.workspaceId,
    action.connection.connectionId,
    action.initiatingSubjectId,
  );
  if (
    !resolvedConnection ||
    resolvedConnection.accountId !== input.accountId ||
    resolvedConnection.subjectId !== action.connection.ownerSubjectId ||
    resolvedConnection.providerDomain.toLowerCase() !==
      action.connection.providerDomain.toLowerCase() ||
    resolvedConnection.kind !== action.connection.kind ||
    resolvedConnection.version !== token.connectionVersion ||
    resolvedConnection.status !== "active"
  ) {
    throw new SyncFailure("connection_reconnect_required", true, true);
  }
  const authorization = token.headers.Authorization ?? token.headers.authorization;
  if (resolvedConnection.providerDomain === GOOGLE_DRIVE_PROVIDER_DOMAIN) {
    const metadata = GoogleDriveConnectionMetadata.parse(resolvedConnection.metadata);
    if (
      !googleDriveSyncProviderAccessAllowed({
        connectionVersion: resolvedConnection.version,
        resolvedConnectionVersion: token.connectionVersion,
        connectionStatus: resolvedConnection.status,
        lifecycleState: metadata.lifecycle?.state,
        grantedScopes: resolvedConnection.grantedScopes,
      })
    ) {
      throw new SyncFailure("connection_reconnect_required", true, true);
    }
    const source = selectedDriveSource(metadata, input.externalSourceId);
    if (!validSelectedSource(source, action, googleDriveKnowledgeScope)) {
      throw new SyncFailure("authority_changed", false);
    }
    return {
      kind: "google_drive",
      selectedDestination: source.destination!,
      aclAuthority: {
        connectionId: resolvedConnection.id,
        connectionVersion: resolvedConnection.version,
        sourceGooglePermissionId: metadata.googlePermissionId,
      },
      driver: googleDriveSyncDriver({
        actionProviderCoordinationKey: action.providerCoordinationKey,
        metadata,
        selectedSource: source,
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        initiatingSubjectId: action.initiatingSubjectId,
        authorization,
        limits: action.limits,
        connectionId: resolvedConnection.id,
        fullReconciliationIntervalMs: GOOGLE_DRIVE_FULL_RECONCILIATION_INTERVAL_MS,
        observedExternalObjectIds: async (externalObjectIds) =>
          await listObservedKnowledgeSourceSyncExternalObjectIds(input.db, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sourceId: input.sourceId,
            externalObjectIds,
          }),
      }) as unknown as KnowledgeSourceSyncDriver<KnowledgeSyncEntry, KnowledgeSyncStopReason>,
    };
  }
  if (resolvedConnection.providerDomain === ATLASSIAN_PROVIDER_DOMAIN) {
    const metadata = AtlassianConnectionMetadata.parse(resolvedConnection.metadata);
    if (
      metadata.lifecycle?.state !== "active" ||
      !atlassianScopesAllowRead(resolvedConnection.grantedScopes)
    ) {
      throw new SyncFailure("connection_reconnect_required", true, true);
    }
    const source = selectedAtlassianSource(metadata, input.externalSourceId);
    if (!validSelectedSource(source, action, atlassianKnowledgeScope)) {
      throw new SyncFailure("authority_changed", false);
    }
    return {
      kind: "atlassian",
      selectedDestination: source.destination!,
      aclAuthority: null,
      driver: atlassianSyncDriver({
        actionProviderCoordinationKey: action.providerCoordinationKey,
        metadata,
        selectedSource: source,
        authorization,
        limits: action.limits,
      }) as unknown as KnowledgeSourceSyncDriver<KnowledgeSyncEntry, KnowledgeSyncStopReason>,
    };
  }
  throw new SyncFailure("provider_rejected", false);
}

function validSelectedSource<Source extends GoogleDriveSelectedSource | AtlassianSelectedSource>(
  source: Source | null,
  action: Extract<ScheduledTask["action"], { kind: "knowledge_source_sync" }>,
  scope: (destination: NonNullable<Source["destination"]>) => ScopedKnowledgeScope,
): source is Source & { destination: NonNullable<Source["destination"]> } {
  return Boolean(
    source &&
    source.syncEnabled &&
    source.configGeneration === action.sourceConfigGeneration &&
    source.destination &&
    scopedKnowledgeScopeKey(scope(source.destination)) ===
      scopedKnowledgeScopeKey(action.destination),
  );
}

function selectedAtlassianSource(
  metadata: ReturnType<typeof AtlassianConnectionMetadata.parse>,
  externalSourceId: string,
): AtlassianSelectedSource | null {
  return metadata.selectedSources.find((source) => source.id === externalSourceId) ?? null;
}

function atlassianSyncDriver(input: {
  actionProviderCoordinationKey: string;
  metadata: ReturnType<typeof AtlassianConnectionMetadata.parse>;
  selectedSource: AtlassianSelectedSource;
  authorization: string | undefined;
  limits: {
    maxItems: number;
    maxBytes: number;
    maxFileBytes: number;
    maxProviderRequests: number;
    maxElapsedSeconds: number;
  };
}): KnowledgeSourceSyncDriver<AtlassianInventoryEntry, AtlassianInventoryStopReason> {
  return {
    providerKey: "atlassian",
    providerDomain: ATLASSIAN_PROVIDER_DOMAIN,
    providerCoordinationKey: input.actionProviderCoordinationKey,
    inventory: async (checkpoint) => {
      const inventory = await inventoryAtlassianSource({
        cloudId: input.selectedSource.cloudId,
        source: input.selectedSource,
        limits: {
          maxItems: input.limits.maxItems,
          maxApiRequests: input.limits.maxProviderRequests,
          maxElapsedMs: input.limits.maxElapsedSeconds * 1_000,
          pageSize: Math.min(input.limits.maxItems, 100),
        },
        checkpoint,
        listPage: async (cursor, pageSize) =>
          await listAtlassianItems(input.selectedSource, cursor, pageSize, input.authorization),
      });
      return {
        ...inventory,
        providerCursor: null,
        authoritativeFullScan: inventory.status === "complete",
        cursorInvalidated: false,
        hardLimitReached:
          inventory.status === "paused" &&
          inventory.stopReason !== "elapsed_time_limit" &&
          inventory.stopReason !== "provider_error",
      };
    },
    fetchContent: async (entry, maxBytes) =>
      await fetchAtlassianContent(input.selectedSource, entry, input.authorization, maxBytes),
    citationLocator: (entry) => ({
      version: 1,
      providerKey: "atlassian",
      providerCoordinationKey: input.actionProviderCoordinationKey,
      cloudId: input.selectedSource.cloudId,
      sourceKind: input.selectedSource.kind,
      externalObjectId: entry.externalObjectId,
      sourceUri: entry.sourceUri,
    }),
  };
}

export function googleDriveSyncDriver(input: {
  actionProviderCoordinationKey: string;
  metadata: ReturnType<typeof GoogleDriveConnectionMetadata.parse>;
  selectedSource: GoogleDriveSelectedSource;
  connectionId: string;
  accountId: string;
  workspaceId: string;
  initiatingSubjectId: string;
  authorization: string | undefined;
  fullReconciliationIntervalMs: number;
  observedExternalObjectIds: (ids: string[]) => Promise<Set<string>>;
  provider?: GoogleDriveSyncProviderPort;
  limits: {
    maxItems: number;
    maxBytes: number;
    maxFileBytes: number;
    maxProviderRequests: number;
    maxElapsedSeconds: number;
  };
}): KnowledgeSourceSyncDriver<GoogleDriveInventoryEntry, GoogleDriveInventoryStopReason> {
  const maxElapsedMs = input.limits.maxElapsedSeconds * 1_000;
  const provider: GoogleDriveSyncProviderPort = input.provider ?? {
    getStartPageToken: async (driveId) =>
      await getDriveStartPageToken(driveId, input.authorization),
    listChanges: async (pageToken, driveId, pageSize) =>
      await listDriveChanges(pageToken, driveId, pageSize, input.authorization),
    getFile: async (fileId) => await getDriveFile(fileId, input.authorization),
    listChildren: async (request) => await listDriveChildren(request, input.authorization),
    listPermissions: async (request) => await listDrivePermissions(request, input.authorization),
  };
  const clock = provider.now ?? Date.now;
  const budgetLimits = {
    maxItems: input.limits.maxItems,
    maxProviderRequests: input.limits.maxProviderRequests,
    maxElapsedMs,
  };
  return {
    providerKey: "google_drive",
    providerDomain: GOOGLE_DRIVE_PROVIDER_DOMAIN,
    providerCoordinationKey: input.actionProviderCoordinationKey,
    inventory: async (executionCheckpoint, providerCursor) => {
      const expectedCursor = {
        connectionId: input.connectionId,
        googlePermissionId: input.metadata.googlePermissionId,
        sourceId: input.selectedSource.id,
        driveId: input.selectedSource.driveId,
      };
      const legacyFullCheckpoint = isLegacyGoogleDriveFullReconciliationCheckpoint(
        executionCheckpoint,
        expectedCursor,
      );
      const cursor = parseGoogleDriveChangesCursor(providerCursor, expectedCursor);
      const checkpoint = parseGoogleDriveExecutionCheckpoint(
        executionCheckpoint,
        expectedCursor,
        budgetLimits,
      );
      const now = new Date(clock());

      const runFullReconciliation = async (full: {
        boundaryId: string;
        startPageToken: string;
        cursorInvalidated: boolean;
        budgetBeforeInventory: GoogleDriveSyncBudget;
        inventoryElapsedMs: number;
        inventoryCheckpoint: GoogleDriveInventoryCheckpoint | null;
        revisionFloors: GoogleDriveRevisionFloor[];
      }) => {
        const inventoryItems = full.inventoryCheckpoint?.totals.itemCount ?? 0;
        const inventoryProviderRequests = full.inventoryCheckpoint?.totals.apiRequestCount ?? 0;
        const budgetBeforeInvocation = {
          examinedItems: full.budgetBeforeInventory.examinedItems + inventoryItems,
          providerRequests: full.budgetBeforeInventory.providerRequests + inventoryProviderRequests,
          elapsedMs: full.budgetBeforeInventory.elapsedMs + full.inventoryElapsedMs,
        } satisfies GoogleDriveSyncBudget;
        const hardStopReason = googleDriveHardLimitReason(budgetBeforeInvocation, budgetLimits);
        const fullCheckpoint = buildGoogleDriveFullReconciliationCheckpoint({
          ...expectedCursor,
          ...full,
        });
        if (hardStopReason) {
          return {
            status: "paused" as const,
            stopReason: hardStopReason,
            entries: [],
            checkpoint: fullCheckpoint,
            providerCursor,
            authoritativeFullScan: false,
            cursorInvalidated: full.cursorInvalidated,
            providerRequests: budgetBeforeInvocation.providerRequests,
            elapsedMs: budgetBeforeInvocation.elapsedMs,
            hardLimitReached: true,
          };
        }

        const phaseMaxItems = input.limits.maxItems - full.budgetBeforeInventory.examinedItems;
        const phaseMaxProviderRequests =
          input.limits.maxProviderRequests - full.budgetBeforeInventory.providerRequests;
        const remainingElapsedMs = maxElapsedMs - budgetBeforeInvocation.elapsedMs;
        const inventory = await inventoryGoogleDriveSource({
          googlePermissionId: input.metadata.googlePermissionId,
          googleEmail: input.metadata.googleEmail,
          source: input.selectedSource,
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          connectionSubjectId: input.initiatingSubjectId,
          limits: {
            maxItems: phaseMaxItems,
            maxKnownBytes: input.limits.maxBytes,
            maxApiRequests: phaseMaxProviderRequests,
            maxElapsedMs: Math.min(GOOGLE_DRIVE_SYNC_INVOCATION_SLICE_MS, remainingElapsedMs),
            maxFileBytes: input.limits.maxFileBytes,
            maxFolders: Math.min(phaseMaxItems * 2, 2_000),
            pageSize: Math.min(phaseMaxItems, 100),
          },
          checkpoint: full.inventoryCheckpoint,
          listChildren: provider.listChildren,
          now: clock,
        });
        const inventoryElapsedMs = full.inventoryElapsedMs + inventory.run.elapsedMs;
        const budget = {
          examinedItems: full.budgetBeforeInventory.examinedItems + inventory.totals.itemCount,
          providerRequests:
            full.budgetBeforeInventory.providerRequests + inventory.totals.apiRequestCount,
          elapsedMs: full.budgetBeforeInventory.elapsedMs + inventoryElapsedMs,
        } satisfies GoogleDriveSyncBudget;
        const reconciled = reconcileGoogleDriveRevisionFloors(
          inventory.entries,
          full.revisionFloors,
          input.limits.maxItems,
        );
        if (reconciled.conflict) {
          return {
            status: "paused" as const,
            stopReason: "incomplete_search" as const,
            entries: [],
            checkpoint: fullCheckpoint,
            providerCursor,
            authoritativeFullScan: false,
            cursorInvalidated: full.cursorInvalidated,
            providerRequests: budget.providerRequests,
            elapsedMs: budget.elapsedMs,
            hardLimitReached: false,
          };
        }
        const nextCursor =
          inventory.status === "complete"
            ? buildGoogleDriveChangesCursor({
                ...expectedCursor,
                boundaryId: full.boundaryId,
                pageToken: full.startPageToken,
                previousGeneration: cursor?.cursorGeneration ?? 0,
                reconciledAt: now,
                fullReconciliationIntervalMs: input.fullReconciliationIntervalMs,
              })
            : providerCursor;
        return {
          status: inventory.status,
          stopReason: inventory.stopReason,
          entries: reconciled.entries,
          checkpoint:
            inventory.status === "paused" && inventory.checkpoint
              ? buildGoogleDriveFullReconciliationCheckpoint({
                  ...expectedCursor,
                  boundaryId: full.boundaryId,
                  startPageToken: full.startPageToken,
                  cursorInvalidated: full.cursorInvalidated,
                  budgetBeforeInventory: full.budgetBeforeInventory,
                  inventoryElapsedMs,
                  inventoryCheckpoint: inventory.checkpoint,
                  revisionFloors: reconciled.revisionFloors,
                })
              : null,
          providerCursor: nextCursor,
          authoritativeFullScan: inventory.status === "complete",
          cursorInvalidated: full.cursorInvalidated,
          providerRequests: budget.providerRequests,
          elapsedMs: budget.elapsedMs,
          hardLimitReached:
            inventory.status === "paused" &&
            googleDriveInventoryStopIsHard(inventory.stopReason, budget, budgetLimits),
        };
      };

      const acquireFullReconciliation = async (details: {
        budget: GoogleDriveSyncBudget;
        boundaryId: string | null;
        cursorInvalidated: boolean;
      }) => {
        const acquisitionStartedAt = clock();
        const initialElapsedMs = details.budget.elapsedMs;
        const budget = { ...details.budget };
        const refreshElapsed = () => {
          budget.elapsedMs = initialElapsedMs + Math.max(0, clock() - acquisitionStartedAt);
        };
        const requireProviderCapacity = () => {
          refreshElapsed();
          if (googleDriveHardLimitReason(budget, budgetLimits)) {
            throw new SyncFailure("resource_limit", false);
          }
          budget.providerRequests += 1;
        };

        requireProviderCapacity();
        const startPageToken = await provider.getStartPageToken(input.selectedSource.driveId);
        refreshElapsed();

        let boundaryId = details.boundaryId;
        if (!boundaryId) {
          if (input.selectedSource.id === "root" && input.selectedSource.driveId === null) {
            requireProviderCapacity();
            try {
              boundaryId = await resolveGoogleDriveChangesBoundaryId({
                source: input.selectedSource,
                getFile: provider.getFile,
              });
            } catch (error) {
              if (error instanceof GoogleDriveChangesProtocolError) {
                throw new SyncFailure("provider_payload_invalid", false);
              }
              throw error;
            }
            refreshElapsed();
          } else {
            boundaryId = input.selectedSource.id;
          }
        }

        return {
          boundaryId,
          startPageToken,
          cursorInvalidated: details.cursorInvalidated,
          budgetBeforeInventory: budget,
          inventoryElapsedMs: 0,
          inventoryCheckpoint: null,
          revisionFloors: [],
        };
      };

      if (checkpoint?.kind === "google_drive_full_reconciliation") {
        return await runFullReconciliation(checkpoint);
      }
      if (!cursor) {
        const budget =
          checkpoint?.kind === "google_drive_changes"
            ? checkpoint.changesCheckpoint.budget
            : emptyGoogleDriveSyncBudget();
        return await runFullReconciliation(
          await acquireFullReconciliation({
            budget,
            boundaryId: null,
            cursorInvalidated: providerCursor !== null,
          }),
        );
      }
      if (!checkpoint && !legacyFullCheckpoint && googleDriveFullReconciliationDue(cursor, now)) {
        return await runFullReconciliation(
          await acquireFullReconciliation({
            budget: emptyGoogleDriveSyncBudget(),
            boundaryId: cursor.boundaryId,
            cursorInvalidated: false,
          }),
        );
      }

      try {
        const forceFullReconciliation =
          legacyFullCheckpoint || googleDriveFullReconciliationDue(cursor, now);
        const changesCheckpoint =
          checkpoint?.kind === "google_drive_changes"
            ? {
                ...checkpoint.changesCheckpoint,
                requiresFullReconciliation:
                  checkpoint.changesCheckpoint.requiresFullReconciliation ||
                  forceFullReconciliation,
              }
            : null;
        const changes = await drainGoogleDriveChanges({
          source: input.selectedSource,
          cursor,
          checkpoint: changesCheckpoint,
          maxItems: input.limits.maxItems,
          maxProviderRequests: input.limits.maxProviderRequests,
          maxElapsedMs,
          maxInvocationElapsedMs: Math.min(GOOGLE_DRIVE_SYNC_INVOCATION_SLICE_MS, maxElapsedMs),
          maxFileBytes: input.limits.maxFileBytes,
          listChanges: async (pageToken, pageSize) =>
            await provider.listChanges(pageToken, input.selectedSource.driveId, pageSize),
          getFile: provider.getFile,
          observedExternalObjectIds: input.observedExternalObjectIds,
          now: clock,
        });
        if (changes.status === "paused" && changes.checkpoint) {
          return {
            status: "paused" as const,
            stopReason: changes.stopReason,
            entries: changes.entries,
            checkpoint: {
              version: 2,
              kind: "google_drive_changes",
              ...expectedCursor,
              changesCheckpoint: {
                ...changes.checkpoint,
                requiresFullReconciliation:
                  changes.checkpoint.requiresFullReconciliation || forceFullReconciliation,
              },
            } satisfies GoogleDriveExecutionCheckpoint,
            providerCursor,
            authoritativeFullScan: false,
            cursorInvalidated: false,
            providerRequests: changes.providerRequests,
            elapsedMs: changes.elapsedMs,
            hardLimitReached: changes.hardLimitReached,
          };
        }
        if (!changes.newStartPageToken) throw new Error("google_drive_changes_cursor_missing");
        if (changes.requiresFullReconciliation || forceFullReconciliation) {
          const hardStopReason = googleDriveHardLimitReason(changes.budget, budgetLimits);
          return {
            status: "paused" as const,
            stopReason: hardStopReason ?? ("elapsed_time_limit" as const),
            entries: changes.entries,
            checkpoint: buildGoogleDriveFullReconciliationCheckpoint({
              ...expectedCursor,
              boundaryId: cursor.boundaryId,
              startPageToken: changes.newStartPageToken,
              cursorInvalidated: false,
              budgetBeforeInventory: changes.budget,
              inventoryElapsedMs: 0,
              inventoryCheckpoint: null,
              revisionFloors: revisionFloorsForEntries(changes.entries, input.limits.maxItems),
            }),
            providerCursor,
            authoritativeFullScan: false,
            cursorInvalidated: false,
            providerRequests: changes.providerRequests,
            elapsedMs: changes.elapsedMs,
            hardLimitReached: hardStopReason !== null,
          };
        }
        return {
          status: "complete" as const,
          stopReason: null,
          entries: changes.entries,
          checkpoint: null,
          providerCursor: advanceGoogleDriveChangesCursor(cursor, changes.newStartPageToken),
          authoritativeFullScan: false,
          cursorInvalidated: false,
          providerRequests: changes.providerRequests,
          elapsedMs: changes.elapsedMs,
          hardLimitReached: false,
        };
      } catch (error) {
        if (error instanceof GoogleDriveChangesProtocolError) {
          throw new SyncFailure("provider_payload_invalid", false);
        }
        if (!(error instanceof GoogleDriveCursorInvalidError)) throw error;
        const full = await acquireFullReconciliation({
          budget: error.budget ?? emptyGoogleDriveSyncBudget(),
          boundaryId: cursor.boundaryId,
          cursorInvalidated: true,
        });
        const hardStopReason = googleDriveHardLimitReason(full.budgetBeforeInventory, budgetLimits);
        return {
          status: "paused" as const,
          stopReason: hardStopReason ?? ("elapsed_time_limit" as const),
          entries: [],
          checkpoint: buildGoogleDriveFullReconciliationCheckpoint({
            ...expectedCursor,
            ...full,
          }),
          providerCursor,
          authoritativeFullScan: false,
          cursorInvalidated: true,
          providerRequests: full.budgetBeforeInventory.providerRequests,
          elapsedMs: full.budgetBeforeInventory.elapsedMs,
          hardLimitReached: hardStopReason !== null,
        };
      }
    },
    fetchContent: async (entry, maxBytes) =>
      await fetchDriveBytes(entry, input.authorization, maxBytes),
    readAcl: async (entry, maxProviderRequests) => {
      if (!provider.listPermissions) {
        throw new SyncFailure("provider_rejected", false);
      }
      return await collectGoogleDriveAclEvidence({
        entry,
        maxProviderRequests,
        listPermissions: provider.listPermissions,
        getFile: provider.getFile,
        now: clock,
      });
    },
    citationLocator: (entry) => ({
      version: 2,
      providerKey: "google-drive",
      providerCoordinationKey: input.actionProviderCoordinationKey,
      externalObjectId: entry.externalObjectId,
      providerRevision: entry.externalVersionId,
      driveId: entry.driveId,
      sourceUri: entry.sourceUri,
    }),
  };
}

type GoogleDriveCheckpointIdentity = {
  connectionId: string;
  googlePermissionId: string;
  sourceId: string;
  driveId: string | null;
};

type GoogleDriveRevisionFloor = [externalObjectId: string, providerRevision: string | null];

type GoogleDriveFullReconciliationCheckpoint = GoogleDriveCheckpointIdentity & {
  version: 3;
  kind: "google_drive_full_reconciliation";
  boundaryId: string;
  startPageToken: string;
  cursorInvalidated: boolean;
  budgetBeforeInventory: GoogleDriveSyncBudget;
  inventoryElapsedMs: number;
  inventoryCheckpoint: GoogleDriveInventoryCheckpoint | null;
  revisionFloors: GoogleDriveRevisionFloor[];
};

type GoogleDriveExecutionCheckpoint = GoogleDriveCheckpointIdentity &
  (
    | {
        version: 2;
        kind: "google_drive_changes";
        changesCheckpoint: GoogleDriveChangesCheckpoint;
      }
    | GoogleDriveFullReconciliationCheckpoint
  );

function isLegacyGoogleDriveFullReconciliationCheckpoint(
  value: Record<string, unknown> | null,
  expected: GoogleDriveCheckpointIdentity,
): boolean {
  return (
    value?.version === 2 &&
    value.kind === "google_drive_full_reconciliation" &&
    value.connectionId === expected.connectionId &&
    value.googlePermissionId === expected.googlePermissionId &&
    value.sourceId === expected.sourceId &&
    value.driveId === expected.driveId &&
    encodedJsonBytes(value) <= GOOGLE_DRIVE_EXECUTION_CHECKPOINT_MAX_BYTES
  );
}

function parseGoogleDriveExecutionCheckpoint(
  value: Record<string, unknown> | null,
  expected: GoogleDriveCheckpointIdentity,
  limits: { maxItems: number; maxProviderRequests: number; maxElapsedMs: number },
): GoogleDriveExecutionCheckpoint | null {
  if (
    !value ||
    value.connectionId !== expected.connectionId ||
    value.googlePermissionId !== expected.googlePermissionId ||
    value.sourceId !== expected.sourceId ||
    value.driveId !== expected.driveId ||
    encodedJsonBytes(value) > GOOGLE_DRIVE_EXECUTION_CHECKPOINT_MAX_BYTES
  ) {
    return null;
  }
  if (value.version === 2 && value.kind === "google_drive_changes") {
    const changesCheckpoint = parseGoogleDriveChangesCheckpoint(value.changesCheckpoint, limits);
    return changesCheckpoint
      ? ({ ...value, changesCheckpoint } as GoogleDriveExecutionCheckpoint)
      : null;
  }
  if (value.version === 3 && value.kind === "google_drive_full_reconciliation") {
    const budgetBeforeInventory = parseGoogleDriveSyncBudget(value.budgetBeforeInventory, limits);
    const revisionFloors = parseGoogleDriveRevisionFloors(value.revisionFloors, limits.maxItems);
    if (
      typeof value.boundaryId !== "string" ||
      value.boundaryId.length < 1 ||
      value.boundaryId.length > 1024 ||
      typeof value.startPageToken !== "string" ||
      value.startPageToken.length < 1 ||
      value.startPageToken.length > 4096 ||
      typeof value.cursorInvalidated !== "boolean" ||
      !budgetBeforeInventory ||
      !revisionFloors ||
      !Number.isSafeInteger(value.inventoryElapsedMs) ||
      Number(value.inventoryElapsedMs) < 0 ||
      Number(value.inventoryElapsedMs) > limits.maxElapsedMs ||
      budgetBeforeInventory.elapsedMs + Number(value.inventoryElapsedMs) > limits.maxElapsedMs ||
      (value.inventoryCheckpoint !== null &&
        (!value.inventoryCheckpoint ||
          typeof value.inventoryCheckpoint !== "object" ||
          Array.isArray(value.inventoryCheckpoint)))
    ) {
      return null;
    }
    return {
      ...value,
      budgetBeforeInventory,
      inventoryElapsedMs: Number(value.inventoryElapsedMs),
      revisionFloors,
    } as GoogleDriveExecutionCheckpoint;
  }
  return null;
}

function buildGoogleDriveFullReconciliationCheckpoint(
  input: Omit<GoogleDriveFullReconciliationCheckpoint, "version" | "kind">,
): GoogleDriveFullReconciliationCheckpoint {
  const checkpoint = {
    version: 3,
    kind: "google_drive_full_reconciliation",
    ...input,
    revisionFloors: input.revisionFloors.map((floor) => [...floor]),
  } satisfies GoogleDriveFullReconciliationCheckpoint;
  if (encodedJsonBytes(checkpoint) > GOOGLE_DRIVE_EXECUTION_CHECKPOINT_MAX_BYTES) {
    throw new SyncFailure("resource_limit", false);
  }
  return checkpoint;
}

function parseGoogleDriveRevisionFloors(
  value: unknown,
  maxItems: number,
): GoogleDriveRevisionFloor[] | null {
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const floors: GoogleDriveRevisionFloor[] = [];
  const seen = new Set<string>();
  for (const floor of value) {
    if (
      !Array.isArray(floor) ||
      floor.length !== 2 ||
      typeof floor[0] !== "string" ||
      floor[0].trim().length < 1 ||
      floor[0].length > 1024 ||
      (floor[1] !== null &&
        (typeof floor[1] !== "string" || floor[1].length < 1 || floor[1].length > 256)) ||
      seen.has(floor[0])
    ) {
      return null;
    }
    seen.add(floor[0]);
    floors.push([floor[0], floor[1]]);
  }
  return floors;
}

function revisionFloorsForEntries(
  entries: GoogleDriveInventoryEntry[],
  maxItems: number,
): GoogleDriveRevisionFloor[] {
  const reconciled = reconcileGoogleDriveRevisionFloors(entries, [], maxItems);
  if (reconciled.conflict) throw new SyncFailure("provider_payload_invalid", false);
  return reconciled.revisionFloors;
}

export function shouldProcessGoogleDriveDurableObservation(input: {
  entry: Pick<GoogleDriveInventoryEntry, "externalObjectId">;
  observation: KnowledgeSourceSyncObjectObservationResult;
  sourceLifecycleGeneration: number;
  aclGeneration: number;
}): boolean {
  if (input.observation.externalObjectId !== input.entry.externalObjectId) {
    throw new SyncFailure("provider_payload_invalid", false);
  }
  if (
    input.observation.disposition === "accepted" ||
    input.observation.disposition === "replayed"
  ) {
    return true;
  }
  if (input.observation.disposition === "conflict") {
    throw new SyncFailure("provider_payload_invalid", false);
  }
  const current = input.observation.currentVersion;
  const comparison = current
    ? compareCanonicalDecimalProviderRevisions(
        current.providerRevision,
        input.observation.providerRevision,
      )
    : null;
  const fullyProcessed =
    current !== null &&
    current.objectLifecycleState === "active" &&
    current.sourceLifecycleGeneration === input.sourceLifecycleGeneration &&
    current.objectLifecycleGeneration === current.currentObjectLifecycleGeneration &&
    current.aclGeneration === input.aclGeneration &&
    current.indexObligationStatus === "indexed" &&
    comparison !== null &&
    comparison >= 0 &&
    (comparison > 0 || current.metadataHash === input.observation.metadataHash);
  if (!fullyProcessed) throw new SyncFailure("provider_payload_invalid", false);
  return false;
}

export function mergeGoogleDriveDurableObservationFloors(
  checkpoint: Record<string, unknown> | null,
  observations: KnowledgeSourceSyncObservationFloor[],
  maxItems: number,
): Record<string, unknown> | null {
  if (
    !checkpoint ||
    checkpoint.version !== 3 ||
    checkpoint.kind !== "google_drive_full_reconciliation"
  ) {
    return checkpoint;
  }
  const parsedFloors = parseGoogleDriveRevisionFloors(checkpoint.revisionFloors, maxItems);
  if (!parsedFloors) throw new SyncFailure("provider_payload_invalid", false);
  const floors = new Map<string, string | null>(parsedFloors);
  for (const observation of observations) {
    floors.set(observation.externalObjectId, observation.providerRevision);
  }
  if (floors.size > maxItems) throw new SyncFailure("resource_limit", false);
  const merged = {
    ...checkpoint,
    revisionFloors: [...floors],
  };
  if (encodedJsonBytes(merged) > GOOGLE_DRIVE_EXECUTION_CHECKPOINT_MAX_BYTES) {
    throw new SyncFailure("resource_limit", false);
  }
  return merged;
}

function reconcileGoogleDriveRevisionFloors(
  entries: GoogleDriveInventoryEntry[],
  existingFloors: GoogleDriveRevisionFloor[],
  maxItems: number,
): {
  entries: GoogleDriveInventoryEntry[];
  revisionFloors: GoogleDriveRevisionFloor[];
  conflict: boolean;
} {
  const floors = new Map<string, string | null>(existingFloors);
  const accepted: GoogleDriveInventoryEntry[] = [];
  for (const entry of entries) {
    if (!floors.has(entry.externalObjectId)) {
      floors.set(entry.externalObjectId, entry.externalVersionId);
      accepted.push(entry);
    } else {
      const comparison = compareCanonicalDecimalProviderRevisions(
        entry.externalVersionId,
        floors.get(entry.externalObjectId) ?? null,
      );
      if (comparison === null) {
        return {
          entries: [],
          revisionFloors: [...floors],
          conflict: true,
        };
      }
      if (comparison > 0) {
        floors.set(entry.externalObjectId, entry.externalVersionId);
        accepted.push(entry);
      }
    }
    if (floors.size > maxItems) throw new SyncFailure("resource_limit", false);
  }
  return {
    entries: accepted,
    revisionFloors: [...floors],
    conflict: false,
  };
}

function encodedJsonBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function parseGoogleDriveSyncBudget(
  value: unknown,
  limits: { maxItems: number; maxProviderRequests: number; maxElapsedMs: number },
): GoogleDriveSyncBudget | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  for (const [key, maximum] of [
    ["examinedItems", limits.maxItems],
    ["providerRequests", limits.maxProviderRequests],
    ["elapsedMs", limits.maxElapsedMs],
  ] as const) {
    const budgetValue = row[key];
    if (
      !Number.isSafeInteger(budgetValue) ||
      Number(budgetValue) < 0 ||
      Number(budgetValue) > maximum
    ) {
      return null;
    }
  }
  return value as GoogleDriveSyncBudget;
}

function emptyGoogleDriveSyncBudget(): GoogleDriveSyncBudget {
  return { examinedItems: 0, providerRequests: 0, elapsedMs: 0 };
}

function googleDriveHardLimitReason(
  budget: GoogleDriveSyncBudget,
  limits: { maxItems: number; maxProviderRequests: number; maxElapsedMs: number },
): Extract<
  GoogleDriveInventoryStopReason,
  "api_request_limit" | "elapsed_time_limit" | "item_limit"
> | null {
  if (budget.examinedItems >= limits.maxItems) return "item_limit";
  if (budget.providerRequests >= limits.maxProviderRequests) return "api_request_limit";
  if (budget.elapsedMs >= limits.maxElapsedMs) return "elapsed_time_limit";
  return null;
}

function googleDriveInventoryStopIsHard(
  reason: GoogleDriveInventoryStopReason | null,
  budget: GoogleDriveSyncBudget,
  limits: { maxItems: number; maxProviderRequests: number; maxElapsedMs: number },
): boolean {
  if (reason === "api_request_limit" || reason === "item_limit" || reason === "known_byte_limit") {
    return true;
  }
  return reason === "elapsed_time_limit" && budget.elapsedMs >= limits.maxElapsedMs;
}

async function getDriveStartPageToken(
  driveId: string | null,
  authorization: string | undefined,
): Promise<string> {
  if (!authorization) throw new SyncFailure("connection_reconnect_required", true, true);
  const url = new URL(`${DRIVE_API_BASE}/changes/startPageToken`);
  url.searchParams.set("supportsAllDrives", "true");
  if (driveId) url.searchParams.set("driveId", driveId);
  const response = await fetch(url, {
    headers: { authorization, accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throwGoogleDriveResponse(response);
  const payload = (await readResponseJsonBounded(
    response,
    DRIVE_JSON_MAX_BYTES,
    "Google Drive start page token",
  )) as Record<string, unknown>;
  return requiredString(payload.startPageToken, "start_page_token");
}

async function listDriveChanges(
  pageToken: string,
  driveId: string | null,
  pageSize: number,
  authorization: string | undefined,
): Promise<GoogleDriveChangesPage> {
  if (!authorization) throw new SyncFailure("connection_reconnect_required", true, true);
  const url = new URL(`${DRIVE_API_BASE}/changes`);
  url.searchParams.set("pageToken", pageToken);
  url.searchParams.set("pageSize", String(pageSize));
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("includeItemsFromAllDrives", "true");
  url.searchParams.set("spaces", "drive");
  url.searchParams.set(
    "fields",
    "nextPageToken,newStartPageToken,changes(fileId,removed,time,driveId,file(id,name,mimeType,driveId,parents,modifiedTime,createdTime,version,md5Checksum,size,webViewLink,trashed))",
  );
  if (driveId) url.searchParams.set("driveId", driveId);
  const response = await fetch(url, {
    headers: { authorization, accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 410) throw new GoogleDriveCursorInvalidError();
  if (!response.ok) throwGoogleDriveResponse(response);
  const payload = (await readResponseJsonBounded(
    response,
    DRIVE_JSON_MAX_BYTES,
    "Google Drive changes list",
  )) as Record<string, unknown>;
  const changes = Array.isArray(payload.changes) ? payload.changes : [];
  return {
    changes: changes.map((value) => {
      const row = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
      const fileId = requiredString(row.fileId, "change_file_id");
      return {
        fileId,
        removed: row.removed === true,
        file: row.file && typeof row.file === "object" ? parseDriveProviderItem(row.file) : null,
      };
    }),
    nextPageToken: optionalString(payload.nextPageToken),
    newStartPageToken: optionalString(payload.newStartPageToken),
  };
}

async function getDriveFile(
  fileId: string,
  authorization: string | undefined,
): Promise<GoogleDriveInventoryProviderItem | null> {
  if (!authorization) throw new SyncFailure("connection_reconnect_required", true, true);
  const url = new URL(`${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}`);
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set(
    "fields",
    "id,name,mimeType,driveId,parents,modifiedTime,createdTime,version,md5Checksum,size,webViewLink,trashed",
  );
  const response = await fetch(url, {
    headers: { authorization, accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throwGoogleDriveResponse(response);
  return parseDriveProviderItem(
    await readResponseJsonBounded(response, DRIVE_JSON_MAX_BYTES, "Google Drive file metadata"),
  );
}

async function listDrivePermissions(
  input: { fileId: string; pageToken: string | null; pageSize: number },
  authorization: string | undefined,
): Promise<GoogleDrivePermissionsPage> {
  if (!authorization) throw new SyncFailure("connection_reconnect_required", true, true);
  const url = new URL(`${DRIVE_API_BASE}/files/${encodeURIComponent(input.fileId)}/permissions`);
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("pageSize", String(input.pageSize));
  url.searchParams.set(
    "fields",
    "nextPageToken,permissions(id,type,emailAddress,domain,role,allowFileDiscovery,expirationTime,deleted,permissionDetails(inherited))",
  );
  if (input.pageToken) url.searchParams.set("pageToken", input.pageToken);
  const response = await fetch(url, {
    headers: { authorization, accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 403 || response.status === 404) {
    return { permissions: [], nextPageToken: null, denied: true };
  }
  if (!response.ok) throwGoogleDriveResponse(response);
  const payload = (await readResponseJsonBounded(
    response,
    DRIVE_JSON_MAX_BYTES,
    "Google Drive permission list",
  )) as Record<string, unknown>;
  const rawPermissions = Array.isArray(payload.permissions) ? payload.permissions : null;
  if (!rawPermissions) throw new SyncFailure("provider_payload_invalid", false);
  return {
    permissions: rawPermissions.map(parseDrivePermission),
    nextPageToken: optionalString(payload.nextPageToken),
    denied: false,
  };
}

export async function collectGoogleDriveAclEvidence(input: {
  entry: Pick<GoogleDriveInventoryEntry, "externalObjectId" | "externalVersionId" | "driveId">;
  maxProviderRequests: number;
  listPermissions: NonNullable<GoogleDriveSyncProviderPort["listPermissions"]>;
  getFile?: GoogleDriveSyncProviderPort["getFile"];
  now?: () => number;
}): Promise<KnowledgeSourceSyncAclEvidence> {
  if (!Number.isSafeInteger(input.maxProviderRequests) || input.maxProviderRequests < 1) {
    throw new SyncFailure("resource_limit", false);
  }
  const now = input.now ?? Date.now;
  const observedAt = new Date(now());
  if (!Number.isFinite(observedAt.getTime())) {
    throw new SyncFailure("provider_payload_invalid", false);
  }
  const permissions: GoogleDrivePermission[] = [];
  const seenTokens = new Set<string>();
  let pageToken: string | null = null;
  let providerRequests = 0;
  let permissionListDenied = false;
  do {
    if (providerRequests >= input.maxProviderRequests) {
      throw new SyncFailure("resource_limit", false);
    }
    providerRequests += 1;
    const page = await input.listPermissions({
      fileId: input.entry.externalObjectId,
      pageToken,
      pageSize: Math.min(100, GOOGLE_DRIVE_ACL_MAX_PRINCIPALS - permissions.length),
    });
    if (page.denied) {
      permissionListDenied = true;
      break;
    }
    permissions.push(...page.permissions);
    if (permissions.length > GOOGLE_DRIVE_ACL_MAX_PRINCIPALS) {
      throw new SyncFailure("resource_limit", false);
    }
    pageToken = page.nextPageToken;
    if (pageToken) {
      if (pageToken.length > 4096 || seenTokens.has(pageToken)) {
        throw new SyncFailure("provider_payload_invalid", false);
      }
      seenTokens.add(pageToken);
    }
  } while (pageToken);

  if (permissionListDenied) {
    if (!input.getFile || providerRequests >= input.maxProviderRequests) {
      return googleDriveDeniedAclEvidence(input.entry, observedAt, providerRequests);
    }
    providerRequests += 1;
    const current = await input.getFile(input.entry.externalObjectId);
    if (!current || current.trashed) {
      return googleDriveDeniedAclEvidence(input.entry, observedAt, providerRequests);
    }
    const aclRevision = createHash("sha256")
      .update(
        JSON.stringify({
          version: 1,
          mode: "source_owner_only",
          externalObjectId: input.entry.externalObjectId,
          providerRevision: input.entry.externalVersionId,
        }),
      )
      .digest("hex");
    return {
      eligibility: "eligible",
      providerRevision: input.entry.externalVersionId,
      driveId: input.entry.driveId,
      aclRevision,
      observedAt: observedAt.toISOString(),
      expiresAt: new Date(observedAt.getTime() + GOOGLE_DRIVE_ACL_FRESHNESS_MS).toISOString(),
      providerRequests,
      principals: [],
    };
  }

  const canonicalPermissions = permissions
    .map((permission) => ({
      id: permission.id,
      type: permission.type,
      role: permission.role,
      emailAddress: permission.emailAddress,
      domain: permission.domain,
      allowFileDiscovery: permission.allowFileDiscovery,
      expirationTime: permission.expirationTime,
      inherited: permission.inherited,
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const aclRevision = createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        externalObjectId: input.entry.externalObjectId,
        providerRevision: input.entry.externalVersionId,
        permissions: canonicalPermissions,
      }),
    )
    .digest("hex");
  return {
    eligibility: "eligible",
    providerRevision: input.entry.externalVersionId,
    driveId: input.entry.driveId,
    aclRevision,
    observedAt: observedAt.toISOString(),
    expiresAt: new Date(observedAt.getTime() + GOOGLE_DRIVE_ACL_FRESHNESS_MS).toISOString(),
    providerRequests,
    principals: canonicalPermissions.map((permission) => ({
      type: permission.type,
      permissionId: permission.id,
      emailAddress: permission.emailAddress,
      domain: permission.domain,
      role: permission.role,
      inherited: permission.inherited,
      allowFileDiscovery: permission.allowFileDiscovery,
      expirationTime: permission.expirationTime,
    })),
  };
}

function googleDriveDeniedAclEvidence(
  entry: Pick<GoogleDriveInventoryEntry, "externalObjectId" | "externalVersionId" | "driveId">,
  observedAt: Date,
  providerRequests: number,
) {
  return {
    eligibility: "denied" as const,
    providerRevision: entry.externalVersionId,
    driveId: entry.driveId,
    aclRevision: createHash("sha256")
      .update(
        JSON.stringify({
          version: 1,
          mode: "provider_denied",
          externalObjectId: entry.externalObjectId,
          providerRevision: entry.externalVersionId,
        }),
      )
      .digest("hex"),
    observedAt: observedAt.toISOString(),
    expiresAt: new Date(observedAt.getTime() + GOOGLE_DRIVE_ACL_FRESHNESS_MS).toISOString(),
    providerRequests,
    principals: [],
  };
}

function parseDrivePermission(value: unknown): GoogleDrivePermission {
  const row = objectRecord(value);
  if (row.deleted === true) throw new SyncFailure("provider_payload_invalid", false);
  const type = requiredString(row.type, "permission.type");
  if (type !== "user" && type !== "group" && type !== "domain" && type !== "anyone") {
    throw new SyncFailure("provider_payload_invalid", false);
  }
  const role = requiredString(row.role, "permission.role");
  if (
    role !== "owner" &&
    role !== "organizer" &&
    role !== "fileOrganizer" &&
    role !== "writer" &&
    role !== "commenter" &&
    role !== "reader"
  ) {
    throw new SyncFailure("provider_payload_invalid", false);
  }
  const permissionDetails = Array.isArray(row.permissionDetails) ? row.permissionDetails : [];
  return {
    id: requiredString(row.id, "permission.id"),
    type,
    role,
    emailAddress: optionalString(row.emailAddress),
    domain: optionalString(row.domain),
    allowFileDiscovery: typeof row.allowFileDiscovery === "boolean" ? row.allowFileDiscovery : null,
    expirationTime: optionalExactProviderTimestamp(row.expirationTime),
    inherited: permissionDetails.some((detail) => objectRecord(detail).inherited === true),
  };
}

function optionalExactProviderTimestamp(value: unknown): string | null {
  const timestamp = optionalString(value);
  if (!timestamp) return null;
  const parsed = new Date(timestamp);
  if (!Number.isFinite(parsed.getTime())) throw new SyncFailure("provider_payload_invalid", false);
  return parsed.toISOString();
}

function throwGoogleDriveResponse(response: Response): never {
  if (response.status === 401 || response.status === 403) {
    throw new SyncFailure("connection_reconnect_required", true, true);
  }
  throw new SyncFailure(
    response.status >= 500 || response.status === 429
      ? "provider_unavailable"
      : "provider_rejected",
    response.status >= 500 || response.status === 429,
  );
}

function selectedDriveSource(
  metadata: ReturnType<typeof GoogleDriveConnectionMetadata.parse>,
  externalSourceId: string,
): GoogleDriveSelectedSource | null {
  const sources =
    metadata.selectedSources ?? (metadata.selectedSource ? [metadata.selectedSource] : []);
  return sources.find((source) => source.id === externalSourceId) ?? null;
}

export function googleDriveSyncProviderAccessAllowed(input: {
  connectionVersion: number;
  resolvedConnectionVersion: number | undefined;
  connectionStatus: string;
  lifecycleState: string | undefined;
  grantedScopes: string[];
}): boolean {
  return (
    input.resolvedConnectionVersion !== undefined &&
    input.connectionVersion === input.resolvedConnectionVersion &&
    input.connectionStatus === "active" &&
    (input.lifecycleState === undefined || input.lifecycleState === "active") &&
    googleDriveScopesAllowCapability(input.grantedScopes, "recursive_source_sync")
  );
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

async function listAtlassianItems(
  source: AtlassianSelectedSource,
  cursor: string | null,
  pageSize: number,
  authorization: string | undefined,
): Promise<AtlassianInventoryPage> {
  if (!authorization) throw new SyncFailure("connection_reconnect_required", true, true);
  if (source.kind === "jira_project") {
    const url = new URL(
      `${ATLASSIAN_API_BASE}/ex/jira/${encodeURIComponent(source.cloudId)}/rest/api/3/search/jql`,
    );
    url.searchParams.set(
      "jql",
      `project = "${source.key.replaceAll('"', '\\"')}" ORDER BY key ASC`,
    );
    url.searchParams.set("maxResults", String(pageSize));
    url.searchParams.set("fields", "summary,created,updated");
    if (cursor) url.searchParams.set("nextPageToken", cursor);
    const payload = objectRecord(await atlassianJsonRequest(url, authorization, "Jira issue list"));
    const issues = Array.isArray(payload.issues) ? payload.issues : [];
    return {
      items: issues.map((raw) => {
        const row = objectRecord(raw);
        const fields = objectRecord(row.fields);
        const id = requiredAtlassianString(row.id, "issue.id");
        const key = requiredAtlassianString(row.key, "issue.key");
        const updatedAt = optionalString(fields.updated);
        return {
          id,
          key,
          title: requiredAtlassianString(fields.summary, "issue.summary"),
          version: updatedAt,
          createdAt: optionalString(fields.created),
          updatedAt,
          webUrl: new URL(`/browse/${encodeURIComponent(key)}`, source.siteUrl).toString(),
        };
      }),
      nextCursor: optionalString(payload.nextPageToken),
    };
  }

  const url = new URL(
    `${ATLASSIAN_API_BASE}/ex/confluence/${encodeURIComponent(source.cloudId)}/wiki/api/v2/spaces/${encodeURIComponent(source.resourceId)}/pages`,
  );
  url.searchParams.set("limit", String(pageSize));
  url.searchParams.set("sort", "id");
  if (cursor) url.searchParams.set("cursor", cursor);
  const payload = objectRecord(
    await atlassianJsonRequest(url, authorization, "Confluence page list"),
  );
  const pages = Array.isArray(payload.results) ? payload.results : [];
  return {
    items: pages.map((raw) => {
      const row = objectRecord(raw);
      const version = objectRecord(row.version);
      const id = requiredAtlassianString(row.id, "page.id");
      const webUi = optionalString(objectRecord(row._links).webui);
      const versionNumber = numberValue(version.number);
      return {
        id,
        key: id,
        title: requiredAtlassianString(row.title, "page.title"),
        version: versionNumber === undefined ? null : String(versionNumber),
        createdAt: optionalString(row.createdAt),
        updatedAt: optionalString(version.createdAt),
        webUrl: webUi
          ? new URL(webUi.startsWith("/wiki/") ? webUi : `/wiki${webUi}`, source.siteUrl).toString()
          : new URL(
              `/wiki/spaces/${encodeURIComponent(source.key)}/pages/${encodeURIComponent(id)}`,
              source.siteUrl,
            ).toString(),
      };
    }),
    nextCursor: confluenceCursor(objectRecord(payload._links).next),
  };
}

async function fetchAtlassianContent(
  source: AtlassianSelectedSource,
  entry: AtlassianInventoryEntry,
  authorization: string | undefined,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!authorization) throw new SyncFailure("connection_reconnect_required", true, true);
  const objectId = entry.externalObjectId.slice(entry.externalObjectId.indexOf(":") + 1);
  const markdown =
    source.kind === "jira_project"
      ? await jiraIssueMarkdown(source, objectId, entry, authorization)
      : await confluencePageMarkdown(source, objectId, entry, authorization);
  const bytes = new TextEncoder().encode(markdown);
  if (bytes.byteLength > maxBytes) throw new SyncFailure("content_too_large", false);
  return bytes;
}

async function jiraIssueMarkdown(
  source: AtlassianSelectedSource,
  issueId: string,
  entry: AtlassianInventoryEntry,
  authorization: string,
): Promise<string> {
  const issueUrl = new URL(
    `${ATLASSIAN_API_BASE}/ex/jira/${encodeURIComponent(source.cloudId)}/rest/api/3/issue/${encodeURIComponent(issueId)}`,
  );
  issueUrl.searchParams.set(
    "fields",
    "summary,description,status,issuetype,priority,assignee,reporter,labels,created,updated",
  );
  const issue = objectRecord(await atlassianJsonRequest(issueUrl, authorization, "Jira issue"));
  const fields = objectRecord(issue.fields);
  const lines = [
    `# ${entry.title}`,
    "",
    `- Key: ${optionalString(issue.key) ?? entry.title}`,
    `- Type: ${optionalString(objectRecord(fields.issuetype).name) ?? "Unknown"}`,
    `- Status: ${optionalString(objectRecord(fields.status).name) ?? "Unknown"}`,
    `- Priority: ${optionalString(objectRecord(fields.priority).name) ?? "None"}`,
    `- Assignee: ${optionalString(objectRecord(fields.assignee).displayName) ?? "Unassigned"}`,
    `- Reporter: ${optionalString(objectRecord(fields.reporter).displayName) ?? "Unknown"}`,
    `- Updated: ${optionalString(fields.updated) ?? "Unknown"}`,
    `- Source: ${entry.sourceUri}`,
    "",
    "## Description",
    "",
    adfToMarkdown(fields.description) || "No description.",
  ];
  const labels = Array.isArray(fields.labels)
    ? fields.labels.filter((value): value is string => typeof value === "string")
    : [];
  if (labels.length > 0) lines.splice(9, 0, `- Labels: ${labels.join(", ")}`);
  const comments = await jiraComments(source, issueId, authorization);
  if (comments.length > 0) {
    lines.push("", "## Comments", "");
    for (const comment of comments) {
      const row = objectRecord(comment);
      const author = optionalString(objectRecord(row.author).displayName) ?? "Unknown author";
      const created = optionalString(row.created) ?? "Unknown date";
      lines.push(`### ${author} · ${created}`, "", adfToMarkdown(row.body), "");
    }
  }
  return lines.join("\n");
}

async function jiraComments(
  source: AtlassianSelectedSource,
  issueId: string,
  authorization: string,
): Promise<unknown[]> {
  const comments: unknown[] = [];
  let startAt = 0;
  for (let page = 0; page < 20; page += 1) {
    const url = new URL(
      `${ATLASSIAN_API_BASE}/ex/jira/${encodeURIComponent(source.cloudId)}/rest/api/3/issue/${encodeURIComponent(issueId)}/comment`,
    );
    url.searchParams.set("startAt", String(startAt));
    url.searchParams.set("maxResults", "100");
    url.searchParams.set("orderBy", "created");
    const payload = objectRecord(await atlassianJsonRequest(url, authorization, "Jira comments"));
    const pageComments = Array.isArray(payload.comments) ? payload.comments : [];
    comments.push(...pageComments);
    const total = numberValue(payload.total) ?? comments.length;
    if (comments.length >= total || pageComments.length === 0) break;
    startAt += pageComments.length;
  }
  return comments;
}

async function confluencePageMarkdown(
  source: AtlassianSelectedSource,
  pageId: string,
  entry: AtlassianInventoryEntry,
  authorization: string,
): Promise<string> {
  const pageUrl = new URL(
    `${ATLASSIAN_API_BASE}/ex/confluence/${encodeURIComponent(source.cloudId)}/wiki/api/v2/pages/${encodeURIComponent(pageId)}`,
  );
  pageUrl.searchParams.set("body-format", "storage");
  const page = objectRecord(await atlassianJsonRequest(pageUrl, authorization, "Confluence page"));
  const storage = objectRecord(objectRecord(page.body).storage);
  const lines = [
    `# ${entry.title}`,
    "",
    `- Space: ${source.name} (${source.key})`,
    `- Updated: ${entry.modifiedTime ?? "Unknown"}`,
    `- Source: ${entry.sourceUri}`,
    "",
    "## Content",
    "",
    optionalString(storage.value) ?? "No content.",
  ];
  const comments = await confluenceFooterComments(source, pageId, authorization);
  if (comments.length > 0) {
    lines.push("", "## Comments", "");
    for (const comment of comments) {
      const row = objectRecord(comment);
      const body = objectRecord(objectRecord(row.body).storage);
      const version = objectRecord(row.version);
      lines.push(
        `### Comment · ${optionalString(version.createdAt) ?? "Unknown date"}`,
        "",
        optionalString(body.value) ?? "",
        "",
      );
    }
  }
  return lines.join("\n");
}

async function confluenceFooterComments(
  source: AtlassianSelectedSource,
  pageId: string,
  authorization: string,
): Promise<unknown[]> {
  const comments: unknown[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 20; page += 1) {
    const url = new URL(
      `${ATLASSIAN_API_BASE}/ex/confluence/${encodeURIComponent(source.cloudId)}/wiki/api/v2/pages/${encodeURIComponent(pageId)}/footer-comments`,
    );
    url.searchParams.set("body-format", "storage");
    url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("cursor", cursor);
    const payload = objectRecord(
      await atlassianJsonRequest(url, authorization, "Confluence page comments"),
    );
    const results = Array.isArray(payload.results) ? payload.results : [];
    comments.push(...results);
    cursor = confluenceCursor(objectRecord(payload._links).next);
    if (!cursor) break;
  }
  return comments;
}

async function atlassianJsonRequest(
  url: URL,
  authorization: string,
  label: string,
): Promise<unknown> {
  const response = await fetch(url, {
    headers: { authorization, accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 401 || response.status === 403) {
      throw new SyncFailure("connection_reconnect_required", true, true);
    }
    throw new SyncFailure(
      "provider_unavailable",
      response.status >= 500 || response.status === 429,
    );
  }
  return await readResponseJsonBounded(response, ATLASSIAN_JSON_MAX_BYTES, label);
}

export function confluenceCursor(value: unknown): string | null {
  const next = optionalString(value);
  if (!next) return null;
  const url = new URL(next, ATLASSIAN_API_BASE);
  const cursor = url.searchParams.get("cursor");
  if (!cursor || cursor.length > 4_096 || /[\u0000-\u001f]/.test(cursor)) {
    throw new Error("invalid Confluence cursor");
  }
  return cursor;
}

export function adfToMarkdown(value: unknown): string {
  const node = objectRecord(value);
  const type = optionalString(node.type);
  const children = Array.isArray(node.content) ? node.content.map(adfToMarkdown).join("") : "";
  if (type === "text") {
    let text = typeof node.text === "string" ? node.text : "";
    const marks = Array.isArray(node.marks) ? node.marks : [];
    for (const rawMark of marks) {
      const mark = objectRecord(rawMark);
      const markType = optionalString(mark.type);
      if (markType === "code") text = `\`${text}\``;
      if (markType === "strong") text = `**${text}**`;
      if (markType === "em") text = `*${text}*`;
      if (markType === "strike") text = `~~${text}~~`;
      if (markType === "link") {
        const href = optionalString(objectRecord(mark.attrs).href);
        if (href) text = `[${text}](${href})`;
      }
    }
    return text;
  }
  if (type === "paragraph") return `${children}\n\n`;
  if (type === "heading") {
    const level = Math.min(Math.max(numberValue(objectRecord(node.attrs).level) ?? 2, 1), 6);
    return `${"#".repeat(level)} ${children.trim()}\n\n`;
  }
  if (type === "hardBreak") return "  \n";
  if (type === "rule") return "---\n\n";
  if (type === "blockquote") {
    return `${children
      .trim()
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n")}\n\n`;
  }
  if (type === "bulletList") {
    return `${children.trimEnd()}\n`;
  }
  if (type === "orderedList") {
    return `${children.trimEnd()}\n`;
  }
  if (type === "listItem") {
    return `- ${children.trim().replaceAll("\n", "\n  ")}\n`;
  }
  if (type === "codeBlock") return `\`\`\`\n${children.trimEnd()}\n\`\`\`\n\n`;
  if (type === "mention") return `@${optionalString(objectRecord(node.attrs).text) ?? "user"}`;
  if (type === "emoji") return optionalString(objectRecord(node.attrs).text) ?? "";
  if (type === "inlineCard") {
    const url = optionalString(objectRecord(node.attrs).url);
    return url ? `[${url}](${url})` : "";
  }
  return children;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function requiredAtlassianString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`invalid_atlassian_${label}`);
  return value;
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

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1000);
}

function entryMetadataHash(entry: KnowledgeSyncEntry): string {
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
  reason: GoogleDriveInventoryStopReason | null,
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
