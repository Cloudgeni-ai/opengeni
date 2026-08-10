import {
  startExpiringMaterialRenewalLoop,
  type ExpiringMaterialRenewalController,
} from "./expiring-material-renewal";
import type { MintedSandboxCodemodeToken } from "./environment";

export const CODEMODE_TOKEN_DEFAULT_REFRESH_MS = 30 * 60_000;
export const CODEMODE_TOKEN_EXPIRY_LEAD_MS = 5 * 60_000;
export const CODEMODE_TOKEN_MIN_REFRESH_MS = 5_000;
export const CODEMODE_TOKEN_MAX_RETRY_MS = 5 * 60_000;

export type CodemodeTokenRenewalController = ExpiringMaterialRenewalController;

export type CodemodeTokenRenewalOptions = {
  initialExpiresAt: Date;
  mint: () => Promise<MintedSandboxCodemodeToken | undefined>;
  write: (material: MintedSandboxCodemodeToken) => Promise<void>;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  clearSchedule?: (timer: unknown) => void;
  onSuccess?: (result: { nextDelayMs: number }) => void;
  onFailure?: (failure: {
    retryDelayMs: number;
    errorClass: "CodemodeTokenRenewalOperationError";
  }) => void;
};

class CodemodeTokenRenewalError extends Error {
  override readonly name = "CodemodeTokenRenewalError";
}

export function startCodemodeTokenRenewalLoop(
  options: CodemodeTokenRenewalOptions,
): CodemodeTokenRenewalController {
  return startExpiringMaterialRenewalLoop<
    MintedSandboxCodemodeToken,
    "CodemodeTokenRenewalOperationError"
  >({
    initialExpiresAt: options.initialExpiresAt,
    resolve: async () => {
      const minted = await options.mint();
      if (!minted) {
        throw new CodemodeTokenRenewalError("Codemode token mint is no longer available");
      }
      return minted;
    },
    write: options.write,
    expiresAt: (material) => material.expiresAt,
    publicErrorClass: "CodemodeTokenRenewalOperationError",
    policy: {
      defaultRefreshMs: CODEMODE_TOKEN_DEFAULT_REFRESH_MS,
      expiryLeadMs: CODEMODE_TOKEN_EXPIRY_LEAD_MS,
      minRefreshMs: CODEMODE_TOKEN_MIN_REFRESH_MS,
      maxRetryMs: CODEMODE_TOKEN_MAX_RETRY_MS,
    },
    ...(options.now ? { now: options.now } : {}),
    ...(options.schedule ? { schedule: options.schedule } : {}),
    ...(options.clearSchedule ? { clearSchedule: options.clearSchedule } : {}),
    ...(options.onSuccess
      ? { onSuccess: ({ nextDelayMs }) => options.onSuccess?.({ nextDelayMs }) }
      : {}),
    ...(options.onFailure ? { onFailure: options.onFailure } : {}),
  });
}
