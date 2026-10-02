import { useId, type ReactNode } from "react";

import { LogoTile } from "@/components/ui/logo-tile";
import { cn } from "@/lib/utils";

/* ----------------------------------------------------------------------------
   EmptyState — a designed empty, not an apology (doctrine D5).

   Every zero-data surface renders this: an optional icon, a short factual
   title (fragment, no period), ONE orienting sentence (what this area is for
   or what will appear here), and the primary action to change that — inside
   the empty state, not off in a distant header.

   Variants (design brief 7.14). Omitting `variant` keeps the original boxed
   look, so existing call sites don't change:
   - "page"   (A) centred: 40px icon tile, title, one sentence, one action,
              64px from the top. Hide the page header's action while it shows.
              Pass `templates` for C: 2-3 starter cards that prefill a form.
   - "inline" (B) one muted sentence and a link, for sections and no results:
              'No matches for "aws".' + Clear search.
   -------------------------------------------------------------------------- */

export type EmptyStateVariant = "boxed" | "page" | "inline";

export function EmptyState({
  icon,
  title,
  description,
  action,
  variant = "boxed",
  tone = "default",
  templates,
  className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  /** "boxed" (the original), "page" (A) or "inline" (B). */
  variant?: EmptyStateVariant;
  /** "danger" colors the icon tile, for load errors. Page variant only. */
  tone?: "default" | "danger";
  /** Starter cards under the action (C), usually `EmptyStateTemplates`. Page variant only. */
  templates?: ReactNode;
  className?: string;
}) {
  if (variant === "page") {
    return (
      <div
        data-slot="empty-state"
        data-variant="page"
        className={cn("flex min-w-0 flex-col items-center px-4 pt-16 pb-12 text-center", className)}
      >
        {icon ? (
          <LogoTile size="lg" icon={icon} tone={tone === "danger" ? "danger" : "neutral"} />
        ) : null}
        <p className={cn("text-sm leading-5 font-semibold text-fg", icon && "mt-4")}>{title}</p>
        {description ? (
          <p className="mt-1 max-w-[380px] text-sm leading-5 text-pretty text-fg-muted">
            {description}
          </p>
        ) : null}
        {action ? (
          <div className="mt-5 flex flex-wrap items-center justify-center gap-2">{action}</div>
        ) : null}
        {templates ? <div className="mt-10 w-full max-w-[760px] text-left">{templates}</div> : null}
      </div>
    );
  }

  if (variant === "inline") {
    return (
      <div
        data-slot="empty-state"
        data-variant="inline"
        className={cn(
          "flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 py-3 text-sm leading-5 text-fg-muted",
          className,
        )}
      >
        <p className="min-w-0">
          {title}
          {description ? <> {description}</> : null}
        </p>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "grid place-items-center gap-1.5 rounded-lg border border-dashed border-border px-6 py-10 text-center",
        className,
      )}
    >
      {icon ? (
        <span className="mb-1 flex size-9 items-center justify-center rounded-full bg-surface-2 text-fg-subtle">
          {icon}
        </span>
      ) : null}
      <p className="text-sm font-medium text-fg">{title}</p>
      {description ? (
        <p className="max-w-sm text-sm leading-5 text-fg-muted">{description}</p>
      ) : null}
      {action ? <div className="mt-2.5">{action}</div> : null}
    </div>
  );
}

/** The quiet text action for inline empty states: "Clear search", "Add variable". */
export function EmptyStateLink({
  children,
  onClick,
  className,
}: {
  children: ReactNode;
  onClick?: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 rounded-[6px] text-sm leading-5 font-medium text-brand underline-offset-4 transition-colors duration-[120ms] hover:underline pointer-coarse:min-h-11",
        className,
      )}
    >
      {children}
    </button>
  );
}

/** Starter cards for the page empty state (C). */
export function EmptyStateTemplates({
  label = "Or start from a template",
  children,
  className,
}: {
  label?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const labelId = useId();
  return (
    <div className={cn("@container/templates min-w-0", className)}>
      <p id={labelId} className="mb-3 text-center text-xs leading-4.5 font-medium text-fg-muted">
        {label}
      </p>
      <ul
        aria-labelledby={labelId}
        className="m-0 grid list-none grid-cols-1 gap-3 p-0 @[600px]/templates:grid-cols-3"
      >
        {children}
      </ul>
    </div>
  );
}

/** One starter card. The whole card prefills the create form. */
export function EmptyStateTemplate({
  icon,
  title,
  description,
  meta,
  onSelect,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** One quiet fact, for example the cadence: "Every weekday at 08:00". */
  meta?: ReactNode;
  onSelect?: () => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  return (
    <li className="min-w-0">
      <button
        type="button"
        onClick={onSelect}
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        className="group/template flex h-full w-full min-w-0 flex-col items-start gap-3 rounded-[14px] border border-border bg-surface p-4 text-left transition-colors duration-[120ms] hover:border-border-strong hover:bg-surface-2"
      >
        {icon ? <LogoTile size="md" icon={icon} tone="brand" /> : null}
        <span className="flex min-w-0 flex-col gap-1">
          <span id={titleId} className="text-sm leading-5 font-medium text-fg">
            {title}
          </span>
          {description ? (
            <span id={descriptionId} className="text-xs leading-4.5 text-fg-muted">
              {description}
            </span>
          ) : null}
        </span>
        {meta ? <span className="mt-auto text-xs leading-4.5 text-fg-subtle">{meta}</span> : null}
      </button>
    </li>
  );
}
