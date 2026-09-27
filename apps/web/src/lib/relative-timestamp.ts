/** Compact relative time: "in 5m", "3h ago". Numbers are unix seconds. */
export function relativeTimestamp(value: string | number | null | undefined, now: number): string {
  if (value == null) return "";
  const timestamp = typeof value === "number" ? value * 1000 : new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "";
  const delta = timestamp - now;
  const future = delta >= 0;
  const absolute = Math.abs(delta);
  const minutes = Math.max(1, Math.round(absolute / 60_000));
  const amount =
    minutes >= 1440
      ? `${Math.round(minutes / 1440)}d`
      : minutes >= 60
        ? `${Math.round(minutes / 60)}h`
        : `${minutes}m`;
  return future ? `in ${amount}` : `${amount} ago`;
}

/**
 * Relative time for something that already happened (a usage check). The
 * `now` clock only ticks every 30s, so a fresh check can sit slightly in the
 * "future"; never read it as "in 1m".
 */
export function relativePastTimestamp(
  value: string | number | null | undefined,
  now: number,
): string {
  if (value == null) return "";
  const timestamp = typeof value === "number" ? value * 1000 : new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "";
  const elapsed = now - timestamp;
  if (elapsed < 60_000) return "just now";
  return relativeTimestamp(timestamp / 1000, now);
}
