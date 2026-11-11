import type { AccessGrant } from "@opengeni/contracts";
import {
  SITE_PREVIEW_FRAME,
  siteConversationContext,
  type SiteFrameHeaders,
} from "@opengeni/contracts/site-session-http";
import { getWorkspaceSiteSessionOrigin, WorkspaceArtifactNotFoundError } from "@opengeni/db";
import {
  currentSiteSessionOrigin,
  siteViewerForGrant,
  withSiteSessionOrigin,
  type ApiRouteDeps,
  type SiteSessionOrigin,
} from "@opengeni/core";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

const FRAME_ID = /^[A-Za-z0-9_-]{1,64}$/u;

// The revision of the version each resolved origin names, read with it, so
// the Site view's first-message context needs no second read.
const originRevisions = new WeakMap<SiteSessionOrigin, number>();

/** The host-set frame marker and per-frame id a Site request carried. */
export type SiteFrameMarker = {
  marker?: string | null | undefined;
  frameId?: string | null | undefined;
};

/**
 * Validates a host-asserted Site association, not browser execution or
 * authority. A published Site (id and version) must be visible to the caller.
 * A request carrying only the host's frame marker came from a frame without a
 * published Site (inline HTML, a Codemode preview): it is recorded as that
 * frame (`siteId: null`, `frame`, `frameId`), never as a published Site.
 */
export async function resolveSiteSessionOrigin(
  db: ApiRouteDeps["db"],
  grant: AccessGrant,
  siteId?: string,
  versionId?: string,
  frame?: SiteFrameMarker,
): Promise<SiteSessionOrigin | null> {
  if (!siteId && !versionId) return frameOnlyOrigin(frame);
  if (
    !z.string().uuid().safeParse(siteId).success ||
    !z.string().uuid().safeParse(versionId).success
  )
    throw new HTTPException(400, { message: "Invalid Site origin" });
  try {
    // Provenance is not a live-version fence: a response-loss retry still belongs
    // to the same Site after it publishes a new version or is archived.
    const origin = await getWorkspaceSiteSessionOrigin(
      db,
      grant.workspaceId,
      await siteViewerForGrant(db, grant),
      siteId!,
      versionId!,
    );
    // Absence is reported by the not-found error; a fixture database may answer null.
    if (!origin) return null;
    const resolved: SiteSessionOrigin = {
      siteId: origin.siteId,
      title: origin.title,
      versionId: versionId!,
    };
    if (typeof origin.revision === "number") originRevisions.set(resolved, origin.revision);
    return resolved;
  } catch (error) {
    if (error instanceof WorkspaceArtifactNotFoundError)
      throw new HTTPException(404, { message: "Site origin not found" });
    throw error;
  }
}

function frameOnlyOrigin(frame: SiteFrameMarker | undefined): SiteSessionOrigin | null {
  if (!frame?.marker) return null;
  const frameId = frame.frameId && FRAME_ID.test(frame.frameId) ? frame.frameId : undefined;
  return {
    siteId: null,
    title: "",
    frame: frame.marker === SITE_PREVIEW_FRAME ? "preview" : "inline",
    ...(frameId ? { frameId } : {}),
  };
}

/**
 * The context a conversation started in the console's Site view begins with:
 * the Site's id, title and the version the person had open
 * (`siteConversationContext`). Null when the origin names no published
 * version or the Site can't be read, so the conversation starts without it.
 */
export async function siteViewConversationContext(
  db: ApiRouteDeps["db"],
  grant: AccessGrant,
  origin: SiteSessionOrigin,
): Promise<string | null> {
  if (!origin.siteId || !origin.versionId) return null;
  const revision = originRevisions.get(origin);
  if (revision !== undefined)
    return siteConversationContext({
      siteId: origin.siteId,
      title: origin.title,
      versionId: origin.versionId,
      revision,
    });
  try {
    const site = await getWorkspaceSiteSessionOrigin(
      db,
      grant.workspaceId,
      await siteViewerForGrant(db, grant),
      origin.siteId,
      origin.versionId,
    );
    if (!site || typeof site.revision !== "number") return null;
    return siteConversationContext({
      siteId: site.siteId,
      title: site.title,
      versionId: origin.versionId,
      revision: site.revision,
    });
  } catch (error) {
    if (error instanceof WorkspaceArtifactNotFoundError) return null;
    throw error;
  }
}

/**
 * The strict origin of a request a host marked as coming from a Site frame:
 * an unverifiable published Site fails the request (400/404) instead of
 * running it without provenance.
 */
export async function resolveSiteRequestOrigin(
  db: ApiRouteDeps["db"],
  grant: AccessGrant,
  frame: SiteFrameHeaders,
): Promise<SiteSessionOrigin> {
  const origin = await resolveSiteSessionOrigin(
    db,
    grant,
    frame.siteId ?? undefined,
    frame.versionId ?? undefined,
    { marker: frame.marker ?? "1", frameId: frame.frameId },
  );
  // Unreachable: a frame always resolves to a published Site or a frame origin.
  if (!origin) throw new HTTPException(400, { message: "Invalid Site origin" });
  return origin;
}

/**
 * Run a follow-up command (Send or Steer) inside the request's Site scope when
 * the published Site bridge supplied a valid origin, so its turn records the
 * `site` surface. Provenance only: a missing or unverifiable origin leaves the
 * command unscoped instead of rejecting a message that is otherwise valid.
 * Requests a host marked as Site frames already run inside their validated
 * origin (apps/api/src/site-frame-guard.ts), which this keeps.
 */
export async function withOptionalSiteCommandOrigin<T>(
  db: ApiRouteDeps["db"],
  grant: AccessGrant,
  siteId: string | undefined,
  versionId: string | undefined,
  run: () => Promise<T>,
): Promise<T> {
  if (currentSiteSessionOrigin()) return await run();
  if (!siteId && !versionId) return await run();
  const origin = await resolveSiteSessionOrigin(db, grant, siteId, versionId).catch(() => null);
  return origin ? await withSiteSessionOrigin(origin, run) : await run();
}
