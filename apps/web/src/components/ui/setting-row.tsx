import {
  createContext,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useState,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
import { ArrowRightIcon, CircleAlertIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { ReasonTooltip } from "./disabled-reason";

/* ----------------------------------------------------------------------------
   Field wiring. A SettingRow owns the label and description; the one control
   inside it (Switch, SegmentedControl, or anything that calls
   `useSettingRowField`) picks up the ids so it is named and described without
   hand-written aria attributes.

   The label only points at the control (`htmlFor`) when a labelable control
   takes `controlId` through `useSettingRowControl`. Radio groups, buttons
   and menus are named with `aria-labelledby` instead, so the label never
   renames them or points at nothing.
   -------------------------------------------------------------------------- */

export interface SettingRowField {
  /** Id for a labelable control (switch, input, native select). Take it through `useSettingRowControl`. */
  controlId: string;
  /** Id of the visible label, for `aria-labelledby`. */
  labelId: string;
  /** Space-separated ids of the description, hint and error, for `aria-describedby`. */
  describedBy: string | undefined;
  /** True when the row shows an error. */
  invalid: boolean;
  /** Points the label at `controlId`; returns the release. Use `useSettingRowControl` instead. */
  claimLabel: () => () => void;
}

const SettingRowFieldContext = createContext<SettingRowField | null>(null);

/** The label and description ids of the enclosing SettingRow, or null outside one. */
export function useSettingRowField(): SettingRowField | null {
  return useContext(SettingRowFieldContext);
}

/**
 * For a labelable control that renders `id={field.controlId}`: the row's
 * label then points at it, so clicking the label focuses or toggles it.
 * Pass `false` when the control keeps its own id.
 */
export function useSettingRowControl(takesId = true): SettingRowField | null {
  const field = useContext(SettingRowFieldContext);
  const claim = field?.claimLabel;
  useLayoutEffect(() => (takesId && claim ? claim() : undefined), [claim, takesId]);
  return field;
}

/** Joins aria id lists, dropping empty entries. */
export function joinIds(...ids: Array<string | null | undefined | false>): string | undefined {
  const joined = ids.filter(Boolean).join(" ");
  return joined.length > 0 ? joined : undefined;
}

/* ----------------------------------------------------------------------------
   Disabled reasons. The app-wide ReasonTooltip (hover, keyboard focus and
   tap), so every "why is this off" reads the same. The control stays
   focusable (`aria-disabled`) so keyboard and screen reader users can reach
   it and hear why; clicks on it open the reason instead of acting.
   -------------------------------------------------------------------------- */

export function DisabledReasonTooltip({
  reason,
  side = "top",
  children,
}: {
  /** Why the control is unavailable and who can fix it. Renders nothing extra when empty. */
  reason?: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  /** One focusable element. Its clicks are swallowed while the reason shows. */
  children: ReactElement;
}) {
  if (reason === undefined || reason === null || reason === false) return children;
  return (
    <ReasonTooltip reason={reason} side={side}>
      {children}
    </ReasonTooltip>
  );
}

/* ----------------------------------------------------------------------------
   SettingRow
   -------------------------------------------------------------------------- */

/**
 * - `control-right` (default): text left, the control in a fixed right column so
 *   every control on the page lines up. Wide controls drop under the text when
 *   the row is narrower than 640px; switches stay on the right.
 * - `control-left`: list style. Switches sit before the label; wider controls
 *   go under the description.
 * - `stacked`: the control always sits under the text, like a form field.
 */
export type SettingRowVariant = "control-right" | "control-left" | "stacked";

/**
 * - `compact`: a switch or a small button. Never wraps under the text in
 *   `control-right`.
 * - `select`: a 240px column; the control fills it (full width when stacked).
 * - `auto`: the control's own width, for segmented controls. Options stretch
 *   to the full width when stacked.
 *
 * Rows use the 32px control size (`size="sm"` on selects and segmented
 * controls), so every control in a list shares one height.
 */
export type SettingRowControlWidth = "compact" | "select" | "auto";

const SettingRowDepthContext = createContext(0);

/** Control left: a switch-wide leading column (36px, or the control's width), then the text. */
const LEFT_COLUMNS = "grid-cols-[minmax(2.25rem,auto)_minmax(0,1fr)] gap-x-3";

export interface SettingRowProps extends Omit<ComponentProps<"div">, "title" | "children"> {
  /** 14/500, sentence case. Wraps; never truncates. */
  label: ReactNode;
  /** 12/18 muted, one or two sentences. */
  description?: ReactNode;
  /** Exactly one control. */
  control?: ReactNode;
  controlWidth?: SettingRowControlWidth;
  variant?: SettingRowVariant;
  /** A quiet line under the description, usually a `SettingRowLink` that fixes an unavailable state. */
  hint?: ReactNode;
  /** What went wrong and what to do. Linked to the control with `aria-describedby`. */
  error?: ReactNode;
  /** Conditional sub-rows (more SettingRows). Render them only when they apply. */
  children?: ReactNode;
}

export function SettingRow({
  label,
  description,
  control,
  controlWidth = "compact",
  variant = "control-right",
  hint,
  error,
  children,
  className,
  ...props
}: SettingRowProps) {
  const depth = useContext(SettingRowDepthContext);
  const baseId = useId();
  const controlId = `${baseId}-control`;
  const labelId = `${baseId}-label`;
  const descriptionId = `${baseId}-description`;
  const hintId = `${baseId}-hint`;
  const errorId = `${baseId}-error`;
  const hasDescription = description !== undefined && description !== null;
  const hasHint = hint !== undefined && hint !== null && hint !== false;
  const hasError = error !== undefined && error !== null && error !== false;
  // How many controls took `controlId`; the label points at the control only then.
  const [labelTargets, setLabelTargets] = useState(0);
  const claimLabel = useCallback(() => {
    setLabelTargets((count) => count + 1);
    return () => setLabelTargets((count) => count - 1);
  }, []);

  const field = useMemo<SettingRowField>(
    () => ({
      controlId,
      labelId,
      describedBy: joinIds(hasDescription && descriptionId, hasHint && hintId, hasError && errorId),
      invalid: hasError,
      claimLabel,
    }),
    [
      claimLabel,
      controlId,
      descriptionId,
      errorId,
      hasDescription,
      hasError,
      hasHint,
      hintId,
      labelId,
    ],
  );

  const nested = depth > 0;
  const compact = controlWidth === "compact";
  const hasControl = control !== undefined && control !== null && control !== false;
  // Where the control goes for this variant and width.
  const placement: "right" | "left" | "below" | "responsive" = !hasControl
    ? "right"
    : variant === "stacked"
      ? "below"
      : variant === "control-left"
        ? compact
          ? "left"
          : "below"
        : compact
          ? "right"
          : "responsive";
  // Control left keeps one text column: rows without a leading switch leave its
  // column empty, so every label on the list starts at the same edge.
  const gutter = variant === "control-left" && placement !== "left" && !nested;

  // With the control under the text (stacked), the hint and error follow the control.
  const trailingNotes = placement === "below";
  const notes =
    hasHint || hasError ? (
      <div className={cn("flex min-w-0 flex-col gap-1.5", trailingNotes ? "-mt-1.5" : "mt-1.5")}>
        {hasHint ? (
          <div id={hintId} className="text-xs leading-4.5 text-fg-muted">
            {hint}
          </div>
        ) : null}
        {hasError ? (
          <p id={errorId} className="flex items-start gap-1.5 text-xs leading-4.5 text-danger">
            <CircleAlertIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
            <span className="min-w-0">{error}</span>
          </p>
        ) : null}
      </div>
    ) : null;

  const text = (
    <div className="min-w-0">
      <div className="text-sm font-medium text-pretty text-fg">
        <label id={labelId} htmlFor={hasControl && labelTargets > 0 ? controlId : undefined}>
          {label}
        </label>
      </div>
      {hasDescription ? (
        <p id={descriptionId} className="mt-0.5 text-xs leading-4.5 text-pretty text-fg-muted">
          {description}
        </p>
      ) : null}
      {trailingNotes ? null : notes}
    </div>
  );

  const controlSlot = hasControl ? (
    <div
      data-slot="setting-row-control"
      className={cn(
        "flex min-w-0 items-center",
        placement === "right" && "justify-end",
        placement === "left" && "h-5 justify-start",
        // Below 640px, wrapped controls fill the row: selects and segmented options stretch.
        (placement === "below" || placement === "responsive") &&
          controlWidth === "select" &&
          "w-full *:w-full @[640px]/setting-row:w-60",
        placement === "below" &&
          controlWidth === "auto" &&
          "w-full *:w-full [&_[data-slot=segmented-control-item]]:flex-1 @[640px]/setting-row:w-auto @[640px]/setting-row:*:w-auto @[640px]/setting-row:[&_[data-slot=segmented-control-item]]:flex-none",
        placement === "responsive" &&
          controlWidth === "auto" &&
          "w-full *:w-full [&_[data-slot=segmented-control-item]]:flex-1 @[640px]/setting-row:w-auto @[640px]/setting-row:*:w-auto @[640px]/setting-row:justify-end @[640px]/setting-row:[&_[data-slot=segmented-control-item]]:flex-none",
      )}
    >
      {control}
    </div>
  ) : null;

  return (
    <SettingRowFieldContext.Provider value={field}>
      <div
        data-slot="setting-row"
        data-variant={variant}
        data-nested={nested || undefined}
        className={cn("@container/setting-row min-w-0", className)}
        {...props}
      >
        <div
          className={cn(
            "grid min-w-0 gap-x-6 gap-y-3",
            nested ? "min-h-11 py-2" : "min-h-14 py-3",
            gutter
              ? `${LEFT_COLUMNS} content-center *:col-start-2`
              : [
                  placement === "right" && "grid-cols-[minmax(0,1fr)_auto] items-center",
                  placement === "left" && `${LEFT_COLUMNS} items-start`,
                  placement === "below" && "grid-cols-1 content-center",
                ],
            placement === "responsive" &&
              "grid-cols-1 content-center @[640px]/setting-row:grid-cols-[minmax(0,1fr)_auto] @[640px]/setting-row:items-center",
          )}
        >
          {placement === "left" ? (
            <>
              {controlSlot}
              {text}
            </>
          ) : (
            <>
              {text}
              {controlSlot}
              {trailingNotes ? notes : null}
            </>
          )}
        </div>
        {children ? (
          <SettingRowDepthContext.Provider value={depth + 1}>
            <div
              data-slot="setting-row-children"
              className={cn(
                "mb-3 min-w-0",
                variant === "control-left"
                  ? // Line up with the parent's label, past the switch column.
                    "pl-12"
                  : // A 24px indent with a quiet guide line.
                    "ml-[7px] border-l border-border pl-4",
              )}
            >
              {children}
            </div>
          </SettingRowDepthContext.Provider>
        ) : null}
      </div>
    </SettingRowFieldContext.Provider>
  );
}

/** Rows of one section, split by hairlines. No box: sections stay open. */
export function SettingRowGroup({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="setting-row-group"
      className={cn("flex min-w-0 flex-col divide-y divide-border", className)}
      {...props}
    />
  );
}

/**
 * The quiet "fix it" link under a row description: "Connect AI Gateway".
 * Renders an anchor when `href` is set, otherwise a button.
 */
export function SettingRowLink({
  href,
  onClick,
  children,
  className,
}: {
  href?: string;
  onClick?: () => void;
  children: ReactNode;
  className?: string;
}) {
  const classes = cn(
    "relative inline-flex min-h-6 items-center gap-1 rounded-sm text-xs font-medium text-brand underline-offset-2 hover:underline pointer-coarse:after:absolute pointer-coarse:after:inset-x-0 pointer-coarse:after:-inset-y-2.5",
    className,
  );
  const content = (
    <>
      {children}
      <ArrowRightIcon aria-hidden="true" className="size-3.5" />
    </>
  );
  return href ? (
    <a href={href} className={classes}>
      {content}
    </a>
  ) : (
    <button type="button" onClick={onClick} className={classes}>
      {content}
    </button>
  );
}

/** Loading placeholder with the same height and columns as a real row. */
export function SettingRowSkeleton({
  controlWidth = "compact",
  variant = "control-right",
  description = true,
  className,
}: {
  controlWidth?: SettingRowControlWidth;
  variant?: SettingRowVariant;
  description?: boolean;
  className?: string;
}) {
  const pulse = "animate-pulse rounded-full bg-surface-3 motion-reduce:animate-none";
  const controlShape = (
    <div
      className={cn(
        "animate-pulse bg-surface-3 motion-reduce:animate-none",
        controlWidth === "compact" && "h-5 w-9 rounded-full",
        controlWidth === "select" && "h-8 w-full rounded-[10px] @[640px]/setting-row:w-60",
        controlWidth === "auto" && "h-8 w-full rounded-[10px] @[640px]/setting-row:w-48",
      )}
    />
  );
  const leading = variant === "control-left" && controlWidth === "compact";
  const below = variant === "stacked" || (variant === "control-left" && !leading);
  return (
    <div
      aria-hidden="true"
      data-slot="setting-row-skeleton"
      className={cn("@container/setting-row min-w-0", className)}
    >
      <div
        className={cn(
          "grid min-h-14 min-w-0 gap-x-6 gap-y-3 py-3",
          variant === "control-left"
            ? `${LEFT_COLUMNS} ${leading ? "items-start" : "content-center *:col-start-2"}`
            : below
              ? "grid-cols-1 content-center"
              : controlWidth === "compact"
                ? "grid-cols-[minmax(0,1fr)_auto] items-center"
                : "grid-cols-1 content-center @[640px]/setting-row:grid-cols-[minmax(0,1fr)_auto] @[640px]/setting-row:items-center",
        )}
      >
        {leading ? <div className="flex h-5 items-center">{controlShape}</div> : null}
        {/* Same line boxes as the label (20px) and description (18px), so nothing jumps on load. */}
        <div className="min-w-0">
          <div className="flex h-5 items-center">
            <div className={cn("h-3.5 w-36 max-w-full", pulse)} />
          </div>
          {description ? (
            <div className="mt-0.5 flex h-4.5 items-center">
              <div className={cn("h-3 w-72 max-w-full", pulse)} />
            </div>
          ) : null}
        </div>
        {leading ? null : controlShape}
      </div>
    </div>
  );
}
