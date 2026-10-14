import { SiteHostMapRecord, siteHostMapKey } from "@opengeni/contracts";
import { edgeCache, internalCacheKey } from "./edge-cache";
import type { GatewayConfig, WaitUntil } from "./env";
import { signedApiRequest } from "./signing";

/** KV edge cache for host-map reads (seconds). */
export const HOST_MAP_KV_CACHE_TTL = 60;
/** Lifetime of a record the gateway writes back after an API lookup (seconds). */
export const HOST_MAP_WRITE_BACK_TTL = 300;
/** Colo-local memory of "no such host" so random labels do not each reach the API (seconds). */
export const HOST_MISS_CACHE_TTL = 60;

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

function parseRecord(value: unknown, hostname: string): SiteHostMapRecord | null {
  const parsed = SiteHostMapRecord.safeParse(value);
  if (!parsed.success || parsed.data.hostname.toLowerCase() !== hostname) return null;
  return parsed.data;
}

async function readKv(config: GatewayConfig, hostname: string): Promise<SiteHostMapRecord | null> {
  if (!config.hostMap) return null;
  try {
    const text = await config.hostMap.get(siteHostMapKey(hostname), {
      type: "text",
      cacheTtl: HOST_MAP_KV_CACHE_TTL,
    });
    return text ? parseRecord(JSON.parse(text), hostname) : null;
  } catch {
    // A broken or unreadable copy is only a cache miss: Postgres is the source of truth.
    return null;
  }
}

/**
 * Resolve a Site hostname to its host-map record: KV first, then the signed
 * API lookup (written back to KV with a short TTL, never over a newer
 * generation). Returns null when the API knows no such host.
 */
export async function lookupHost(
  config: GatewayConfig,
  hostname: string,
  clientIp: string,
  ctx: WaitUntil,
): Promise<SiteHostMapRecord | null> {
  const cached = await readKv(config, hostname);
  if (cached) return cached;
  const cache = edgeCache();
  const missKey = internalCacheKey(`/host-miss/${hostname}`);
  if (cache && (await cache.match(missKey))) return null;

  let response: Response;
  try {
    response = await fetch(
      await signedApiRequest(
        config,
        { host: hostname, session: "", visitor: "", clientIp, human: false },
        { method: "GET", suffix: "/host" },
      ),
    );
  } catch {
    throw new UpstreamError("Site host lookup failed", null);
  }
  if (response.status === 404) {
    await response.body?.cancel();
    if (cache)
      ctx.waitUntil(
        cache.put(
          missKey,
          new Response(null, {
            status: 200,
            headers: { "Cache-Control": `public, max-age=${HOST_MISS_CACHE_TTL}` },
          }),
        ),
      );
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new UpstreamError("Site host lookup failed", response.status);
  }
  const record = parseRecord(await response.json().catch(() => null), hostname);
  if (!record) throw new UpstreamError("Site host lookup returned an invalid record", 502);
  if (config.hostMap) ctx.waitUntil(writeBack(config, record));
  return record;
}

async function writeBack(config: GatewayConfig, record: SiteHostMapRecord): Promise<void> {
  const hostMap = config.hostMap;
  if (!hostMap) return;
  try {
    // API edge sync may have written a newer generation meanwhile; never replace it.
    const current = await readKv(config, record.hostname);
    if (current && current.generation >= record.generation) return;
    await hostMap.put(siteHostMapKey(record.hostname), JSON.stringify(record), {
      expirationTtl: HOST_MAP_WRITE_BACK_TTL,
    });
  } catch {
    // Best effort: the next miss repeats the lookup.
  }
}
