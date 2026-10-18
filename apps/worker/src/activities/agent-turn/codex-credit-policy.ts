import type { CodexUsageHeaderSnapshot } from "@opengeni/codex";

/** Local admission decision, never a synthetic provider/transport error. */
export class CodexIncludedUsageExhaustedError extends Error {
  readonly code = "codex_included_usage_exhausted";
  constructor(readonly resetsInSeconds: number | null) {
    super("This account's included Codex usage is exhausted. Extra credits are protected.");
    this.name = "CodexIncludedUsageExhaustedError";
  }
}

export function findCodexCreditPolicyError(
  error: unknown,
): CodexIncludedUsageExhaustedError | null {
  const seen = new Set<object>();
  for (let depth = 0; depth < 8 && error && typeof error === "object"; depth++) {
    if (seen.has(error)) break;
    seen.add(error);
    if (error instanceof CodexIncludedUsageExhaustedError) return error;
    error = (error as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * Protects purchased Codex credits without delaying model requests. Admission
 * reads no usage endpoint: it refuses a dispatch only when usage this turn
 * already observed (the usage headers every Codex response carries) shows an
 * included window fully used and not yet reset, unless credit spending is
 * explicitly allowed. Unknown usage admits the request. A single request may
 * therefore cross the limit before its own headers report it; the next one is
 * refused. Connections the shared core already knows are exhausted are not
 * leased to a turn in the first place.
 */
export function createCodexCreditGuard(input: {
  allowExtraCredits?: boolean;
  /** Live accepted-pool admission, rechecked immediately before dispatch. */
  canSpendCredits?: () => Promise<boolean>;
  now?: () => number;
}) {
  const now = input.now ?? Date.now;
  type Observation = { windows: Array<{ used: number; reset: Date | null }>; checkedAt: Date };
  let snapshot: Observation | null = null;
  const observe = (next: CodexUsageHeaderSnapshot) => {
    // Out-of-order responses cannot replace newer evidence with older.
    if (snapshot && next.checkedAt.getTime() < snapshot.checkedAt.getTime()) return;
    snapshot = {
      checkedAt: next.checkedAt,
      windows: [
        { used: next.primaryUsedPercent, reset: next.primaryResetAt },
        { used: next.secondaryUsedPercent, reset: next.secondaryResetAt },
      ],
    };
  };
  /** The refusal the latest observation proves, or null when none is known. */
  const knownExhaustion = (): CodexIncludedUsageExhaustedError | null => {
    if (!snapshot) return null;
    const at = now();
    // A window whose reset has passed is no longer known to be exhausted.
    const exhausted = snapshot.windows.filter(
      (w) => Number.isFinite(w.used) && w.used >= 100 && (!w.reset || w.reset.getTime() > at),
    );
    if (!exhausted.length) return null;
    const reset = exhausted.every((w) => w.reset)
      ? Math.max(...exhausted.map((w) => w.reset!.getTime()))
      : null;
    return new CodexIncludedUsageExhaustedError(
      reset === null ? null : Math.ceil((reset - at) / 1000),
    );
  };
  return {
    observe,
    /** Refuses only known exhaustion without live consent to spend credits. */
    assertKnownUsageAllowsDispatch: async () => {
      if (input.allowExtraCredits) return;
      const refusal = knownExhaustion();
      if (!refusal) return;
      if (await input.canSpendCredits?.()) return;
      throw refusal;
    },
  };
}

/** No awaited policy work may run after the final physical lease fence. */
export async function assertCodexDispatchAdmission(
  assertCredits: () => Promise<void>,
  assertLease: () => Promise<void>,
): Promise<void> {
  await assertCredits();
  await assertLease();
}
