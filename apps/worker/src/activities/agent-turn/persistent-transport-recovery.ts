import { isModelSocketTransportError } from "@opengeni/network/responses-websocket";
import type { ProviderRecoveryResult } from "./errors";

/** The existing durable step-recovery owner has already checked custody and
 * retry authority. The last existing retry slot is HTTP, rather than granting
 * another recovery after exhaustion. A failed HTTP attempt remains exhausted. */
export function shouldFallbackModelSocket(input: {
  error: unknown;
  recovery: ProviderRecoveryResult;
  httpOnly: boolean;
  nextRecoveryCount: number;
  recoveryLimit: number;
}): boolean {
  return (
    !input.httpOnly &&
    input.recovery.status === "recovering" &&
    input.nextRecoveryCount === input.recoveryLimit &&
    isModelSocketTransportError(input.error)
  );
}
