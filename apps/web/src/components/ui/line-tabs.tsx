import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
} from "react";
import { cva } from "class-variance-authority";
import { Slot, Tabs as TabsPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

/**
 * Page tabs: the Capabilities tab row as a reusable primitive.
 *
 * - `underline` (default): 44px, 14/500, 24px apart, muted until active, and a
 *   2px bar sitting on the row's 1px rule. Reads as places on a page.
 * - `pill`: filled pills on a ruled row. Reads as filters.
 *
 * `LineTabs*` wrap Radix Tabs for in-page panels (arrow keys move between
 * tabs). `LineTabsNav` + `LineTabsLink` render the same row as links for tabs
 * that are routes or URL state (`aria-current="page"`).
 *
 * The row never wraps: on narrow widths the tabs scroll sideways with a soft
 * fade on the clipped edge, the active tab is scrolled into view, and the
 * trailing slot (for example "+ Add") stays pinned right.
 */

export type LineTabsVariant = "underline" | "pill";
export type LineTabsCountTone = "neutral" | "attention";

const VariantContext = createContext<LineTabsVariant>("underline");

const barVariants = cva("flex min-w-0 items-center gap-4 border-b border-border", {
  variants: {
    variant: {
      underline: "",
      pill: "pb-3",
    },
  },
});

const scrollerVariants = cva(
  // The 4px padding (cancelled by the negative margin) keeps the 2px focus
  // outline and its 2px offset inside the scroll box, which clips both axes.
  "-m-1 flex min-w-0 flex-1 items-center overflow-x-auto overscroll-x-contain p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
  {
    variants: {
      variant: {
        underline: "gap-6",
        pill: "gap-2",
      },
    },
  },
);

export const lineTabVariants = cva(
  "group/line-tab relative inline-flex shrink-0 items-center gap-1.5 text-sm font-medium whitespace-nowrap transition-colors duration-[120ms] outline-none select-none disabled:pointer-events-none aria-disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        underline: [
          "h-11 px-0.5 text-fg-muted hover:text-fg data-[state=active]:text-fg",
          "disabled:text-fg-subtle aria-disabled:text-fg-subtle",
          "after:pointer-events-none after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:rounded-full after:bg-fg after:opacity-0 after:transition-opacity after:duration-[120ms] data-[state=active]:after:opacity-100",
          "pointer-coarse:px-1",
        ],
        pill: [
          "h-8 rounded-full border border-border bg-surface px-3 text-fg-muted hover:border-border-strong hover:bg-surface-2 hover:text-fg",
          "data-[state=active]:border-border-strong data-[state=active]:bg-selection data-[state=active]:text-fg",
          "disabled:text-fg-subtle aria-disabled:text-fg-subtle pointer-coarse:h-11 pointer-coarse:px-4",
        ],
      },
    },
    defaultVariants: { variant: "underline" },
  },
);

const countVariants = cva(
  "inline-flex h-4.5 min-w-4.5 items-center justify-center rounded-full px-1.5 text-2xs font-medium tabular-nums",
  {
    variants: {
      variant: {
        underline: "",
        pill: "",
      },
      tone: {
        neutral: "",
        attention: "bg-status-waiting/12 text-status-waiting",
      },
    },
    compoundVariants: [
      {
        variant: "underline",
        tone: "neutral",
        className:
          "bg-surface-2 text-fg-muted group-data-[state=active]/line-tab:bg-surface-3 group-data-[state=active]/line-tab:text-fg",
      },
      {
        variant: "pill",
        tone: "neutral",
        className:
          "bg-surface-2 text-fg-muted group-data-[state=active]/line-tab:bg-bg/20 group-data-[state=active]/line-tab:text-bg",
      },
      {
        variant: "pill",
        tone: "attention",
        className:
          "group-data-[state=active]/line-tab:bg-bg/20 group-data-[state=active]/line-tab:text-bg",
      },
    ],
    defaultVariants: { variant: "underline", tone: "neutral" },
  },
);

/** The 11px count badge inside a tab: "Review 3". */
export function LineTabCount({
  count,
  tone = "neutral",
  label,
  className,
}: {
  count: ReactNode;
  tone?: LineTabsCountTone;
  /** Read instead of the bare number, for example "3 waiting for review". */
  label?: string;
  className?: string;
}) {
  const variant = useContext(VariantContext);
  return (
    <>
      <span
        data-slot="line-tab-count"
        aria-hidden={label ? true : undefined}
        className={cn(countVariants({ variant, tone }), className)}
      >
        {count}
      </span>
      {label ? <span className="sr-only">, {label}</span> : null}
    </>
  );
}

/* ----------------------------------------------------------------------------
   Horizontal overflow: fade the clipped edge, keep the active tab in view.
   -------------------------------------------------------------------------- */

const FADE = "24px";

function useScrollEdges() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [edges, setEdges] = useState({ start: false, end: false });

  const measure = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    const max = element.scrollWidth - element.clientWidth;
    const start = element.scrollLeft > 1;
    const end = max - element.scrollLeft > 1;
    setEdges((current) =>
      current.start === start && current.end === end ? current : { start, end },
    );
  }, []);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    // Bring the active tab into view (on mount and whenever it changes, for
    // example from the URL), by scrolling the row only, never the page.
    const revealActive = () => {
      const active = element.querySelector<HTMLElement>(
        '[data-state="active"], [aria-current="page"]',
      );
      if (!active) return;
      const box = element.getBoundingClientRect();
      const rect = active.getBoundingClientRect();
      const left = rect.left - box.left + element.scrollLeft;
      const right = left + rect.width;
      if (right > element.scrollLeft + element.clientWidth) {
        element.scrollLeft = right - element.clientWidth + 24;
      } else if (left < element.scrollLeft) {
        element.scrollLeft = Math.max(0, left - 24);
      }
    };
    revealActive();
    measure();
    element.addEventListener("scroll", measure, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    const activeObserver =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver((records) => {
            const activated = records.some(
              (record) =>
                record.target instanceof HTMLElement &&
                (record.target.dataset.state === "active" ||
                  record.target.getAttribute("aria-current") === "page"),
            );
            if (activated) revealActive();
          });
    activeObserver?.observe(element, {
      subtree: true,
      attributes: true,
      attributeFilter: ["data-state", "aria-current"],
    });
    return () => {
      element.removeEventListener("scroll", measure);
      observer?.disconnect();
      activeObserver?.disconnect();
    };
  }, [measure]);

  let style: CSSProperties | undefined;
  if (edges.start || edges.end) {
    const mask = `linear-gradient(to right, ${edges.start ? `transparent, black ${FADE}` : "black"}, ${
      edges.end ? `black calc(100% - ${FADE}), transparent` : "black"
    })`;
    style = { maskImage: mask, WebkitMaskImage: mask };
  }

  return { ref, style, edges };
}

/* ----------------------------------------------------------------------------
   Radix-backed tabs (in-page panels).
   -------------------------------------------------------------------------- */

export function LineTabs({ className, ...props }: ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="line-tabs"
      className={cn("flex min-w-0 flex-col", className)}
      {...props}
    />
  );
}

export interface LineTabsListProps extends ComponentProps<typeof TabsPrimitive.List> {
  variant?: LineTabsVariant;
  /** Pinned to the right of the row, on the same rule: "+ Add". */
  trailing?: ReactNode;
  /** Classes for the outer row (the one with the rule). */
  barClassName?: string;
}

export function LineTabsList({
  variant = "underline",
  trailing,
  className,
  barClassName,
  children,
  ...props
}: LineTabsListProps) {
  const { ref, style, edges } = useScrollEdges();
  return (
    <VariantContext.Provider value={variant}>
      <div
        data-slot="line-tabs-bar"
        data-variant={variant}
        className={cn(barVariants({ variant }), barClassName)}
      >
        <TabsPrimitive.List
          ref={ref}
          data-slot="line-tabs-list"
          data-overflow-start={edges.start || undefined}
          data-overflow-end={edges.end || undefined}
          style={style}
          className={cn(scrollerVariants({ variant }), className)}
          {...props}
        >
          {children}
        </TabsPrimitive.List>
        {trailing ? (
          <div data-slot="line-tabs-trailing" className="flex shrink-0 items-center gap-2 py-1">
            {trailing}
          </div>
        ) : null}
      </div>
    </VariantContext.Provider>
  );
}

export interface LineTabsTriggerProps extends ComponentProps<typeof TabsPrimitive.Trigger> {
  /** Shown as an 11px badge after the label. */
  count?: ReactNode;
  countTone?: LineTabsCountTone;
  /** Read instead of the bare count. */
  countLabel?: string;
}

export function LineTabsTrigger({
  className,
  children,
  count,
  countTone,
  countLabel,
  ...props
}: LineTabsTriggerProps) {
  const variant = useContext(VariantContext);
  return (
    <TabsPrimitive.Trigger
      data-slot="line-tabs-trigger"
      className={cn(lineTabVariants({ variant }), className)}
      {...props}
    >
      {children}
      {count === undefined || count === null ? null : (
        <LineTabCount count={count} tone={countTone} label={countLabel} />
      )}
    </TabsPrimitive.Trigger>
  );
}

export function LineTabsContent({
  className,
  ...props
}: ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="line-tabs-content"
      className={cn("min-w-0 outline-none", className)}
      {...props}
    />
  );
}

/* ----------------------------------------------------------------------------
   Link tabs (routes and URL state).
   -------------------------------------------------------------------------- */

export interface LineTabsNavProps extends ComponentProps<"nav"> {
  variant?: LineTabsVariant;
  trailing?: ReactNode;
  barClassName?: string;
}

export function LineTabsNav({
  variant = "underline",
  trailing,
  className,
  barClassName,
  children,
  ...props
}: LineTabsNavProps) {
  const { ref, style, edges } = useScrollEdges();
  return (
    <VariantContext.Provider value={variant}>
      <nav data-slot="line-tabs-nav" className={cn("min-w-0", className)} {...props}>
        <div
          data-slot="line-tabs-bar"
          data-variant={variant}
          className={cn(barVariants({ variant }), barClassName)}
        >
          <div
            ref={ref}
            role="list"
            data-slot="line-tabs-list"
            data-overflow-start={edges.start || undefined}
            data-overflow-end={edges.end || undefined}
            style={style}
            className={scrollerVariants({ variant })}
          >
            {children}
          </div>
          {trailing ? (
            <div data-slot="line-tabs-trailing" className="flex shrink-0 items-center gap-2 py-1">
              {trailing}
            </div>
          ) : null}
        </div>
      </nav>
    </VariantContext.Provider>
  );
}

export interface LineTabsLinkProps extends ComponentProps<"a"> {
  /** Render your router's link as the child (`<Link to="..." />`). */
  asChild?: boolean;
  active?: boolean;
  count?: ReactNode;
  countTone?: LineTabsCountTone;
  countLabel?: string;
}

export function LineTabsLink({
  asChild = false,
  active = false,
  count,
  countTone,
  countLabel,
  className,
  children,
  ...props
}: LineTabsLinkProps) {
  const variant = useContext(VariantContext);
  const Comp = asChild ? Slot.Root : "a";
  return (
    <div role="listitem" className="flex shrink-0">
      <Comp
        data-slot="line-tabs-link"
        data-state={active ? "active" : "inactive"}
        aria-current={active ? "page" : undefined}
        className={cn(lineTabVariants({ variant }), className)}
        {...props}
      >
        <Slot.Slottable>{children}</Slot.Slottable>
        {count === undefined || count === null ? null : (
          <LineTabCount count={count} tone={countTone} label={countLabel} />
        )}
      </Comp>
    </div>
  );
}
