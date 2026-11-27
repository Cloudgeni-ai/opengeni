import type { CodexRealtimeProviderConfig } from "@opengeni/codex";

/**
 * One read of the cache. `refresh` is present when `value` is past its
 * freshness window: the value is still used for this call (configuration
 * rotates rarely), while this caller's own request refreshes the entry. It
 * resolves to the newly read configuration, or null when the refresh failed
 * or only produced the pinned fallback.
 */
export type RealtimeProviderConfigRead = {
  value: CodexRealtimeProviderConfig;
  refresh?: Promise<CodexRealtimeProviderConfig | null>;
};

/** Configuration only, never credentials, session context, or an admission decision. */
export function createRealtimeProviderConfigCache(
  options: {
    now?: () => number;
    ttlMs?: number;
    /** How long past `ttlMs` an entry may still be served while it refreshes. */
    staleMs?: number;
    maxEntries?: number;
  } = {},
) {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? 300_000;
  const staleMs = options.staleMs ?? 86_400_000;
  const maxEntries = options.maxEntries ?? 256;
  const entries = new Map<string, { value: CodexRealtimeProviderConfig; freshUntil: number }>();
  // Network/malformed-config fallbacks are not successful configuration reads.
  const successful = (value: CodexRealtimeProviderConfig) =>
    value.source === "remote" || Boolean(value.advertisedVersion);
  const store = (key: string, value: CodexRealtimeProviderConfig) => {
    if (!successful(value)) return;
    entries.delete(key);
    for (const [candidate, cached] of entries) {
      if (cached.freshUntil + staleMs <= now()) entries.delete(candidate);
    }
    while (entries.size >= maxEntries) entries.delete(entries.keys().next().value!);
    entries.set(key, { value, freshUntil: now() + ttlMs });
  };
  return {
    async get(
      key: string,
      load: () => Promise<CodexRealtimeProviderConfig>,
    ): Promise<RealtimeProviderConfigRead> {
      const entry = entries.get(key);
      const at = now();
      if (entry && entry.freshUntil > at) return { value: entry.value };
      // Do not share an in-flight authenticated request: its operation lease and
      // cancellation belong to one caller, not to other calls using this cache.
      if (entry && entry.freshUntil + staleMs > at) {
        const refresh = load().then(
          (value) => {
            store(key, value);
            return successful(value) ? value : null;
          },
          () => null,
        );
        return { value: entry.value, refresh };
      }
      entries.delete(key);
      const value = await load();
      store(key, value);
      return { value };
    },
    invalidate(key: string) {
      entries.delete(key);
    },
  };
}
