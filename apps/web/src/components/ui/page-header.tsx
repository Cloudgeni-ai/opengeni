import { createContext, useContext, useMemo, type ComponentProps, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * One header for every page: title, one-line description, primary action and
 * optional tabs. Title 20/28 semibold, description 14/20 muted, actions pinned
 * right with `shrink-0` (they never push past the column), and a hairline 16px
 * below. A `tabs` slot replaces the hairline with the tab row's own rule.
 *
 * Variants:
 * - `default`: 20px title, optional 16px brand icon (Capabilities style).
 * - `large`: 24px title and never an icon (the older settings style).
 *
 * Whether the icon shows is also a page-level choice: settings shells can wrap
 * their pages in `<PageHeaderStyleProvider icon="hide">` so sub-pages drop the
 * icon while main-rail pages keep it, without touching each call site.
 *
 * The layout responds to its own width (container query), so it stacks the
 * actions under the title in a phone, a sheet or a narrow preview alike.
 */

export type PageHeaderVariant = "default" | "large";
export type PageHeaderIconMode = "show" | "hide";

interface PageHeaderStyle {
  variant?: PageHeaderVariant;
  icon?: PageHeaderIconMode;
}

const PageHeaderStyleContext = createContext<PageHeaderStyle>({});

/** Sets the header style for every PageHeader below it (props still win). */
export function PageHeaderStyleProvider({
  variant,
  icon,
  children,
}: PageHeaderStyle & { children: ReactNode }) {
  const parent = useContext(PageHeaderStyleContext);
  const value = useMemo(
    () => ({ variant: variant ?? parent.variant, icon: icon ?? parent.icon }),
    [icon, parent.icon, parent.variant, variant],
  );
  return (
    <PageHeaderStyleContext.Provider value={value}>{children}</PageHeaderStyleContext.Provider>
  );
}

/** The header style in effect here, after providers and defaults. */
export function usePageHeaderStyle(): Required<PageHeaderStyle> {
  const style = useContext(PageHeaderStyleContext);
  const variant = style.variant ?? "default";
  return { variant, icon: variant === "large" ? "hide" : (style.icon ?? "show") };
}

export interface PageHeaderProps extends Omit<ComponentProps<"header">, "title"> {
  /** The page name. Same noun as the rail entry and the route. */
  title: ReactNode;
  /** One line, 90 characters or less. */
  description?: ReactNode;
  /** A 16px lucide icon, the same one as the page's rail entry. */
  icon?: ReactNode;
  /** A 12px line above the title, for organization scope or a back link. */
  context?: ReactNode;
  /** Inline after the title, for example a scope chip. */
  meta?: ReactNode;
  /** Right-aligned actions. Keep one primary action. */
  actions?: ReactNode;
  /** A tab row (LineTabsList or LineTabsNav). Replaces the hairline. */
  tabs?: ReactNode;
  /** Overrides the provider. */
  variant?: PageHeaderVariant;
  /** Overrides the provider: force the icon on or off. */
  showIcon?: boolean;
  /** The hairline under the header when there are no tabs. Default true. */
  divider?: boolean;
}

export function PageHeader({
  title,
  description,
  icon,
  context,
  meta,
  actions,
  tabs,
  variant: variantProp,
  showIcon,
  divider = true,
  className,
  ...props
}: PageHeaderProps) {
  const style = useContext(PageHeaderStyleContext);
  const variant = variantProp ?? style.variant ?? "default";
  const large = variant === "large";
  const iconVisible = Boolean(icon) && !large && (showIcon ?? style.icon !== "hide");
  const ruled = divider && !tabs;

  return (
    <header
      data-slot="page-header"
      data-variant={variant}
      className={cn("@container/page-header min-w-0", className)}
      {...props}
    >
      <div
        className={cn(
          "flex min-w-0 flex-col gap-3 @xl/page-header:flex-row @xl/page-header:items-center @xl/page-header:justify-between @xl/page-header:gap-6",
          ruled && "border-b border-border",
          ruled && (large ? "pb-6" : "pb-4"),
        )}
      >
        <div className="min-w-0 flex-1">
          {context ? (
            <div
              data-slot="page-header-context"
              className={cn(
                "flex min-w-0 items-center gap-1.5 text-xs leading-4.5 font-medium text-fg-subtle",
                large ? "mb-2" : "mb-1",
              )}
            >
              {context}
            </div>
          ) : null}
          <div className="flex min-w-0 items-start gap-2">
            {iconVisible ? (
              <span
                aria-hidden="true"
                className="flex h-7 shrink-0 items-center text-brand [&_svg]:size-4 [&_svg]:shrink-0"
              >
                {icon}
              </span>
            ) : null}
            <h1
              className={cn(
                "min-w-0 font-semibold tracking-[-0.5px] break-words text-fg",
                large ? "text-2xl leading-8" : "text-xl leading-7",
              )}
            >
              {title}
            </h1>
            {meta ? (
              <span
                className={cn(
                  "flex shrink-0 items-center gap-1.5 self-start",
                  large ? "h-8" : "h-7",
                )}
              >
                {meta}
              </span>
            ) : null}
          </div>
          {description ? (
            <p
              data-slot="page-header-description"
              className={cn("text-sm leading-5 text-fg-muted", large ? "mt-1.5" : "mt-1")}
            >
              {description}
            </p>
          ) : null}
        </div>
        {actions ? (
          <div
            data-slot="page-header-actions"
            className="flex min-w-0 shrink-0 flex-wrap items-center gap-2"
          >
            {actions}
          </div>
        ) : null}
      </div>
      {tabs ? <div className={cn("min-w-0", large ? "mt-4" : "mt-3")}>{tabs}</div> : null}
    </header>
  );
}
