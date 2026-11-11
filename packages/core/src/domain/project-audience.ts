import type { AccessGrant } from "@opengeni/contracts";
import {
  getPrivateSessionCreatePolicy,
  getSessionAuthorityProjection,
  type Database,
} from "@opengeni/db";
import { HTTPException } from "hono/http-exception";
import type { PrivacySettings } from "../application/organization-privacy";
import { mayStartOnlyMe } from "./scheduled-task-audience";
import { SITE_PRIVATE_DISABLED_MESSAGE, siteViewerForGrant } from "./site-audience";

/**
 * A project has the audiences a chat has: the whole workspace, or only its
 * owner ("Only me"). An Only me project is seen by its owner alone and holds
 * only their own Only me chats and Sites, so nothing about it reaches anyone
 * else; the database keeps that true (1161).
 */

export const PROJECT_PRIVATE_OWNER_MESSAGE = "Only a person can have an Only me project.";
export const PROJECT_AUDIENCE_HUMAN_MESSAGE =
  "Only the project's owner can share it with the workspace, from the app.";

export type ProjectAudience = Readonly<{
  visibility: "user_private" | "workspace_shared";
  ownerSubjectId: string | null;
}>;

const SHARED: ProjectAudience = Object.freeze({
  visibility: "workspace_shared",
  ownerSubjectId: null,
});

/**
 * The audience of a new project. An explicit choice wins; Only me needs a
 * person who may start Only me work here. Without one, an agent's project
 * follows its chat: made in an Only me chat, it is Only me for the chat's
 * owner, so the chat can be filed in it. Everything else is shared, as every
 * project was before audiences. A Personal workspace has nobody else in it, so
 * its projects stay shared there.
 */
export async function resolveNewProjectAudience(input: {
  db: Database;
  settings: PrivacySettings;
  grant: AccessGrant;
  requested: "private" | "workspace" | undefined;
  /** The chat an agent makes it from; null for people, keys and services. */
  sourceSessionId: string | null;
}): Promise<ProjectAudience> {
  if (input.requested === "workspace") return SHARED;
  const workspaceId = input.grant.workspaceId;
  if (input.requested === "private") {
    const { subjectId: owner } = await siteViewerForGrant(input.db, input.grant);
    if (!owner) throw new HTTPException(422, { message: PROJECT_PRIVATE_OWNER_MESSAGE });
    if (await inPersonalWorkspace(input.db, workspaceId, owner)) return SHARED;
    if (!(await mayStartOnlyMe(input.db, input.settings, workspaceId, owner)))
      throw new HTTPException(403, { message: SITE_PRIVATE_DISABLED_MESSAGE });
    return { visibility: "user_private", ownerSubjectId: owner };
  }
  if (input.sourceSessionId === null) return SHARED;
  // The chat already is Only me, so this narrows nothing and needs no fresh
  // permission, like an existing Only me item when Only me is later turned off.
  const chat = await getSessionAuthorityProjection(input.db, workspaceId, input.sourceSessionId);
  const owner = chat?.visibility === "user_private" ? (chat.ownerSubjectId ?? null) : null;
  if (!owner || (await inPersonalWorkspace(input.db, workspaceId, owner))) return SHARED;
  return { visibility: "user_private", ownerSubjectId: owner };
}

/** Sharing an Only me project is its owner's own decision, made in the app. */
export function requireProjectAudienceChangeByPerson(grant: AccessGrant): void {
  if (grant.principalKind !== "human_session" || grant.subjectId.startsWith("api_key:"))
    throw new HTTPException(403, { message: PROJECT_AUDIENCE_HUMAN_MESSAGE });
}

/** The chat an exact agent attempt works in; null for people, keys and services. */
export function projectSourceSessionId(grant: AccessGrant): string | null {
  const sessionId = grant.metadata?.["sessionId"];
  return grant.principalKind === "agent_attempt" && typeof sessionId === "string"
    ? sessionId
    : null;
}

async function inPersonalWorkspace(
  db: Database,
  workspaceId: string,
  subjectId: string,
): Promise<boolean> {
  const policy = await getPrivateSessionCreatePolicy(db, {
    workspaceId,
    actorSubjectId: subjectId,
  }).catch(() => null);
  return policy?.personalWorkspace === true;
}
