const countFormatter = new Intl.NumberFormat("en-US");

/** Visible count text. A capped traversal is a lower bound, never an exact total. */
export function sessionDescendantCountText(count: number, truncated: boolean): string {
  return `${countFormatter.format(count)}${truncated ? "+" : ""}`;
}

/** Screen-reader text that preserves the same exact-vs-lower-bound contract. */
export function sessionDescendantCountAria(count: number, truncated: boolean): string {
  const formatted = countFormatter.format(count);
  if (truncated) return `At least ${formatted} descendant sessions`;
  return `${formatted} descendant session${count === 1 ? "" : "s"}`;
}
