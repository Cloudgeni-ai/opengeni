import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/* ----------------------------------------------------------------------------
   EmptyState — a designed empty, not an apology (doctrine D5).

   Every zero-data surface renders this: an optional icon, a short factual
   title (fragment, no period), ONE orienting sentence (what this area is for
   or what will appear here), and the primary action to change that — inside
   the empty state, not off in a distant header.
   -------------------------------------------------------------------------- */

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
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
