import {
  CODEX_CLIENT_VERSION,
  fetchCodexUsage,
  normalizeCodexUsage,
  type CodexTokenSnapshot,
  type CodexUsageHeaderSnapshot,
  type CodexUsagePayload,
} from "@opengeni/codex";
import { SubscriptionCoreCodexRequestOutcomeUnknownError } from "@opengeni/db";

/** Local admission decision, never a synthetic provider/transport error. */
export class CodexIncludedUsageExhaustedError extends Error {
  readonly code = "codex_included_usage_exhausted";
  constructor(readonly resetsInSeconds: number | null) {
    super("This account's included Codex usage is exhausted. Extra credits are protected.");
    this.name = "CodexIncludedUsageExhaustedError";
  }
}

export class CodexIncludedUsageUnknownError extends Error {
  readonly code = "codex_included_usage_unknown";
  constructor() {
    super(
      "Couldn't verify included Codex usage. This account is temporarily unavailable while extra credits are protected.",
    );
    this.name = "CodexIncludedUsageUnknownError";
  }
}

export function findCodexCreditPolicyError(
  error: unknown,
): CodexIncludedUsageExhaustedError | CodexIncludedUsageUnknownError | null {
  const seen = new Set<object>();
  for (let depth = 0; depth < 8 && error && typeof error === "object"; depth++) {
    if (seen.has(error)) break;
    seen.add(error);
    if (
      error instanceof CodexIncludedUsageExhaustedError ||
      error instanceof CodexIncludedUsageUnknownError
    )
      return error;
    error = (error as { cause?: unknown }).cause;
  }
  return null;
}

/** A model call can cross the provider's limit; the next call must be admitted again. */
export function createCodexCreditGuard(input: {
  allowExtraCredits?: boolean;
  /** Live accepted-pool admission, rechecked immediately before dispatch. */
  canSpendCredits?: () => Promise<boolean>;
  readUsage?: (token: CodexTokenSnapshot) => Promise<CodexUsagePayload>;
  fetchUsage?: typeof fetchCodexUsage;
  refreshToken?: () => Promise<CodexTokenSnapshot>;
  now?: () => number;
  onUsage?: (snapshot: CodexUsageHeaderSnapshot) => void;
}) {
  const now = input.now ?? Date.now;
  const readUsage =
    input.readUsage ??
    (async (token: CodexTokenSnapshot) => {
      const result = await (input.fetchUsage ?? fetchCodexUsage)({
        ...token,
        clientVersion: CODEX_CLIENT_VERSION,
      });
      if (result.status === 401) throw new CodexUsageUnauthorizedError();
      return normalizeCodexUsage(result.status, result.payload);
    });
  let token: CodexTokenSnapshot | null = null;
  type Observation = { windows: Array<{ used: number; reset: Date | null }>; checkedAt: Date };
  let snapshot: Observation | null = null;
  let spendingRefusal: CodexIncludedUsageExhaustedError | CodexIncludedUsageUnknownError | null =
    null;
  let observationRevision = 0;
  let admissionTail: Promise<void> = Promise.resolve();
  const observe = (next: CodexUsageHeaderSnapshot) => {
    if (snapshot && next.checkedAt.getTime() < snapshot.checkedAt.getTime()) return;
    observationRevision++;
    snapshot = {
      checkedAt: next.checkedAt,
      windows: [
        { used: next.primaryUsedPercent, reset: next.primaryResetAt },
        { used: next.secondaryUsedPercent, reset: next.secondaryResetAt },
      ],
    };
  };
  const check = (value: Observation, at: number): boolean => {
    const windows = value.windows;
    const exhausted = windows.filter((w) => w.used >= 100 && (!w.reset || w.reset.getTime() > at));
    if (exhausted.length) {
      const reset = exhausted.every((w) => w.reset)
        ? Math.max(...exhausted.map((w) => w.reset!.getTime()))
        : null;
      throw new CodexIncludedUsageExhaustedError(
        reset === null ? null : Math.ceil((reset - at) / 1000),
      );
    }
    // A passed reset is a reason to refresh, not proof of new allowance.
    return windows.every((w) => Number.isFinite(w.used) && (!w.reset || w.reset.getTime() > at));
  };
  const assertCanDispatch = async () => {
    if (input.allowExtraCredits) return;
    const at = now();
    // Headers can refuse dispatch immediately. A successful observation is
    // never a reusable spending permit: the preceding response or another
    // session may have consumed the remaining allowance.
    if (snapshot) check(snapshot, at);
    if (!token) throw new CodexIncludedUsageUnknownError();
    const revisionAtRead = observationRevision;
    let usage: CodexUsagePayload | null;
    try {
      usage = await readUsage(token);
    } catch (error) {
      if (error instanceof SubscriptionCoreCodexRequestOutcomeUnknownError) throw error;
      if (error instanceof CodexUsageUnauthorizedError && input.refreshToken) {
        // This runs during credential resolution, before the model's auth
        // headers are constructed. The caller tracks the refreshed version.
        token = await input.refreshToken();
        usage = await readUsage(token).catch((usageError: unknown) => {
          if (usageError instanceof SubscriptionCoreCodexRequestOutcomeUnknownError)
            throw usageError;
          return null;
        });
      } else {
        usage = null;
      }
    }
    if (!usage || usage.status === "error" || usage.status === "no-data")
      throw new CodexIncludedUsageUnknownError();
    const windows = [usage.fiveHour, usage.weekly].flatMap((window) =>
      window
        ? [
            {
              used: window.percent,
              reset: window.resetAt ? new Date(window.resetAt) : null,
            },
          ]
        : [],
    );
    if (!windows.length) {
      if (usage.limitReached || usage.status === "limit_reached")
        throw new CodexIncludedUsageExhaustedError(null);
      throw new CodexIncludedUsageUnknownError();
    }
    const next: Observation = { windows, checkedAt: new Date(now()) };
    // A response header received during this read is newer evidence than the
    // request's snapshot. Never let a delayed usage response erase it.
    if (observationRevision === revisionAtRead) snapshot = next;
    // The legacy cache contract only accepts a complete duration-labeled pair.
    if (usage.fiveHour && usage.weekly && observationRevision === revisionAtRead)
      input.onUsage?.({
        primaryUsedPercent: usage.fiveHour.percent,
        primaryResetAt: usage.fiveHour.resetAt ? new Date(usage.fiveHour.resetAt) : null,
        secondaryUsedPercent: usage.weekly.percent,
        secondaryResetAt: usage.weekly.resetAt ? new Date(usage.weekly.resetAt) : null,
        checkedAt: next.checkedAt,
      });
    if (snapshot) check(snapshot, now());
    if (!check(next, now())) throw new CodexIncludedUsageUnknownError();
    // Provider feature identifiers are not guaranteed to be model slugs.
    // Until an authoritative mapping exists, an exhausted extra allowance
    // cannot grant permission to continue spending on this account.
    for (const limit of usage.additionalLimits ?? []) {
      if (limit.unknownWindowExhausted) throw new CodexIncludedUsageExhaustedError(null);
      const featureWindows = [limit.fiveHour, limit.weekly].flatMap((window) =>
        window
          ? [
              {
                used: window.percent,
                reset: window.resetAt ? new Date(window.resetAt) : null,
              },
            ]
          : [],
      );
      if (
        featureWindows.length &&
        !check({ windows: featureWindows, checkedAt: next.checkedAt }, now())
      ) {
        throw new CodexIncludedUsageUnknownError();
      }
    }
    if (usage.limitReached || usage.status === "limit_reached")
      throw new CodexIncludedUsageExhaustedError(null);
  };
  return {
    setToken: (next: CodexTokenSnapshot) => {
      token = next;
    },
    observe,
    assertObservedUsageAllowsDispatch: async () => {
      if (input.allowExtraCredits) return;
      const refusal = spendingRefusal;
      if (refusal instanceof CodexIncludedUsageExhaustedError) {
        const allowed = await input.canSpendCredits?.();
        // A concurrent read can learn that usage is unverifiable while this
        // policy query is pending. Earlier consent cannot erase newer evidence.
        if (spendingRefusal !== refusal) {
          if (spendingRefusal) throw spendingRefusal;
          if (snapshot) check(snapshot, now());
          return;
        }
        if (allowed) return;
      }
      if (spendingRefusal) throw spendingRefusal;
      if (snapshot) check(snapshot, now());
    },
    assertCanDispatch: () => {
      // Main and title requests share this guard. Serialize their reads so a
      // late successful response cannot overwrite a newer exhaustion result.
      const admission = admissionTail.then(async () => {
        try {
          await assertCanDispatch();
          // Pending reads cannot erase an earlier feature-limit refusal. Only
          // a complete, successful usage observation restores included access.
          spendingRefusal = null;
        } catch (error) {
          if (
            error instanceof CodexIncludedUsageExhaustedError ||
            error instanceof CodexIncludedUsageUnknownError
          )
            spendingRefusal = error;
          if (
            error instanceof CodexIncludedUsageExhaustedError &&
            (await input.canSpendCredits?.()) &&
            spendingRefusal === error
          ) {
            return;
          }
          throw error;
        }
      });
      admissionTail = admission.catch(() => undefined);
      return admission;
    },
  };
}

class CodexUsageUnauthorizedError extends Error {}

/** No awaited policy work may run after the final physical lease fence. */
export async function assertCodexDispatchAdmission(
  assertCredits: () => Promise<void>,
  assertLease: () => Promise<void>,
): Promise<void> {
  await assertCredits();
  await assertLease();
}
