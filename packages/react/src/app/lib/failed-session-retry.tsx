import { OpenGeniApiError } from "@opengeni/sdk/browser";
import type { Session } from "@opengeni/sdk";

type RetryPolicy = Pick<Session, "model" | "reasoningEffort" | "latencyMode">;
export type FailedSessionRetryInput = RetryPolicy & {
  clientEventId: string;
  failureEventId: string;
};

/** Keep an ambiguous transport retry bound to the exact original operation. */
export function createFailedSessionRetry(
  submit: (input: FailedSessionRetryInput) => Promise<unknown>,
  onOperationChange?: (input: FailedSessionRetryInput | null) => void,
) {
  let operation: FailedSessionRetryInput | null = null;
  let inFlight: Promise<boolean> | null = null;
  let accepted = false;
  return function retry(failureEventId: string, policy: RetryPolicy): Promise<boolean> {
    if (operation?.failureEventId !== failureEventId) {
      operation = null;
      inFlight = null;
      accepted = false;
    }
    if (accepted) return Promise.resolve(true);
    if (inFlight) return inFlight;
    operation ??= { ...policy, failureEventId, clientEventId: crypto.randomUUID() };
    const input = operation;
    // The UI must describe and lock the same policy while its outcome is
    // unknown, rather than displaying a newer model this request cannot use.
    onOperationChange?.(input);
    const request = (async () => {
      try {
        await submit(input);
        if (operation === input) {
          accepted = true;
          onOperationChange?.(null);
        }
        return true;
      } catch (error) {
        // A definitive rejection permits a corrected model selection. Unknown
        // outcomes must retain the immutable body and idempotency key.
        if (
          operation === input &&
          error instanceof OpenGeniApiError &&
          !error.outcomeUnknown &&
          error.status >= 400 &&
          error.status < 500
        ) {
          operation = null;
          onOperationChange?.(null);
        }
        throw error;
      }
    })();
    inFlight = request;
    void request
      .finally(() => {
        if (inFlight === request) inFlight = null;
      })
      .catch(() => undefined);
    return request;
  };
}
