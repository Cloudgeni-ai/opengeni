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
  stop(): Promise<void>;
};

export type GitCredentialRenewalOptions = {
  expectedProviders: readonly GitCredentialProvider[];
  initialExpiresAt?: GitTokenExpiries;
  mint: () => Promise<MintedRunGitCredentials | undefined>;
  write: (tokens: GitTokenSeeds) => Promise<void>;
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
  let timer: RenewalTimer | null = null;
  let inFlight: Promise<void> | null = null;
  let writeInFlight: Promise<void> | null = null;
  let retryDelayMs = GIT_CREDENTIAL_MIN_REFRESH_MS;

  const clearTimer = (): void => {
    if (timer === null) return;
    clearSchedule(timer);
    timer = null;
  };

  const scheduleRefresh = (delayMs: number): void => {
    if (stopped || providers.length === 0) return;
    clearTimer();
    timer = schedule(() => {
      timer = null;
      void refreshNow();
    }, delayMs);
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
      const write = options.write(minted.gitTokens);
      writeInFlight = write;
      try {
        await write;
      } finally {
        if (writeInFlight === write) writeInFlight = null;
      }
      if (stopped) return;
      retryDelayMs = GIT_CREDENTIAL_MIN_REFRESH_MS;
      const nextDelayMs = nextGitCredentialRenewalDelay(minted.expiresAt, providers, now());
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
    clearTimer();
    const operation = performRefresh();
    inFlight = operation;
    void operation.finally(() => {
      if (inFlight === operation) inFlight = null;
    });
    return operation;
  };

  scheduleRefresh(nextGitCredentialRenewalDelay(options.initialExpiresAt, providers, now()));

  return {
    refreshNow,
    stop: async () => {
      stopped = true;
      clearTimer();
      // A broker mint can be a remote host call with no cancellation seam. It
      // cannot mutate the sandbox, and the stopped check above rejects its late
      // result, so never hold turn settlement hostage to a hung mint. A write
      // does mutate the box and must drain before capture/teardown.
      await writeInFlight?.catch(() => undefined);
    },
  };
}

class GitCredentialRenewalError extends Error {
  override readonly name = "GitCredentialRenewalError";
}
