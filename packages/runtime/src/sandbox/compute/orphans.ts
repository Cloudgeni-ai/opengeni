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
 * requests in flight end. Failures are counted and left for the next sweep.
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
}): Promise<ComputeOrphanSweepResult> {
  const nowMs = input.nowMs ?? Date.now();
  const maxDeletions = input.maxDeletions ?? COMPUTE_ORPHAN_SWEEP_LIMIT;
  const concurrency = Math.max(1, input.concurrency ?? COMPUTE_ORPHAN_SWEEP_CONCURRENCY);
  const result: ComputeOrphanSweepResult = { examined: 0, deleted: [], failed: 0 };
  if (input.signal?.aborted) return result;
  const views = await input.fabric.list({ [COMPUTE_METADATA.gateway]: input.gateway });
  const candidates: ComputeSandboxIdentity[] = [];
  for (const view of views) {
    const identity = identityOf(view);
    if (!identity) continue;
    result.examined += 1;
    if (nowMs - view.created_ms < UNSEEN_CREATE_SETTLE_MS) continue;
    candidates.push(identity);
  }
  let next = 0;
  let started = 0;
  const work = async (): Promise<void> => {
    while (next < candidates.length && started < maxDeletions && !input.signal?.aborted) {
      const identity = candidates[next]!;
      next += 1;
      try {
        if (await input.named(identity)) continue;
        if (input.signal?.aborted) return;
        started += 1;
        await input.revokeEnrollment({
          workspaceId: identity.workspaceId,
          enrollmentId: identity.enrollmentId,
        });
        await input.fabric.delete(identity.sandboxId);
        result.deleted.push(identity);
      } catch {
        result.failed += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, work));
  return result;
}
