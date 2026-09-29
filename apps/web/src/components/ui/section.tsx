import { createContext, useContext, useId, type ComponentProps, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Groups related rows on a page, a sheet or a dialog. Title 16/24 semibold,
 * one step above the 14/20 row labels so a section never reads as a setting
 * without a control; optional 12/18 description 4px below, content 12px below
 * that, and an optional action vertically centred on the title line.
 *
 * Variants (how the rows are held):
 * - `open` (default outside settings): rows sit on the page, no box. Sections
 *   are separated by one full-width hairline (SectionStack).
 * - `group` (default inside settings, via `SectionVariantProvider` in the
 *   settings shell): the heading sits above, the rows share one bordered
 *   card (radius 14, surface, 20px inner gutter), split by hairlines. A
 *   Notice among the rows loses its own box so it never nests a card in a
 *   card, and a Section whose rows render nothing shows no empty card.
 * - `tiles`: every row gets its own bordered card.
 *
 * Rows are the direct children of a Section (SettingRow, ListRow, a Notice...).
 * `group` and `tiles` add the horizontal padding their boxes need, so the same
 * rows work in every variant.
 */

/** The section title type. Shared by every heading that sits above setting rows. */
export const SECTION_TITLE_CLASS = "text-base leading-6 font-semibold tracking-[-0.2px] text-fg";

export type SectionVariant = "open" | "group" | "tiles";

const SectionVariantContext = createContext<SectionVariant | null>(null);

/** True inside a grouped Section's card, so nested lists don't draw a second card. */
const SectionCardContext = createContext(false);

/**
 * How a resource list should hold itself here: `card` when the page groups its
 * sections into cards but the list is not already inside one, `inside` when it
 * sits in a grouped Section's card, `open` otherwise.
 */
export function useSectionListFrame(): "card" | "inside" | "open" {
  const variant = useContext(SectionVariantContext);
  const inCard = useContext(SectionCardContext);
  if (inCard) return "inside";
  return variant === "group" ? "card" : "open";
}

/**
 * Sets the default variant for every SectionStack and Section below it. The
 * settings shell provides `group`, so every settings page gets grouped cards.
 */
export function SectionVariantProvider({
  variant,
  children,
}: {
  variant: SectionVariant;
  children?: ReactNode;
}) {
  return (
    <SectionVariantContext.Provider value={variant}>{children}</SectionVariantContext.Provider>
  );
}

export interface SectionStackProps extends ComponentProps<"div"> {
  /**
   * Applies to every Section inside unless a Section sets its own. Defaults to
   * the enclosing provider's variant, then `open`.
   */
  variant?: SectionVariant;
  /**
   * A full-width hairline between sections with 24px above and below.
   * Defaults to true for `open` and false for boxed variants (32px gap).
   */
  divided?: boolean;
}

/** A column of sections with the page rhythm between them. */
export function SectionStack({
  variant: variantProp,
  divided,
  className,
  children,
  ...props
}: SectionStackProps) {
  const inherited = useContext(SectionVariantContext);
  const variant = variantProp ?? inherited ?? "open";
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
  /**
   * Omit only for the first rows of a page whose page title already names them
   * (Settings > General: Name, ID). Pass `aria-label` then if the rows need a name.
   */
  title?: ReactNode;
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
  group: cn(
    // The 20px gutter is on the card, so the hairlines between rows are inset
    // like the text they separate.
    "flex flex-col divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface px-5 py-1 empty:hidden",
    // A Notice among the rows becomes a row: no second border, fill or radius.
    "[&>[data-slot=notice]]:rounded-none [&>[data-slot=notice]]:border-0 [&>[data-slot=notice]]:bg-transparent [&>[data-slot=notice]]:px-0 [&>[data-slot=notice]]:py-4",
  ),
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
  const hasHeader = title !== undefined && title !== null && title !== false;

  return (
    <section
      data-slot="section"
      data-variant={variant}
      aria-labelledby={hasHeader ? headingId : undefined}
      className={cn("min-w-0", className)}
      {...props}
    >
      {/* Title and action share the first line; on narrow widths the description
          runs under both, so a wide action never squeezes it into a column. */}
      {hasHeader ? (
        <div
          className={cn(
            "@container/section-header grid min-w-0 items-start gap-x-4",
            action ? "grid-cols-[minmax(0,1fr)_auto]" : "grid-cols-1",
          )}
        >
          <Heading
            id={headingId}
            className={cn("col-start-1 row-start-1 break-words", SECTION_TITLE_CLASS)}
          >
            {title}
          </Heading>
          {action ? (
            <div
              data-slot="section-action"
              className="col-start-2 row-start-1 flex h-6 shrink-0 items-center gap-2"
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
                // overhangs the 24px title line by 4px.
                action && "col-span-2 mt-2 @md/section-header:col-span-1 @md/section-header:mt-1",
              )}
            >
              {description}
            </p>
          ) : null}
        </div>
      ) : null}
      {hasContent ? (
        <div
          data-slot="section-content"
          className={cn(
            "min-w-0",
            hasHeader && "mt-3",
            CONTENT_CLASS[variant],
            variant === "open" && divided && "divide-y divide-border",
            contentClassName,
          )}
        >
          <SectionCardContext.Provider value={variant === "group"}>
            {children}
          </SectionCardContext.Provider>
        </div>
      ) : null}
    </section>
  );
}
