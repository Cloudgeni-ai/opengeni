import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Which Site page a request came from. Provenance, plus the key the API uses
 * to keep one Site's pages away from another Site's sessions.
 *
 * A published Site has a `siteId` (and `versionId` when the host pinned one).
 * Inline HTML and Codemode preview frames have no published id: they record
 * `siteId: null`, the `frame` kind and the host-minted `frameId` of the
 * mounted page, so a frame reaches only the sessions it started itself.
 */
export type SiteSessionOrigin = {
  siteId: string | null;
  title: string;
  versionId?: string;
  frame?: "inline" | "preview";
  frameId?: string;
};

export const SITE_ORIGIN_METADATA_KEY = "_opengeniSiteOrigin";

const origins = new AsyncLocalStorage<SiteSessionOrigin>();

/**
 * Request-local provenance, set only after the API validated the Site the
 * request came from (a published Site version the caller can see, or a
 * host-marked inline or preview frame).
 */
export function withSiteSessionOrigin<T>(origin: SiteSessionOrigin, run: () => T): T {
  return origins.run(origin, run);
}

export function sessionCreationMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  return withSiteOriginMetadata(metadata, origins.getStore() ?? null);
}

/** The validated Site origin of the current request, if any. Provenance only. */
export function currentSiteSessionOrigin(): SiteSessionOrigin | undefined {
  return origins.getStore();
}

/**
 * Replace any caller-supplied Site origin in `metadata` with `origin` (or drop
 * it). Callers never choose their own provenance.
 */
export function withSiteOriginMetadata(
  metadata: Record<string, unknown>,
  origin: SiteSessionOrigin | null | undefined,
): Record<string, unknown> {
  const { [SITE_ORIGIN_METADATA_KEY]: _ignored, ...rest } = metadata;
  return origin ? { ...rest, [SITE_ORIGIN_METADATA_KEY]: origin } : rest;
}

/**
 * Read the recorded Site origin from session (or schedule agent config)
 * metadata. Any object under the key counts as a Site origin, so a malformed
 * record still marks the session as Site-started (fail closed).
 */
export function siteSessionOriginFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
): SiteSessionOrigin | null {
  const raw = metadata?.[SITE_ORIGIN_METADATA_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  return {
    siteId: typeof value.siteId === "string" && value.siteId.length > 0 ? value.siteId : null,
    title: typeof value.title === "string" ? value.title : "",
    ...(typeof value.versionId === "string" ? { versionId: value.versionId } : {}),
    ...(value.frame === "inline" || value.frame === "preview" ? { frame: value.frame } : {}),
    ...(typeof value.frameId === "string" && value.frameId.length > 0
      ? { frameId: value.frameId }
      : {}),
  };
}

/**
 * Whether a request from the `requester` Site page may reach a session (or
 * schedule) whose recorded origin is `target`. Same published Site, or, for
 * frames without a published id, the same mounted frame. Anything without a
 * Site origin is out of reach for a Site page.
 */
export function siteOriginsMatch(
  requester: SiteSessionOrigin,
  target: SiteSessionOrigin | null | undefined,
): boolean {
  if (!target) return false;
  if (requester.siteId !== null) return target.siteId === requester.siteId;
  return (
    target.siteId === null &&
    requester.frameId !== undefined &&
    target.frameId !== undefined &&
    target.frameId === requester.frameId
  );
}
