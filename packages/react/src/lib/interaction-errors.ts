import { OpenGeniApiError } from "@opengeni/sdk";

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
