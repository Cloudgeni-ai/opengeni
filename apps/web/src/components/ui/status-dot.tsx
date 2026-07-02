import { cn } from "@/lib/utils";

/* ----------------------------------------------------------------------------
   StatusDot — the ONE status color language (doctrine D2).

   Every surface that renders a lifecycle state (session rail, header badge,
   queue rail, document indexing, schedule state, connection health) maps its
   domain state onto one of these six tones and renders this dot. No surface
   invents its own palette. Labels are sentence case; the tone-to-hue mapping
   comes from the og status tokens and nowhere else.
   -------------------------------------------------------------------------- */

export type StatusTone =
  | "queued"
  | "running"
  | "waiting"
  | "idle"
  | "failed"
  | "cancelled";

export const STATUS_META: Record<StatusTone, { dot: string; text: string; label: string }> = {
  queued: { dot: "bg-status-queued", text: "text-status-queued", label: "Queued" },
  running: { dot: "bg-status-running", text: "text-status-running", label: "Running" },
  waiting: { dot: "bg-status-waiting", text: "text-status-waiting", label: "Waiting on you" },
  idle: { dot: "bg-status-idle", text: "text-status-idle", label: "Idle" },
  failed: { dot: "bg-status-failed", text: "text-status-failed", label: "Failed" },
  cancelled: { dot: "bg-status-cancelled", text: "text-status-cancelled", label: "Cancelled" },
};

export function StatusDot({
  tone,
  pulse,
  className,
}: {
  tone: StatusTone;
  /** Gentle pulse for genuinely live states (running). Respects reduced motion. */
  pulse?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        STATUS_META[tone].dot,
        pulse && "motion-safe:animate-pulse",
        className,
      )}
    />
  );
}
