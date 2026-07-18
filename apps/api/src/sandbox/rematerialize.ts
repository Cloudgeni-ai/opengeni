import type { Settings } from "@opengeni/config";
import {
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
  establishSandboxSessionFromEnvelope,
  isProviderSandboxNotFoundError,
  serializeEstablishedSandboxEnvelope,
  tagModalSandbox,
  verifySandboxExecReadiness,
  WorkspaceArchiveIntegrityError,
  type EstablishedSandboxSession,
  type WorkspaceArchiveDescriptor,
} from "@opengeni/runtime/sandbox";

const ARCHIVE_FIELDS = [
  "workspaceArchive",
  "workspaceArchiveMeta",
  "workspaceArchivePrev",
  "workspaceArchivePrevMeta",
  "workspaceArchiveAt",
] as const;

function preserveWorkspaceArchives(
  target: Record<string, unknown> | null,
  source: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const sourceSession =
    source?.sessionState && typeof source.sessionState === "object"
      ? (source.sessionState as Record<string, unknown>)
      : undefined;
  if (!sourceSession || typeof sourceSession.workspaceArchive !== "string") return target;
  const fields: Record<string, unknown> = {};
  for (const key of ARCHIVE_FIELDS) {
    if (sourceSession[key] !== undefined && sourceSession[key] !== null) {
      fields[key] = sourceSession[key];
    }
  }
  const targetSession =
    target?.sessionState && typeof target.sessionState === "object"
      ? (target.sessionState as Record<string, unknown>)
      : {};
  return {
    ...(target ?? {}),
    ...(target?.backendId === undefined && source?.backendId !== undefined
      ? { backendId: source.backendId }
      : {}),
    sessionState: { ...targetSession, ...fields },
  };
}

async function terminateCreated(established: EstablishedSandboxSession | null): Promise<boolean> {
  if (!established) return true;
  const client = established.client as { delete?: (state: unknown) => Promise<unknown> };
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
  const spawnEnvelope = input.acquiredLease.resumeState ?? input.fallbackEnvelope;
  let established: EstablishedSandboxSession | null = null;
  let rematerialization: { id: string; selectedRevision: string } | null = null;
  try {
    if (input.acquiredLease.recovery.archive.status === "available") {
      const id = crypto.randomUUID();
      const begun = await beginSandboxRematerialization(input.db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sandboxGroupId: input.sandboxGroupId,
        expectedEpoch: input.expectedEpoch,
        rematerializationId: id,
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
      const selectedRevision = begun.lease.recovery.restore.selectedRevision;
      if (!selectedRevision) {
        throw new WorkspaceArchiveIntegrityError(
          "archive_metadata_invalid",
          "sandbox rematerialization selected no durable archive revision",
        );
      }
      rematerialization = { id, selectedRevision };
    } else if (input.acquiredLease.recovery.archive.status !== "none") {
      throw new SandboxLeaseRecoveryBlockedError(
        input.sandboxGroupId,
        input.expectedEpoch,
        "restore_degraded",
        input.acquiredLease.recovery,
      );
    }

    established = await establishSandboxSessionFromEnvelope(input.settings, spawnEnvelope, {
      sessionId: input.sessionId,
      recovery: "create-or-restore",
      backendOverride: input.backend as never,
      environment: input.environment,
      onSandboxCreated: async (created) => {
        established = created;
        const serialized =
          (await serializeEstablishedSandboxEnvelope(created)) ?? input.fallbackEnvelope;
        const resumeState = preserveWorkspaceArchives(serialized ?? null, spawnEnvelope);
        const recorded = await recordWarmingSandboxCreated(input.db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sandboxGroupId: input.sandboxGroupId,
          expectedEpoch: input.expectedEpoch,
          instanceId: created.instanceId,
          resumeBackendId: created.backendId,
          resumeState,
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
    const serialized =
      (await serializeEstablishedSandboxEnvelope(established)) ?? input.fallbackEnvelope;
    const resumeState =
      established.origin === "restored"
        ? preserveWorkspaceArchives(serialized ?? null, spawnEnvelope)
        : serialized;
    const committed = await commitWarmingToWarm(input.db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sandboxGroupId: input.sandboxGroupId,
      expectedEpoch: input.expectedEpoch,
      instanceId: established.instanceId,
      dataPlaneUrl: input.dataPlaneUrl,
      resumeBackendId: established.backendId,
      resumeState: resumeState ?? null,
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
