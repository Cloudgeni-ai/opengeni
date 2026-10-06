import type { SandboxV2ActiveCredentials, SandboxV2CredentialLifecycleOwner } from "@opengeni/core";
import { startExpiringMaterialRenewalLoop } from "./activities/expiring-material-renewal";
import {
  RUN_CREDENTIAL_DEFAULT_REFRESH_MS,
  RUN_CREDENTIAL_EXPIRY_LEAD_MS,
  RUN_CREDENTIAL_MIN_REFRESH_MS,
  RUN_CREDENTIAL_MAX_RETRY_MS,
  type RunCredentialRenewalController,
} from "./activities/run-credential-renewal";

function expiresAt(value: SandboxV2ActiveCredentials): Date | null {
  if (value.resolution.status !== "ok") return null;
  const expiries = [
    ...(value.resolution.expiresAt ? [Date.parse(value.resolution.expiresAt)] : []),
    ...(value.resolution.mcp ?? []).flatMap((entry) =>
      entry.expiresAt ? [Date.parse(entry.expiresAt)] : [],
    ),
  ];
  if (expiries.some((expiry) => !Number.isFinite(expiry)))
    throw Error("Run credential expiry is unavailable");
  return expiries.length ? new Date(Math.min(...expiries)) : null;
}

/** Reuse ordinary refresh/expiry/backoff policy, with durable renewal identity.
 * The resolve phase snapshots only a nonsecret predecessor. ALL broker/native
 * work belongs to write, so stop drains a started renewal before settlement.
 * Failure preserves the original expected predecessor and pending ticket; a
 * retry cannot reserve another generation or reinterpret an unknown writer. */
export function startSandboxV2CredentialRenewalLoop(options: {
  owner: Pick<SandboxV2CredentialLifecycleOwner, "renew">;
  initial: SandboxV2ActiveCredentials;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  clearSchedule?: (timer: unknown) => void;
  onSuccess?: (result: { nextDelayMs: number; authNeeded: boolean }) => void;
  onFailure?: (failure: {
    retryDelayMs: number;
    errorClass: "RunCredentialRenewalOperationError";
  }) => void;
}): RunCredentialRenewalController {
  const { owner, onSuccess, onFailure } = options;
  let expectedGenerationId = options.initial.ticket.definition.generationId;
  type Renewal = { expectedGenerationId: string; expiresAt: Date | null; authNeeded: boolean };
  return startExpiringMaterialRenewalLoop<Renewal, "RunCredentialRenewalOperationError">({
    initialExpiresAt: expiresAt(options.initial),
    resolve: async () => ({ expectedGenerationId, expiresAt: null, authNeeded: false }),
    write: async (renewal) => {
      const activated = await owner.renew(renewal.expectedGenerationId);
      // Update only after the lifecycle owner returned its activated generation.
      // The loop retains no environment values, files or MCP header material.
      const expiry = expiresAt(activated);
      renewal.expiresAt = expiry;
      renewal.authNeeded =
        activated.resolution.status === "auth_needed" ||
        (activated.resolution.status === "ok" &&
          (activated.resolution.authNeeded?.length ?? 0) > 0);
      expectedGenerationId = activated.ticket.definition.generationId;
    },
    expiresAt: (renewal) => renewal.expiresAt,
    publicErrorClass: "RunCredentialRenewalOperationError",
    policy: {
      defaultRefreshMs: RUN_CREDENTIAL_DEFAULT_REFRESH_MS,
      expiryLeadMs: RUN_CREDENTIAL_EXPIRY_LEAD_MS,
      minRefreshMs: RUN_CREDENTIAL_MIN_REFRESH_MS,
      maxRetryMs: RUN_CREDENTIAL_MAX_RETRY_MS,
    },
    ...(options.now ? { now: options.now } : {}),
    ...(options.schedule ? { schedule: options.schedule } : {}),
    ...(options.clearSchedule ? { clearSchedule: options.clearSchedule } : {}),
    ...(onSuccess
      ? {
          onSuccess: ({ material, nextDelayMs }) =>
            onSuccess({ nextDelayMs, authNeeded: material.authNeeded }),
        }
      : {}),
    ...(onFailure ? { onFailure } : {}),
  });
}
