/**
 * One token bucket per closed key, for anonymous beacon routes. It bounds
 * counter inflation and log volume from any caller without per-client state.
 */
export type KeyedAdmission<Key extends string> = { admit(key: Key): boolean };

export function createKeyedAdmission<Key extends string>(
  options: { capacity?: number; refillPerSecond?: number; now?: () => number } = {},
): KeyedAdmission<Key> {
  const capacity = options.capacity ?? 30;
  const refillPerMs = (options.refillPerSecond ?? 0.5) / 1_000;
  const now = options.now ?? Date.now;
  const buckets = new Map<Key, { tokens: number; updatedAt: number }>();
  return {
    admit(key) {
      const at = now();
      const bucket = buckets.get(key) ?? { tokens: capacity, updatedAt: at };
      bucket.tokens = Math.min(
        capacity,
        bucket.tokens + Math.max(0, at - bucket.updatedAt) * refillPerMs,
      );
      bucket.updatedAt = at;
      buckets.set(key, bucket);
      if (bucket.tokens < 1) return false;
      bucket.tokens -= 1;
      return true;
    },
  };
}
