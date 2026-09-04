import { RefreshCwIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { PersonalResourceAttachmentController } from "@/lib/use-personal-resource-attachment";

export function PersonalResourceAttachmentControl(props: {
  controller: PersonalResourceAttachmentController;
  disabled?: boolean;
  compact?: boolean;
}) {
  const { controller } = props;
  // Healthy selections are already described inside their pickers. Keep the
  // composer-top surface for transient or actionable status only.
  const hasVisibleStatus =
    controller.loading ||
    controller.notice !== null ||
    controller.error !== null ||
    controller.truncated;
  if (!controller.eligible || !hasVisibleStatus) {
    return null;
  }
  const disabled = props.disabled || controller.loading || controller.refreshing;
  return (
    <div
      data-personal-resource-attachment
      className={cn("min-w-0 space-y-2", props.compact ? "mt-2" : "mt-4")}
      aria-busy={controller.loading || controller.refreshing}
    >
      {controller.loading ? (
        <p role="status" className="text-xs text-fg-subtle">
          Loading selected personal resources…
        </p>
      ) : null}
      {controller.notice ? (
        <p className="text-xs text-fg-muted" role="status" aria-live="polite">
          {controller.notice}
        </p>
      ) : null}
      {controller.error ? (
        <div className="flex items-center justify-between gap-3" role="alert">
          <span className="text-xs text-danger">
            The selected personal resource is unavailable. Retry, or open Variable Sets to replace
            or remove it.
          </span>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={disabled}
            onClick={() => void controller.refresh()}
          >
            <RefreshCwIcon className="size-3.5" aria-hidden />
            Retry
          </Button>
        </div>
      ) : null}
      {controller.truncated ? (
        <p className="text-2xs text-fg-subtle" role="status">
          Showing the first 400 personal resources of each supported type.
        </p>
      ) : null}
    </div>
  );
}
