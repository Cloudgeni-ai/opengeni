import {
  useId,
  useRef,
  useState,
  type ComponentProps,
  type MouseEvent,
  type ReactNode,
} from "react";
import { Loader2Icon } from "lucide-react";
import { Switch as SwitchPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";
import { DisabledReasonTooltip, joinIds, useSettingRowControl } from "./setting-row";

/**
 * - `brand` (default): the primary fill and edge when on, with a primary-ink
 *   thumb; a solid switch-track when off, so the off state is visible in both
 *   themes.
 * - `neutral`: foreground track when on. Quieter, for dense admin pages.
 */
export type SwitchVariant = "brand" | "neutral";

/** `md` is 36x20 for settings and sheets; `sm` is 28x16 for menus. Both have a 44px hit area. */
export type SwitchSize = "md" | "sm";

export interface SwitchProps extends Omit<
  ComponentProps<typeof SwitchPrimitive.Root>,
  "asChild" | "children"
> {
  variant?: SwitchVariant;
  size?: SwitchSize;
  /**
   * Saving. Shows a spinner in the thumb and ignores clicks, but stays
   * focusable so keyboard focus isn't lost. Pass the new value as `checked`.
   */
  pending?: boolean;
  /**
   * Why the switch is disabled and who can fix it. Only used with `disabled`:
   * the switch stays focusable (`aria-disabled`) and shows the reason in a
   * tooltip on hover, focus and tap.
   */
  disabledReason?: ReactNode;
  /** Adds a small On or Off label before the switch, for dense rows. */
  showStateText?: boolean;
  /** Overrides the On and Off words. */
  stateLabels?: { on: ReactNode; off: ReactNode };
}

const DEFAULT_STATE_LABELS = { on: "On", off: "Off" };

export function Switch({
  variant = "brand",
  size = "md",
  pending = false,
  disabled = false,
  disabledReason,
  showStateText = false,
  stateLabels = DEFAULT_STATE_LABELS,
  checked: checkedProp,
  defaultChecked,
  onCheckedChange,
  onClick,
  className,
  id: idProp,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledByProp,
  "aria-describedby": ariaDescribedByProp,
  ...props
}: SwitchProps) {
  // Takes the row's control id unless given its own, so clicking the row label toggles it.
  const field = useSettingRowControl(idProp === undefined);
  const reasonId = useId();
  const rootRef = useRef<HTMLButtonElement>(null);
  const [uncontrolled, setUncontrolled] = useState(defaultChecked ?? false);
  const checked = checkedProp ?? uncontrolled;
  const hasReason = disabled && disabledReason !== undefined && disabledReason !== null;
  // A reason keeps the switch focusable; without one it is natively disabled.
  const blocked = hasReason || pending;

  const handleCheckedChange = (next: boolean) => {
    if (blocked) return;
    if (checkedProp === undefined) setUncontrolled(next);
    onCheckedChange?.(next);
  };
  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    onClick?.(event);
    if (pending) event.preventDefault();
  };

  const root = (
    <SwitchPrimitive.Root
      ref={rootRef}
      data-slot="switch"
      data-variant={variant}
      data-size={size}
      id={idProp ?? field?.controlId}
      checked={checked}
      onCheckedChange={handleCheckedChange}
      onClick={handleClick}
      disabled={disabled && !hasReason}
      aria-disabled={hasReason || undefined}
      aria-busy={pending || undefined}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledByProp ?? (ariaLabel ? undefined : field?.labelId)}
      aria-describedby={joinIds(ariaDescribedByProp, field?.describedBy, hasReason && reasonId)}
      className={cn(
        // `rounded-full!` keeps the pill shape under the app-wide focus outline.
        "group/switch relative inline-flex shrink-0 cursor-pointer items-center rounded-full! border p-px transition-colors duration-[120ms] ease-out",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand/55",
        // Touch: an invisible 44px hit area without changing layout.
        "pointer-coarse:after:absolute pointer-coarse:after:top-1/2 pointer-coarse:after:left-1/2 pointer-coarse:after:size-11 pointer-coarse:after:-translate-x-1/2 pointer-coarse:after:-translate-y-1/2",
        size === "md" ? "h-5 w-9" : "h-4 w-7",
        "border-transparent bg-switch-track",
        // Keyed on aria-checked: a disabled-reason tooltip trigger replaces data-state.
        variant === "brand"
          ? "aria-checked:border-primary-border aria-checked:bg-primary"
          : "aria-checked:bg-fg",
        "disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50",
        pending && "cursor-progress",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none grid place-items-center rounded-full shadow-og-sm transition-transform duration-[120ms] ease-out motion-reduce:transition-none",
          size === "md"
            ? "size-4 data-[state=checked]:translate-x-4"
            : "size-3 data-[state=checked]:translate-x-3",
          // The off thumb is the switch-thumb token; on, the brand thumb takes the
          // primary ink and the neutral thumb the surface colour, so both read in
          // light and dark.
          variant === "brand"
            ? "bg-switch-thumb data-[state=checked]:bg-primary-foreground"
            : "bg-switch-thumb data-[state=checked]:bg-surface",
        )}
      >
        {pending ? (
          <Loader2Icon
            aria-hidden="true"
            className={cn(
              "animate-spin",
              size === "md" ? "size-3" : "size-2.5",
              variant === "brand" ? "text-primary-border" : "text-fg-muted",
            )}
          />
        ) : null}
      </SwitchPrimitive.Thumb>
    </SwitchPrimitive.Root>
  );

  const control = hasReason ? (
    <DisabledReasonTooltip reason={disabledReason}>{root}</DisabledReasonTooltip>
  ) : (
    root
  );

  return (
    <>
      {showStateText ? (
        <span data-slot="switch-with-state" className="inline-flex shrink-0 items-center gap-2">
          <span
            aria-hidden="true"
            onClick={() => rootRef.current?.click()}
            className={cn(
              "grid cursor-pointer text-right text-xs font-medium select-none",
              disabled ? "cursor-not-allowed" : pending && "cursor-progress",
              disabled && "opacity-50",
            )}
          >
            {/* Both words share one cell so the width never jumps. */}
            <span className={cn("col-start-1 row-start-1 text-fg", !checked && "invisible")}>
              {stateLabels.on}
            </span>
            <span className={cn("col-start-1 row-start-1 text-fg-subtle", checked && "invisible")}>
              {stateLabels.off}
            </span>
          </span>
          {control}
        </span>
      ) : (
        control
      )}
      {hasReason ? (
        <span id={reasonId} hidden>
          {disabledReason}
        </span>
      ) : null}
    </>
  );
}
