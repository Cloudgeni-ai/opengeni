// The one owner of compute sandboxes nothing durable names any more.
//
// The fabric is the inventory: every sandbox Opengeni creates carries its
// deployment's gateway, workspace, sandbox group and enrollment in its metadata.
// A sandbox whose enrollment is no longer the live box of its group (a create
// whose answer was lost, a cleanup that failed, a worker that crashed between
// create and commit, a workspace deleted with everything in it) is deleted here
// and its enrollment revoked. Nothing on this path messages a sandbox's agent,
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

/**
 * Delete every sandbox of this deployment that nothing durable names, then
 * revoke its enrollment. `named` decides from Opengeni's own records (the
 * enrollment is active and its group's lease holds this box, or a creator is
 * still working on the group). A sandbox younger than the settle window is left
 * alone, because its create may not have committed yet. Failures are counted
 * and left for the next sweep.
 */
export async function sweepComputeOrphans(input: {
  fabric: Pick<ComputeFabricClient, "list" | "delete">;
  /** This deployment's gateway URL, stamped on every sandbox it creates. */
  gateway: string;
  named(identity: ComputeSandboxIdentity): Promise<boolean>;
  revokeEnrollment(input: { workspaceId: string; enrollmentId: string }): Promise<void>;
  nowMs?: number;
}): Promise<ComputeOrphanSweepResult> {
  const nowMs = input.nowMs ?? Date.now();
  const views = await input.fabric.list({ [COMPUTE_METADATA.gateway]: input.gateway });
  const result: ComputeOrphanSweepResult = { examined: 0, deleted: [], failed: 0 };
  for (const view of views) {
    const identity = identityOf(view);
    if (!identity) continue;
    result.examined += 1;
    if (nowMs - view.created_ms < UNSEEN_CREATE_SETTLE_MS) continue;
    try {
      if (await input.named(identity)) continue;
      await input.fabric.delete(identity.sandboxId);
      await input.revokeEnrollment({
        workspaceId: identity.workspaceId,
        enrollmentId: identity.enrollmentId,
      });
      result.deleted.push(identity);
    } catch {
      result.failed += 1;
    }
  }
  return result;
}
