import { CircleHelpIcon, InfoIcon } from "lucide-react";
import type { ReactNode } from "react";

import { ReasonTooltip } from "@/components/ui/disabled-reason";
import { cn } from "@/lib/utils";

/* ----------------------------------------------------------------------------
   InlineHelp (design brief 7, "Also build").

   A static explanation is one muted line, not a Notice: 12/18 fg-muted, an
   optional leading info glyph and an optional trailing link. If it needs a
   title or an action button, it's a Notice. If it only matters on demand,
   it's a HelpTip.
   -------------------------------------------------------------------------- */

export function InlineHelp({
  children,
  icon = false,
  action,
  className,
}: {
  children: ReactNode;
  /** A leading info glyph. Use when the line stands alone under a section. */
  icon?: boolean;
  /** A trailing link, for example "Go to People". */
  action?: ReactNode;
  className?: string;
}) {
  return (
    <p
      data-slot="inline-help"
      className={cn(
        "flex min-w-0 items-start gap-1.5 text-xs leading-4.5 text-fg-muted",
        className,
      )}
    >
      {icon ? (
        <InfoIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-fg-subtle" />
      ) : null}
      <span className="min-w-0">
        {children}
        {/* A plain space, not a margin, so a wrapped link lines up with the text. */}
        {action ? (
          <>
            {" "}
            <span className="inline-flex whitespace-nowrap">{action}</span>
          </>
        ) : null}
      </span>
    </p>
  );
}

/** The one text link style for help lines and messages. */
export function HelpLink({
  children,
  href,
  onClick,
  className,
}: {
  children: ReactNode;
  href?: string;
  onClick?: () => void;
  className?: string;
}) {
  const classes = cn(
    "rounded-sm font-medium text-brand underline-offset-2 hover:underline",
    className,
  );
  if (href) {
    return (
      <a href={href} className={classes}>
        {children}
      </a>
    );
  }
  return (
    <button type="button" onClick={onClick} className={classes}>
      {children}
    </button>
  );
}

/**
 * A 16px help glyph next to a label that opens an explanation on hover,
 * focus or tap. For facts people rarely need, like where a number comes from.
 */
export function HelpTip({
  children,
  label = "More information",
  side = "top",
}: {
  /** The explanation. */
  children: ReactNode;
  /** Accessible name for the button. */
  label?: string;
  side?: "top" | "right" | "bottom" | "left";
}) {
  return (
    <ReasonTooltip reason={children} side={side}>
      <button
        type="button"
        aria-label={label}
        className="relative inline-grid size-4 shrink-0 place-items-center rounded-full align-middle text-fg-subtle transition-colors duration-[120ms] hover:text-fg after:absolute after:-inset-1.5 pointer-coarse:after:-inset-3.5"
      >
        <CircleHelpIcon aria-hidden="true" className="size-3.5" />
      </button>
    </ReasonTooltip>
  );
}
