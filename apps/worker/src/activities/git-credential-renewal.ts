import type { GitCredentialProvider } from "@opengeni/contracts";
import type { GitTokenExpiries, GitTokenSeeds, MintedRunGitCredentials } from "./environment";

export const GIT_CREDENTIAL_DEFAULT_REFRESH_MS = 30 * 60_000;
export const GIT_CREDENTIAL_EXPIRY_LEAD_MS = 5 * 60_000;
export const GIT_CREDENTIAL_MIN_REFRESH_MS = 5_000;
export const GIT_CREDENTIAL_MAX_RETRY_MS = 5 * 60_000;

type RenewalTimer = unknown;

export type GitCredentialRenewalResult = {
  providers: readonly GitCredentialProvider[];
  nextDelayMs: number;
};

export type GitCredentialRenewalFailure = {
  providers: readonly GitCredentialProvider[];
  retryDelayMs: number;
  errorClass: string;
};

export type GitCredentialRenewalController = {
  refreshNow(): Promise<void>;
  invalidateNow(providers?: readonly GitCredentialProvider[]): Promise<void>;
  stop(): Promise<void>;
};

export type GitCredentialRenewalOptions = {
  expectedProviders: readonly GitCredentialProvider[];
  initialExpiresAt?: GitTokenExpiries;
  mint: () => Promise<MintedRunGitCredentials | undefined>;
  write: (tokens: GitTokenSeeds) => Promise<void>;
  /**
   * Remove the platform-owned token files for these providers. The controller
   * serializes this with token writes, so readers see either a complete old
   * token, no token after expiry/revocation, or a complete replacement.
   */
  invalidate?: (providers: readonly GitCredentialProvider[]) => Promise<void>;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => RenewalTimer;
  clearSchedule?: (timer: RenewalTimer) => void;
  onSuccess?: (result: GitCredentialRenewalResult) => void;
  onFailure?: (failure: GitCredentialRenewalFailure) => void;
};

/**
 * Return a conservative refresh delay for a provider set.
 *
 * The fixed cadence caps long/unknown provider TTLs; a known earlier expiry
 * pulls renewal forward. Invalid metadata is treated as unknown rather than
 * allowing a token to live indefinitely.
 */
export function nextGitCredentialRenewalDelay(
  expiresAt: GitTokenExpiries | undefined,
  providers: readonly GitCredentialProvider[],
  nowMs = Date.now(),
): number {
  let delay = GIT_CREDENTIAL_DEFAULT_REFRESH_MS;
  for (const provider of providers) {
    const rawExpiry = expiresAt?.[provider];
    if (!rawExpiry) continue;
    const expiryMs = Date.parse(rawExpiry);
    if (!Number.isFinite(expiryMs)) continue;
    delay = Math.min(
      delay,
      Math.max(GIT_CREDENTIAL_MIN_REFRESH_MS, expiryMs - nowMs - GIT_CREDENTIAL_EXPIRY_LEAD_MS),
    );
  }
  return delay;
}

export function startGitCredentialRenewalLoop(
  options: GitCredentialRenewalOptions,
): GitCredentialRenewalController {
  const providers = [...new Set(options.expectedProviders)];
  const now = options.now ?? Date.now;
  const schedule =
    options.schedule ??
    ((callback: () => void, delayMs: number): ReturnType<typeof setTimeout> => {
      const timer = setTimeout(callback, delayMs);
      timer.unref?.();
      return timer;
    });
  const clearSchedule =
    options.clearSchedule ??
    ((timer: RenewalTimer): void => clearTimeout(timer as ReturnType<typeof setTimeout>));

  let stopped = false;
  let refreshTimer: RenewalTimer | null = null;
  let expiryTimer: RenewalTimer | null = null;
  let inFlight: Promise<void> | null = null;
  let mutationTail: Promise<void> = Promise.resolve();
  let retryDelayMs = GIT_CREDENTIAL_MIN_REFRESH_MS;
  let credentialRevision = 0;
  let currentExpiresAt: GitTokenExpiries = { ...(options.initialExpiresAt ?? {}) };

  const clearRefreshTimer = (): void => {
    if (refreshTimer === null) return;
    clearSchedule(refreshTimer);
    refreshTimer = null;
  };

  const clearExpiryTimer = (): void => {
    if (expiryTimer === null) return;
    clearSchedule(expiryTimer);
    expiryTimer = null;
  };

  const scheduleRefresh = (delayMs: number): void => {
    if (stopped || providers.length === 0) return;
    clearRefreshTimer();
    refreshTimer = schedule(() => {
      refreshTimer = null;
      void refreshNow();
    }, delayMs);
  };

  const enqueueMutation = (mutation: () => Promise<void>): Promise<void> => {
    const operation = mutationTail.then(mutation, mutation);
    // Keep the serialization chain usable after a failed sandbox mutation. The
    // caller still receives the original rejection through `operation`.
    mutationTail = operation.catch(() => undefined);
    return operation;
  };

  const scheduleExpiry = (): void => {
    clearExpiryTimer();
    if (stopped || !options.invalidate) return;
    let earliest = Number.POSITIVE_INFINITY;
    for (const provider of providers) {
      const raw = currentExpiresAt[provider];
      if (!raw) continue;
      const parsed = Date.parse(raw);
      if (Number.isFinite(parsed)) earliest = Math.min(earliest, parsed);
    }
    if (!Number.isFinite(earliest)) return;
    const scheduledRevision = credentialRevision;
    expiryTimer = schedule(
      () => {
        expiryTimer = null;
        const expiredAtCallback = providers.filter((provider) => {
          const raw = currentExpiresAt[provider];
          return Boolean(raw) && Date.parse(raw!) <= now();
        });
        if (expiredAtCallback.length === 0) {
          scheduleExpiry();
          return;
        }
        void enqueueMutation(async () => {
          if (credentialRevision !== scheduledRevision || !options.invalidate) return;
          const expired = expiredAtCallback.filter((provider) => {
            const raw = currentExpiresAt[provider];
            return Boolean(raw) && Date.parse(raw!) <= now();
          });
          if (expired.length === 0) return;
          await options.invalidate(expired);
          for (const provider of expired) delete currentExpiresAt[provider];
          credentialRevision += 1;
        }).finally(() => {
          if (!stopped) scheduleExpiry();
        });
      },
      Math.max(0, earliest - now()),
    );
  };

  const validateMintedTokens = (
    minted: MintedRunGitCredentials | undefined,
  ): MintedRunGitCredentials => {
    if (!minted) {
      throw new GitCredentialRenewalError("credential provider returned no token bundle");
    }
    for (const provider of providers) {
      if (!minted.gitTokens[provider]) {
        throw new GitCredentialRenewalError(`credential provider omitted ${provider}`);
      }
    }
    return minted;
  };

  const performRefresh = async (): Promise<void> => {
    try {
      const minted = validateMintedTokens(await options.mint());
      if (stopped) return;
      await enqueueMutation(async () => {
        await options.write(minted.gitTokens);
        currentExpiresAt = { ...minted.expiresAt };
        credentialRevision += 1;
      });
      if (stopped) return;
      retryDelayMs = GIT_CREDENTIAL_MIN_REFRESH_MS;
      const nextDelayMs = nextGitCredentialRenewalDelay(minted.expiresAt, providers, now());
      scheduleExpiry();
      try {
        options.onSuccess?.({ providers, nextDelayMs });
      } catch {
        // Observability callbacks never own credential liveness.
      }
      scheduleRefresh(nextDelayMs);
    } catch (error) {
      if (stopped) return;
      const scheduledRetryMs = retryDelayMs;
      retryDelayMs = Math.min(retryDelayMs * 2, GIT_CREDENTIAL_MAX_RETRY_MS);
      try {
        options.onFailure?.({
          providers,
          retryDelayMs: scheduledRetryMs,
          errorClass: error instanceof Error ? error.name : "UnknownError",
        });
      } catch {
        // Observability callbacks never own credential liveness.
      }
      scheduleRefresh(scheduledRetryMs);
    }
  };

  const refreshNow = (): Promise<void> => {
    if (stopped || providers.length === 0) return Promise.resolve();
    if (inFlight) return inFlight;
    clearRefreshTimer();
    const operation = performRefresh();
    inFlight = operation;
    void operation.finally(() => {
      if (inFlight === operation) inFlight = null;
    });
    return operation;
  };

  scheduleRefresh(nextGitCredentialRenewalDelay(options.initialExpiresAt, providers, now()));
  scheduleExpiry();

  return {
    refreshNow,
    invalidateNow: async (requestedProviders = providers) => {
      if (stopped || !options.invalidate) return;
      const selected = [...new Set(requestedProviders)].filter((provider) =>
        providers.includes(provider),
      );
      if (selected.length === 0) return;
      clearExpiryTimer();
      await enqueueMutation(async () => {
        if (!options.invalidate) return;
        await options.invalidate(selected);
        for (const provider of selected) delete currentExpiresAt[provider];
        credentialRevision += 1;
      });
      scheduleExpiry();
    },
    stop: async () => {
      stopped = true;
      clearRefreshTimer();
      clearExpiryTimer();
      // A broker mint can be a remote host call with no cancellation seam. It
      // cannot mutate the sandbox, and the stopped check above rejects its late
      // result, so never hold turn settlement hostage to a hung mint. Token-file
      // writes and invalidations do mutate the box and must drain before
      // capture/teardown.
      await mutationTail.catch(() => undefined);
    },
  };
}

class GitCredentialRenewalError extends Error {
  override readonly name = "GitCredentialRenewalError";
}
