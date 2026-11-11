import { SiteHostMapRecord, siteHostMapKey } from "@opengeni/contracts";
import type { Settings } from "@opengeni/config";

/**
 * Optional Cloudflare edge sync for published Sites. Postgres is the source
 * of truth; the KV host map and the edge cache are rebuildable copies. With
 * no Cloudflare settings every call is a no-op.
 *
 * Writes go through the Cloudflare REST API with plain fetch (no SDK, each
 * call bounded by a 10 s timeout) and never block the database write: callers
 * schedule them after commit, each is retried a few times and then logged.
 * The caller reads what a hostname should hold in a short transaction under
 * the hostname's lock and commits before any of these calls, so no database
 * transaction or lock waits on Cloudflare; after writing it re-reads the
 * hostname and writes again if it moved meanwhile. One process runs at most
 * one sync per hostname at a time. A writer never replaces a newer
 * generation (read, compare, write; KV has no compare-and-set, so writers in
 * two processes racing within one round trip can still land out of order,
 * until the entry's TTL ends it). Generations come from one database
 * sequence shared by every hostname, so a later change to a label (a move,
 * an unpublish tombstone, a takedown) always carries a higher generation
 * than anything written before.
 *
 * Staleness bound: the API itself refuses a suspended or unpublished Site on
 * the very next site-runtime call (it re-checks publication status and access
 * every time). The edge copies lag behind: Cloudflare KV propagates a write
 * to other locations within about 60 s, every KV entry expires after
 * `sitesHostMapTtlSeconds` (default 300 s), and the gateway caches host
 * lookups for up to 60 s and access checks for 30 s. A takedown also purges
 * the host's edge cache when a zone id is configured. The after-commit sync
 * runs in process, so a restart can lose a pending write; the next signed
 * host lookup for that label re-syncs a stale record, and the TTL bounds the
 * rest. A missed sync is therefore corrected within TTL + 60 s at worst.
 */

export type SiteEdgeSyncSettings = Pick<
  Settings,
  | "sitesCloudflareApiToken"
  | "sitesCloudflareAccountId"
  | "sitesCloudflareKvNamespaceId"
  | "sitesCloudflareZoneId"
  | "sitesHostMapTtlSeconds"
>;

export type SiteEdgeSync = {
  readonly kvEnabled: boolean;
  readonly purgeEnabled: boolean;
  /** Write the host-map record unless the edge already holds a newer generation. */
  putHostRecord(record: SiteHostMapRecord): Promise<"written" | "skipped_newer" | "disabled">;
  /** Purge the edge cache for one hostname. */
  purgeHost(hostname: string): Promise<"purged" | "disabled">;
};

export type SiteEdgeSyncOptions = {
  fetch?: typeof fetch;
  attempts?: number;
  backoffMs?: number;
};

const API = "https://api.cloudflare.com/client/v4";
const FETCH_TIMEOUT_MS = 10_000;

async function withRetries<T>(attempts: number, backoffMs: number, run: () => Promise<T>) {
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      last = error;
      if (attempt < attempts - 1)
        await new Promise((resolve) => setTimeout(resolve, backoffMs * 2 ** attempt));
    }
  }
  throw last;
}

export function createSiteEdgeSync(
  settings: SiteEdgeSyncSettings,
  options: SiteEdgeSyncOptions = {},
): SiteEdgeSync {
  const fetchImpl = options.fetch ?? fetch;
  const attempts = Math.max(1, options.attempts ?? 3);
  const backoffMs = Math.max(0, options.backoffMs ?? 250);
  const token = settings.sitesCloudflareApiToken;
  const account = settings.sitesCloudflareAccountId;
  const namespace = settings.sitesCloudflareKvNamespaceId;
  const zone = settings.sitesCloudflareZoneId;
  const kvEnabled = Boolean(token && account && namespace);
  const purgeEnabled = Boolean(token && zone);
  const headers = { authorization: `Bearer ${token ?? ""}` };
  const valueUrl = (key: string) =>
    `${API}/accounts/${encodeURIComponent(account ?? "")}/storage/kv/namespaces/${encodeURIComponent(
      namespace ?? "",
    )}/values/${encodeURIComponent(key)}`;

  return {
    kvEnabled,
    purgeEnabled,
    async putHostRecord(record) {
      if (!kvEnabled) return "disabled";
      const parsed = SiteHostMapRecord.parse(record);
      const key = siteHostMapKey(parsed.hostname);
      return await withRetries(attempts, backoffMs, async () => {
        const current = await fetchImpl(valueUrl(key), {
          method: "GET",
          headers,
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (current.ok) {
          const existing = SiteHostMapRecord.safeParse(await current.json().catch(() => null));
          if (existing.success && existing.data.generation > parsed.generation)
            return "skipped_newer" as const;
        } else if (current.status !== 404) {
          throw new Error(`Cloudflare KV read failed with ${current.status}`);
        } else {
          await current.body?.cancel().catch(() => undefined);
        }
        const ttl = Math.max(60, settings.sitesHostMapTtlSeconds);
        const written = await fetchImpl(`${valueUrl(key)}?expiration_ttl=${ttl}`, {
          method: "PUT",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(parsed),
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!written.ok) throw new Error(`Cloudflare KV write failed with ${written.status}`);
        await written.body?.cancel().catch(() => undefined);
        return "written" as const;
      });
    },
    async purgeHost(hostname) {
      if (!purgeEnabled) return "disabled";
      return await withRetries(attempts, backoffMs, async () => {
        const response = await fetchImpl(
          `${API}/zones/${encodeURIComponent(zone ?? "")}/purge_cache`,
          {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({ hosts: [hostname.toLowerCase()] }),
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          },
        );
        if (!response.ok) throw new Error(`Cloudflare cache purge failed with ${response.status}`);
        await response.body?.cancel().catch(() => undefined);
        return "purged" as const;
      });
    },
  };
}
