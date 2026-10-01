import { useId, useState, type ComponentProps, type ReactNode } from "react";
import { Loader2Icon } from "lucide-react";
import { ToggleGroup as ToggleGroupPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";
import { DisabledReasonTooltip, joinIds, useSettingRowField } from "./setting-row";

/**
 * - `filled` (default): a soft surface-2 track; the active option is raised on
 *   the surface with a hairline and a small shadow. For settings and filters
 *   alike.
 * - `outlined`: a bordered button group; the active option takes the brand
 *   tint, like the app-wide selected highlight.
 * - `underline`: text options with a brand underline. Only for view filters.
 */
export type SegmentedControlVariant = "filled" | "outlined" | "underline";

/**
 * `md` is 36px tall (forms, page toolbars); `sm` is 32px (setting rows, list
 * toolbars), the same height as a select in a row.
 */
export type SegmentedControlSize = "md" | "sm";

export interface SegmentedControlOption<Value extends string = string> {
  value: Value;
  /** Short: one or two words. */
  label: ReactNode;
  /** A trailing 11px count, for filters ("Invited 2"). */
  count?: number | string;
  /** Optional 14px leading icon. */
  icon?: ReactNode;
  /** Hides the label visually (icon-only option); it stays the accessible name. */
  iconOnly?: boolean;
  disabled?: boolean;
  /**
   * Why this option can't be picked and who can fix it. With `disabled`, the
   * option stays focusable and shows the reason on hover, focus and tap.
   */
  disabledReason?: ReactNode;
}

export interface SegmentedControlProps<Value extends string = string> extends Omit<
  ComponentProps<"div">,
  "defaultValue" | "onChange" | "dir" | "children"
> {
  /** 2 to 4 options. Use a select for more. */
  options: readonly SegmentedControlOption<Value>[];
  value?: Value;
  defaultValue?: Value;
  onValueChange?: (value: Value) => void;
  variant?: SegmentedControlVariant;
  size?: SegmentedControlSize;
  /** Disables every option. */
  disabled?: boolean;
  /** Saving the new value: a spinner replaces the active option's label, which keeps its width. */
  pending?: boolean;
  /** Stretch the options to fill the width (phones, sheets). */
  fullWidth?: boolean;
}

export function SegmentedControl<Value extends string = string>({
  options,
  value: valueProp,
  defaultValue,
  onValueChange,
  variant = "filled",
  size = "md",
  disabled = false,
  pending = false,
  fullWidth = false,
  className,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledByProp,
  "aria-describedby": ariaDescribedByProp,
  ...props
}: SegmentedControlProps<Value>) {
  const field = useSettingRowField();
  const reasonBaseId = useId();
  const [uncontrolled, setUncontrolled] = useState<Value | undefined>(
    defaultValue ?? options.find((option) => !option.disabled)?.value,
  );
  const value = valueProp ?? uncontrolled;

  const select = (next: string) => {
    // Radix sends "" when the active option is pressed again; one option always stays on.
    if (!next || next === value) return;
    const option = options.find((candidate) => candidate.value === next);
    if (!option || option.disabled) return;
    if (valueProp === undefined) setUncontrolled(option.value);
    onValueChange?.(option.value);
  };

  const reasons = options.flatMap((option, index) =>
    option.disabled && option.disabledReason
      ? [{ id: `${reasonBaseId}-${index}`, index, reason: option.disabledReason }]
      : [],
  );

  return (
    <>
      <ToggleGroupPrimitive.Root
        type="single"
        data-slot="segmented-control"
        data-variant={variant}
        data-size={size}
        value={value ?? ""}
        onValueChange={select}
        disabled={disabled}
        loop
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledByProp ?? (ariaLabel ? undefined : field?.labelId)}
        aria-describedby={joinIds(ariaDescribedByProp, field?.describedBy)}
        aria-busy={pending || undefined}
        className={cn(
          "min-w-0 items-center",
          fullWidth ? "flex w-full" : "inline-flex max-w-full",
          variant === "filled" && "gap-0.5 rounded-[10px] bg-surface-2 p-0.75",
          variant === "outlined" && "isolate",
          variant === "underline" && "gap-4",
          className,
        )}
        {...props}
      >
        {options.map((option, index) => {
          const active = option.value === value;
          const busy = pending && active;
          const reason = reasons.find((entry) => entry.index === index);
          const item = (
            <ToggleGroupPrimitive.Item
              key={option.value}
              value={option.value}
              data-slot="segmented-control-item"
              disabled={option.disabled && !reason}
              aria-disabled={reason ? true : undefined}
              aria-describedby={reason?.id}
              aria-label={
                option.iconOnly && typeof option.label === "string" ? option.label : undefined
              }
              className={cn(
                itemClasses(variant, size),
                option.iconOnly && variant !== "underline" && "px-2",
                fullWidth && "flex-1",
              )}
            >
              {/* While saving, the content fades and a spinner takes its place, so
                  nothing around the control moves. The label stays readable to
                  assistive tech. */}
              <span
                className={cn(
                  "inline-flex min-w-0 items-center gap-1.5 transition-opacity duration-[120ms]",
                  busy && "opacity-0",
                )}
              >
                {option.icon ? (
                  <span aria-hidden="true" className="inline-flex shrink-0 [&_svg]:size-3.5">
                    {option.icon}
                  </span>
                ) : null}
                {option.iconOnly ? (
                  typeof option.label === "string" ? null : (
                    <span className="sr-only">{option.label}</span>
                  )
                ) : (
                  <span className="min-w-0 truncate">{option.label}</span>
                )}
                {option.count !== undefined ? (
                  <span
                    className={cn(
                      "text-2xs font-medium tabular-nums",
                      active
                        ? variant === "outlined"
                          ? "text-brand/80"
                          : "text-fg-muted"
                        : "text-fg-subtle",
                    )}
                  >
                    {option.count}
                  </span>
                ) : null}
              </span>
              {busy ? (
                <Loader2Icon
                  aria-hidden="true"
                  className="absolute inset-0 m-auto size-3.5 animate-spin"
                />
              ) : null}
            </ToggleGroupPrimitive.Item>
          );
          return reason ? (
            <DisabledReasonTooltip key={option.value} reason={option.disabledReason}>
              {item}
            </DisabledReasonTooltip>
          ) : (
            item
          );
        })}
      </ToggleGroupPrimitive.Root>
      {reasons.map((entry) => (
        <span key={entry.id} id={entry.id} hidden>
          {entry.reason}
        </span>
      ))}
    </>
  );
}

// States key on aria-checked, not data-state: a disabled-reason tooltip trigger
// replaces data-state on the items it wraps.
function itemClasses(variant: SegmentedControlVariant, size: SegmentedControlSize): string {
  const base = cn(
    "relative inline-flex min-w-0 shrink-0 items-center justify-center gap-1.5 font-medium whitespace-nowrap transition-colors duration-[120ms] ease-out select-none",
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand/55 focus-visible:z-20",
    "disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50",
    // Touch: 44px tall targets without changing the look.
    "pointer-coarse:after:absolute pointer-coarse:after:inset-x-0 pointer-coarse:after:top-1/2 pointer-coarse:after:h-11 pointer-coarse:after:-translate-y-1/2",
  );
  if (variant === "filled") {
    return cn(
      base,
      "rounded-sm px-3 text-xs text-fg-muted",
      size === "md" ? "h-7.5" : "h-6.5 px-2.5",
      // Hover only brightens the text: a hover fill would outshine the active option in dark.
      "enabled:hover:text-fg aria-disabled:hover:text-fg-muted",
      "aria-checked:bg-surface aria-checked:text-fg aria-checked:shadow-og-sm aria-checked:ring-1 aria-checked:ring-border",
      // In dark, surface sits below surface-2; a faint light layer lifts the active
      // option above the track there, and disappears on white.
      "aria-checked:bg-linear-to-b aria-checked:from-brand-fg/10 aria-checked:to-brand-fg/10",
    );
  }
  if (variant === "outlined") {
    return cn(
      base,
      // `!` keeps the outer corners under the app-wide focus outline radius.
      "-ml-px border border-border bg-surface px-3 text-xs text-fg-muted first:ml-0 first:rounded-l-[10px]! last:rounded-r-[10px]! not-first:not-last:rounded-none!",
      size === "md" ? "h-9" : "h-8 px-2.5",
      "enabled:hover:bg-surface-2 enabled:hover:text-fg aria-disabled:hover:bg-surface aria-disabled:hover:text-fg-muted",
      "aria-checked:z-10 aria-checked:border-brand/45 aria-checked:bg-brand/10 aria-checked:text-brand aria-checked:hover:bg-brand/10 aria-checked:hover:text-brand",
    );
  }
  return cn(
    base,
    // Same 12px type as the other variants; the underline is the only treatment.
    "rounded-sm px-0.5 text-xs text-fg-muted",
    size === "md" ? "h-9" : "h-8",
    "enabled:hover:text-fg aria-disabled:hover:text-fg-muted",
    // The underline sits on the bottom edge, 2px, brand.
    "before:absolute before:inset-x-0 before:bottom-0 before:h-0.5 before:rounded-full before:bg-transparent before:transition-colors before:duration-[120ms]",
    "aria-checked:text-fg aria-checked:before:bg-brand",
  );
}
