import type { AccessContext } from "@/types";

import { isWorkspacePermissionDenied, lacksWorkspacePermission } from "./permissions";

/** Sites and editable documents are readable only with `artifacts:read`. */
export const ARTIFACT_ACCESS_REQUIRED =
  "You need access to artifacts in this workspace. Ask a workspace admin.";

/**
 * A Site or editable artifact failed to open because the viewer can't read
 * artifacts in this workspace, not because it was removed. Either the server
 * refused the read, or the viewer's own grant lacks `artifacts:read`.
 */
export function isArtifactReadDenied(
  error: unknown,
  context: AccessContext | null,
  workspaceId: string,
): boolean {
  return (
    isWorkspacePermissionDenied(error) ||
    lacksWorkspacePermission(context, workspaceId, "artifacts:read")
  );
}
