import type {
  AccessGrant,
  FileAccess,
  FileAsset,
  WorkspaceArtifactVisibility,
  Workspace,
} from "@opengeni/contracts";
import {
  authorizedFileSourceReference,
  getManagedUserProfilesByIds,
  getFileSourceSessionReference,
  getSessionAuthorityProjection,
  getSlackInteractionSessionAccess,
  updateFileVisibility,
  type Database,
} from "@opengeni/db";
import { HTTPException } from "hono/http-exception";

import type { PrivacySettings } from "../application/organization-privacy";
import { mayStartOnlyMe } from "./scheduled-task-audience";
import {
  requireSessionAuthorization,
  SessionAuthorizationDeniedError,
  grantHasAgentAttemptAuthority,
} from "../session-authorization";
import type { ApiRouteDeps } from "../dependencies";

/**
 * A file has the same two audiences as a Site or a chat: Only me (only its
 * owner can open it) or the whole workspace. One rule decides a new file's
 * audience on every path an agent makes files through: it follows the chat,
 * so a file made in an Only me chat stays Only me until its owner shares it.
 * A person can explicitly share a private-chat file; an agent cannot widen
 * that audience on its own.
 */

export const FILE_PRIVATE_OWNER_MESSAGE = "Only a person can have an Only me file.";
export const FILE_PRIVATE_DISABLED_MESSAGE = "Only me is turned off for this organization.";
export const FILE_OWNER_REQUIRED_MESSAGE = "Only the file's owner can change who can open it.";
export const FILE_NOT_SHAREABLE_MESSAGE =
  "Session screenshots and saved tool output stay with their chat and can't be shared.";
export const FILE_PERSONAL_WORKSPACE_MESSAGE =
  "Files in a personal workspace are only yours; there is nobody to share them with.";

/** Fail closed when an agent asks to publish a private source to the workspace. */
export async function sourceSessionRequiresHumanShare(
  db: Database,
  workspaceId: string,
  sessionId: string,
): Promise<boolean> {
  const source = await getSessionAuthorityProjection(db, workspaceId, sessionId);
  if (!source) return true;
  if (
    source.visibility === "user_private" ||
    source.memoryScope === "user" ||
    source.siteAccessRootId !== null
  )
    return true;
  const slack = await getSlackInteractionSessionAccess(db, workspaceId, source.rootSessionId);
  return slack?.visibility === "private";
}

/** A host that denies the live source chat also denies its inherited File ID.
 * Document origin reads request a fresh File-RLS check because their separate
 * Document authority can return an origin File hidden from generic File reads. */
export async function fileSourceVisibleToHost(
  deps: Pick<ApiRouteDeps, "db" | "sessionAuthorization">,
  grant: AccessGrant,
  fileId: string,
  fileWorkspaceId = grant.workspaceId,
  requireFileRls = false,
  fileRlsSubjectId = grant.subjectId,
  authorizedFile?: FileAsset,
): Promise<boolean> {
  if (!deps.sessionAuthorization && !requireFileRls) return true;
  const authorizedSource = authorizedFile ? authorizedFileSourceReference(authorizedFile) : null;
  const source = authorizedFile
    ? authorizedSource
    : await getFileSourceSessionReference(deps.db, {
        accountId: grant.accountId,
        workspaceId: fileWorkspaceId,
        subjectId: fileRlsSubjectId,
        fileId,
      });
  if (!source) return false;
  if (
    authorizedFile &&
    authorizedSource &&
    (authorizedSource.accountId !== grant.accountId ||
      authorizedSource.workspaceId !== fileWorkspaceId ||
      authorizedSource.fileId !== fileId)
  )
    return false;
  if (!deps.sessionAuthorization) return true;
  if (!source.sessionId || source.audienceExplicit) return true;
  const live = await getSessionAuthorityProjection(deps.db, fileWorkspaceId, source.sessionId);
  if (!live) return true; // The file policy already applied the deletion snapshot.
  try {
    await requireSessionAuthorization(
      deps,
      { ...grant, workspaceId: fileWorkspaceId },
      {
        sessionId: source.sessionId,
        operation: "session.read",
        surface: "http",
      },
    );
    return true;
  } catch (error) {
    if (error instanceof SessionAuthorizationDeniedError) return false;
    throw error;
  }
}

/** The stored audience of a file, in Site vocabulary. */
export function fileVisibility(file: Pick<FileAsset, "scope">): WorkspaceArtifactVisibility {
  return file.scope === "personal" ? "private" : "workspace";
}

async function personName(db: Database, subjectId: string | null): Promise<string | null> {
  if (!subjectId?.startsWith("user:")) return null;
  const [profile] = await getManagedUserProfilesByIds(db, [subjectId.slice("user:".length)]).catch(
    () => [],
  );
  const name = profile?.name?.trim() || profile?.email?.trim();
  return name ? name.slice(0, 120) : null;
}

/**
 * One plain sentence saying who can open a file, for the agent that made or
 * shared it. It names only the owner the agent already acts for, and the
 * workspace it already works in. It names the owner rather than saying "you":
 * the reader may be an agent, or a shared chat where others see the link.
 */
export async function fileAccessFor(
  db: Database,
  input: {
    workspace: Pick<Workspace, "name" | "kind">;
    file: Pick<FileAsset, "scope" | "ownerSubjectId">;
  },
): Promise<FileAccess> {
  const visibility = fileVisibility(input.file);
  if (visibility === "workspace")
    return {
      visibility,
      whoCanOpen: `Everyone in the workspace “${input.workspace.name.slice(0, 200)}” can open this file.`,
    };
  const name = await personName(db, input.file.ownerSubjectId ?? null);
  const only = name ? `Only ${name} can open this file` : "Only its owner can open this file";
  return {
    visibility,
    whoCanOpen:
      input.workspace.kind === "personal"
        ? `${only}; it is in a personal workspace.`
        : `${only}. Anyone else who opens its link is told it is private.`,
  };
}

/**
 * Who can open a new file an agent or person makes. `chatOwner` is the owner
 * of the Only me chat the file comes from (null for a shared chat or no chat),
 * and `person` is the human the request acts for. Omitted, the file follows
 * the chat. Choosing the workspace from an Only me chat shares it on the
 * chat owner's behalf; choosing Only me from a shared chat needs a person who
 * may make things Only me here. A personal workspace keeps everything private.
 */
export async function resolveNewFileAudience(input: {
  db: Database;
  settings: PrivacySettings;
  workspace: Pick<Workspace, "id" | "kind">;
  chatOwner: string | null;
  person: string | null;
  requested: WorkspaceArtifactVisibility | undefined;
}): Promise<{ privateOwnerSubjectId: string | null; ownerSubjectId: string | null }> {
  const owner = input.chatOwner ?? input.person;
  if (input.workspace.kind === "personal" && owner)
    return { privateOwnerSubjectId: owner, ownerSubjectId: owner };
  const visibility = input.requested ?? (input.chatOwner ? "private" : "workspace");
  if (visibility === "workspace") return { privateOwnerSubjectId: null, ownerSubjectId: owner };
  if (!owner) throw new HTTPException(422, { message: FILE_PRIVATE_OWNER_MESSAGE });
  // An Only me chat already is Only me, so this narrows nothing new.
  if (
    !input.chatOwner &&
    !(await mayStartOnlyMe(input.db, input.settings, input.workspace.id, owner))
  )
    throw new HTTPException(403, { message: FILE_PRIVATE_DISABLED_MESSAGE });
  return { privateOwnerSubjectId: owner, ownerSubjectId: owner };
}

/**
 * The owner's change of who can open one file, from Opengeni or by their
 * agent on their behalf. `person` is the human caller or the human the agent
 * acts for; the file must already be visible to the caller's own scope.
 */
export async function changeFileVisibility(input: {
  db: Database;
  settings: PrivacySettings;
  grant: AccessGrant;
  workspace: Pick<Workspace, "id" | "kind">;
  person: string | null;
  fileId: string;
  visibility: WorkspaceArtifactVisibility;
}): Promise<{ file: FileAsset; changed: boolean }> {
  if (input.workspace.kind === "personal")
    throw new HTTPException(422, { message: FILE_PERSONAL_WORKSPACE_MESSAGE });
  if (!input.person) throw new HTTPException(403, { message: FILE_OWNER_REQUIRED_MESSAGE });
  if (
    input.visibility === "private" &&
    !(await mayStartOnlyMe(input.db, input.settings, input.workspace.id, input.person))
  )
    throw new HTTPException(403, { message: FILE_PRIVATE_DISABLED_MESSAGE });
  const result = await updateFileVisibility(input.db, {
    accountId: input.grant.accountId,
    workspaceId: input.workspace.id,
    fileId: input.fileId,
    visibility: input.visibility,
    actorSubjectId: input.person,
    auditSubjectId: input.grant.subjectId,
    agentAttempt: grantHasAgentAttemptAuthority(input.grant),
  });
  switch (result.kind) {
    case "changed":
    case "unchanged":
      return { file: result.file, changed: result.kind === "changed" };
    case "not_found":
      throw new HTTPException(404, { message: "file not found" });
    case "not_owner":
      throw new HTTPException(403, { message: FILE_OWNER_REQUIRED_MESSAGE });
    case "not_changeable":
      throw new HTTPException(409, { message: FILE_NOT_SHAREABLE_MESSAGE });
  }
}
