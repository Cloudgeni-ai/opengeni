import type { ComposerSendBlocker } from "@/lib/composer-send-blocking";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";

type ContinuationBlocker = "draft" | "unsent" | "delivery" | "queued" | "loading";
const CONTINUATION_REASONS: Record<ContinuationBlocker, string> = {
  draft: "Send your draft below to continue.",
  unsent: "Retry or remove the unsent message below before continuing.",
  delivery: "A message is being delivered below. Check its delivery status.",
  queued: "Work is already queued or running. Check the activity controls below.",
  loading: "Wait for the composer to finish loading or sending.",
};

/** Normal Send owns delivery and retry; this shortcut never replays a tool. */
export function FailedSessionActions(props: {
  failureId?: string | null;
  composerBlocker?: ComposerSendBlocker | null;
  repositoryError?: string | null;
  onContinue: () => Promise<boolean>;
  continuationBlocker: ContinuationBlocker | null;
  onChooseModel: () => void;
  modelDisabled: boolean;
}) {
  const [identity, setIdentity] = useState(props.failureId ?? null);
  const [generation, setGeneration] = useState(0);
  if (props.failureId && props.failureId !== identity) {
    setIdentity(props.failureId);
    // Initial history hydration identifies the same failure. A later distinct
    // boundary permits a new continuation even if React skipped the running state.
    if (identity) setGeneration(generation + 1);
  }
  return <FailureActionsAttempt key={generation} {...props} />;
}

function FailureActionsAttempt({
  onContinue,
  composerBlocker,
  repositoryError,
  continuationBlocker,
  onChooseModel,
  modelDisabled,
}: {
  onContinue: () => Promise<boolean>;
  composerBlocker?: ComposerSendBlocker | null;
  repositoryError?: string | null;
  continuationBlocker: ContinuationBlocker | null;
  onChooseModel: () => void;
  modelDisabled: boolean;
}) {
  const continueBlockedReason = composerBlocker
    ? {
        upload: "Wait for the upload below to finish, or remove it.",
        repository: repositoryError || "Resolve repository access below.",
        policy: "Choose a supported model, reasoning level and speed below.",
        variable_sets: "Review the Variable Sets selection below.",
        personal_decision: "Review the personal resource attachment below.",
        personal_loading: "Wait for personal resource access to finish loading.",
      }[composerBlocker]
    : continuationBlocker
      ? CONTINUATION_REASONS[continuationBlocker]
      : null;
  const pending = useRef(false);
  const accepted = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit() {
    if (pending.current || accepted.current || continueBlockedReason) return;
    pending.current = true;
    setSubmitting(true);
    setError(null);
    try {
      if (await onContinue()) {
        accepted.current = true;
        setSubmitted(true);
      } else setError("The follow-up could not be added. Check the composer below and try again.");
    } catch {
      setError("The follow-up could not be added. Check the composer below and try again.");
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
          disabled={submitting || submitted || Boolean(continueBlockedReason)}
          onClick={() => void submit()}
        >
          {submitting ? "Adding follow-up…" : submitted ? "Continue requested" : "Continue"}
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
          Follow-up added below. Its delivery status and retry controls appear with the message.
        </p>
      ) : continueBlockedReason ? (
        <p className="mt-2 text-xs text-fg-muted">{continueBlockedReason}</p>
      ) : null}
      {error ? (
        <p className="mt-2 text-xs" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
