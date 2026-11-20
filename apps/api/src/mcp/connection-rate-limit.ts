/**
 * Token buckets per connected agent (an organization MCP connection, a
 * personal key or an organization key), so one runaway agent can't flood the
 * API or start work without end. In process memory: each API process limits
 * on its own. Idle buckets refill to full and are dropped first once the map
 * is at its size bound, so the map never grows without end.
 */
export type ConnectionRateLimiter = {
  /** Seconds until the next call is admitted, or 0 when admitted now (and counted). */
  admit(key: string): number;
};

export function createConnectionRateLimiter(options: {
  capacity: number;
  refillPerSecond: number;
  maxKeys?: number;
  now?: () => number;
}): ConnectionRateLimiter {
  const maxKeys = options.maxKeys ?? 10_000;
  const refillPerMs = options.refillPerSecond / 1_000;
  const now = options.now ?? Date.now;
  const buckets = new Map<string, { tokens: number; updatedAt: number }>();
  return {
    admit(key) {
      const at = now();
      const bucket = buckets.get(key) ?? {
        tokens: options.capacity,
        updatedAt: at,
      };
      bucket.tokens = Math.min(
        options.capacity,
        bucket.tokens + Math.max(0, at - bucket.updatedAt) * refillPerMs,
      );
      bucket.updatedAt = at;
      // Most recently used last, so the oldest bucket is evicted first.
      buckets.delete(key);
      buckets.set(key, bucket);
      while (buckets.size > maxKeys) {
        const oldest = buckets.keys().next().value;
        if (oldest === undefined) break;
        buckets.delete(oldest);
      }
      if (bucket.tokens < 1)
        return Math.max(1, Math.ceil((1 - bucket.tokens) / refillPerMs / 1_000));
      bucket.tokens -= 1;
      return 0;
    },
  };
}
