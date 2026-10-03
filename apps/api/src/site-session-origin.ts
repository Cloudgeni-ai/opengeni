import { getWorkspaceSiteSessionOrigin, WorkspaceArtifactNotFoundError } from "@opengeni/db";
import { withSiteSessionOrigin, type ApiRouteDeps } from "@opengeni/core";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

/** Validates a caller-asserted Site association, not browser execution or authority. */
export async function resolveSiteSessionOrigin(
  db: ApiRouteDeps["db"],
  workspaceId: string,
  siteId?: string,
  versionId?: string,
) {
  if (!siteId && !versionId) return null;
  if (
    !z.string().uuid().safeParse(siteId).success ||
    !z.string().uuid().safeParse(versionId).success
  )
    throw new HTTPException(400, { message: "Invalid Site origin" });
  try {
    // Provenance is not a live-version fence: a response-loss retry still belongs
    // to the same Site after it publishes a new version or is archived.
    return await getWorkspaceSiteSessionOrigin(db, workspaceId, siteId!, versionId!);
  } catch (error) {
    if (error instanceof WorkspaceArtifactNotFoundError)
      throw new HTTPException(404, { message: "Site origin not found" });
    throw error;
  }
}

/**
 * Run a follow-up command (Send or Steer) inside the request's Site scope when
 * the published Site bridge supplied a valid origin, so its turn records the
 * `site` surface. Provenance only: a missing or unverifiable origin leaves the
 * command unscoped instead of rejecting a message that is otherwise valid.
 */
export async function withOptionalSiteCommandOrigin<T>(
  db: ApiRouteDeps["db"],
  workspaceId: string,
  siteId: string | undefined,
  versionId: string | undefined,
  run: () => Promise<T>,
): Promise<T> {
  if (!siteId && !versionId) return await run();
  const origin = await resolveSiteSessionOrigin(db, workspaceId, siteId, versionId).catch(
    () => null,
  );
  return origin ? await withSiteSessionOrigin(origin, run) : await run();
}
