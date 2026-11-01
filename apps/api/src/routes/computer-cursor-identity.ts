import { createHash } from "node:crypto";
import sharp from "sharp";
import {
  deriveSessionDisplayTitle,
  type AccessGrant,
  type ComputerCursorIdentity,
  type Session,
  type SessionAvatar,
} from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  getFilesForSubject,
  getGeneratedImageArtifact,
  getRetainedFileArtifact,
} from "@opengeni/db";
import { renderSessionAvatarPng } from "../integrations/session-avatar-image";
import { fileAuthoritySubjectIdForGrant } from "./files";

/** Same human-facing identity as navigation, never the computer-control key.
 * Only resolved, bounded pixels cross to the desktop; no storage URL or token.
 */
export async function computerCursorIdentity(
  deps: Pick<ApiRouteDeps, "db" | "objectStorage">,
  grant: AccessGrant,
  session: Session,
): Promise<ComputerCursorIdentity> {
  const title = deriveSessionDisplayTitle(session);
  const label = (
    title.startsWith("Conversation ") && title.includes(session.id.slice(0, 13))
      ? "New conversation"
      : title
  )
    .slice(0, 200)
    .replace(/[\uD800-\uDBFF]$/u, "");
  // Avatar storage/rendering is cosmetic. A slow store must not hold up an open.
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      renderCursorIdentity(deps, grant, session, label),
      new Promise<ComputerCursorIdentity>((resolve) => {
        timeout = setTimeout(() => resolve({ label }), 750);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function renderCursorIdentity(
  deps: Pick<ApiRouteDeps, "db" | "objectStorage">,
  grant: AccessGrant,
  session: Session,
  label: string,
): Promise<ComputerCursorIdentity> {
  const fallback = cursorInitialsAvatar(label, session.id);
  try {
    const avatar = session.avatar ?? fallback;
    const png = await renderSessionAvatarPng(avatar, async () => {
      if (avatar.kind !== "image" || !deps.objectStorage) return null;
      const source =
        (await getGeneratedImageArtifact(deps.db, session.workspaceId, avatar.artifactId))?.file ??
        (await getRetainedFileArtifact(deps.db, session.workspaceId, avatar.artifactId))?.file;
      if (!source) return null;
      const [file] = await getFilesForSubject(deps.db, {
        accountId: grant.accountId,
        workspaceId: session.workspaceId,
        subjectId: await fileAuthoritySubjectIdForGrant(deps, grant),
        fileIds: [source.id],
      });
      if (
        !file ||
        file.status !== "ready" ||
        !file.contentType.startsWith("image/") ||
        file.sizeBytes > 20 * 1024 * 1024
      )
        return null;
      const stored = await deps.objectStorage.getObjectBytes(file.objectKey);
      if (!stored || stored.bytes.byteLength > 20 * 1024 * 1024) return null;
      if (file.sha256 && createHash("sha256").update(stored.bytes).digest("hex") !== file.sha256)
        return null;
      return stored.bytes;
    });
    const pixels = png ?? (await renderSessionAvatarPng(fallback, async () => null));
    if (!pixels) return { label };
    const small = await sharp(pixels).resize(64, 64).png().toBuffer();
    return { label, ...(small.length <= 32 * 1024 ? { avatarPng: small.toString("base64") } : {}) };
  } catch {
    // Cosmetic metadata must never prevent authorized computer use.
    return { label };
  }
}

export function cursorInitialsAvatar(name: string, seed: string): SessionAvatar {
  const letters =
    name
      .trim()
      .split(/\s+/u)
      .map((word) => [...word].find((char) => /[\p{L}\p{N}]/u.test(char)))
      .filter(Boolean)
      .slice(0, 2)
      .join("")
      .toUpperCase()
      .slice(0, 2)
      .replace(/[\uD800-\uDBFF]$/u, "") || "?";
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return { kind: "letters", letters, hue: hash % 360 };
}
