import {
  CODEX_CLIENT_VERSION,
  fetchCodexUsage,
  normalizeCodexUsage,
  type CodexTokenSnapshot,
  type CodexUsageHeaderSnapshot,
  type CodexUsagePayload,
} from "@opengeni/codex";

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
      "Couldn't verify included Codex usage. Work stopped to protect extra credits. Try again after checking the account's usage.",
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
  allowExtraCredits: boolean;
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
  const observe = (next: CodexUsageHeaderSnapshot) => {
    if (snapshot && next.checkedAt.getTime() < snapshot.checkedAt.getTime()) return;
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
  return {
    setToken: (next: CodexTokenSnapshot) => {
      token = next;
    },
    observe,
    assertObservedUsageAllowsDispatch: () => {
      if (!input.allowExtraCredits && snapshot) check(snapshot, now());
    },
    assertCanDispatch: async () => {
      if (input.allowExtraCredits) return;
      const at = now();
      // Headers can refuse dispatch immediately. A successful observation is
      // never a reusable spending permit: the preceding response or another
      // session may have consumed the remaining allowance.
      if (snapshot) check(snapshot, at);
      if (!token) throw new CodexIncludedUsageUnknownError();
      let usage: CodexUsagePayload | null;
      try {
        usage = await readUsage(token);
      } catch (error) {
        if (error instanceof CodexUsageUnauthorizedError && input.refreshToken) {
          // This runs during credential resolution, before the model's auth
          // headers are constructed. The caller tracks the refreshed version.
          token = await input.refreshToken();
          usage = await readUsage(token).catch(() => null);
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
      snapshot = next;
      // The legacy cache contract only accepts a complete duration-labeled pair.
      if (usage.fiveHour && usage.weekly)
        input.onUsage?.({
          primaryUsedPercent: usage.fiveHour.percent,
          primaryResetAt: usage.fiveHour.resetAt ? new Date(usage.fiveHour.resetAt) : null,
          secondaryUsedPercent: usage.weekly.percent,
          secondaryResetAt: usage.weekly.resetAt ? new Date(usage.weekly.resetAt) : null,
          checkedAt: next.checkedAt,
        });
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
    },
  };
}

class CodexUsageUnauthorizedError extends Error {}
