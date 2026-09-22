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
      // Historical reconciliation only: there is no runtime correction switch.
      // An unconsumed correction permission cannot unlock a failed ledger.
      const correctedBadRequest =
        failed.statusCode === 400 &&
        history.some(
          (r) =>
            r.kind === "bad_request_correction" &&
            r.failedId === started.id &&
            r.failedPayloadHash === started.payloadHash &&
            typeof r.replacementPayloadHash === "string" &&
            /^[a-f0-9]{64}$/.test(r.replacementPayloadHash) &&
            r.replacementPayloadHash !== started.payloadHash &&
            history.some((binding) => {
              if (
                binding.kind !== "bad_request_correction_settled" ||
                binding.failedId !== started.id ||
                binding.replacementPayloadHash !== r.replacementPayloadHash
              )
                return false;
              const replacement = history.find(
                (item) => item.kind === "started" && item.id === binding.replacementId,
              );
              if (!replacement) return false;
              return (
                replacement?.payloadHash === r.replacementPayloadHash &&
                ["model", "stage", "caseId", "arm"].every(
                  (key) => typeof started[key] === "string" && replacement[key] === started[key],
                ) &&
                history.some((item) => item.kind === "completed" && item.id === replacement.id) &&
                !history.some((item) => item.kind === "failed" && item.id === replacement.id)
              );
            }),
        );
      if ((!transientStatus(failed.statusCode) || !approved) && !correctedBadRequest)
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
