import type { NormalizedRunCredentialMaterial } from "@opengeni/runtime";
import {
  nextExpiringMaterialRenewalDelay,
  startExpiringMaterialRenewalLoop,
  type ExpiringMaterialRenewalController,
} from "./expiring-material-renewal";

export const RUN_CREDENTIAL_DEFAULT_REFRESH_MS = 30 * 60_000;
export const RUN_CREDENTIAL_EXPIRY_LEAD_MS = 5 * 60_000;
export const RUN_CREDENTIAL_MIN_REFRESH_MS = 5_000;
export const RUN_CREDENTIAL_MAX_RETRY_MS = 5 * 60_000;

export type RunCredentialRenewalController = ExpiringMaterialRenewalController;

type RenewalTimer = unknown;

export type RunCredentialRenewalOptions = {
  initialExpiresAt: Date | null;
  resolve: () => Promise<NormalizedRunCredentialMaterial | null>;
  write: (material: NormalizedRunCredentialMaterial | null) => Promise<void>;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => RenewalTimer;
  clearSchedule?: (timer: RenewalTimer) => void;
  onSuccess?: (result: { nextDelayMs: number; authNeeded: boolean }) => void;
  onFailure?: (failure: { retryDelayMs: number; errorClass: string }) => void;
};

export function nextRunCredentialRenewalDelay(expiresAt: Date | null, nowMs = Date.now()): number {
  return nextExpiringMaterialRenewalDelay(
    expiresAt,
    {
      defaultRefreshMs: RUN_CREDENTIAL_DEFAULT_REFRESH_MS,
      expiryLeadMs: RUN_CREDENTIAL_EXPIRY_LEAD_MS,
      minRefreshMs: RUN_CREDENTIAL_MIN_REFRESH_MS,
      maxRetryMs: RUN_CREDENTIAL_MAX_RETRY_MS,
    },
    nowMs,
  );
}

/** Single-flight renewal; late resolves cannot mutate a stopped attempt. */
export function startRunCredentialRenewalLoop(
  options: RunCredentialRenewalOptions,
): RunCredentialRenewalController {
  return startExpiringMaterialRenewalLoop<NormalizedRunCredentialMaterial | null>({
    initialExpiresAt: options.initialExpiresAt,
    resolve: options.resolve,
    write: options.write,
    expiresAt: (material) => material?.expiresAt ?? null,
    policy: {
      defaultRefreshMs: RUN_CREDENTIAL_DEFAULT_REFRESH_MS,
      expiryLeadMs: RUN_CREDENTIAL_EXPIRY_LEAD_MS,
      minRefreshMs: RUN_CREDENTIAL_MIN_REFRESH_MS,
      maxRetryMs: RUN_CREDENTIAL_MAX_RETRY_MS,
    },
    ...(options.now ? { now: options.now } : {}),
    ...(options.schedule ? { schedule: options.schedule } : {}),
    ...(options.clearSchedule ? { clearSchedule: options.clearSchedule } : {}),
    ...(options.onSuccess
      ? {
          onSuccess: ({ material, nextDelayMs }) =>
            options.onSuccess?.({
              nextDelayMs,
              authNeeded: (material?.authNeeded.length ?? 0) > 0,
            }),
        }
      : {}),
    ...(options.onFailure ? { onFailure: options.onFailure } : {}),
  });
}
