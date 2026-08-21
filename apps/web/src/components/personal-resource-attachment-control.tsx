import { AlertTriangleIcon, KeyRoundIcon, RefreshCwIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { PersonalResourceAttachmentController } from "@/lib/use-personal-resource-attachment";

const MODE_OPTIONS = [
  {
    value: "once" as const,
    label: "This message",
    description: "Use them only for the work submitted now.",
  },
  {
    value: "session" as const,
    label: "This session",
    description: "Keep session-scoped authority available for later work.",
  },
  {
    value: "always" as const,
    label: "Remember here",
    description: "Make it available for future work you start in this workspace.",
  },
];

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
  const names = [
    ...controller.selected.variableSets.map((resource) => `Variable set: ${resource.name}`),
    ...controller.selected.rigs.map((resource) => `Rig: ${resource.name}`),
  ];
  return (
    <fieldset
      data-personal-resource-attachment
      className={cn(
        "min-w-0 rounded-lg border border-border bg-surface/50 p-3",
        props.compact ? "mt-2" : "mt-4",
      )}
      disabled={props.disabled || controller.loading || controller.refreshing}
    >
      <legend className="px-1 text-xs font-semibold text-fg">
        <span className="inline-flex items-center gap-1.5">
          <KeyRoundIcon className="size-3.5 text-fg-subtle" aria-hidden />
          Your resource access
        </span>
      </legend>
      {controller.loading ? (
        <p role="status" className="text-xs text-fg-subtle">
          Loading your personal resources…
        </p>
      ) : controller.selected.resourceCount > 0 ? (
        <>
          <p className="text-xs text-fg-muted">
            {names.join(" · ")} {controller.selected.resourceCount === 1 ? "belongs" : "belong"} to
            you. Choose how long OpenGeni may use{" "}
            {controller.selected.resourceCount === 1 ? "it" : "them"}.
          </p>
          <div className="mt-3 grid gap-2 sm:grid-cols-3" role="radiogroup">
            {MODE_OPTIONS.map((option) => (
              <label
                key={option.value}
                className={cn(
                  "flex cursor-pointer gap-2 rounded-md border p-2.5 text-left",
                  "focus-within:ring-2 focus-within:ring-brand focus-within:ring-offset-2",
                  controller.mode === option.value
                    ? "border-brand/60 bg-brand/[0.08]"
                    : "border-border bg-surface hover:bg-surface-2/60",
                )}
              >
                <input
                  type="radio"
                  name="personal-resource-attachment-mode"
                  value={option.value}
                  checked={controller.mode === option.value}
                  onChange={() => controller.setMode(option.value)}
                  className="mt-0.5 size-4 accent-brand"
                />
                <span className="min-w-0">
                  <span className="block text-xs font-medium text-fg">{option.label}</span>
                  <span className="mt-0.5 block text-2xs leading-4 text-fg-subtle">
                    {option.description}
                  </span>
                </span>
              </label>
            ))}
          </div>
          {controller.visibility === "workspace" && controller.mode ? (
            <label className="mt-3 flex cursor-pointer items-start gap-2 rounded-md border border-warning/30 bg-warning/5 p-2.5 text-xs text-fg-muted">
              <input
                type="checkbox"
                checked={controller.acknowledged}
                onChange={(event) => controller.setAcknowledged(event.target.checked)}
                className="mt-0.5 size-4 shrink-0 accent-brand"
              />
              <span>
                <span className="mb-1 flex items-center gap-1 font-medium text-fg">
                  <AlertTriangleIcon className="size-3.5 text-warning" aria-hidden />
                  Confirm shared-session use
                </span>
                {controller.warning}
              </span>
            </label>
          ) : null}
        </>
      ) : null}
      {controller.notice ? (
        <p className="mt-2 text-xs text-fg-muted" role="status" aria-live="polite">
          {controller.notice}
        </p>
      ) : null}
      {controller.error ? (
        <div className="mt-2 flex items-center justify-between gap-3" role="alert">
          <span className="text-xs text-danger">
            We couldn’t check access to the selected Variable Set or Rig. Try again, or choose a
            different resource.
          </span>
          <Button
            type="button"
            size="sm"
            variant="secondary"
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
    </fieldset>
  );
}
