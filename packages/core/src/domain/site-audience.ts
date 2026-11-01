import type { AccessGrant, WorkspaceArtifactVisibility } from "@opengeni/contracts";
import {
  getVisibleSessionAudience,
  type Database,
  type WorkspaceArtifactViewer,
} from "@opengeni/db";
import { HTTPException } from "hono/http-exception";
import type { PrivacySettings } from "../application/organization-privacy";
import { mayStartOnlyMe, scheduledTaskViewerSubjectForGrant } from "./scheduled-task-audience";

/**
 * A Site, document, spreadsheet or presentation has an audience, like a chat
 * and a schedule: the whole workspace, or only its owner ("Only me").
 * Everyone with workspace access sees workspace ones. An Only me one is
 * visible to its owner alone; admins cannot see it, exactly like an Only me
 * chat. Only the owner changes the audience.
 *
 * Every surface that reads or changes them (HTTP, agent tools, the artifact
 * library, Site tools and Site conversations) resolves its viewer here; the
 * database layer enforces it.
 */

/** What the audience belongs to, as people name it ("Site", "document"). */
export type ArtifactAudienceNoun = "Site" | "document" | "spreadsheet" | "presentation";

export function artifactPrivateOwnerMessage(noun: ArtifactAudienceNoun): string {
  return `Only a person can have an Only me ${noun}.`;
}

export function artifactAudienceHumanMessage(noun: ArtifactAudienceNoun): string {
  return `Only the ${noun}'s owner can change who can see it, from the app.`;
}

export const SITE_PRIVATE_OWNER_MESSAGE = artifactPrivateOwnerMessage("Site");
export const SITE_PRIVATE_DISABLED_MESSAGE = "Only me is turned off for this organization.";
export const SITE_AUDIENCE_HUMAN_MESSAGE = artifactAudienceHumanMessage("Site");

/**
 * The person a request reads Sites and documents as: the human caller, or the
 * human an exact agent attempt acts for. Keys, services and runs without a
 * person see workspace ones only.
 */
export async function siteViewerForGrant(
  db: Database,
  grant: AccessGrant,
): Promise<WorkspaceArtifactViewer> {
  const subjectId = await scheduledTaskViewerSubjectForGrant(db, grant);
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
  noun: ArtifactAudienceNoun;
}): Promise<string> {
  if (!input.ownerSubjectId)
    throw new HTTPException(422, { message: artifactPrivateOwnerMessage(input.noun) });
  if (!(await mayStartOnlyMe(input.db, input.settings, input.workspaceId, input.ownerSubjectId)))
    throw new HTTPException(403, { message: SITE_PRIVATE_DISABLED_MESSAGE });
  return input.ownerSubjectId;
}

/**
 * The audience and owner to store for a new Site or document. An explicit
 * choice wins; Only me needs a person who may start Only me work here.
 * Without one, it starts with its source's audience: made in an Only me chat,
 * or from an Only me file, it stays Only me until its owner shares it.
 * Anything else starts shared with the workspace, as everything did before
 * audiences existed. The owner is the person it was made for; in an Only me
 * chat that is always the chat's owner.
 */
export async function resolveNewArtifactAudience(input: {
  db: Database;
  settings: PrivacySettings;
  grant: AccessGrant;
  viewer: WorkspaceArtifactViewer;
  requested: WorkspaceArtifactVisibility | undefined;
  sourceSessionId: string | null;
  /** Made from something already Only me to this person, such as their file. */
  sourcePrivate?: boolean;
  noun: ArtifactAudienceNoun;
}): Promise<{
  visibility: "user_private" | "workspace_shared";
  ownerSubjectId: string | null;
}> {
  const viewerSubjectId = input.viewer.subjectId;
  if (input.requested === "private") {
    const ownerSubjectId = await requireOnlyMeAllowed({
      db: input.db,
      settings: input.settings,
      workspaceId: input.grant.workspaceId,
      ownerSubjectId: viewerSubjectId,
      noun: input.noun,
    });
    return { visibility: "user_private", ownerSubjectId };
  }
  if (input.requested === "workspace")
    return { visibility: "workspace_shared", ownerSubjectId: viewerSubjectId };
  // The source already is Only me, so this narrows nothing and needs no fresh
  // permission, like an existing Only me item when Only me is later turned off.
  const chat =
    input.sourceSessionId === null
      ? null
      : await getVisibleSessionAudience(input.db, input.grant.workspaceId, input.sourceSessionId);
  if (chat?.visibility === "user_private") {
    // Only its owner works in an Only me chat; a run there without a person
    // (such as a meeting summary) still makes its owner's things.
    const ownerSubjectId = viewerSubjectId ?? chat.ownerSubjectId;
    if (ownerSubjectId) return { visibility: "user_private", ownerSubjectId };
  }
  if (input.sourcePrivate && viewerSubjectId)
    return { visibility: "user_private", ownerSubjectId: viewerSubjectId };
  return { visibility: "workspace_shared", ownerSubjectId: viewerSubjectId };
}

/** The audience and owner to store for a new Site; see resolveNewArtifactAudience. */
export async function resolveNewSiteAudience(input: {
  db: Database;
  settings: PrivacySettings;
  grant: AccessGrant;
  viewer: WorkspaceArtifactViewer;
  requested: WorkspaceArtifactVisibility | undefined;
  sourceSessionId: string | null;
}): Promise<{
  visibility: "user_private" | "workspace_shared";
  ownerSubjectId: string | null;
}> {
  return await resolveNewArtifactAudience({ ...input, noun: "Site" });
}

/**
 * The stored audience for an owner's change. Sharing with the workspace is
 * always allowed; limiting to Only me needs Only me to be allowed for them.
 * Whether the caller owns it is checked atomically by the database.
 */
export async function resolveArtifactAudienceChange(input: {
  db: Database;
  settings: PrivacySettings;
  grant: AccessGrant;
  viewer: WorkspaceArtifactViewer;
  requested: WorkspaceArtifactVisibility;
  noun: ArtifactAudienceNoun;
}): Promise<"user_private" | "workspace_shared"> {
  // Like a chat's audience, this is a person's own decision, not an agent's.
  if (input.grant.principalKind === "agent_attempt")
    throw new HTTPException(403, { message: artifactAudienceHumanMessage(input.noun) });
  if (input.requested === "private")
    await requireOnlyMeAllowed({
      db: input.db,
      settings: input.settings,
      workspaceId: input.grant.workspaceId,
      ownerSubjectId: input.viewer.subjectId,
      noun: input.noun,
    });
  return stored(input.requested);
}

/** The stored audience for a Site owner's change; see resolveArtifactAudienceChange. */
export async function resolveSiteAudienceChange(input: {
  db: Database;
  settings: PrivacySettings;
  grant: AccessGrant;
  viewer: WorkspaceArtifactViewer;
  requested: WorkspaceArtifactVisibility;
}): Promise<"user_private" | "workspace_shared"> {
  return await resolveArtifactAudienceChange({ ...input, noun: "Site" });
}
