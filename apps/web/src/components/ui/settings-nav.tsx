import { Children, isValidElement, useId, type ComponentProps, type ReactNode } from "react";
import { Slot } from "radix-ui";

import { ReasonTooltip } from "@/components/ui/disabled-reason";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * Navigation items for the main rail and the settings sub-nav.
 *
 * NavItem: 32px, radius 10, 16px icon, 14/500 muted. Active is a surface-2
 * fill, full-strength text and a 2x16px brand bar on the left edge. Every
 * destination appears once, with one name and one icon. Coarse pointers get a
 * 44px target.
 *
 * SettingsNav variants:
 * - `column` (default): a 200px sub-nav inside the content area. The main rail
 *   never swaps; text-only items keep it quieter than the rail beside it.
 * - `rail`: a 240px rail that replaces the main rail (switcher as header).
 */

export type NavItemSize = "default" | "comfortable";

export interface NavItemProps extends Omit<ComponentProps<"a">, "children"> {
  /** Render your router's link as the only child (`<Link to="..." />`). */
  asChild?: boolean;
  children?: ReactNode;
  /** Same name as the page title and the route noun. */
  label: ReactNode;
  /** A 16px lucide icon. One icon per destination. */
  icon?: ReactNode;
  active?: boolean;
  /** Trailing count or text, 11px: "3". */
  badge?: ReactNode;
  /** A purple dot for "needs you" (for example pending reviews). */
  attention?: boolean;
  /** Read after the label when `attention` is set. */
  attentionLabel?: string;
  /** Trailing icon for links that leave this area ("Organization →"). */
  trailingIcon?: ReactNode;
  /** Icon-only, with the label in a tooltip (collapsed rail). */
  collapsed?: boolean;
  /** `default` 32px; `comfortable` 36px (a rail with few items). */
  size?: NavItemSize;
  /**
   * Blocks the destination and explains why in a tooltip. Prefer hiding
   * destinations the viewer can never use.
   */
  disabledReason?: string;
}

const ITEM_BASE =
  "group/nav-item relative flex min-w-0 items-center rounded-[10px] text-sm font-medium text-fg-muted transition-colors duration-[120ms] outline-none select-none hover:bg-surface-2 hover:text-fg data-[active=true]:bg-surface-2 data-[active=true]:text-fg aria-disabled:cursor-not-allowed aria-disabled:text-fg-subtle aria-disabled:hover:bg-transparent aria-disabled:hover:text-fg-subtle";

function textLabel(label: ReactNode): string | undefined {
  return typeof label === "string" ? label : undefined;
}

export function NavItem({
  asChild = false,
  children,
  label,
  icon,
  active = false,
  badge,
  attention = false,
  attentionLabel = "Needs your review",
  trailingIcon,
  collapsed = false,
  size = "default",
  disabledReason,
  className,
  ...props
}: NavItemProps) {
  const disabled = Boolean(disabledReason);
  const reasonId = useId();
  const Comp = disabled ? "span" : asChild ? Slot.Root : "a";

  const item = (
    <Comp
      data-slot="nav-item"
      // A blocked destination is still announced as one: "Insights, link, dimmed".
      role={disabled ? "link" : undefined}
      data-active={active || undefined}
      aria-current={active && !disabled ? "page" : undefined}
      aria-disabled={disabled || undefined}
      aria-describedby={disabled ? reasonId : undefined}
      tabIndex={disabled ? 0 : undefined}
      className={cn(
        ITEM_BASE,
        size === "comfortable" ? "h-9" : "h-8",
        "pointer-coarse:h-11",
        collapsed ? "w-8 justify-center pointer-coarse:w-11" : "gap-2.5 px-2.5",
        className,
      )}
      {...(disabled ? {} : props)}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-0 h-4 w-0.5 -translate-y-1/2 rounded-full bg-brand opacity-0 transition-opacity duration-[120ms] group-data-[active=true]/nav-item:opacity-100"
      />
      {icon ? (
        <span
          aria-hidden="true"
          className="flex size-4 shrink-0 items-center justify-center [&_svg]:size-4 [&_svg]:shrink-0"
        >
          {icon}
        </span>
      ) : null}
      {asChild && !disabled ? <Slot.Slottable>{children}</Slot.Slottable> : null}
      {collapsed ? (
        <span className="sr-only">{label}</span>
      ) : (
        <span className="min-w-0 flex-1 truncate">{label}</span>
      )}
      {attention ? (
        <>
          <span
            aria-hidden="true"
            className={cn(
              "size-1.5 shrink-0 rounded-full bg-status-waiting",
              collapsed && "absolute top-1.5 right-1.5",
            )}
          />
          <span className="sr-only">, {attentionLabel}</span>
        </>
      ) : null}
      {badge !== undefined && badge !== null && !collapsed ? (
        <span className="shrink-0 text-2xs font-medium text-fg-subtle tabular-nums">{badge}</span>
      ) : null}
      {trailingIcon && !collapsed ? (
        <span
          aria-hidden="true"
          className="flex shrink-0 items-center text-fg-subtle transition-colors group-hover/nav-item:text-fg-muted [&_svg]:size-3.5"
        >
          {trailingIcon}
        </span>
      ) : null}
    </Comp>
  );

  if (disabled) {
    // Touch-safe: a tap opens the reason instead of doing nothing.
    // The reason sits outside the item so it describes it without joining its name.
    return (
      <>
        <ReasonTooltip reason={disabledReason} side={collapsed ? "right" : "bottom"}>
          {item}
        </ReasonTooltip>
        <span id={reasonId} hidden>
          {disabledReason}
        </span>
      </>
    );
  }
  if (!collapsed) return item;
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>{item}</TooltipTrigger>
        <TooltipContent side="right" sideOffset={8}>
          {textLabel(label) ?? label}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** A placeholder item while the list of destinations loads. */
export function NavItemSkeleton({
  collapsed = false,
  width = "w-24",
}: {
  collapsed?: boolean;
  /** Tailwind width class for the label bar. */
  width?: string;
}) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "flex h-8 items-center gap-2.5 pointer-coarse:h-11",
        collapsed ? "w-8 justify-center" : "px-2.5",
      )}
    >
      <Skeleton className="size-4 rounded-[4px] bg-surface-3" />
      {collapsed ? null : <Skeleton className={cn("h-3 rounded-full bg-surface-3", width)} />}
    </div>
  );
}

/**
 * A list of NavItems with an optional 12px sentence-case label. Each child is
 * wrapped in a list item.
 */
export function NavGroup({
  label,
  collapsed = false,
  className,
  children,
}: {
  label?: ReactNode;
  /** Hides the label (collapsed rail); a hairline marks the group instead. */
  collapsed?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const labelId = useId();
  const showLabel = Boolean(label) && !collapsed;
  return (
    <div
      role="group"
      aria-labelledby={showLabel ? labelId : undefined}
      aria-label={!showLabel && typeof label === "string" ? label : undefined}
      data-slot="nav-group"
      className={cn("min-w-0", className)}
    >
      {showLabel ? (
        <p id={labelId} className="mb-1 px-2.5 text-xs leading-4.5 font-medium text-fg-subtle">
          {label}
        </p>
      ) : null}
      {label && collapsed ? (
        <div aria-hidden="true" className="mx-auto mb-1.5 h-px w-4 bg-border" />
      ) : null}
      <ul className={cn("grid gap-0.5", collapsed && "justify-center")}>
        {Children.map(children, (child) =>
          isValidElement(child) ? <li className="min-w-0">{child}</li> : child,
        )}
      </ul>
    </div>
  );
}

export type SettingsNavVariant = "column" | "rail";

export interface SettingsNavProps extends ComponentProps<"nav"> {
  variant?: SettingsNavVariant;
  /** Top slot: the workspace switcher (rail) or a small title (column). */
  header?: ReactNode;
  /** Bottom slot: the link to organization settings. */
  footer?: ReactNode;
}

/** The settings sub-nav. Label it: `aria-label="Workspace settings"`. */
export function SettingsNav({
  variant = "column",
  header,
  footer,
  className,
  children,
  ...props
}: SettingsNavProps) {
  const rail = variant === "rail";
  return (
    <nav
      data-slot="settings-nav"
      data-variant={variant}
      className={cn(
        "flex min-h-0 min-w-0 flex-col",
        rail ? "w-60 shrink-0 border-r border-border bg-bg px-3 py-3" : "w-[200px] shrink-0",
        className,
      )}
      {...props}
    >
      {header ? <div className={cn("min-w-0", rail ? "mb-4" : "mb-3")}>{header}</div> : null}
      <div className={cn("flex min-w-0 flex-1 flex-col", rail ? "gap-5" : "gap-4")}>{children}</div>
      {footer ? <div className="mt-4 min-w-0 border-t border-border pt-3">{footer}</div> : null}
    </nav>
  );
}
