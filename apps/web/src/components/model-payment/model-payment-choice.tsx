import { BillingClassMark, type PickerBillingClass } from "@opengeni/react";
import { ChevronRightIcon, LockIcon } from "lucide-react";
import type { ReactNode } from "react";

import { analyticsAction, type AnalyticsAction } from "@/lib/analytics-actions";
import type { ModelPaymentOption, ModelPaymentOptionId } from "@/lib/model-payment";
import { cn } from "@/lib/utils";

export const PAYMENT_MARKS: Record<ModelPaymentOptionId, PickerBillingClass> = {
  credits: "opengeni_credits",
  codex: "codex_subscription",
  supergrok: "supergrok_subscription",
  gateway: "byok",
  openrouter: "external",
};

/** The option's mark at tile size, the same everywhere the choice appears. */
export function ModelPaymentMark({
  id,
  size = "md",
}: {
  id: ModelPaymentOptionId;
  size?: "sm" | "md";
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid shrink-0 place-items-center rounded-[10px] bg-surface-2 text-fg",
        size === "md" ? "size-8" : "size-6",
      )}
    >
      <BillingClassMark billingClass={PAYMENT_MARKS[id]} aria-label="" className="size-4 text-fg" />
    </span>
  );
}

export type ModelPaymentRowAction =
  | { kind: "link"; render: (row: ReactNode, className: string) => ReactNode }
  | {
      kind: "button";
      onClick: () => void;
      expanded?: boolean;
      /** Accessible name when the row text isn't enough: "Connect SuperGrok". */
      label?: string;
      disabled?: boolean;
      analytics?: AnalyticsAction;
    }
  | { kind: "none" };

/**
 * "How do you want to pay for models?": one row per way to pay, in the order
 * and words `modelPaymentOptions` gives. Each place says what a row does
 * (`actionFor`); a row the person can't use shows why instead of a chevron.
 * Rows are flat: in a card they split by hairlines, in a menu they don't.
 */
export function ModelPaymentChoice({
  options,
  actionFor,
  renderBelow,
  density = "comfortable",
  className,
}: {
  options: readonly ModelPaymentOption[];
  actionFor: (option: ModelPaymentOption) => ModelPaymentRowAction;
  /** Inline content under a row (an API key form, a device code). */
  renderBelow?: (option: ModelPaymentOption) => ReactNode;
  density?: "comfortable" | "compact";
  className?: string;
}) {
  const compact = density === "compact";
  return (
    <ul
      className={cn("m-0 min-w-0 list-none p-0", !compact && "divide-y divide-border", className)}
      data-model-payment-choice=""
    >
      {options.map((option) => {
        const usable = option.state === "available";
        const action = usable ? actionFor(option) : ({ kind: "none" } as const);
        const content = (
          <>
            <ModelPaymentMark id={option.id} size={compact ? "sm" : "md"} />
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                <span className={cn("text-sm font-medium", usable ? "text-fg" : "text-fg-muted")}>
                  {option.title}
                </span>
                {option.meta ? (
                  <span className="text-2xs font-medium text-fg-subtle">{option.meta}</span>
                ) : null}
              </span>
              <span
                className={cn(
                  "mt-0.5 flex min-w-0 items-start gap-1.5 text-xs leading-4.5 text-fg-muted",
                  compact && "line-clamp-2",
                )}
              >
                {usable ? null : (
                  <LockIcon aria-hidden="true" className="mt-0.5 size-3 shrink-0 text-fg-subtle" />
                )}
                <span className="min-w-0">{usable ? option.description : option.reason}</span>
              </span>
            </span>
            {action.kind === "none" ? null : (
              <ChevronRightIcon
                aria-hidden="true"
                className={cn(
                  "size-4 shrink-0 text-fg-subtle transition-transform duration-[120ms]",
                  action.kind === "button" && action.expanded && "rotate-90",
                )}
              />
            )}
          </>
        );
        const rowClass = cn(
          "flex w-full min-w-0 items-center gap-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
          compact
            ? "rounded-[10px] px-2 py-2"
            : "-mx-2 w-[calc(100%+1rem)] rounded-[10px] px-2 py-3",
          action.kind !== "none" && "transition-colors duration-[120ms] hover:bg-hover",
        );
        return (
          <li key={option.id} data-payment-option={option.id} data-state={option.state}>
            {action.kind === "link" ? (
              action.render(content, rowClass)
            ) : action.kind === "button" ? (
              <button
                type="button"
                className={cn(rowClass, "disabled:cursor-not-allowed disabled:opacity-60")}
                aria-expanded={action.expanded}
                aria-label={action.label}
                disabled={action.disabled}
                onClick={action.onClick}
                {...analyticsAction(action.analytics)}
              >
                {content}
              </button>
            ) : (
              <div className={rowClass}>{content}</div>
            )}
            {renderBelow ? renderBelow(option) : null}
          </li>
        );
      })}
    </ul>
  );
}
