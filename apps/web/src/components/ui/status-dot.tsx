import { cn } from "@/lib/utils";

/* ----------------------------------------------------------------------------
   StatusDot — the ONE status color language (doctrine D2).

   Every surface that renders a lifecycle state (session rail, header badge,
   queue rail, document indexing, schedule state, connection health) maps its
   domain state onto one of these six tones and renders this dot. No surface
   invents its own palette. Labels are sentence case; the tone-to-hue mapping
   comes from the og status tokens and nowhere else.
   -------------------------------------------------------------------------- */

export type StatusTone = "queued" | "running" | "waiting" | "idle" | "failed" | "cancelled";

export const STATUS_META: Record<StatusTone, { dot: string; text: string; label: string }> = {
  queued: { dot: "bg-status-queued", text: "text-status-queued", label: "Queued" },
  running: { dot: "bg-status-running", text: "text-status-running", label: "Running" },
  waiting: { dot: "bg-status-waiting", text: "text-status-waiting", label: "Waiting on you" },
  idle: { dot: "bg-status-idle", text: "text-status-idle", label: "Idle" },
  failed: { dot: "bg-status-failed", text: "text-status-failed", label: "Failed" },
  cancelled: { dot: "bg-status-cancelled", text: "text-status-cancelled", label: "Cancelled" },
};

/* ----------------------------------------------------------------------------
   Semantic tones (design brief 2 and 7.12). The product-wide tone table:
   green is fine, purple needs you, amber is working, red failed, grey is
   paused or off. StatusBadge renders these; lifecycle tones map onto them.
   -------------------------------------------------------------------------- */

export type SemanticTone = "success" | "attention" | "progress" | "danger" | "neutral";

export const SEMANTIC_TONES: readonly SemanticTone[] = [
  "success",
  "attention",
  "progress",
  "danger",
  "neutral",
];

export const SEMANTIC_TONE_META: Record<
  SemanticTone,
  {
    /** Dot fill. */
    dot: string;
    /** Tone-colored text, for tinted surfaces and low values. */
    text: string;
    /** Soft fill and border, for tinted pills. */
    soft: string;
    /** Plain-language meaning, for docs and the kit. */
    meaning: string;
  }
> = {
  success: {
    dot: "bg-status-idle",
    text: "text-status-idle",
    soft: "border-status-idle/25 bg-status-idle/10",
    meaning: "Fine",
  },
  attention: {
    dot: "bg-status-waiting",
    text: "text-status-waiting",
    soft: "border-status-waiting/25 bg-status-waiting/10",
    meaning: "Needs you",
  },
  progress: {
    dot: "bg-status-running",
    text: "text-status-running",
    soft: "border-status-running/25 bg-status-running/10",
    meaning: "Working",
  },
  danger: {
    dot: "bg-danger",
    text: "text-danger",
    soft: "border-danger/25 bg-danger/10",
    meaning: "Failed",
  },
  neutral: {
    dot: "bg-fg-subtle",
    text: "text-fg-muted",
    soft: "border-border bg-surface-2",
    meaning: "Paused or off",
  },
};

/** The semantic tone a lifecycle tone reads as. */
export const LIFECYCLE_TO_SEMANTIC: Record<StatusTone, SemanticTone> = {
  queued: "neutral",
  running: "progress",
  waiting: "attention",
  idle: "success",
  failed: "danger",
  cancelled: "neutral",
};

function isSemanticTone(tone: StatusTone | SemanticTone): tone is SemanticTone {
  return tone in SEMANTIC_TONE_META;
}

export function StatusDot({
  tone,
  pulse,
  size,
  className,
}: {
  /** A lifecycle tone, or one of the semantic tones from the tone table. */
  tone: StatusTone | SemanticTone;
  /** Gentle pulse for genuinely live states (running). Respects reduced motion. */
  pulse?: boolean;
  /** "sm" is the 6px badge dot. Omit for the original 8px dot. */
  size?: "sm" | "md";
  className?: string;
}) {
  const fill = isSemanticTone(tone) ? SEMANTIC_TONE_META[tone].dot : STATUS_META[tone].dot;
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        size === "sm" && "size-1.5",
        fill,
        pulse && "motion-safe:animate-pulse",
        className,
      )}
    />
  );
}
