import { createContext, useContext, useId, type ComponentProps, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Groups related rows on a page, a sheet or a dialog. Title 14/20 semibold,
 * optional 12/18 description 4px below, content 12px below that, and an
 * optional action vertically centred on the title line.
 *
 * Variants (how the rows are held):
 * - `open` (default): rows sit on the page, no box. Sections are separated by
 *   one full-width hairline (SectionStack). Never produces a card in a card.
 * - `group`: the rows share one bordered surface, split by hairlines.
 * - `tiles`: every row gets its own bordered card.
 *
 * Rows are the direct children of a Section (SettingRow, ListRow, a Notice...).
 * `group` and `tiles` add the horizontal padding their boxes need, so the same
 * rows work in every variant.
 */

export type SectionVariant = "open" | "group" | "tiles";

const SectionVariantContext = createContext<SectionVariant | null>(null);

export interface SectionStackProps extends ComponentProps<"div"> {
  /** Applies to every Section inside unless a Section sets its own. */
  variant?: SectionVariant;
  /**
   * A full-width hairline between sections with 24px above and below.
   * Defaults to true for `open` and false for boxed variants (32px gap).
   */
  divided?: boolean;
}

/** A column of sections with the page rhythm between them. */
export function SectionStack({
  variant = "open",
  divided,
  className,
  children,
  ...props
}: SectionStackProps) {
  const hairlines = divided ?? variant === "open";
  return (
    <SectionVariantContext.Provider value={variant}>
      <div
        data-slot="section-stack"
        data-variant={variant}
        className={cn(
          "flex min-w-0 flex-col",
          hairlines
            ? "divide-y divide-border [&>*]:py-6 [&>*:first-child]:pt-0 [&>*:last-child]:pb-0"
            : "gap-8",
          className,
        )}
        {...props}
      >
        {children}
      </div>
    </SectionVariantContext.Provider>
  );
}

export interface SectionProps extends Omit<ComponentProps<"section">, "title"> {
  title: ReactNode;
  /** One or two short sentences, 12px muted. */
  description?: ReactNode;
  /** Right of the title, centred on the title line. One quiet action. */
  action?: ReactNode;
  /** Defaults to the enclosing SectionStack's variant, then `open`. */
  variant?: SectionVariant;
  /** Hairlines between rows. `group` always has them. */
  divided?: boolean;
  /** Heading level. Default 2 (under the page's h1). */
  headingLevel?: 2 | 3;
  /** Classes for the rows container. */
  contentClassName?: string;
  children?: ReactNode;
}

const CONTENT_CLASS: Record<SectionVariant, string> = {
  open: "flex flex-col",
  group:
    "flex flex-col divide-y divide-border overflow-hidden rounded-[14px] border border-border bg-surface [&>*]:px-4",
  tiles:
    "flex flex-col gap-2 [&>*]:rounded-[14px] [&>*]:border [&>*]:border-border [&>*]:bg-surface [&>*]:px-4 [&>*]:py-1",
};

export function Section({
  title,
  description,
  action,
  variant: variantProp,
  divided,
  headingLevel = 2,
  contentClassName,
  className,
  children,
  ...props
}: SectionProps) {
  const inherited = useContext(SectionVariantContext);
  const variant = variantProp ?? inherited ?? "open";
  const headingId = useId();
  const Heading = headingLevel === 3 ? "h3" : "h2";
  const hasContent = children !== undefined && children !== null && children !== false;

  return (
    <section
      data-slot="section"
      data-variant={variant}
      aria-labelledby={headingId}
      className={cn("min-w-0", className)}
      {...props}
    >
      {/* Title and action share the first line; on narrow widths the description
          runs under both, so a wide action never squeezes it into a column. */}
      <div
        className={cn(
          "@container/section-header grid min-w-0 items-start gap-x-4",
          action ? "grid-cols-[minmax(0,1fr)_auto]" : "grid-cols-1",
        )}
      >
        <Heading
          id={headingId}
          className="col-start-1 row-start-1 text-sm leading-5 font-semibold break-words text-fg"
        >
          {title}
        </Heading>
        {action ? (
          <div
            data-slot="section-action"
            className="col-start-2 row-start-1 flex h-5 shrink-0 items-center gap-2"
          >
            {action}
          </div>
        ) : null}
        {description ? (
          <p
            data-slot="section-description"
            className={cn(
              "row-start-2 mt-1 text-xs leading-4.5 text-fg-muted",
              // Under the action on narrow widths: clear the 32px button, which
              // overhangs the 20px title line by 6px.
              action && "col-span-2 mt-2.5 @md/section-header:col-span-1 @md/section-header:mt-1",
            )}
          >
            {description}
          </p>
        ) : null}
      </div>
      {hasContent ? (
        <div
          data-slot="section-content"
          className={cn(
            "mt-3 min-w-0",
            CONTENT_CLASS[variant],
            variant === "open" && divided && "divide-y divide-border",
            contentClassName,
          )}
        >
          {children}
        </div>
      ) : null}
    </section>
  );
}
