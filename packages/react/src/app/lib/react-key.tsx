/**
 * Attach deterministic, duplicate-safe React keys to a rendered list.
 *
 * Content identifies an item across insertions and reorders; the occurrence
 * suffix keeps intentionally duplicated rows unique without falling back to an
 * array index.
 */
export function withOccurrenceKeys<T>(
  items: readonly T[],
  contentKey: (item: T) => string,
): Array<{ key: string; item: T }> {
  const occurrences = new Map<string, number>();
  return items.map((item) => {
    const content = contentKey(item);
    const occurrence = (occurrences.get(content) ?? 0) + 1;
    occurrences.set(content, occurrence);
    return { key: `${content}\u0000${occurrence}`, item };
  });
}
