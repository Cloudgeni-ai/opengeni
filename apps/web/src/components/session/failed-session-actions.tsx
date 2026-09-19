import type { ComposerSendBlocker } from "@/lib/composer-send-blocking";
import { OpenGeniApiError } from "@opengeni/sdk/browser";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";

type RetryBlocker =
  | "draft"
  | "unsent"
  | "delivery"
  | "queued"
  | "loading"
  | "permission"
  | "paused";
const RETRY_REASONS: Record<RetryBlocker, string> = {
  draft: "Send or clear your draft below before trying again.",
  unsent: "Retry or remove the unsent message below before trying again.",
  delivery: "A message is being delivered below. Check its delivery status.",
  queued: "Work is already queued or running. Check the activity controls below.",
  loading: "Wait for the composer to finish loading or sending.",
  permission: "You do not have permission to retry this session.",
  paused: "Resume the paused session before trying again.",
};

/** Retry is an execution control, never a new user message. */
export function FailedSessionActions(props: {
  failureId?: string | null;
  composerBlocker?: ComposerSendBlocker | null;
  repositoryError?: string | null;
  onRetry: () => Promise<boolean>;
  retryBlocker: RetryBlocker | null;
  onChooseModel: () => void;
  modelDisabled: boolean;
}) {
  const [identity, setIdentity] = useState(props.failureId ?? null);
  const [generation, setGeneration] = useState(0);
  if (props.failureId && props.failureId !== identity) {
    setIdentity(props.failureId);
    // Initial history hydration identifies the same failure. A later distinct
    // boundary permits a new retry even if React skipped the running state.
    if (identity) setGeneration(generation + 1);
  }
  return <FailureActionsAttempt key={generation} {...props} />;
}

function FailureActionsAttempt({
  onRetry,
  composerBlocker,
  repositoryError,
  retryBlocker,
  onChooseModel,
  modelDisabled,
}: {
  onRetry: () => Promise<boolean>;
  composerBlocker?: ComposerSendBlocker | null;
  repositoryError?: string | null;
  retryBlocker: RetryBlocker | null;
  onChooseModel: () => void;
  modelDisabled: boolean;
}) {
  const retryBlockedReason = composerBlocker
    ? {
        upload: "Wait for the upload below to finish, or remove it.",
        repository: repositoryError || "Resolve repository access below.",
        policy: "Choose a supported model, reasoning level and speed below.",
        variable_sets: "Review the Variable Sets selection below.",
        personal_decision: "Review the personal resource attachment below.",
        personal_loading: "Wait for personal resource access to finish loading.",
      }[composerBlocker]
    : retryBlocker
      ? RETRY_REASONS[retryBlocker]
      : null;
  const pending = useRef(false);
  const accepted = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit() {
    if (pending.current || accepted.current || retryBlockedReason) return;
    pending.current = true;
    setSubmitting(true);
    setError(null);
    try {
      if (await onRetry()) {
        accepted.current = true;
        setSubmitted(true);
      } else setError("Could not retry this session. Check the controls below and try again.");
    } catch (failure) {
      setError(
        failure instanceof OpenGeniApiError && !failure.outcomeUnknown && failure.status < 500
          ? failure.code === "RETRY_UNSUPPORTED_FAILURE"
            ? "This failure cannot be retried safely. Send a new message below."
            : failure.code === "RETRY_EXECUTION_UNRESOLVED"
              ? "Earlier work is still settling. Wait before trying again."
              : failure.code === "RETRY_PAUSED"
                ? "Resume the paused session before trying again."
                : failure.status === 409
                  ? "The session changed. Check its current status before trying again."
                  : "Could not retry this session. Check your access and selected model, then try again."
          : "Could not confirm the retry. Try again to check the same request.",
      );
    } finally {
      pending.current = false;
      setSubmitting(false);
    }
  }
  return (
    <div className="mt-3">
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={submitting || submitted || Boolean(retryBlockedReason)}
          onClick={() => void submit()}
        >
          {submitting ? "Trying again…" : submitted ? "Retry requested" : "Try again"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={modelDisabled}
          onClick={onChooseModel}
        >
          Choose another model
        </Button>
      </div>
      {submitted ? (
        <p className="mt-2 text-xs text-fg-muted" role="status">
          Retry requested. Your original request and completed work are preserved.
        </p>
      ) : retryBlockedReason ? (
        <p className="mt-2 text-xs text-fg-muted">{retryBlockedReason}</p>
      ) : null}
      {error ? (
        <p className="mt-2 text-xs" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
