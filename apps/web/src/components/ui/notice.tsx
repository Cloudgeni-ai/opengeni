import { CircleAlertIcon, CircleCheckIcon, InfoIcon, TriangleAlertIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/* ----------------------------------------------------------------------------
   Notice — the one inline panel for states that need a quiet word (doctrine D7).

   Replaces every hand-rolled amber/red/emerald box. Tone budget follows the
   chip doctrine's spirit: color marks the exception, so `muted` is the default
   and tinted tones are reserved for states that genuinely differ (a failure,
   an action waiting on the user, a one-time success confirmation).
   -------------------------------------------------------------------------- */

export type NoticeTone = "muted" | "info" | "success" | "waiting" | "failed";

const TONE: Record<NoticeTone, { box: string; icon: string; glyph: typeof InfoIcon }> = {
  muted: {
    box: "border-border bg-surface/40 text-fg-muted",
    icon: "text-fg-subtle",
    glyph: InfoIcon,
  },
  info: { box: "border-brand/30 bg-brand/[0.06] text-fg", icon: "text-brand", glyph: InfoIcon },
  success: {
    box: "border-status-idle/30 bg-status-idle/[0.06] text-fg",
    icon: "text-status-idle",
    glyph: CircleCheckIcon,
  },
  waiting: {
    box: "border-status-waiting/30 bg-status-waiting/[0.06] text-fg",
    icon: "text-status-waiting",
    glyph: CircleAlertIcon,
  },
  failed: {
    box: "border-status-failed/30 bg-status-failed/[0.06] text-fg",
    icon: "text-status-failed",
    glyph: TriangleAlertIcon,
  },
};

export function Notice({
  tone = "muted",
  title,
  children,
  action,
  icon,
  className,
}: {
  tone?: NoticeTone;
  /** Short bolded lead. Omit for a single-sentence notice. */
  title?: ReactNode;
  children?: ReactNode;
  /** Right-aligned action (a small Button or link). */
  action?: ReactNode;
  /** Override the tone glyph; pass null to render no icon. */
  icon?: ReactNode | null;
  className?: string;
}) {
  const meta = TONE[tone];
  const Glyph = meta.glyph;
  return (
    <div
      className={cn("flex items-start gap-2.5 rounded-lg border p-3 text-sm", meta.box, className)}
    >
      {icon === null ? null : (
        <span className={cn("mt-0.5 shrink-0", meta.icon)}>
          {icon ?? <Glyph className="size-4" />}
        </span>
      )}
      <div className="min-w-0 flex-1">
        {title ? <div className="font-medium">{title}</div> : null}
        {children ? (
          <div className={cn("break-words text-sm leading-5", title ? "mt-0.5 text-fg-muted" : "")}>
            {children}
          </div>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
