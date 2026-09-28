import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import { STATUS_META, type StatusTone } from "@/components/ui/status-dot";

/* ----------------------------------------------------------------------------
   MetaChip — the one quiet metadata chip (doctrine D7).

   Replaces the dozens of hand-rolled `rounded border px-1.5 text-[10px]`
   clones. Follows the chip doctrine: no filled pills, color only via an
   optional status dot — the text itself stays muted. Anything louder than
   this is not a chip; it's a Notice or a Button.

   Plans, types, scopes, counts and roles ("Primary") are MetaChips; health
   and lifecycle are StatusBadges. The optional `variant` matches a chip to
   the StatusBadge look next to it:
   - "text"     no chrome, for rows next to a dot-and-label status (A);
   - "outline"  22px bordered pill, next to an outline StatusBadge (B);
   - "soft"     22px filled pill, next to a tinted StatusBadge (C).
   Omit `variant` for the original chip.
   -------------------------------------------------------------------------- */

export type MetaChipVariant = "text" | "outline" | "soft";

const VARIANT_CLASS: Record<MetaChipVariant, string> = {
  text: "gap-1 text-xs leading-4 font-medium text-fg-subtle",
  outline:
    "h-5.5 gap-1 rounded-full border border-border bg-surface px-2 text-2xs font-medium text-fg-muted",
  soft: "h-5.5 gap-1 rounded-full border border-transparent bg-surface-2 px-2 text-2xs font-medium text-fg-muted",
};

export function MetaChip({
  children,
  dot,
  rounded = "md",
  variant,
  icon,
  title,
  className,
}: {
  children: ReactNode;
  /** Optional status dot; the one permitted hint of color. */
  dot?: StatusTone;
  /** Original chip only; the variants are always pills. */
  rounded?: "md" | "full";
  /** Match a StatusBadge look. Omit for the original chip. */
  variant?: MetaChipVariant;
  /** Optional 12px leading icon, for example a star for "Primary". */
  icon?: ReactNode;
  title?: string;
  className?: string;
}) {
  return (
    <span
      title={title}
      data-slot="meta-chip"
      className={cn(
        "inline-flex max-w-full items-center",
        variant
          ? cn("shrink-0 align-middle whitespace-nowrap", VARIANT_CLASS[variant])
          : cn(
              "gap-1.5 border border-border bg-surface-2/60 px-1.5 py-0.5 text-2xs font-medium text-fg-muted",
              rounded === "full" ? "rounded-full" : "rounded-md",
            ),
        className,
      )}
    >
      {dot ? (
        <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", STATUS_META[dot].dot)} />
      ) : null}
      {icon ? (
        <span aria-hidden className="inline-flex shrink-0 text-fg-subtle [&>svg]:size-3">
          {icon}
        </span>
      ) : null}
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}
