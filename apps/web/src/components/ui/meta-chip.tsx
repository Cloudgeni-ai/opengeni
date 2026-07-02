import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import { STATUS_META, type StatusTone } from "@/components/ui/status-dot";

/* ----------------------------------------------------------------------------
   MetaChip — the one quiet metadata chip (doctrine D7).

   Replaces the dozens of hand-rolled `rounded border px-1.5 text-[10px]`
   clones. Follows the chip doctrine: no filled pills, color only via an
   optional status dot — the text itself stays muted. Anything louder than
   this is not a chip; it's a Notice or a Button.
   -------------------------------------------------------------------------- */

export function MetaChip({
  children,
  dot,
  rounded = "md",
  title,
  className,
}: {
  children: ReactNode;
  /** Optional status dot; the one permitted hint of color. */
  dot?: StatusTone;
  rounded?: "md" | "full";
  title?: string;
  className?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 border border-border bg-surface-2/60 px-1.5 py-0.5 text-2xs font-medium text-fg-muted",
        rounded === "full" ? "rounded-full" : "rounded-md",
        className,
      )}
    >
      {dot ? <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", STATUS_META[dot].dot)} /> : null}
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}
