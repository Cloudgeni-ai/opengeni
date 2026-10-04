import { Clock3Icon } from "lucide-react";
import type { ModelRecovery } from "@/lib/model-recovery";

/** Non-actionable status: the worker owns backoff and resuming the saved turn. */
export function ModelRecoveryNotice({ recovery }: { recovery: ModelRecovery }) {
  return (
    <div className="shrink-0 px-4 py-2 sm:px-6" data-model-recovery-notice="">
      <div className="mx-auto flex w-full max-w-3xl items-start gap-2 text-sm text-fg-muted">
        <Clock3Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0" role="status" aria-live="polite">
          <p className="font-medium text-fg">
            {recovery.kind === "rate_limited"
              ? "This model is busy"
              : "The model is temporarily unavailable"}
          </p>
          <p className="mt-0.5 text-xs">Your request is saved. We’ll retry automatically.</p>
        </div>
      </div>
    </div>
  );
}
