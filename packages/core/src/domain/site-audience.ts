import type { AccessGrant, WorkspaceArtifactVisibility } from "@opengeni/contracts";
import {
  scheduledTaskViewerSubject,
  type Database,
  type WorkspaceArtifactViewer,
} from "@opengeni/db";
import { HTTPException } from "hono/http-exception";
import type { PrivacySettings } from "../application/organization-privacy";
import { mayStartOnlyMe } from "./scheduled-task-audience";
import { creationInitiatorForGrant } from "./sessions";

/**
 * A Site has an audience, like a chat and a schedule: the whole workspace, or
 * only its owner ("Only me"). Everyone with workspace access sees workspace
 * Sites. An Only me Site is visible to its owner alone; admins cannot see it,
 * exactly like an Only me chat. Only the owner changes the audience.
 *
 * Every surface that reads or changes Sites (HTTP, agent tools, the artifact
 * library, Site tools and Site conversations) resolves its viewer here and
 * passes it to the database layer, which filters by it.
 */

export const SITE_PRIVATE_OWNER_MESSAGE = "Only a person can have an Only me Site.";
export const SITE_PRIVATE_DISABLED_MESSAGE = "Only me is turned off for this organization.";
export const SITE_AUDIENCE_HUMAN_MESSAGE =
  "Only the Site's owner can change who can see it, from Opengeni.";

/**
 * The person a request reads Sites as: the human caller, or the human an exact
 * agent attempt acts for. Keys, services and runs without a person see
 * workspace Sites only.
 */
export async function siteViewerForGrant(
  db: Database,
  grant: AccessGrant,
): Promise<WorkspaceArtifactViewer> {
  const creator = creationInitiatorForGrant(grant);
  const subjectId = await scheduledTaskViewerSubject(db, {
    workspaceId: grant.workspaceId,
    ...(creator.initiator ? { createdBy: creator.initiator } : {}),
    ...(creator.context ? { createdByContext: creator.context } : {}),
    createdByActor: creator.actor ?? null,
  });
  return { subjectId };
}

function stored(visibility: WorkspaceArtifactVisibility): "user_private" | "workspace_shared" {
  return visibility === "private" ? "user_private" : "workspace_shared";
}

async function requireOnlyMeAllowed(input: {
  db: Database;
  settings: PrivacySettings;
  workspaceId: string;
  ownerSubjectId: string | null;
}): Promise<string> {
  if (!input.ownerSubjectId) throw new HTTPException(422, { message: SITE_PRIVATE_OWNER_MESSAGE });
  if (!(await mayStartOnlyMe(input.db, input.settings, input.workspaceId, input.ownerSubjectId)))
    throw new HTTPException(403, { message: SITE_PRIVATE_DISABLED_MESSAGE });
  return input.ownerSubjectId;
}

/**
 * The audience and owner to store for a new Site. An explicit choice wins;
 * Only me needs a person who may start Only me work here. Without one, a Site
 * starts shared with the workspace, as every Site did before audiences existed.
 */
export async function resolveNewSiteAudience(input: {
  db: Database;
  settings: PrivacySettings;
  grant: AccessGrant;
  viewer: WorkspaceArtifactViewer;
  requested: WorkspaceArtifactVisibility | undefined;
}): Promise<{
  visibility: "user_private" | "workspace_shared";
  ownerSubjectId: string | null;
}> {
  const ownerSubjectId = input.viewer.subjectId;
  if (input.requested === "private") {
    await requireOnlyMeAllowed({
      db: input.db,
      settings: input.settings,
      workspaceId: input.grant.workspaceId,
      ownerSubjectId,
    });
    return { visibility: "user_private", ownerSubjectId };
  }
  return { visibility: "workspace_shared", ownerSubjectId };
}

/**
 * The stored audience for an owner's change. Sharing with the workspace is
 * always allowed; limiting to Only me needs Only me to be allowed for them.
 * Whether the caller owns the Site is checked atomically by the database.
 */
export async function resolveSiteAudienceChange(input: {
  db: Database;
  settings: PrivacySettings;
  grant: AccessGrant;
  viewer: WorkspaceArtifactViewer;
  requested: WorkspaceArtifactVisibility;
}): Promise<"user_private" | "workspace_shared"> {
  // Like a chat's audience, this is a person's own decision, not an agent's.
  if (input.grant.principalKind === "agent_attempt")
    throw new HTTPException(403, { message: SITE_AUDIENCE_HUMAN_MESSAGE });
  if (input.requested === "private")
    await requireOnlyMeAllowed({
      db: input.db,
      settings: input.settings,
      workspaceId: input.grant.workspaceId,
      ownerSubjectId: input.viewer.subjectId,
    });
  return stored(input.requested);
}
