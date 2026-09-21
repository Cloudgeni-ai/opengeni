export type LedgerRow = Record<string, any>;
import { transientReceipt, transientStatus } from "./transient-failure";
export { transientStatus };

/** Only an already-journaled explicit transient exhaustion permits ordinary-tool fallback. */
export async function withTransientDelegationFallback<T>(invoke: () => Promise<T>) {
  try {
    return await invoke();
  } catch (error) {
    if (!transientReceipt(error)) throw error;
    return {
      version: "transient-delegation-fallback-v1",
      status: "needs_guidance",
      answer: "indecisive",
      reasonCode: "jev_temporarily_unavailable",
      evidence: [],
      coverage: undefined,
      internalChars: null,
      trace: [
        {
          stage: "provider_yield",
          reason: "Transient retry exhausted; failed requests remain reserved. Use ordinary tools.",
        },
      ],
    };
  }
}

/** Unknown bills stay reserved; authorization permits continuation, never erases history. */
export function budgetState(history: LedgerRow[]) {
  const starts = history.filter((r) => r.kind === "started");
  let used = 0;
  for (const started of starts) {
    const completed = history.find((r) => r.id === started.id && r.kind === "completed");
    const failed = history.find((r) => r.id === started.id && r.kind === "failed");
    if (!completed && !failed) throw new Error("unsettled_ledger");
    if (failed) {
      const approved = history.some(
        (r) =>
          ["resume_authorization", "transient_reserved"].includes(r.kind) &&
          r.failedId === started.id,
      );
      if (!transientStatus(failed.statusCode) || !approved)
        throw new Error("failed_ledger_requires_authorization");
    }
    const values = [
      completed?.nominalUsd ?? 0,
      completed?.reportedUsd ?? 0,
      failed ? started.reservedUsd : 0,
    ];
    if (values.some((v) => typeof v !== "number" || !Number.isFinite(v) || v < 0))
      throw new Error("invalid_ledger_amount");
    used += Math.max(...values);
  }
  return { attempts: starts.length, used };
}
