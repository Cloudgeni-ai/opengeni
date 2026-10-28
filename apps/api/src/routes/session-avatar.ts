import type { AccessGrant, SessionAvatar } from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  getFilesForSubject,
  getGeneratedImageArtifact,
  getRetainedFileArtifact,
  getSessionVisibility,
} from "@opengeni/db";
import { HTTPException } from "hono/http-exception";
import { fileAuthoritySubjectIdForGrant } from "./files";

/**
 * An image avatar must be a finished image in this workspace that the caller
 * can open. When everyone in the workspace can see where the avatar shows (a
 * shared chat, or a bot template), an Only me image is refused: everyone else
 * would only see initials. Other avatar kinds need no check.
 */
export async function requireUsableSessionAvatar(
  deps: Pick<ApiRouteDeps, "db">,
  grant: AccessGrant,
  avatar: SessionAvatar | null | undefined,
  audience: { sharedWithWorkspace: boolean } | { sessionId: string },
): Promise<void> {
  if (!avatar || avatar.kind !== "image") return;
  const { db } = deps;
  const workspaceId = grant.workspaceId;
  const unusable = (message: string) => new HTTPException(422, { message });
  const generated = await getGeneratedImageArtifact(db, workspaceId, avatar.artifactId);
  const fileId =
    generated?.file.id ??
    (await getRetainedFileArtifact(db, workspaceId, avatar.artifactId))?.file.id ??
    null;
  if (!fileId) throw unusable("No image with that id exists in this workspace.");
  const [file] = await getFilesForSubject(db, {
    accountId: grant.accountId,
    workspaceId,
    subjectId: await fileAuthoritySubjectIdForGrant(deps, grant),
    fileIds: [fileId],
  });
  if (!file) throw unusable("No image with that id exists in this workspace.");
  if (file.status !== "ready" || !file.contentType.startsWith("image/")) {
    throw unusable("An avatar must be a finished image file.");
  }
  const sharedWithWorkspace =
    "sessionId" in audience
      ? (await getSessionVisibility(db, workspaceId, audience.sessionId)) !== "user_private"
      : audience.sharedWithWorkspace;
  if (sharedWithWorkspace && file.scope === "personal") {
    throw unusable(
      "This image is Only me, so others in the workspace would not see it. Share the image with the workspace first, then use it as the avatar.",
    );
  }
}
