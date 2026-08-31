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
  if (
    !controller.eligible ||
    (!controller.loading &&
      controller.selected.resourceCount === 0 &&
      !controller.sourceLost &&
      !controller.error &&
      !controller.truncated)
  ) {
    return null;
  }
  const disabled = props.disabled || controller.loading || controller.refreshing;
  const names = [
    ...controller.selected.variableSets.map((resource) => `Variable set: ${resource.name}`),
    ...controller.selected.rigs.map((resource) => `Rig: ${resource.name}`),
    ...controller.selected.connectedMachines.map(
      (resource) => `Connected machine: ${resource.name}`,
    ),
  ];
  return (
    <div
      data-personal-resource-attachment
      className={cn("min-w-0", props.compact ? "mt-2" : "mt-4")}
      aria-busy={controller.loading || controller.refreshing}
    >
      {controller.loading ? (
        <p role="status" className="text-xs text-fg-subtle">
          Loading selected personal resources…
        </p>
      ) : controller.selected.resourceCount > 0 ? (
        <p className="text-xs text-fg-muted">
          {names.join(" · ")}{" "}
          {controller.visibility === "private"
            ? "is available in this private session."
            : "will be used only for messages you send. Other members may see the result, but cannot use your credential."}
        </p>
      ) : null}
      {controller.notice ? (
        <p className="mt-2 text-xs text-fg-muted" role="status" aria-live="polite">
          {controller.notice}
        </p>
      ) : null}
      {controller.error ? (
        <div className="mt-2 flex items-center justify-between gap-3" role="alert">
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
        <p className="mt-2 text-2xs text-fg-subtle" role="status">
          Showing the first 400 personal resources of each supported type.
        </p>
      ) : null}
    </div>
  );
}
