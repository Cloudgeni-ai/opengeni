import type { SiteViewAs, SiteViewer } from "@opengeni/contracts";
import { SITE_VIEW_COOKIE } from "./cookies";
import { sha256Hex } from "./crypto";
import { edgeCache, edgeCacheKey } from "./edge-cache";
import { UpstreamError } from "./host-map";
import { signedApiRequest } from "./signing";
import { siteCaller, type SiteContext } from "./site-context";

/** How long a confirmed (host, session) pair skips the API check at this colo (seconds). */
export const ACCESS_PROBE_CACHE_TTL = 30;

export type AccessProbe =
  | { kind: "ok"; viewer: SiteViewer | null; viewAs: SiteViewAs | null }
  | { kind: "signin" }
  | { kind: "forbidden" }
  | { kind: "missing" };

/** The preview role the API reports (`capabilities.viewAs`), or null. */
function viewAsFrom(value: unknown): SiteViewAs | null {
  const viewAs = (value as { capabilities?: { viewAs?: unknown } } | null)?.capabilities?.viewAs;
  return viewAs === "invited" || viewAs === "public" ? viewAs : null;
}

function viewerFrom(value: unknown): SiteViewer | null {
  const viewer = (value as { viewer?: unknown } | null)?.viewer as Record<string, unknown> | null;
  if (
    !viewer ||
    typeof viewer !== "object" ||
    !["member", "invited", "user", "guest"].includes(String(viewer.kind)) ||
    typeof viewer.id !== "string" ||
    typeof viewer.signedIn !== "boolean"
  )
    return null;
  return {
    kind: viewer.kind as SiteViewer["kind"],
    id: viewer.id,
    name: typeof viewer.name === "string" ? viewer.name : null,
    email: typeof viewer.email === "string" ? viewer.email : null,
    signedIn: viewer.signedIn,
  };
}

/**
 * Confirm with the API that this site session may open this Site, using the
 * allowlisted `GET /v1/site-runtime/site/config`. The gateway only sees an
 * opaque token; presence of the cookie is never treated as access. A
 * confirmed result is cached briefly per (host, session hash, preview
 * cookie), so starting or ending "View as visitor" is seen at once.
 */
export async function probeAccess(site: SiteContext): Promise<AccessProbe> {
  if (!site.session) return { kind: "signin" };
  const cache = edgeCache();
  // Keyed on the host-map generation: a new record (access change, takedown)
  // never reuses an earlier confirmation.
  const key = edgeCacheKey(site.hostname, "access", [
    site.record.generation,
    await sha256Hex(
      `${site.hostname}\n${site.session}\n${site.cookies.get(SITE_VIEW_COOKIE) ?? ""}`,
    ),
  ]);
  if (cache) {
    const hit = await cache.match(key);
    if (hit) {
      const cached = await hit.json().catch(() => null);
      return { kind: "ok", viewer: viewerFrom(cached), viewAs: viewAsFrom(cached) };
    }
  }
  let response: Response;
  try {
    response = await fetch(
      await signedApiRequest(site.config, siteCaller(site), {
        method: "GET",
        suffix: "/site/config",
        headers: new Headers({ accept: "application/json" }),
      }),
    );
  } catch {
    throw new UpstreamError("Site access check failed", null);
  }
  if (response.status === 401) return discard(response, { kind: "signin" });
  if (response.status === 403) return discard(response, { kind: "forbidden" });
  if (response.status === 404 || response.status === 410)
    return discard(response, { kind: "missing" });
  if (!response.ok) {
    await response.body?.cancel();
    throw new UpstreamError("Site access check failed", response.status);
  }
  const body = await response.json().catch(() => null);
  const viewer = viewerFrom(body);
  const viewAs = viewAsFrom(body);
  if (cache)
    site.ctx.waitUntil(
      cache.put(
        key,
        new Response(JSON.stringify({ viewer, capabilities: { viewAs } }), {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": `public, max-age=${ACCESS_PROBE_CACHE_TTL}`,
          },
        }),
      ),
    );
  return { kind: "ok", viewer, viewAs };
}

async function discard<T>(response: Response, value: T): Promise<T> {
  await response.body?.cancel();
  return value;
}
