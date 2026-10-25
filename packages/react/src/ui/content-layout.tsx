import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from "react";

import { cn } from "../lib/cn";

/**
 * Width-, height-, and overflow-safe page frame for workspace content surfaces.
 *
 * Scroll ownership and column width are deliberately split:
 * - Outer (`data-slot="content-page"`) is the full-width flex child that owns
 *   vertical scroll + overscroll containment inside the fixed app canvas.
 * - Inner (`data-slot="content-page-inner"`) is the centered max-width column.
 *
 * Putting `overflow-y-auto` on the max-width box itself left gutters outside
 * the scrollport; wheel there scrolled the document and shoved the whole app
 * up (empty band + floating DevTools). Never merge those two again.
 *
 * The `min-w-0` chain is intentional: pages live inside a flex shell and must
 * be allowed to shrink before a long untrusted name can widen the viewport.
 */
export const ContentPage = /* @__PURE__ */ forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<"div"> & { width?: "standard" | "wide" }
>(function ContentPage({ className, width = "wide", children, ...props }, ref) {
  return (
    <div
      data-slot="content-page"
      data-workspace-scroll-owner="page"
      className="flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto overscroll-y-contain"
      ref={ref}
      {...props}
    >
      <div
        data-slot="content-page-inner"
        className={cn(
          "mx-auto flex w-full min-w-0 flex-col px-4 py-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:px-6 lg:px-8",
          width === "standard" ? "max-w-5xl" : "max-w-7xl",
          className,
        )}
      >
        {children}
      </div>
    </div>
  );
});

/** A bordered content region with consistent density and no implicit width. */
export const ContentSurface = /* @__PURE__ */ forwardRef<
  HTMLElement,
  ComponentPropsWithoutRef<"section">
>(function ContentSurface({ className, ...props }, ref) {
  return (
    <section
      data-slot="content-surface"
      className={cn("min-w-0 rounded-xl border border-border bg-surface/45 p-3 sm:p-4", className)}
      ref={ref}
      {...props}
    />
  );
});

/** Compact title/description/action row used inside content surfaces. */
export function ContentSurfaceHeader({
  title,
  description,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode | undefined;
  actions?: ReactNode | undefined;
  className?: string | undefined;
}) {
  return (
    <div
      data-slot="content-surface-header"
      className={cn(
        "flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between",
        className,
      )}
    >
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-fg">{title}</h2>
        {description ? (
          <p className="mt-0.5 text-xs leading-5 text-fg-muted">{description}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2 sm:shrink-0">{actions}</div>
      ) : null}
    </div>
  );
}

/** Responsive form layout: one column first, opt-in columns as space permits. */
export const FormGrid = /* @__PURE__ */ forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<"div"> & { columns?: "two" | "three" }
>(function FormGrid({ className, columns = "two", ...props }, ref) {
  return (
    <div
      data-slot="form-grid"
      className={cn(
        "grid min-w-0 gap-3",
        columns === "two" ? "sm:grid-cols-2" : "sm:grid-cols-2 xl:grid-cols-3",
        className,
      )}
      ref={ref}
      {...props}
    />
  );
});

/** Accessible form-field stack shared by native and custom form controls. */
export const FormField = /* @__PURE__ */ forwardRef<
  HTMLLabelElement,
  Omit<ComponentPropsWithoutRef<"label">, "children"> & {
    label: ReactNode;
    hint?: ReactNode | undefined;
    children: ReactNode;
  }
>(function FormField({ label, hint, className, children, ...props }, ref) {
  return (
    <label
      data-slot="form-field"
      className={cn("grid min-w-0 gap-1.5 text-sm font-medium text-fg", className)}
      ref={ref}
      {...props}
    >
      <span>{label}</span>
      {children}
      {hint ? <span className="text-2xs font-normal leading-4 text-fg-subtle">{hint}</span> : null}
    </label>
  );
});

/**
 * Contained horizontal overflow for genuinely tabular or wide data.
 * This is the only element that scrolls; it never widens the page itself.
 */
export const DataScroller = /* @__PURE__ */ forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<"div">
>(function DataScroller({ className, ...props }, ref) {
  return (
    <div
      data-slot="data-scroller"
      tabIndex={0}
      role="region"
      className={cn(
        "max-w-full min-w-0 overflow-x-auto overscroll-x-contain rounded-lg focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
      ref={ref}
      {...props}
    />
  );
});
