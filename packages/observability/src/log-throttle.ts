/**
 * Per-key warning throttle for repetitive, content-free operational warnings.
 *
 * The first occurrence of a key is always admitted, and so is the first
 * occurrence after a quiet interval. Occurrences inside the interval are only
 * counted, and the key's next admitted line reports how many were suppressed.
 * Keys are process-local and never logged, so a caller may key on a private
 * digest. The key set is bounded: when full, the least recently admitted key is
 * forgotten (its pending suppressed count is lost and it is admitted again as a
 * first occurrence). Metrics stay the exact rate signal; this only bounds logs.
 */
export type LogThrottle = {
  /** `null` means "counted, do not log"; otherwise log now and report
   * `suppressedCount` occurrences hidden since this key's previous line. */
  admit(key: string): { suppressedCount: number } | null;
};

export function createLogThrottle(options: {
  intervalMs: number;
  maxKeys?: number;
  now?: () => number;
}): LogThrottle {
  const intervalMs = Math.max(0, options.intervalMs);
  const maxKeys = Math.max(1, Math.floor(options.maxKeys ?? 1_024));
  const now = options.now ?? Date.now;
  const entries = new Map<string, { admittedAt: number; suppressed: number }>();
  return {
    admit(key) {
      const at = now();
      const entry = entries.get(key);
      if (entry && at >= entry.admittedAt && at - entry.admittedAt < intervalMs) {
        entry.suppressed += 1;
        return null;
      }
      const suppressedCount = entry?.suppressed ?? 0;
      // Re-insert so Map order tracks the least recently admitted key.
      entries.delete(key);
      if (entries.size >= maxKeys) {
        const oldest = entries.keys().next();
        if (!oldest.done) entries.delete(oldest.value);
      }
      entries.set(key, { admittedAt: at, suppressed: 0 });
      return { suppressedCount };
    },
  };
}
