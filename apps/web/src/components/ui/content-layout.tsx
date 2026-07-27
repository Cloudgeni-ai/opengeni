import type { ComponentProps, ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Width- and overflow-safe page frame for workspace content surfaces.
 *
 * The `min-w-0` chain is intentional: pages live inside a flex shell and must
 * be allowed to shrink before a long untrusted name can widen the viewport.
 */
export function ContentPage({
  className,
  width = "wide",
  ...props
}: ComponentProps<"div"> & { width?: "standard" | "wide" }) {
  return (
    <div
      data-slot="content-page"
      className={cn(
        "mx-auto flex w-full min-w-0 flex-1 flex-col px-4 py-5 sm:px-6 lg:px-8",
        width === "standard" ? "max-w-5xl" : "max-w-7xl",
        className,
      )}
      {...props}
    />
  );
}

/** A bordered content region with consistent density and no implicit width. */
export function ContentSurface({ className, ...props }: ComponentProps<"section">) {
  return (
    <section
      data-slot="content-surface"
      className={cn("min-w-0 rounded-xl border border-border bg-surface/45 p-3 sm:p-4", className)}
      {...props}
    />
  );
}

/** Compact title/description/action row used inside content surfaces. */
export function ContentSurfaceHeader({
  title,
  description,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
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
export function FormGrid({
  className,
  columns = "two",
  ...props
}: ComponentProps<"div"> & { columns?: "two" | "three" }) {
  return (
    <div
      data-slot="form-grid"
      className={cn(
        "grid min-w-0 gap-3",
        columns === "two" ? "sm:grid-cols-2" : "sm:grid-cols-2 xl:grid-cols-3",
        className,
      )}
      {...props}
    />
  );
}

/** Accessible form-field stack shared by native and custom form controls. */
export function FormField({
  label,
  hint,
  className,
  children,
  ...props
}: Omit<ComponentProps<"label">, "children"> & {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label
      data-slot="form-field"
      className={cn("grid min-w-0 gap-1.5 text-xs font-medium text-fg-subtle", className)}
      {...props}
    >
      <span>{label}</span>
      {children}
      {hint ? <span className="text-2xs font-normal leading-4 text-fg-subtle">{hint}</span> : null}
    </label>
  );
}

/**
 * Contained horizontal overflow for genuinely tabular or wide data.
 * This is the only element that scrolls; it never widens the page itself.
 */
export function DataScroller({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="data-scroller"
      tabIndex={0}
      role="region"
      className={cn(
        "max-w-full min-w-0 overflow-x-auto overscroll-x-contain rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
      {...props}
    />
  );
}
