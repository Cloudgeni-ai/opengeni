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

// Read live icon imports at render time: production chunk cycles can initialize
// this table before the icon modules, so eagerly captured values may be undefined.
const TONE: Record<NoticeTone, { box: string; icon: string; glyph: () => typeof InfoIcon }> = {
  muted: {
    box: "border-border bg-surface/40 text-fg-muted",
    icon: "text-fg-subtle",
    glyph: () => InfoIcon,
  },
  info: {
    box: "border-brand/30 bg-brand/[0.06] text-fg",
    icon: "text-brand",
    glyph: () => InfoIcon,
  },
  success: {
    box: "border-status-idle/30 bg-status-idle/[0.06] text-fg",
    icon: "text-status-idle",
    glyph: () => CircleCheckIcon,
  },
  waiting: {
    box: "border-status-waiting/30 bg-status-waiting/[0.06] text-fg",
    icon: "text-status-waiting",
    glyph: () => CircleAlertIcon,
  },
  failed: {
    box: "border-status-failed/30 bg-status-failed/[0.06] text-fg",
    icon: "text-status-failed",
    glyph: () => TriangleAlertIcon,
  },
};

export function Notice({
  tone = "muted",
  title,
  children,
  action,
  icon,
  onDismiss,
  dismissLabel = "Dismiss",
  layout,
  actionLayout,
  live,
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
  /** Adds a close button. Only for notices the person may safely hide. */
  onDismiss?: () => void;
  /** Accessible name of the close button. */
  dismissLabel?: string;
  /**
   * "banner" spans a whole page or workspace: square corners, a bottom rule
   * only, one 32px line that keeps the icon and action on the first line
   * when the text wraps. Omit for the inline panel.
   */
  layout?: "banner";
  /**
   * "responsive" moves the action under the text when the notice is
   * narrower than 448px, so phone widths don't squeeze the message.
   */
  actionLayout?: "responsive";
  /**
   * Announce it when it appears: "polite" for results of an action,
   * "assertive" only for failures that block what the person is doing.
   */
  live?: "polite" | "assertive";
  className?: string;
}) {
  const meta = TONE[tone];
  const Glyph = meta.glyph();
  return (
    <div
      role={live === "assertive" ? "alert" : live === "polite" ? "status" : undefined}
      className={cn(
        "flex items-start gap-2.5 rounded-lg border p-3 text-sm",
        meta.box,
        layout === "banner" && "rounded-none border-x-0 border-t-0 px-4 py-2",
        actionLayout === "responsive" && "@container/notice flex-wrap",
        className,
      )}
    >
      {icon === null ? null : (
        <span className={cn("mt-0.5 shrink-0", layout === "banner" && "mt-2", meta.icon)}>
          {icon ?? <Glyph className="size-4" />}
        </span>
      )}
      <div className={cn("min-w-0 flex-1", layout === "banner" && "py-1.5")}>
        {title ? <div className="font-medium">{title}</div> : null}
        {children ? (
          <div className={cn("break-words text-sm leading-5", title ? "mt-0.5 text-fg-muted" : "")}>
            {children}
          </div>
        ) : null}
      </div>
      {action ? (
        <div
          className={cn(
            "shrink-0",
            actionLayout === "responsive" &&
              "@max-md/notice:order-last @max-md/notice:basis-full @max-md/notice:pl-6.5",
            actionLayout === "responsive" && icon === null && "@max-md/notice:pl-0",
          )}
        >
          {action}
        </div>
      ) : null}
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={dismissLabel}
          className={cn(
            "-mr-1 inline-grid size-7 shrink-0 place-items-center rounded-md text-fg-subtle transition-colors duration-[120ms] hover:bg-surface-2 hover:text-fg pointer-coarse:size-11",
            layout === "banner" ? "mt-0.5" : "-my-1",
          )}
        >
          {/* Inline glyph: the icon table above documents why late icon imports are avoided. */}
          <svg
            aria-hidden="true"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            className="size-4"
          >
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      ) : null}
    </div>
  );
}
