import type {
  AccessGrant,
  FileAccess,
  WorkspaceArtifact,
  WorkspaceArtifactVisibility,
} from "@opengeni/contracts";
import {
  audienceAccessFor,
  hasPermission,
  resolveSiteAudienceChange,
  siteViewerForGrant,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  requireWorkspace,
  updateWorkspaceArtifactVisibility,
  WorkspaceArtifactNotFoundError,
} from "@opengeni/db";
import { HTTPException } from "hono/http-exception";

import { notifySitePublicationChanged } from "./site-publishing/service";

/**
 * The owner's change of who can see their Site, from the Site page or by an
 * agent turn acting for them: one path, so both get the same rules. The
 * database refuses anyone but the owner, and a Site the viewer can't see
 * reads as missing.
 */
export async function changeSiteAudience(
  deps: ApiRouteDeps,
  input: { grant: AccessGrant; artifactId: string; visibility: WorkspaceArtifactVisibility },
): Promise<WorkspaceArtifact> {
  const { grant } = input;
  const viewer = await siteViewerForGrant(deps.db, grant);
  const visibility = await resolveSiteAudienceChange({
    db: deps.db,
    settings: deps.settings,
    grant,
    viewer,
    requested: input.visibility,
  });
  const artifact = await updateWorkspaceArtifactVisibility(deps.db, {
    workspaceId: grant.workspaceId,
    artifactId: input.artifactId,
    viewer,
    visibility,
  });
  await notifySitePublicationChanged(
    deps,
    { accountId: grant.accountId, workspaceId: grant.workspaceId },
    input.artifactId,
  );
  return artifact;
}

/** Who can see a Site now, after an agent changed it for its owner. */
export type SiteAccessReceipt = {
  type: "site_access";
  artifactId: string;
  title: string;
  access: FileAccess;
};

/**
 * sandbox_file_publish's artifactId path for a Site rather than a file. It
 * needs what the Site page needs: permission to publish Sites, and to be (or
 * act for) the Site's owner. Without that permission the tool offers files
 * only, and answers as it always has.
 */
export async function changeSiteAudienceForAgent(
  deps: ApiRouteDeps,
  input: { grant: AccessGrant; artifactId: string; visibility: WorkspaceArtifactVisibility },
): Promise<SiteAccessReceipt> {
  if (!hasPermission(input.grant.permissions, "artifacts:publish"))
    throw new HTTPException(404, { message: "file not found" });
  let artifact: WorkspaceArtifact;
  try {
    artifact = await changeSiteAudience(deps, input);
  } catch (error) {
    if (error instanceof WorkspaceArtifactNotFoundError)
      throw new HTTPException(404, {
        message: "No file or Site you can open has this artifactId.",
      });
    throw error;
  }
  const workspace = await requireWorkspace(deps.db, input.grant.workspaceId);
  return {
    type: "site_access",
    artifactId: artifact.id,
    title: artifact.title,
    access: await audienceAccessFor(deps.db, {
      workspace,
      visibility: artifact.visibility,
      ownerSubjectId: artifact.ownerSubjectId ?? null,
      noun: "Site",
    }),
  };
}
