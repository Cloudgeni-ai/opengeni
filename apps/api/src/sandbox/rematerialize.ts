import type { Settings } from "@opengeni/config";
import {
  adoptLegacyModalCheckpointArtifact,
  beginSandboxRematerialization,
  commitWarmingToWarm,
  failSandboxRematerialization,
  failWarmingToCold,
  markSandboxRestoreVerifying,
  recordWarmingSandboxCreated,
  SandboxLeaseRecoveryBlockedError,
  SandboxLeaseSupersededError,
  type Database,
  type LeaseSnapshot,
} from "@opengeni/db";
import {
  describeLegacyNativeSnapshotArchive,
  establishSandboxSessionFromEnvelope,
  isProviderSandboxNotFoundError,
  modalSessionMatchesCheckpointProviderBinding,
  parseWorkspaceArchiveDescriptor,
  requirePersistableReplacementSandboxEnvelope,
  resolveModalCheckpointProviderBindingForSession,
  serializeReplacementSandboxEnvelope,
  tagModalSandbox,
  verifySandboxExecReadiness,
  WorkspaceArchiveIntegrityError,
  type EstablishedSandboxSession,
  type WorkspaceArchiveDescriptor,
} from "@opengeni/runtime/sandbox";

function hasWorkspaceArchive(envelope: Record<string, unknown> | null): boolean {
  const sessionState =
    envelope?.sessionState && typeof envelope.sessionState === "object"
      ? (envelope.sessionState as Record<string, unknown>)
      : null;
  return (
    typeof sessionState?.workspaceArchive === "string" && sessionState.workspaceArchive.length > 0
  );
}

function legacyNativeArchiveFromEnvelope(envelope: Record<string, unknown> | null) {
  const sessionState =
    envelope?.sessionState && typeof envelope.sessionState === "object"
      ? (envelope.sessionState as Record<string, unknown>)
      : null;
  if (!sessionState) return null;
  const existing = parseWorkspaceArchiveDescriptor(sessionState.workspaceArchiveMeta);
  if (existing?.version === 2) return null;
  return describeLegacyNativeSnapshotArchive(
    sessionState.workspaceArchive,
    existing?.version === 1 ? Date.parse(existing.capturedAt) : Date.now(),
  );
}

function withoutProviderIdentity(
  envelope: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!envelope) return null;
  const sessionState =
    envelope.sessionState && typeof envelope.sessionState === "object"
      ? (envelope.sessionState as Record<string, unknown>)
      : null;
  if (!sessionState) return envelope;
  const { providerState: _providerState, ...providerIndependentState } = sessionState;
  return { ...envelope, sessionState: providerIndependentState };
}

async function terminateCreated(established: EstablishedSandboxSession | null): Promise<boolean> {
  if (!established) return true;
  const client = established.client as {
    delete?: (state: unknown) => Promise<unknown>;
  };
  try {
    if (typeof client.delete === "function" && established.sessionState !== undefined) {
      await client.delete(established.sessionState);
      return true;
    }
    const session = established.session as {
      terminate?: () => Promise<unknown>;
      kill?: () => Promise<unknown>;
      close?: () => Promise<unknown>;
      closed?: boolean;
    };
    if (session.terminate) await session.terminate();
    else if (session.kill) await session.kill();
    else if (session.close && !session.closed) await session.close();
    else return false;
    return true;
  } catch (error) {
    return isProviderSandboxNotFoundError(established.backendId, error);
  }
}

/** The sole API-direct cold->warming owner path used by Channel A and viewer
 * attach. It never publishes warm until archive identity, hydrated tree, command
 * routing, provider identity, and the selected rematerialization attempt all
 * agree under one lease epoch. */
export async function establishApiSandboxSpawner(input: {
  db: Database;
  settings: Settings;
  accountId: string;
  workspaceId: string;
  sandboxGroupId: string;
  sessionId: string;
  backend: string;
  environment: Record<string, string>;
  expectedEpoch: number;
  acquiredLease: LeaseSnapshot;
  fallbackEnvelope: Record<string, unknown> | null;
  dataPlaneUrl: string | null;
}): Promise<{ established: EstablishedSandboxSession; lease: LeaseSnapshot }> {
  const fallbackArchiveEnvelope =
    input.acquiredLease.recovery.archive.status === "none" &&
    hasWorkspaceArchive(input.fallbackEnvelope)
      ? withoutProviderIdentity(input.fallbackEnvelope)
      : null;
  let spawnEnvelope =
    fallbackArchiveEnvelope ?? input.acquiredLease.resumeState ?? input.fallbackEnvelope;
  const archiveSource =
    input.acquiredLease.recovery.archive.status === "none"
      ? fallbackArchiveEnvelope
      : input.acquiredLease.resumeState;
  let established: EstablishedSandboxSession | null = null;
  let rematerialization: {
    id: string;
    selectedRevision: string;
    workspaceGeneration: number;
    providerBindingKey: string | null;
    legacyCheckpoint: ReturnType<typeof legacyNativeArchiveFromEnvelope>;
    legacyProviderBinding: Awaited<
      ReturnType<typeof resolveModalCheckpointProviderBindingForSession>
    > | null;
  } | null = null;
  try {
    if (
      input.acquiredLease.recovery.archive.status === "available" ||
      hasWorkspaceArchive(archiveSource)
    ) {
      const id = crypto.randomUUID();
      const legacyNativeArchive = legacyNativeArchiveFromEnvelope(archiveSource);
      const begun = await beginSandboxRematerialization(input.db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sandboxGroupId: input.sandboxGroupId,
        expectedEpoch: input.expectedEpoch,
        rematerializationId: id,
        archiveSource,
        legacyNativeArchive,
      });
      if (begun.status !== "started") {
        if (begun.code === "stale_epoch" || begun.code === "attempt_conflict") {
          throw new SandboxLeaseSupersededError(
            input.sandboxGroupId,
            begun.lease?.leaseEpoch ?? input.expectedEpoch,
          );
        }
        throw new SandboxLeaseRecoveryBlockedError(
          input.sandboxGroupId,
          begun.lease?.leaseEpoch ?? input.expectedEpoch,
          begun.code === "archive_unverified" ? "restore_degraded" : "restore_unrecoverable",
          begun.lease?.recovery ?? input.acquiredLease.recovery,
        );
      }
      spawnEnvelope = begun.lease.resumeState ?? spawnEnvelope;
      const selectedRevision = begun.lease.recovery.restore.selectedRevision;
      if (!selectedRevision) {
        throw new WorkspaceArchiveIntegrityError(
          "archive_metadata_invalid",
          "sandbox rematerialization selected no durable archive revision",
        );
      }
      rematerialization = {
        id,
        selectedRevision,
        workspaceGeneration: begun.lease.workspaceGeneration,
        providerBindingKey: begun.checkpointArtifact?.providerBindingKey ?? null,
        legacyCheckpoint: begun.checkpointArtifact === null ? legacyNativeArchive : null,
        legacyProviderBinding: null,
      };
    } else if (input.acquiredLease.recovery.archive.status !== "none") {
      throw new SandboxLeaseRecoveryBlockedError(
        input.sandboxGroupId,
        input.expectedEpoch,
        "restore_degraded",
        input.acquiredLease.recovery,
      );
    }

    const providerCreateStartedAt = new Date();
    established = await establishSandboxSessionFromEnvelope(input.settings, spawnEnvelope, {
      sessionId: input.sessionId,
      recovery: "create-or-restore",
      backendOverride: input.backend as never,
      environment: input.environment,
      onSandboxCreated: async (created) => {
        established = created;
        if (
          rematerialization &&
          (rematerialization.providerBindingKey || rematerialization.legacyCheckpoint)
        ) {
          if (created.backendId !== "modal") {
            throw new WorkspaceArchiveIntegrityError(
              "native_snapshot_reference_invalid",
              "Modal checkpoint restore resolved a non-Modal sandbox backend",
            );
          }
          if (rematerialization.providerBindingKey) {
            if (
              !(await modalSessionMatchesCheckpointProviderBinding(
                input.settings,
                created.session,
                rematerialization.providerBindingKey,
              ))
            ) {
              throw new WorkspaceArchiveIntegrityError(
                "native_snapshot_reference_invalid",
                "Modal checkpoint restore refused because the authenticated provider workspace changed",
              );
            }
          } else {
            rematerialization.legacyProviderBinding =
              await resolveModalCheckpointProviderBindingForSession(
                input.settings,
                created.session,
              );
          }
        }
        const resumeState = requirePersistableReplacementSandboxEnvelope(
          await serializeReplacementSandboxEnvelope(created, spawnEnvelope),
          created.backendId,
        );
        const recorded = await recordWarmingSandboxCreated(input.db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sandboxGroupId: input.sandboxGroupId,
          expectedEpoch: input.expectedEpoch,
          rematerializationId: rematerialization?.id ?? null,
          instanceId: created.instanceId,
          resumeBackendId: created.backendId,
          resumeState,
          ...(created.backendId === "modal"
            ? {
                providerCreatedAt: providerCreateStartedAt,
                providerDeadlineAt: new Date(
                  providerCreateStartedAt.getTime() + input.settings.modalTimeoutSeconds * 1000,
                ),
              }
            : {}),
          leaseTtlMs: input.settings.sandboxLeaseTtlMs,
          warmingLeaseTtlMs: input.settings.sandboxWarmingTimeoutMs,
        });
        if (!recorded.recorded) {
          throw new SandboxLeaseSupersededError(input.sandboxGroupId, input.expectedEpoch);
        }
        if (created.backendId === "modal") {
          await tagModalSandbox(input.settings, created.instanceId, {
            leaseId: input.acquiredLease.id,
            workspaceId: input.workspaceId,
            sandboxGroupId: input.sandboxGroupId,
          }).catch(() => undefined);
        }
      },
      onWorkspaceRestoreVerifying: async (descriptor: WorkspaceArchiveDescriptor) => {
        if (!rematerialization || descriptor.revision !== rematerialization.selectedRevision) {
          throw new WorkspaceArchiveIntegrityError(
            "archive_metadata_invalid",
            `hydrated archive revision ${descriptor.revision} does not match the selected rematerialization revision`,
          );
        }
        if (rematerialization.legacyCheckpoint) {
          const binding = rematerialization.legacyProviderBinding;
          if (!binding) {
            throw new WorkspaceArchiveIntegrityError(
              "native_snapshot_reference_invalid",
              "Legacy Modal checkpoint restore produced no authenticated provider identity",
            );
          }
          const adopted = await adoptLegacyModalCheckpointArtifact(input.db, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sandboxGroupId: input.sandboxGroupId,
            leaseId: input.acquiredLease.id,
            leaseEpoch: input.expectedEpoch,
            workspaceGeneration: rematerialization.workspaceGeneration,
            slot: "current",
            archiveBase64: rematerialization.legacyCheckpoint.archiveBase64,
            descriptor: rematerialization.legacyCheckpoint.descriptor,
            providerBindingKey: binding.key,
            providerBinding: binding.binding,
            rematerializationId: rematerialization.id,
          });
          if (!adopted) {
            throw new SandboxLeaseSupersededError(input.sandboxGroupId, input.expectedEpoch);
          }
          rematerialization.providerBindingKey = binding.key;
        }
        const verifying = await markSandboxRestoreVerifying(input.db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sandboxGroupId: input.sandboxGroupId,
          expectedEpoch: input.expectedEpoch,
          rematerializationId: rematerialization.id,
        });
        if (!verifying.wrote) {
          throw new SandboxLeaseSupersededError(input.sandboxGroupId, input.expectedEpoch);
        }
      },
    });

    await verifySandboxExecReadiness(established);
    if (
      rematerialization &&
      established.restoredArchive?.revision !== rematerialization.selectedRevision
    ) {
      throw new WorkspaceArchiveIntegrityError(
        "workspace_fingerprint_mismatch",
        "sandbox restore completed without the exact selected durable archive revision",
      );
    }
    const resumeState = requirePersistableReplacementSandboxEnvelope(
      await serializeReplacementSandboxEnvelope(established, spawnEnvelope),
      established.backendId,
    );
    const committed = await commitWarmingToWarm(input.db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sandboxGroupId: input.sandboxGroupId,
      expectedEpoch: input.expectedEpoch,
      instanceId: established.instanceId,
      dataPlaneUrl: input.dataPlaneUrl,
      resumeBackendId: established.backendId,
      resumeState,
      ...(rematerialization
        ? {
            rematerialization: {
              id: rematerialization.id,
              verifiedRevision: rematerialization.selectedRevision,
            },
          }
        : {}),
      leaseTtlMs: input.settings.sandboxLeaseTtlMs,
    });
    if (!committed.committed || !committed.lease) {
      const terminated = await terminateCreated(established);
      if (terminated && rematerialization) {
        await failSandboxRematerialization(input.db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sandboxGroupId: input.sandboxGroupId,
          expectedEpoch: input.expectedEpoch,
          rematerializationId: rematerialization.id,
          failureCode: committed.reason ?? "warm_commit_rejected",
          retryable: false,
        });
      } else if (terminated) {
        await failWarmingToCold(input.db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sandboxGroupId: input.sandboxGroupId,
          expectedEpoch: input.expectedEpoch,
        });
      }
      throw new SandboxLeaseSupersededError(input.sandboxGroupId, input.expectedEpoch);
    }
    return { established, lease: committed.lease };
  } catch (error) {
    if (error instanceof SandboxLeaseSupersededError) throw error;
    const terminated = await terminateCreated(established);
    if (terminated) {
      if (rematerialization) {
        await failSandboxRematerialization(input.db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sandboxGroupId: input.sandboxGroupId,
          expectedEpoch: input.expectedEpoch,
          rematerializationId: rematerialization.id,
          failureCode:
            error instanceof WorkspaceArchiveIntegrityError
              ? error.code
              : "sandbox_rematerialization_failed",
          retryable: error instanceof WorkspaceArchiveIntegrityError ? error.retryable : true,
        });
      } else {
        await failWarmingToCold(input.db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sandboxGroupId: input.sandboxGroupId,
          expectedEpoch: input.expectedEpoch,
        });
      }
    }
    throw error;
  }
}
