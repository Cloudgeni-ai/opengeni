// The one owner of compute sandboxes nothing durable names any more.
//
// The fabric is the inventory: every sandbox Opengeni creates carries its
// deployment's gateway, workspace, sandbox group and enrollment in its metadata.
// A sandbox whose enrollment is no longer the live box of its group (a create
// whose answer was lost, a cleanup that failed, a worker that crashed between
// create and commit, a workspace deleted with everything in it) has its
// enrollment revoked and is deleted here. Nothing on this path messages its agent,
// so the sweep never wakes or keeps awake a sleeping sandbox.

import type { ComputeFabricClient, ComputeSandboxView } from "./fabric";

/**
 * How long a create the fabric has never seen may still arrive there, and how
 * long a new sandbox may wait for its create to commit. Nothing younger is
 * treated as abandoned.
 */
export const UNSEEN_CREATE_SETTLE_MS = 10 * 60_000;

/** The metadata a compute create stamps on its sandbox. */
export const COMPUTE_METADATA = {
  gateway: "opengeni_gateway",
  workspaceId: "opengeni_workspace_id",
  sandboxGroupId: "opengeni_sandbox_group_id",
  enrollmentId: "opengeni_enrollment_id",
} as const;

/** The Opengeni identity of one fabric sandbox, from its create's metadata. */
export type ComputeSandboxIdentity = {
  sandboxId: string;
  workspaceId: string;
  sandboxGroupId: string;
  enrollmentId: string;
};

/** Deletions per sweep, so one pass stays short; the next pass continues. */
export const COMPUTE_ORPHAN_SWEEP_LIMIT = 50;

export type ComputeOrphanSweepResult = {
  examined: number;
  deleted: ComputeSandboxIdentity[];
  failed: number;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function identityOf(view: ComputeSandboxView): ComputeSandboxIdentity | null {
  const workspaceId = view.metadata?.[COMPUTE_METADATA.workspaceId];
  const sandboxGroupId = view.metadata?.[COMPUTE_METADATA.sandboxGroupId];
  const enrollmentId = view.metadata?.[COMPUTE_METADATA.enrollmentId];
  // Opengeni names everything with UUIDs; anything else is not its sandbox.
  if (![workspaceId, sandboxGroupId, enrollmentId].every((id) => id && UUID.test(id))) {
    return null;
  }
  if (!workspaceId || !sandboxGroupId || !enrollmentId) return null;
  // The agent the sandbox runs is the enrollment its create named.
  if (view.agent && (view.agent.agent !== enrollmentId || view.agent.workspace !== workspaceId)) {
    return null;
  }
  return { sandboxId: view.id, workspaceId, sandboxGroupId, enrollmentId };
}

/** Orphans handled at once, so one stalled delete never holds up the rest. */
export const COMPUTE_ORPHAN_SWEEP_CONCURRENCY = 8;

/** How long a candidate whose cleanup failed sits out, doubling per failure. */
export const COMPUTE_ORPHAN_RETRY_BASE_MS = 10 * 60_000;
export const COMPUTE_ORPHAN_RETRY_MAX_MS = 60 * 60_000;

/**
 * What one sweeper carries from pass to pass, so every listed sandbox is
 * reached in turn: each pass resumes after the last candidate the previous one
 * reached (wrapping around), and a candidate whose cleanup failed sits out a
 * growing interval instead of using up the next pass. Kept in memory; a fresh
 * sweeper simply starts at the oldest sandbox.
 */
export type ComputeOrphanSweepProgress = {
  cursor: string | undefined;
  failures: Map<string, { count: number; retryAtMs: number }>;
};

export function createComputeOrphanSweepProgress(): ComputeOrphanSweepProgress {
  return { cursor: undefined, failures: new Map() };
}

/** A stable traversal order: oldest first, the sandbox id breaking ties. */
function traversalKey(view: Pick<ComputeSandboxView, "id" | "created_ms">): string {
  return `${String(Math.max(0, Math.floor(view.created_ms))).padStart(16, "0")}:${view.id}`;
}

/** `ordered` (sorted by key) resumed after `cursor`, wrapping around. */
function resumedAfter<T extends { key: string }>(ordered: T[], cursor: string | undefined): T[] {
  const resumeAt = cursor === undefined ? 0 : ordered.findIndex((entry) => entry.key > cursor);
  return resumeAt <= 0 ? ordered : [...ordered.slice(resumeAt), ...ordered.slice(0, resumeAt)];
}

/** Sit `id` out for a growing interval after a failed cleanup. */
function deferFailed(progress: ComputeOrphanSweepProgress, id: string, nowMs: number): void {
  const count = (progress.failures.get(id)?.count ?? 0) + 1;
  const delay = Math.min(
    COMPUTE_ORPHAN_RETRY_MAX_MS,
    COMPUTE_ORPHAN_RETRY_BASE_MS * 2 ** Math.min(count - 1, 16),
  );
  progress.failures.set(id, { count, retryAtMs: nowMs + delay });
}

/** Wait for `work`, or end as soon as `signal` aborts. */
async function untilStopped<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return await work;
  work.catch(() => {});
  let onAbort: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error("The compute orphan sweep was stopped."));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  stopped.catch(() => {});
  try {
    return await Promise.race([work, stopped]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Delete every sandbox of this deployment that nothing durable names. Its
 * enrollment is revoked first and the sandbox deleted after, so the fabric's
 * listing keeps the cleanup owned until both are done: a failed revoke leaves
 * everything for the next sweep, and a failed delete leaves a listed sandbox
 * whose revoked enrollment no longer names it. Enrollments whose sandbox is
 * already gone are not seen here; the worker's stale-enrollment reconcile
 * revokes those.
 *
 * `named` decides from Opengeni's own records (the enrollment is active and its
 * group's lease holds this box, or a creator is still working on the group). A
 * sandbox younger than the settle window is left alone, because its create may
 * not have committed yet. Orphans are handled a few at a time; once `signal`
 * aborts (the caller's budget or cancellation) no new one starts and the
 * checks and requests in flight are abandoned at once. Failures are counted
 * and, with `progress`, sit out a while so the candidates behind them are
 * reached.
 */
export async function sweepComputeOrphans(input: {
  fabric: Pick<ComputeFabricClient, "list" | "delete">;
  /** This deployment's gateway URL, stamped on every sandbox it creates. */
  gateway: string;
  named(identity: ComputeSandboxIdentity): Promise<boolean>;
  revokeEnrollment(input: { workspaceId: string; enrollmentId: string }): Promise<void>;
  nowMs?: number;
  maxDeletions?: number;
  concurrency?: number;
  /** Stops the sweep: no new orphan starts after it aborts. Pass the same
   * signal to the fabric client so the requests in flight end too. */
  signal?: AbortSignal;
  /** Carried between passes by one sweeper (see ComputeOrphanSweepProgress). */
  progress?: ComputeOrphanSweepProgress;
}): Promise<ComputeOrphanSweepResult> {
  const nowMs = input.nowMs ?? Date.now();
  const maxDeletions = input.maxDeletions ?? COMPUTE_ORPHAN_SWEEP_LIMIT;
  const concurrency = Math.max(1, input.concurrency ?? COMPUTE_ORPHAN_SWEEP_CONCURRENCY);
  const signal = input.signal;
  const progress = input.progress;
  const result: ComputeOrphanSweepResult = { examined: 0, deleted: [], failed: 0 };
  if (signal?.aborted) return result;
  const views = await untilStopped(
    input.fabric.list({ [COMPUTE_METADATA.gateway]: input.gateway }),
    signal,
  );
  const ordered: { key: string; identity: ComputeSandboxIdentity }[] = [];
  const listed = new Set<string>();
  for (const view of views) {
    const identity = identityOf(view);
    if (!identity) continue;
    result.examined += 1;
    listed.add(identity.sandboxId);
    if (nowMs - view.created_ms < UNSEEN_CREATE_SETTLE_MS) continue;
    const failure = progress?.failures.get(identity.sandboxId);
    if (failure && failure.retryAtMs > nowMs) continue;
    ordered.push({ key: traversalKey(view), identity });
  }
  if (progress) {
    // A sandbox the fabric no longer lists needs nothing more.
    for (const sandboxId of progress.failures.keys()) {
      if (!listed.has(sandboxId)) progress.failures.delete(sandboxId);
    }
  }
  ordered.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  // Resume after the last candidate the previous pass reached, wrapping around.
  const candidates = resumedAfter(ordered, progress?.cursor);
  const recordFailure = (sandboxId: string): void => {
    result.failed += 1;
    if (progress) deferFailed(progress, sandboxId, nowMs);
  };
  let next = 0;
  let started = 0;
  const work = async (): Promise<void> => {
    while (next < candidates.length && started < maxDeletions && !input.signal?.aborted) {
      const { key, identity } = candidates[next]!;
      next += 1;
      if (progress) progress.cursor = key;
      try {
        if (await untilStopped(input.named(identity), signal)) {
          progress?.failures.delete(identity.sandboxId);
          continue;
        }
        if (signal?.aborted) return;
        started += 1;
        await untilStopped(
          input.revokeEnrollment({
            workspaceId: identity.workspaceId,
            enrollmentId: identity.enrollmentId,
          }),
          signal,
        );
        await input.fabric.delete(identity.sandboxId);
        result.deleted.push(identity);
        progress?.failures.delete(identity.sandboxId);
      } catch {
        // A stopped sweep did not fail this candidate; the next pass retries it.
        if (signal?.aborted) return;
        recordFailure(identity.sandboxId);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, work));
  return result;
}

export type StaleComputeEnrollment = { workspaceId: string; enrollmentId: string };

/**
 * Revoke the compute sandbox enrollments Opengeni's own records show are stale
 * (their sandbox is already gone, so no fabric listing names them; see the
 * database's stale inventory). Like the orphan sweep, enrollments are handled
 * a few at a time and, with `progress` (its own, keyed by enrollment), each
 * pass resumes after the last one reached and a failed revoke sits out a
 * while, so one enrollment whose workspace stays locked never keeps the
 * others waiting pass after pass. Give each `revoke` its own short deadline so
 * a stuck one fails, rather than holding a slot until `signal` stops the
 * whole pass. Once `signal` aborts no new revoke starts.
 */
export async function reconcileStaleComputeEnrollments(input: {
  list(): Promise<StaleComputeEnrollment[]>;
  /** True when it revoked the enrollment, false when it no longer qualifies. */
  revoke(candidate: StaleComputeEnrollment): Promise<boolean>;
  nowMs?: number;
  concurrency?: number;
  signal?: AbortSignal;
  progress?: ComputeOrphanSweepProgress;
}): Promise<{ examined: number; revoked: StaleComputeEnrollment[]; failed: number }> {
  const nowMs = input.nowMs ?? Date.now();
  const concurrency = Math.max(1, input.concurrency ?? COMPUTE_ORPHAN_SWEEP_CONCURRENCY);
  const { signal, progress } = input;
  const result = { examined: 0, revoked: [] as StaleComputeEnrollment[], failed: 0 };
  if (signal?.aborted) return result;
  const listed = await untilStopped(input.list(), signal);
  result.examined = listed.length;
  if (progress) {
    const ids = new Set(listed.map((candidate) => candidate.enrollmentId));
    for (const id of progress.failures.keys()) if (!ids.has(id)) progress.failures.delete(id);
  }
  const ordered = listed
    .filter((candidate) => {
      const failure = progress?.failures.get(candidate.enrollmentId);
      return !failure || failure.retryAtMs <= nowMs;
    })
    .map((candidate) => ({ key: candidate.enrollmentId, candidate }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const candidates = resumedAfter(ordered, progress?.cursor);
  let next = 0;
  const work = async (): Promise<void> => {
    while (next < candidates.length && !input.signal?.aborted) {
      const { key, candidate } = candidates[next]!;
      next += 1;
      if (progress) progress.cursor = key;
      try {
        if (await untilStopped(input.revoke(candidate), signal)) result.revoked.push(candidate);
        progress?.failures.delete(candidate.enrollmentId);
      } catch {
        // A stopped pass did not fail this enrollment; the next pass retries it.
        if (signal?.aborted) return;
        result.failed += 1;
        if (progress) deferFailed(progress, candidate.enrollmentId, nowMs);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, work));
  return result;
}
