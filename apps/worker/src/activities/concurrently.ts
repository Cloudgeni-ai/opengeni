/** Run `work` on every item, at most `limit` at once, keeping the results in order. */
export async function mapConcurrently<Item, Result>(
  items: readonly Item[],
  limit: number,
  work: (item: Item, index: number) => Promise<Result>,
): Promise<Result[]> {
  const results: Result[] = new Array(items.length);
  let next = 0;
  let failure: { error: unknown } | null = null;
  const runner = async () => {
    while (!failure && next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = await work(items[index]!, index);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, runner));
  if (failure) throw (failure as { error: unknown }).error;
  return results;
}
