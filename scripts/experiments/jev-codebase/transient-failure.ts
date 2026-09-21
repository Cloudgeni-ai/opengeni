type Receipt = { id: string; statusCode: number; reservedUsd: number };
const receipts = new WeakMap<Error, Receipt>();
export const transientStatus = (status: unknown) =>
  typeof status === "number" && [429, 502, 503, 504, 529].includes(status);

/** A message alone is not proof: construct only after the failed attempt and reserve exist. */
export function journaledTransientFailure(
  id: string,
  history: Record<string, any>[],
  cause: unknown,
) {
  const start = history.find((r) => r.id === id && r.kind === "started");
  const failure = history.find((r) => r.id === id && r.kind === "failed");
  const reserve = history.find((r) => r.failedId === id && r.kind === "transient_reserved");
  if (
    !start ||
    !failure ||
    !reserve ||
    !transientStatus(failure.statusCode) ||
    !Number.isFinite(start.reservedUsd) ||
    start.reservedUsd < 0 ||
    reserve.reservedUsd !== start.reservedUsd
  )
    throw new Error("transient_receipt_missing");
  const error = new Error("transient_provider_unavailable", { cause });
  error.name = "JournaledTransientFailure";
  receipts.set(error, { id, statusCode: failure.statusCode, reservedUsd: start.reservedUsd });
  return error;
}
export function transientReceipt(error: unknown) {
  return error instanceof Error ? receipts.get(error) : undefined;
}
