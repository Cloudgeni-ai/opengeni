import { isTransactionHandle, type Database } from "@opengeni/db";

/** Overlap independent response projections on a pool, never on a scoped connection.
 * Drain both readers before returning or failing; no transaction work outlives its owner.
 */
export async function readSessionResponsePair<A, B>(
  db: Database,
  primary: () => Promise<A>,
  additional: () => Promise<B>,
): Promise<[A, B]> {
  if (isTransactionHandle(db)) return [await primary(), await additional()];
  const [first, second] = await Promise.allSettled([
    Promise.resolve().then(primary),
    Promise.resolve().then(additional),
  ]);
  if (first.status === "rejected") throw first.reason;
  if (second.status === "rejected") throw second.reason;
  return [first.value, second.value];
}
