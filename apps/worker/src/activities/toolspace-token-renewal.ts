import {
  startExpiringMaterialRenewalLoop,
  type ExpiringMaterialRenewalController,
} from "./expiring-material-renewal";
import type { MintedSandboxToolspaceToken } from "./environment";

export const TOOLSPACE_TOKEN_DEFAULT_REFRESH_MS = 30 * 60_000;
export const TOOLSPACE_TOKEN_EXPIRY_LEAD_MS = 5 * 60_000;
export const TOOLSPACE_TOKEN_MIN_REFRESH_MS = 5_000;
export const TOOLSPACE_TOKEN_MAX_RETRY_MS = 5 * 60_000;

export type ToolspaceTokenRenewalController = ExpiringMaterialRenewalController;

export type ToolspaceTokenRenewalOptions = {
  initialExpiresAt: Date;
  mint: () => Promise<MintedSandboxToolspaceToken | undefined>;
  write: (material: MintedSandboxToolspaceToken) => Promise<void>;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  clearSchedule?: (timer: unknown) => void;
  onSuccess?: (result: { nextDelayMs: number }) => void;
  onFailure?: (failure: { retryDelayMs: number; errorClass: string }) => void;
};

class ToolspaceTokenRenewalError extends Error {
  override readonly name = "ToolspaceTokenRenewalError";
}

export function startToolspaceTokenRenewalLoop(
  options: ToolspaceTokenRenewalOptions,
): ToolspaceTokenRenewalController {
  return startExpiringMaterialRenewalLoop<MintedSandboxToolspaceToken>({
    initialExpiresAt: options.initialExpiresAt,
    resolve: async () => {
      const minted = await options.mint();
      if (!minted) {
        throw new ToolspaceTokenRenewalError("Toolspace token mint is no longer available");
      }
      return minted;
    },
    write: options.write,
    expiresAt: (material) => material.expiresAt,
    policy: {
      defaultRefreshMs: TOOLSPACE_TOKEN_DEFAULT_REFRESH_MS,
      expiryLeadMs: TOOLSPACE_TOKEN_EXPIRY_LEAD_MS,
      minRefreshMs: TOOLSPACE_TOKEN_MIN_REFRESH_MS,
      maxRetryMs: TOOLSPACE_TOKEN_MAX_RETRY_MS,
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
