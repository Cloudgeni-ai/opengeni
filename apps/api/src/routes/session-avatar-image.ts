import { createHash } from "node:crypto";
import type { ApiRouteDeps } from "@opengeni/core";
import { getGeneratedImageArtifact, getRetainedFileArtifact } from "@opengeni/db";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  renderSessionAvatarPng,
  SESSION_AVATAR_IMAGE_PATH_PREFIX,
  verifySessionAvatarImageToken,
} from "../integrations/session-avatar-image";

const MAX_AVATAR_SOURCE_BYTES = 20 * 1024 * 1024;

/**
 * A bot's avatar picture for Slack, which fetches it without credentials. The
 * signed path is the only authority: see `session-avatar-image.ts`.
 */
export function registerSessionAvatarImageRoutes(app: Hono, deps: ApiRouteDeps): void {
  app.get(`${SESSION_AVATAR_IMAGE_PATH_PREFIX}:file`, async (c) => {
    const notFound = () => new HTTPException(404, { message: "avatar not found" });
    const secret = deps.settings.slackSigningSecret;
    const file = c.req.param("file");
    if (!secret || !file.endsWith(".png")) throw notFound();
    const claim = verifySessionAvatarImageToken(secret, file.slice(0, -".png".length));
    if (!claim) throw notFound();
    const { avatar, workspaceId } = claim;
    const png = await renderSessionAvatarPng(avatar, async () => {
      if (avatar.kind !== "image" || !deps.objectStorage) return null;
      const source =
        (await getGeneratedImageArtifact(deps.db, workspaceId, avatar.artifactId))?.file ??
        (await getRetainedFileArtifact(deps.db, workspaceId, avatar.artifactId))?.file ??
        null;
      if (
        !source ||
        source.status !== "ready" ||
        !source.contentType.startsWith("image/") ||
        source.sizeBytes > MAX_AVATAR_SOURCE_BYTES
      ) {
        return null;
      }
      const stored = await deps.objectStorage.getObjectBytes(source.objectKey).catch(() => null);
      if (
        !stored ||
        (source.sha256 && createHash("sha256").update(stored.bytes).digest("hex") !== source.sha256)
      ) {
        return null;
      }
      return stored.bytes;
    }).catch(() => null);
    if (!png) throw notFound();
    return c.body(new Uint8Array(png), 200, {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=86400",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    });
  });
}
