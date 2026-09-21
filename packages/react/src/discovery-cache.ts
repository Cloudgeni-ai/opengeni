/** Short-lived presentation data only. Never cache installation or authorization state. */
export function createDiscoveryCache<T>(ttlMs = 60_000, capacity = 64) {
  const clients = new WeakMap<
    object,
    Map<string, { expires: number; value: T | undefined; pending: Promise<T> }>
  >();
  return {
    peek(client: object, key: string): T | undefined {
      const entry = clients.get(client)?.get(key);
      return entry && entry.expires > Date.now() ? entry.value : undefined;
    },
    read(client: object, key: string, fetch: () => Promise<T>): Promise<T> {
      let entries = clients.get(client);
      if (!entries) {
        entries = new Map();
        clients.set(client, entries);
      }
      const existing = entries.get(key);
      if (existing && existing.expires > Date.now()) return existing.pending;
      entries.delete(key);
      while (entries.size >= capacity) entries.delete(entries.keys().next().value!);
      const entry = {
        expires: Date.now() + ttlMs,
        value: undefined as T | undefined,
        pending: Promise.resolve().then(fetch),
      };
      entries.set(key, entry);
      entry.pending = entry.pending.then(
        (value) => {
          entry.value = value;
          entry.expires = Date.now() + ttlMs;
          return value;
        },
        (error) => {
          if (entries.get(key) === entry) entries.delete(key);
          throw error;
        },
      );
      return entry.pending;
    },
  };
}
