// Target-owned Modal lease establishment and provider-gone recovery.
//
// This is the DB-coupled half of the runtime leaf's typed `outcome:"gone"`.
// The leaf never licenses create on a warm/rearmed/attached path. This module
// first wins the exact `(lease_epoch, instance_id)` warm->warming election,
// checkpoints the replacement id immediately after provider create, and only
// then commits warming->warm (lease_epoch++) together with active-route epoch
// invalidation. It is shared by worker and API routing construction so a named
// Modal target has ONE lifecycle keyed by `sandboxes.id`; it never reads a
// caller session's home envelope.

import type { Settings } from "@opengeni/config";
import {
  acquireLease,
  claimGoneLeaseReclaim,
  commitWarmingToWarm,
  failWarmingToCold,
  heartbeatLeaseHolder,
  readLease,
  recordWarmingSandboxCreated,
  releaseLeaseHolder,
  touchLeaseHolder,
  SandboxLeaseSupersededError,
  type Database,
  type LeaseHolderKind,
  type LeaseSnapshot,
} from "@opengeni/db";
import {
  establishSandboxSessionFromEnvelope,
  isSandboxInstanceGoneOutcome,
  serializeEstablishedSandboxEnvelope,
  tagModalSandbox,
  type EstablishedSandboxSession,
  type RuntimeMetricsHooks,
  type SandboxInstanceGoneOutcome,
} from "@opengeni/runtime/sandbox";

const DEFAULT_POLL_INTERVAL_MS = 100;

export class SandboxLeaseWarmingTimeoutError extends Error {
  readonly name = "SandboxLeaseWarmingTimeoutError";
  readonly code = "sandbox_warming_timeout";

  constructor(
    public readonly sandboxGroupId: string,
    public readonly timeoutMs: number,
  ) {
    super(
      `Sandbox lease ${sandboxGroupId} did not finish materializing within ${Math.ceil(timeoutMs / 1000)}s.`,
    );
  }
}

export type LeaseRouteIdentity = {
  /** `null` is a session home/group target; a UUID is a first-class named
   * sandbox target. This value decides which sessions' routing cache epoch is
   * advanced when the SAME logical target is rematerialized. */
  targetSandboxId: string | null;
};

export type WarmLeaseEstablishInput = {
  db: Database;
  settings: Settings;
  accountId: string;
  workspaceId: string;
  sandboxGroupId: string;
  /** Provider-facing logical identity. A named target MUST pass its own
   * `sandboxes.id`, never the calling session id. */
  lifecycleSessionId: string;
  backend: string;
  environment?: Record<string, string>;
  metrics?: RuntimeMetricsHooks;
  initialLease: LeaseSnapshot;
  /** Home-only fallback. Named targets must pass null; their lease.resumeState
   * is the only valid envelope. */
  fallbackEnvelope: Record<string, unknown> | null;
  route: LeaseRouteIdentity;
  /** Optional setup between create and warm commit. It may return a freshly
   * resolved desktop URL to fold into the same commit. */
  prepareReplacement?: (
    established: EstablishedSandboxSession,
  ) => Promise<{ dataPlaneUrl?: string | null } | void>;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export type WarmLeaseEstablishResult = {
  established: EstablishedSandboxSession;
  lease: LeaseSnapshot;
  rematerialized: boolean;
};

function workspaceArchiveFromEnvelope(
  envelope: Record<string, unknown> | null | undefined,
): string | null {
  const sessionState =
    envelope && typeof envelope.sessionState === "object" && envelope.sessionState !== null
      ? (envelope.sessionState as Record<string, unknown>)
      : null;
  const archive = sessionState?.workspaceArchive;
  return typeof archive === "string" && archive.length > 0 ? archive : null;
}

function preserveWorkspaceArchive(
  resumeState: Record<string, unknown> | null,
  archiveSource: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const archive = workspaceArchiveFromEnvelope(archiveSource);
  if (!archive) return resumeState;
  const currentSessionState =
    resumeState && typeof resumeState.sessionState === "object" && resumeState.sessionState !== null
      ? (resumeState.sessionState as Record<string, unknown>)
      : {};
  const sourceSessionState =
    archiveSource &&
    typeof archiveSource.sessionState === "object" &&
    archiveSource.sessionState !== null
      ? (archiveSource.sessionState as Record<string, unknown>)
      : {};
  return {
    ...(resumeState ?? {}),
    ...(resumeState?.backendId === undefined && archiveSource?.backendId !== undefined
      ? { backendId: archiveSource.backendId }
      : {}),
    sessionState: {
      ...currentSessionState,
      workspaceArchive: archive,
      ...(typeof sourceSessionState.workspaceArchivePrev === "string"
        ? { workspaceArchivePrev: sourceSessionState.workspaceArchivePrev }
        : {}),
      ...(typeof sourceSessionState.workspaceArchiveAt === "string"
        ? { workspaceArchiveAt: sourceSessionState.workspaceArchiveAt }
        : {}),
    },
  };
}

/** Terminate ONLY the exact handle this invocation created. Never use this for
 * a resumed/non-owned handle. The lease/reaper remains the backstop if the
 * provider termination itself fails. */
export async function terminateExactCreatedSandbox(
  established: EstablishedSandboxSession | null | undefined,
): Promise<boolean> {
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
  } catch {
    return false;
  }
}

function exactObservedInstance(lease: LeaseSnapshot, gone: SandboxInstanceGoneOutcome): string {
  const observed = gone.observedInstanceId ?? lease.instanceId;
  // unix_local uses an empty string as its existing identity. It is still an
  // exact SQL value; only null means no checkpoint.
  if (observed === null || lease.instanceId === null || observed !== lease.instanceId) {
    throw new SandboxLeaseSupersededError(lease.sandboxGroupId, lease.leaseEpoch);
  }
  return observed;
}

async function rollbackOwnedWarming(
  input: WarmLeaseEstablishInput,
  expectedEpoch: number,
  expectedInstanceId: string | null,
): Promise<void> {
  await failWarmingToCold(input.db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sandboxGroupId: input.sandboxGroupId,
    expectedEpoch,
    expectedInstanceId,
  });
}

async function materializeOwnedWarming(
  input: WarmLeaseEstablishInput,
  lease: LeaseSnapshot,
  restoreEnvelope: Record<string, unknown> | null,
  gone: SandboxInstanceGoneOutcome | undefined,
  expectedPriorInstanceId: string | null,
  advanceActiveRoute: boolean,
): Promise<WarmLeaseEstablishResult> {
  const expectedEpoch = lease.leaseEpoch;
  let created: EstablishedSandboxSession | null = null;
  let recorded = false;
  // Hydration may replace a freshly-created placeholder and invoke the callback
  // again with a new exact id. Chain each CAS from the id the previous callback
  // durably checkpointed rather than repeatedly from the pre-create identity.
  let checkpointedInstanceId = expectedPriorInstanceId;
  try {
    const established = await establishSandboxSessionFromEnvelope(input.settings, restoreEnvelope, {
      sessionId: input.lifecycleSessionId,
      backendOverride: input.backend as never,
      ...(input.environment ? { environment: input.environment } : {}),
      ...(input.metrics ? { metrics: input.metrics } : {}),
      createPolicy: "lease_owner",
      ...(gone ? { gone } : {}),
      onSandboxCreated: async (next) => {
        created = next;
        const serialized = preserveWorkspaceArchive(
          (await serializeEstablishedSandboxEnvelope(next)) ?? null,
          restoreEnvelope,
        );
        const checkpoint = await recordWarmingSandboxCreated(input.db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sandboxGroupId: input.sandboxGroupId,
          expectedEpoch,
          expectedPriorInstanceId: checkpointedInstanceId,
          instanceId: next.instanceId,
          resumeBackendId: next.backendId,
          resumeState: serialized,
          leaseTtlMs: input.settings.sandboxLeaseTtlMs,
          warmingLeaseTtlMs: input.settings.sandboxWarmingTimeoutMs,
        });
        if (!checkpoint.recorded) {
          throw new SandboxLeaseSupersededError(input.sandboxGroupId, expectedEpoch);
        }
        recorded = true;
        checkpointedInstanceId = next.instanceId;
        if (next.backendId === "modal") {
          await tagModalSandbox(input.settings, next.instanceId, {
            leaseId: lease.id,
            workspaceId: input.workspaceId,
            sandboxGroupId: input.sandboxGroupId,
          }).catch(() => undefined);
        }
      },
    });
    created = established;
    const prepared = await input.prepareReplacement?.(established);
    const finalEnvelope = preserveWorkspaceArchive(
      (await serializeEstablishedSandboxEnvelope(established)) ?? null,
      restoreEnvelope,
    );
    const committed = await commitWarmingToWarm(input.db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sandboxGroupId: input.sandboxGroupId,
      expectedEpoch,
      expectedWarmingInstanceId: established.instanceId,
      instanceId: established.instanceId,
      dataPlaneUrl: prepared?.dataPlaneUrl ?? null,
      resumeBackendId: established.backendId,
      resumeState: finalEnvelope,
      leaseTtlMs: input.settings.sandboxLeaseTtlMs,
      ...(advanceActiveRoute ? { advanceActiveRoute: input.route } : {}),
    });
    if (!committed.committed || !committed.lease) {
      throw new SandboxLeaseSupersededError(input.sandboxGroupId, expectedEpoch);
    }
    return {
      established,
      lease: committed.lease,
      rematerialized: advanceActiveRoute,
    };
  } catch (error) {
    const terminated = await terminateExactCreatedSandbox(created);
    if (terminated) {
      // If the callback never checkpointed the new id, the row still carries the
      // prior identity; otherwise it carries exactly the created id. The identity
      // fence makes this rollback a no-op if another creator already replaced it.
      await rollbackOwnedWarming(
        input,
        expectedEpoch,
        recorded ? checkpointedInstanceId : expectedPriorInstanceId,
      ).catch(() => undefined);
    }
    throw error;
  }
}

/** Resume a live lease without create permission. A typed provider-gone outcome
 * triggers the exact reclaim election; losers wait/re-read and never create. */
export async function establishWarmLeaseSandbox(
  input: WarmLeaseEstablishInput,
): Promise<WarmLeaseEstablishResult> {
  if (input.route.targetSandboxId !== null && input.fallbackEnvelope !== null) {
    throw new Error("named Modal targets must not use a session home envelope fallback");
  }
  const now = input.now ?? Date.now;
  const wait =
    input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + input.settings.sandboxWarmingTimeoutMs;
  let lease: LeaseSnapshot | null = input.initialLease;

  for (;;) {
    if (!lease) {
      throw new SandboxLeaseSupersededError(input.sandboxGroupId, 0);
    }
    if (lease.liveness === "warming") {
      if (now() >= deadline) {
        throw new SandboxLeaseWarmingTimeoutError(
          input.sandboxGroupId,
          input.settings.sandboxWarmingTimeoutMs,
        );
      }
      await wait(input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
      lease = await readLease(input.db, input.workspaceId, input.sandboxGroupId);
      continue;
    }
    if (lease.liveness !== "warm" && lease.liveness !== "draining") {
      throw new SandboxLeaseSupersededError(input.sandboxGroupId, lease.leaseEpoch);
    }

    const envelope = lease.resumeState ?? input.fallbackEnvelope;
    const established = await establishSandboxSessionFromEnvelope(input.settings, envelope, {
      sessionId: input.lifecycleSessionId,
      backendOverride: input.backend as never,
      ...(input.environment ? { environment: input.environment } : {}),
      ...(input.metrics ? { metrics: input.metrics } : {}),
      createPolicy: "never",
    });
    if (!isSandboxInstanceGoneOutcome(established)) {
      return { established, lease, rematerialized: false };
    }

    // A draining row is not reclaimable until a holder re-arms it through
    // acquireLease. Never turn this into an out-of-band create.
    if (lease.liveness !== "warm") {
      throw new SandboxLeaseSupersededError(input.sandboxGroupId, lease.leaseEpoch);
    }
    const observedInstanceId = exactObservedInstance(lease, established);
    const election = await claimGoneLeaseReclaim(input.db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sandboxGroupId: input.sandboxGroupId,
      observedLeaseEpoch: lease.leaseEpoch,
      observedInstanceId,
      warmingLeaseTtlMs: input.settings.sandboxWarmingTimeoutMs,
    });
    if (election.role === "owner") {
      return await materializeOwnedWarming(
        input,
        election.lease,
        envelope,
        established,
        observedInstanceId,
        true,
      );
    }
    // waiting or fenced: no permission to create. Re-read until the elected
    // owner commits, fails cold, or the bounded warming deadline expires.
    lease = election.lease ?? (await readLease(input.db, input.workspaceId, input.sandboxGroupId));
  }
}

export type NamedModalTargetInput = Omit<
  WarmLeaseEstablishInput,
  | "sandboxGroupId"
  | "initialLease"
  | "fallbackEnvelope"
  | "route"
  | "backend"
  | "lifecycleSessionId"
> & {
  sandboxId: string;
  holderKind: LeaseHolderKind;
  holderId: string;
  subjectId: string;
  image?: string;
  /** Holder + lease heartbeat cadence. Production defaults to 10s; focused
   * lifecycle tests may shorten it to prove post-establishment renewal without
   * sleeping through the production interval. */
  heartbeatIntervalMs?: number;
};

export type NamedModalTargetResult = WarmLeaseEstablishResult & {
  /** Stop the operation-owned automatic heartbeat without releasing the holder.
   * Long-lived viewer attaches hand heartbeat ownership to the client after the
   * attach response; retaining this timer there would keep an abandoned viewer
   * alive forever and defeat stale-holder eviction. */
  stopAutomaticHeartbeat: () => void;
  /** Idempotent target-holder release. Never terminates the provider box. */
  release: () => Promise<void>;
};

/** Establish a first-class named Modal target under `sandboxes.id` ownership.
 * Absence of a lease is a clean named cold start. No session envelope is read or
 * accepted; the target's lease.resumeState is its sole recovery descriptor. */
export async function establishNamedModalTarget(
  input: NamedModalTargetInput,
): Promise<NamedModalTargetResult> {
  const heartbeatIntervalMs = Math.max(1, input.heartbeatIntervalMs ?? 10_000);
  let released = false;
  let holderTouchTimer: ReturnType<typeof setInterval> | undefined;
  let leaseHeartbeatTimer: ReturnType<typeof setInterval> | undefined;
  const stopAutomaticHeartbeat = (): void => {
    if (holderTouchTimer) {
      clearInterval(holderTouchTimer);
      holderTouchTimer = undefined;
    }
    if (leaseHeartbeatTimer) {
      clearInterval(leaseHeartbeatTimer);
      leaseHeartbeatTimer = undefined;
    }
  };
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    stopAutomaticHeartbeat();
    await releaseLeaseHolder(input.db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sandboxGroupId: input.sandboxId,
      kind: input.holderKind,
      holderId: input.holderId,
      idleGraceMs: input.settings.sandboxIdleGraceMs,
    });
  };

  const acquired = await acquireLease(input.db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sandboxGroupId: input.sandboxId,
    kind: input.holderKind,
    holderId: input.holderId,
    subjectId: input.subjectId,
    backend: "modal",
    os: "linux",
    ...(input.image ? { image: input.image } : {}),
    leaseTtlMs: input.settings.sandboxLeaseTtlMs,
    warmingLeaseTtlMs: input.settings.sandboxWarmingTimeoutMs,
  });
  if (acquired.role === "fenced") {
    await release();
    throw new SandboxLeaseSupersededError(input.sandboxId, acquired.lease.leaseEpoch);
  }

  holderTouchTimer = setInterval(() => {
    void touchLeaseHolder(input.db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sandboxGroupId: input.sandboxId,
      kind: input.holderKind,
      holderId: input.holderId,
    }).catch(() => undefined);
  }, heartbeatIntervalMs);
  holderTouchTimer.unref?.();

  const warmInput: WarmLeaseEstablishInput = {
    db: input.db,
    settings: input.settings,
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sandboxGroupId: input.sandboxId,
    lifecycleSessionId: input.sandboxId,
    backend: "modal",
    ...(input.environment ? { environment: input.environment } : {}),
    ...(input.metrics ? { metrics: input.metrics } : {}),
    initialLease: acquired.lease,
    fallbackEnvelope: null,
    route: { targetSandboxId: input.sandboxId },
    ...(input.prepareReplacement ? { prepareReplacement: input.prepareReplacement } : {}),
    ...(input.pollIntervalMs !== undefined ? { pollIntervalMs: input.pollIntervalMs } : {}),
    ...(input.sleep ? { sleep: input.sleep } : {}),
    ...(input.now ? { now: input.now } : {}),
  };

  try {
    const result =
      acquired.role === "spawner"
        ? await materializeOwnedWarming(
            warmInput,
            acquired.lease,
            // Named cold start: target-owned state is absent by definition.
            acquired.lease.resumeState,
            undefined,
            null,
            // Epoch 0 is the first materialization. Any later cold rematerialize
            // is the SAME logical target and must invalidate active route caches.
            acquired.lease.leaseEpoch > 0,
          )
        : await establishWarmLeaseSandbox(warmInput);
    if (holderTouchTimer) {
      clearInterval(holderTouchTimer);
      holderTouchTimer = undefined;
    }
    // Establishment can outlive the normal 90s lease TTL and the returned
    // target may be used for an arbitrarily long turn/viewer operation. Keep
    // both the exact holder row and lease epoch live until release; stopping at
    // establishment made the reaper evict a still-running named target.
    leaseHeartbeatTimer = setInterval(() => {
      void heartbeatLeaseHolder(input.db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sandboxGroupId: input.sandboxId,
        kind: input.holderKind,
        holderId: input.holderId,
        leaseTtlMs: input.settings.sandboxLeaseTtlMs,
        expectedEpoch: result.lease.leaseEpoch,
      })
        .then((alive) => {
          if (!alive && leaseHeartbeatTimer) {
            clearInterval(leaseHeartbeatTimer);
            leaseHeartbeatTimer = undefined;
          }
        })
        .catch(() => undefined);
    }, heartbeatIntervalMs);
    leaseHeartbeatTimer.unref?.();
    return { ...result, stopAutomaticHeartbeat, release };
  } catch (error) {
    await release().catch(() => undefined);
    throw error;
  }
}
