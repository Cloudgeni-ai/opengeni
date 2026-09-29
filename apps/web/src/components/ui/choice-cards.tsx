import { CheckIcon, CircleAlertIcon, LockIcon } from "lucide-react";
import { RadioGroup } from "radix-ui";
import { createContext, useContext, useId, useMemo, type ReactNode } from "react";

import { useField } from "@/components/ui/field";
import { useSectionListFrame } from "@/components/ui/section-variant";
import { cn } from "@/lib/utils";

/* ----------------------------------------------------------------------------
   The selected highlight.

   One highlight for every selected state in the app: choice cards, template
   cards and picker rows. A 1px brand border and a faint brand fill; hover on
   an unselected surface is the same surface-2 fill as a list row.
   -------------------------------------------------------------------------- */

/** Border and fill of a selectable surface that isn't selected. */
export const SELECTABLE_SURFACE_CLASS =
  "border border-border bg-surface transition-colors duration-[120ms] hover:bg-surface-2";

/** The one selected highlight: brand border, brand fill at 5%. */
export const SELECTED_SURFACE_CLASS = "border-brand bg-brand/5 hover:bg-brand/8";

/**
 * Classes for any selectable surface (a card, a template, a picker row), so
 * every selected state in the app looks the same.
 */
export function selectableSurface(selected: boolean, className?: string): string {
  return cn(SELECTABLE_SURFACE_CLASS, selected && SELECTED_SURFACE_CLASS, className);
}

/** The small check badge that marks the selected card, in the top corner. */
export function SelectedCheck({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid size-4 shrink-0 place-items-center rounded-full bg-brand text-surface",
        className,
      )}
    >
      <CheckIcon className="size-3" strokeWidth={3} />
    </span>
  );
}

/* ----------------------------------------------------------------------------
   ChoiceCards
   -------------------------------------------------------------------------- */

/**
 * - `ring` (default): brand border, faint brand fill and a check in the corner.
 * - `radio`: neutral border; only the radio dot shows the selection.
 * - `list`: no cards, just radio, title and description rows.
 */
export type ChoiceCardsVariant = "ring" | "radio" | "list";

interface ChoiceCardsContextValue {
  variant: ChoiceCardsVariant;
  invalid: boolean;
  /** Flat rows split by hairlines: the options sit inside a section card. */
  rows: boolean;
}

const ChoiceCardsContext = createContext<ChoiceCardsContextValue>({
  variant: "ring",
  invalid: false,
  rows: false,
});

export interface ChoiceCardsProps {
  /** The selected option. Use with `onValueChange`, or pass `defaultValue`. */
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  variant?: ChoiceCardsVariant;
  /** The question, shown above the options: "Who can use it?". */
  label?: ReactNode;
  /** One line under the label, when the question needs context. */
  description?: ReactNode;
  /** Accessible name when there is no visible label. */
  "aria-label"?: string;
  /**
   * `stack` (default) puts options under each other, as in dialogs. `grid`
   * puts them two across once the group is at least 560px wide.
   */
  layout?: "stack" | "grid";
  /** What went wrong and what to do: "Choose who can use it." */
  error?: ReactNode;
  disabled?: boolean;
  required?: boolean;
  /** Form field name, for native form submission. */
  name?: string;
  className?: string;
  children: ReactNode;
}

/**
 * 2-3 options whose consequences need a sentence each. Keyboard: Tab into the
 * group, arrow keys move and select, Space selects.
 */
export function ChoiceCards({
  value,
  defaultValue,
  onValueChange,
  variant = "ring",
  label,
  description,
  "aria-label": ariaLabel,
  layout = "stack",
  error,
  disabled,
  required,
  name,
  className,
  children,
}: ChoiceCardsProps) {
  const field = useField();
  const labelId = useId();
  const descriptionId = useId();
  const errorId = useId();
  // Inside a `Field group`, the field's label names the group and its hint or
  // error describes it. The group's own label and error win.
  const invalid = Boolean(error) || Boolean(field?.invalid);
  const groupDisabled = Boolean(disabled || field?.disabled);
  const labelledBy = label ? labelId : ariaLabel ? undefined : field?.labelId;
  const describedBy =
    [description ? descriptionId : null, error ? errorId : null, field?.describedBy]
      .filter(Boolean)
      .join(" ") || undefined;

  // Inside a settings section card nothing may draw its own box: the options
  // become flat radio rows split by the card's hairlines.
  const inCard = useSectionListFrame() === "inside";
  const effectiveVariant: ChoiceCardsVariant = inCard ? "list" : variant;
  const context = useMemo(
    () => ({ variant: effectiveVariant, invalid, rows: inCard }),
    [effectiveVariant, invalid, inCard],
  );

  return (
    <ChoiceCardsContext.Provider value={context}>
      <div data-slot="choice-cards" className={cn("@container min-w-0", className)}>
        {label || description ? (
          <div className={cn("min-w-0", effectiveVariant === "list" ? "mb-0.5" : "mb-2")}>
            {label ? (
              <p id={labelId} className="text-sm font-medium text-fg">
                {label}
              </p>
            ) : null}
            {description ? (
              <p id={descriptionId} className="mt-0.5 text-xs leading-4.5 text-fg-muted">
                {description}
              </p>
            ) : null}
          </div>
        ) : null}
        <RadioGroup.Root
          value={value}
          defaultValue={defaultValue}
          onValueChange={onValueChange}
          disabled={groupDisabled}
          required={required ?? field?.required}
          name={name}
          aria-label={label ? undefined : ariaLabel}
          aria-labelledby={labelledBy}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          data-variant={effectiveVariant}
          data-rows={inCard || undefined}
          className={cn(
            "grid min-w-0",
            inCard
              ? "divide-y divide-border"
              : effectiveVariant === "list"
                ? "-mx-2 gap-0.5"
                : "gap-2",
            layout === "grid" && !inCard && "@min-[560px]:grid-cols-2",
          )}
        >
          {children}
        </RadioGroup.Root>
        {error ? (
          <p
            id={errorId}
            className="mt-2 flex min-w-0 items-start gap-1.5 text-xs leading-4.5 text-danger"
          >
            <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0">{error}</span>
          </p>
        ) : null}
      </div>
    </ChoiceCardsContext.Provider>
  );
}

export interface ChoiceCardProps {
  value: string;
  title: ReactNode;
  /** The consequence of picking it, in one sentence. */
  description?: ReactNode;
  /** A 16px lucide icon. Shown on cards, dropped in the plain list. */
  icon?: ReactNode;
  /** Quiet detail after the title, for example "3 permissions". */
  meta?: ReactNode;
  disabled?: boolean;
  /** Why it can't be picked and who can change that. Shown under the description. */
  disabledReason?: ReactNode;
  className?: string;
}

/** One option inside `ChoiceCards`. The whole card is the radio. */
export function ChoiceCard({
  value,
  title,
  description,
  icon,
  meta,
  disabled,
  disabledReason,
  className,
}: ChoiceCardProps) {
  const { variant, invalid, rows } = useContext(ChoiceCardsContext);
  const titleId = useId();
  const descriptionId = useId();
  const reasonId = useId();
  const showReason = Boolean(disabled && disabledReason);
  const describedBy =
    [description ? descriptionId : null, showReason ? reasonId : null].filter(Boolean).join(" ") ||
    undefined;
  const showIcon = Boolean(icon) && variant !== "list";

  return (
    <RadioGroup.Item
      value={value}
      disabled={disabled}
      aria-labelledby={titleId}
      aria-describedby={describedBy}
      data-slot="choice-card"
      className={cn(
        "group/choice relative flex w-full min-w-0 items-start gap-3 text-left transition-colors duration-[120ms] disabled:cursor-not-allowed",
        rows
          ? // A row of the card, on the card's own 20px text column: no box and
            // no fill of its own; the filled radio marks the choice.
            "py-3"
          : variant === "list"
            ? "rounded-[10px] px-2 py-2.5 hover:bg-surface-2 disabled:hover:bg-transparent"
            : "rounded-[14px] border px-4 py-3",
        variant === "ring" &&
          "border-border bg-surface hover:bg-surface-2 data-[state=checked]:border-brand data-[state=checked]:bg-brand/5 data-[state=checked]:hover:bg-brand/8",
        variant === "radio" && "border-border bg-surface hover:bg-surface-2",
        variant !== "list" && "disabled:bg-surface-2/60 disabled:hover:bg-surface-2/60",
        invalid && variant !== "list" && "data-[state=unchecked]:border-danger/50",
        className,
      )}
    >
      {variant === "list" ? <RadioDot invalid={invalid} /> : null}
      {showIcon ? (
        <span
          aria-hidden="true"
          className={cn(
            "mt-0.5 flex size-4 shrink-0 items-center justify-center text-fg-muted [&_svg]:size-4",
            variant === "ring" && "group-data-[state=checked]/choice:text-brand",
            "group-disabled/choice:text-fg-subtle",
          )}
        >
          {icon}
        </span>
      ) : null}
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <span
            id={titleId}
            className="min-w-0 text-sm font-medium text-fg group-disabled/choice:text-fg-muted"
          >
            {title}
          </span>
          {meta ? <span className="text-2xs font-medium text-fg-subtle">{meta}</span> : null}
        </span>
        {description ? (
          <span
            id={descriptionId}
            className="mt-0.5 block text-xs leading-4.5 text-fg-muted group-disabled/choice:text-fg-subtle"
          >
            {description}
          </span>
        ) : null}
        {showReason ? (
          <span
            id={reasonId}
            className="mt-1.5 flex min-w-0 items-start gap-1.5 text-xs leading-4.5 text-fg-muted"
          >
            <LockIcon className="mt-0.5 size-3.5 shrink-0 text-fg-subtle" aria-hidden="true" />
            <span className="min-w-0">{disabledReason}</span>
          </span>
        ) : null}
      </span>
      {variant === "ring" ? (
        <span aria-hidden="true" className="mt-0.5 flex size-4 shrink-0">
          <RadioGroup.Indicator>
            <SelectedCheck />
          </RadioGroup.Indicator>
        </span>
      ) : null}
      {variant === "radio" ? <RadioDot invalid={invalid} /> : null}
    </RadioGroup.Item>
  );
}

/** The radio circle used by the `radio` and `list` variants. */
function RadioDot({ invalid }: { invalid: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border bg-surface transition-colors duration-[120ms]",
        invalid ? "border-danger/70" : "border-border-strong",
        "group-data-[state=checked]/choice:border-brand group-data-[state=checked]/choice:bg-brand",
        "group-disabled/choice:border-border group-disabled/choice:bg-surface-2",
      )}
    >
      <span className="size-1.5 rounded-full bg-surface opacity-0 transition-opacity duration-[120ms] group-data-[state=checked]/choice:opacity-100" />
    </span>
  );
}

/** Placeholder while the options load, in the same geometry as the cards. */
export function ChoiceCardsSkeleton({
  count = 2,
  variant = "ring",
  label,
  className,
}: {
  count?: number;
  variant?: ChoiceCardsVariant;
  /** Keep the real question visible while the options load. */
  label?: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      data-slot="choice-cards-skeleton"
      className={cn("min-w-0", className)}
    >
      <span className="sr-only">Loading options</span>
      {label ? (
        <p className={cn("text-sm font-medium text-fg", variant === "list" ? "mb-0.5" : "mb-2")}>
          {label}
        </p>
      ) : null}
      <div
        aria-hidden="true"
        className={cn("grid", variant === "list" ? "-mx-2 gap-0.5" : "gap-2")}
      >
        {Array.from({ length: count }, (_, index) => (
          <div
            // oxlint-disable-next-line react/no-array-index-key -- static placeholders
            key={index}
            className={cn(
              "flex items-start gap-3",
              variant === "list"
                ? "px-2 py-2.5"
                : "rounded-[14px] border border-border bg-surface px-4 py-3",
            )}
          >
            {variant === "list" ? (
              <span className="mt-0.5 size-4 shrink-0 animate-pulse rounded-full bg-surface-2 motion-reduce:animate-none" />
            ) : null}
            <span className="flex min-w-0 flex-1 flex-col gap-2 py-1">
              <span className="h-3 w-2/5 animate-pulse rounded-full bg-surface-2 motion-reduce:animate-none" />
              <span className="h-2.5 w-4/5 animate-pulse rounded-full bg-surface-2 motion-reduce:animate-none" />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
