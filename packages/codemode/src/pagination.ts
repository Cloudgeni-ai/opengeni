import { createHash, randomUUID } from "node:crypto";

export type IdPage = { ids: readonly string[]; nextPageToken?: string | null };
/** Collect every page before mutation. A failed/incomplete read never returns a selection. */
export async function collectIdPages(
  load: (pageToken: string | undefined, signal?: AbortSignal) => Promise<IdPage>,
  options: { maxItems?: number; maxPages?: number; signal?: AbortSignal } = {},
): Promise<readonly string[]> {
  const maxItems = options.maxItems ?? 10_000,
    maxPages = options.maxPages ?? 200;
  if (
    !Number.isSafeInteger(maxItems) ||
    maxItems < 1 ||
    maxItems > 50_000 ||
    !Number.isSafeInteger(maxPages) ||
    maxPages < 1 ||
    maxPages > 1000
  )
    throw new Error("Invalid selection limit");
  const ids = new Set<string>(),
    tokens = new Set<string>();
  let token: string | undefined;
  for (let index = 0; index < maxPages; index++) {
    options.signal?.throwIfAborted();
    const page = await load(token, options.signal);
    options.signal?.throwIfAborted();
    if (!Array.isArray(page?.ids) || page.ids.length > 50_000)
      throw new Error("Invalid selection page");
    for (const id of page.ids) {
      if (typeof id !== "string" || !id || id.length > 256) throw new Error("Invalid selection ID");
      ids.add(id);
      if (ids.size > maxItems)
        throw new Error("Selection exceeds item limit; no complete selection returned");
    }
    if (!page.nextPageToken) return Object.freeze([...ids]);
    if (typeof page.nextPageToken !== "string" || page.nextPageToken.length > 4096)
      throw new Error("Invalid page token");
    if (!page.ids.length || tokens.has(page.nextPageToken))
      throw new Error("Pagination did not progress; no complete selection returned");
    tokens.add(page.nextPageToken);
    token = page.nextPageToken;
  }
  throw new Error("Selection exceeds page limit; no complete selection returned");
}

export type IdBatchPlan = {
  readonly id: string;
  readonly selectionDigest: string;
  readonly count: number;
  readonly batches: readonly { readonly operationId: string; readonly ids: readonly string[] }[];
};
/** Pure chunk plan. Each chunk is a separate durable operation and review, never a fresh query. */
export function planIdBatches(selection: readonly string[], maxBatchSize = 1000): IdBatchPlan {
  if (
    !Number.isSafeInteger(maxBatchSize) ||
    maxBatchSize < 1 ||
    maxBatchSize > 1000 ||
    selection.length > 50_000
  )
    throw new Error("Invalid batch limit");
  if (selection.some((id) => typeof id !== "string" || !id || id.length > 256))
    throw new Error("Invalid selection ID");
  const ids = [...new Set(selection)];
  const batches = Array.from({ length: Math.ceil(ids.length / maxBatchSize) }, (_, index) =>
    Object.freeze({
      operationId: randomUUID(),
      ids: Object.freeze(ids.slice(index * maxBatchSize, (index + 1) * maxBatchSize)),
    }),
  );
  return Object.freeze({
    id: randomUUID(),
    selectionDigest: createHash("sha256").update(JSON.stringify(ids)).digest("hex"),
    count: ids.length,
    batches: Object.freeze(batches),
  });
}

export type IdBatchReceipt = {
  operationId: string;
  outcome: "acknowledged" | "failed_before_effect" | "unknown" | "waiting";
};
/** No per-item success is implied by a provider's batch acknowledgement. */
export function summarizeIdBatches(plan: IdBatchPlan, receipts: readonly IdBatchReceipt[]) {
  const byId = new Map<string, IdBatchReceipt["outcome"]>();
  const known = new Set(plan.batches.map((batch) => batch.operationId));
  for (const receipt of receipts) {
    if (!["acknowledged", "failed_before_effect", "unknown", "waiting"].includes(receipt.outcome))
      throw new Error("Invalid batch outcome");
    if (!known.has(receipt.operationId) || byId.has(receipt.operationId))
      throw new Error("Receipt does not uniquely identify a planned batch");
    byId.set(receipt.operationId, receipt.outcome);
  }
  const counts = { acknowledged: 0, failed_before_effect: 0, unknown: 0, waiting: 0, unstarted: 0 };
  for (const batch of plan.batches)
    counts[byId.get(batch.operationId) ?? "unstarted"] += batch.ids.length;
  return { selected: plan.count, ...counts, individualStateVerified: false as const };
}
