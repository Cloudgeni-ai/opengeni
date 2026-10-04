import { Clock3Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ModelRecovery } from "@/lib/model-recovery";

/**
 * Status while the worker owns backoff and resuming the saved turn. The only
 * action opens the composer's model picker; it never creates another retry.
 */
export function ModelRecoveryNotice({
  recovery,
  onChooseModel,
}: {
  recovery: ModelRecovery;
  /** Opens the composer's model picker; omitted when the model cannot be changed. */
  onChooseModel?: () => void;
}) {
  const throttled = recovery.kind === "rate_limited";
  return (
    <div className="shrink-0 px-4 py-2 sm:px-6" data-model-recovery-notice="">
      <div className="mx-auto flex w-full max-w-3xl items-start gap-2 text-sm text-fg-muted">
        <Clock3Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 flex-1" role="status" aria-live="polite">
          <p className="font-medium text-fg">
            {throttled ? "High demand right now" : "This model is temporarily unavailable"}
          </p>
          <p className="mt-0.5 text-xs">
            {throttled ? "Some models are being throttled. " : ""}
            Your message is saved and will retry automatically, or choose another model.
          </p>
        </div>
        {onChooseModel ? (
          <Button
            type="button"
            size="xs"
            variant="outline"
            className="-mt-0.5 shrink-0"
            onClick={onChooseModel}
          >
            Choose model
          </Button>
        ) : null}
      </div>
    </div>
  );
}
