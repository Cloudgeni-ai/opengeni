import { Clock3Icon } from "lucide-react";
import type { ModelRecovery } from "@/lib/model-recovery";

/**
 * Status while the worker resumes the accepted turn with its frozen model.
 * Changing the composer draft cannot switch that turn's recovery model.
 */
export function ModelRecoveryNotice({ recovery }: { recovery: ModelRecovery }) {
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
            {throttled ? "This model is being throttled. " : ""}
            Your work is saved. We’ll retry automatically.
          </p>
        </div>
      </div>
    </div>
  );
}
