/**
 * Await independent operations together, then report the outcome a caller
 * would have seen had they been awaited one after another: the first failure
 * in list order wins, and no rejection is left unobserved. Use it to overlap
 * reads without changing which error a request returns.
 */
export async function allSettledInOrder<const T extends readonly unknown[] | []>(
  operations: T,
): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }> {
  const outcomes = await Promise.allSettled(operations);
  const values: unknown[] = [];
  for (const outcome of outcomes) {
    if (outcome.status === "rejected") throw outcome.reason;
    values.push(outcome.value);
  }
  return values as { -readonly [K in keyof T]: Awaited<T[K]> };
}
