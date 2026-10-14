import type { SiteViewer } from "@opengeni/contracts";
import { sha256Hex } from "./crypto";
import { edgeCache, internalCacheKey } from "./edge-cache";
import { UpstreamError } from "./host-map";
import { signedApiRequest } from "./signing";
import { siteCaller, type SiteContext } from "./site-context";

/** How long a confirmed (host, session) pair skips the API check at this colo (seconds). */
export const ACCESS_PROBE_CACHE_TTL = 30;

export type AccessProbe =
  | { kind: "ok"; viewer: SiteViewer | null }
  | { kind: "signin" }
  | { kind: "forbidden" }
  | { kind: "missing" };

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
 * confirmed result is cached briefly per (host, session hash).
 */
export async function probeAccess(site: SiteContext): Promise<AccessProbe> {
  if (!site.session) return { kind: "signin" };
  const cache = edgeCache();
  const key = internalCacheKey(`/access/${await sha256Hex(`${site.hostname}\n${site.session}`)}`);
  if (cache) {
    const hit = await cache.match(key);
    if (hit) return { kind: "ok", viewer: viewerFrom(await hit.json().catch(() => null)) };
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
  if (cache)
    site.ctx.waitUntil(
      cache.put(
        key,
        new Response(JSON.stringify({ viewer }), {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": `public, max-age=${ACCESS_PROBE_CACHE_TTL}`,
          },
        }),
      ),
    );
  return { kind: "ok", viewer };
}

async function discard<T>(response: Response, value: T): Promise<T> {
  await response.body?.cancel();
  return value;
}
