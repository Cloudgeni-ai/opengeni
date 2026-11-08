import type { CodexRealtimeProviderConfig } from "@opengeni/codex";

/** Configuration only, never credentials, session context, or an admission decision. */
export function createRealtimeProviderConfigCache(
  options: {
    now?: () => number;
    ttlMs?: number;
    maxEntries?: number;
  } = {},
) {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? 300_000;
  const maxEntries = options.maxEntries ?? 256;
  const entries = new Map<string, { value: CodexRealtimeProviderConfig; expiresAt: number }>();
  return {
    async get(key: string, load: () => Promise<CodexRealtimeProviderConfig>) {
      const entry = entries.get(key);
      if (entry && entry.expiresAt > now()) return entry.value;
      entries.delete(key);
      // Do not share an in-flight authenticated request: its operation lease and
      // cancellation belong to one caller, not to other calls using this cache.
      const value = await load();
      // Network/malformed-config fallbacks are not successful configuration reads.
      if (value.source === "remote" || value.advertisedVersion) {
        entries.delete(key);
        for (const [candidate, cached] of entries) {
          if (cached.expiresAt <= now()) entries.delete(candidate);
        }
        while (entries.size >= maxEntries) entries.delete(entries.keys().next().value!);
        entries.set(key, { value, expiresAt: now() + ttlMs });
      }
      return value;
    },
    invalidate(key: string) {
      entries.delete(key);
    },
  };
}
