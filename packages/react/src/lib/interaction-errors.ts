import { OpenGeniApiError } from "@opengeni/sdk";
import { interactionControlFailureFromError } from "@opengeni/sdk/interaction";

/** Media can remain live when the independent control service is unavailable.
 * A target refusal or an uncertain mutation does not establish a service outage. */
export function isInteractionControlUnavailable(
  error: unknown,
  request: "control" | "observation" = "control",
): error is OpenGeniApiError {
  if (!(error instanceof OpenGeniApiError)) return false;
  const failure = interactionControlFailureFromError(error);
  if (failure) return failure.code === "agent_offline" || failure.code === "draining";
  return (
    request === "control" && !error.outcomeUnknown && (error.status >= 500 || error.status === 0)
  );
}

export function isNonRetryableInteractionError(error: unknown): error is OpenGeniApiError {
  return error instanceof OpenGeniApiError && error.retryable === false;
}

export function isSourcePlacementChangedError(
  error: unknown,
  resource: "browser_session" | "computer_session",
): error is OpenGeniApiError {
  return (
    isNonRetryableInteractionError(error) &&
    error.status === 409 &&
    error.details?.interactionResource === resource &&
    error.details?.interactionFailureCode === "source_placement_changed" &&
    error.details?.interactionLifecycle === "lost"
  );
}
