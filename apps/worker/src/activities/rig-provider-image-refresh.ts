import type { RigProviderImageSelectionReason } from "@opengeni/core";
import { errorMessage } from "@opengeni/contracts/values";
import type { StartRigProviderImageRefresh } from "./types";

/**
 * Deterministic Temporal workflow id for an automatic provider-image rebuild:
 * at most one start per version, expected content and UTC day.
 */
export function rigProviderImageRefreshWorkflowId(input: {
  versionId: string;
  contentHash: string;
  now?: Date;
}): string {
  const day = (input.now ?? new Date()).toISOString().slice(0, 10);
  const content = input.contentHash.replace(/^sha256:/, "").slice(0, 32);
  return `rig-provider-image-refresh:${input.versionId}:${content}:${day}`;
}

/**
 * A ready, cold-boot-proven provider image whose content no longer matches is
 * stale: the deployment base image (or the content identity protocol) moved
 * after it was built. A version with setup that was never built for this
 * backend (built before the backend could build, or before builds existed) is
 * unbuilt. Either way the turn uses the ordinary setup path, and asks once in
 * the background for a build on the current base so later fresh sandboxes
 * start from a prebuilt image. Never awaited by the turn.
 */
export function requestStaleRigProviderImageRefresh(input: {
  selection: { reason: RigProviderImageSelectionReason; contentHash: string | null };
  /**
   * Verification always builds on the deployment base. A turn on a
   * workspace-selected base could never be served by that rebuild.
   */
  turnUsesDeploymentBase: boolean;
  workspaceId: string;
  versionId: string | null;
  start: StartRigProviderImageRefresh | null | undefined;
  warn: (message: string, context: { versionId: string; error: string }) => void;
}): boolean {
  if (
    (input.selection.reason !== "content_mismatch" && input.selection.reason !== "unbuilt") ||
    !input.turnUsesDeploymentBase
  ) {
    return false;
  }
  if (!input.versionId || !input.selection.contentHash || !input.start) return false;
  const versionId = input.versionId;
  void Promise.resolve()
    .then(() =>
      input.start!({
        workspaceId: input.workspaceId,
        versionId,
        contentHash: input.selection.contentHash!,
      }),
    )
    .catch((error: unknown) => {
      input.warn("sandbox environment provider image refresh could not start", {
        versionId,
        error: errorMessage(error),
      });
    });
  return true;
}
