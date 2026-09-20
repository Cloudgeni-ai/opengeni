import type { ComposerSendBlocker } from "@/lib/composer-send-blocking";
import type { FailedSessionRetryInput } from "@/lib/failed-session-retry";
import { OpenGeniApiError } from "@opengeni/sdk/browser";
import { useRef, useState } from "react";
import { RotateCcwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

type RetryBlocker =
  | "draft"
  | "unsent"
  | "delivery"
  | "queued"
  | "loading"
  | "permission"
  | "paused";

/** Retry is an execution control, never a new user message. */
export function FailedSessionActions(props: {
  failureId?: string | null;
  composerBlocker?: ComposerSendBlocker | null;
  onRetry: () => Promise<boolean>;
  retryBlocker: RetryBlocker | null;
  retryInput?: FailedSessionRetryInput | null;
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
  retryBlocker,
  retryInput,
}: {
  onRetry: () => Promise<boolean>;
  composerBlocker?: ComposerSendBlocker | null;
  retryBlocker: RetryBlocker | null;
  retryInput?: FailedSessionRetryInput | null;
}) {
  const retryBlockedReason = composerBlocker || retryBlocker;
  const pending = useRef(false);
  const accepted = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejected, setRejected] = useState(false);
  async function submit() {
    if (pending.current || accepted.current || retryBlockedReason || rejected) return;
    pending.current = true;
    setSubmitting(true);
    setError(null);
    try {
      if (await onRetry()) {
        accepted.current = true;
        setSubmitted(true);
      } else setError("Could not retry this session.");
    } catch (failure) {
      if (
        failure instanceof OpenGeniApiError &&
        !failure.outcomeUnknown &&
        ["RETRY_UNSUPPORTED_FAILURE", "RETRY_PAUSED", "RETRY_EXECUTION_UNRESOLVED"].includes(
          failure.code ?? "",
        )
      ) {
        setRejected(true);
      }
      setError(
        failure instanceof OpenGeniApiError && !failure.outcomeUnknown && failure.status < 500
          ? failure.code === "RETRY_UNSUPPORTED_FAILURE"
            ? "This failure cannot be retried safely."
            : failure.code === "RETRY_EXECUTION_UNRESOLVED"
              ? "Earlier work is still settling."
              : failure.code === "RETRY_PAUSED"
                ? "This session is paused."
                : failure.status === 409
                  ? "The session changed."
                  : "Could not retry this session. Check your access and model."
          : "Retry not confirmed.",
      );
    } finally {
      pending.current = false;
      setSubmitting(false);
    }
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {!retryBlockedReason && !rejected && !submitted ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={submitting}
          onClick={() => void submit()}
        >
          <RotateCcwIcon aria-hidden="true" className="size-3.5" />
          {submitting ? "Retrying…" : retryInput ? "Check retry" : "Retry"}
        </Button>
      ) : null}
      {submitted ? <span role="status">Retry requested.</span> : null}
      {error ? (
        <span className="text-xs" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}
