import type { SessionStatus as SessionStatusValue } from "@opengeni/sdk";
import { cn } from "../lib/cn";

export type SessionStatusMeta = {
  label: string;
  /** Token-backed color classes for the dot and tinted badge. */
  dotClassName: string;
  badgeClassName: string;
  /** Live states breathe; terminal states hold still. */
  pulse: boolean;
};

export const SESSION_STATUS_META: Record<SessionStatusValue, SessionStatusMeta> = {
  queued: {
    label: "Queued",
    dotClassName: "bg-og-status-queued",
    badgeClassName: "text-og-fg-muted border-og-border bg-og-status-queued/10",
    pulse: true,
  },
  running: {
    label: "Running",
    dotClassName: "bg-og-status-running",
    badgeClassName: "text-og-status-running border-og-status-running/30 bg-og-status-running/10",
    pulse: true,
  },
  recovering: {
    label: "Recovering",
    dotClassName: "bg-og-status-running",
    badgeClassName: "text-og-status-running border-og-status-running/30 bg-og-status-running/10",
    pulse: true,
  },
  waiting_capacity: {
    label: "Waiting for capacity",
    dotClassName: "bg-og-status-waiting",
    badgeClassName: "text-og-status-waiting border-og-status-waiting/35 bg-og-status-waiting/10",
    pulse: true,
  },
  paused: {
    label: "Paused",
    dotClassName: "bg-og-status-cancelled",
    badgeClassName: "text-og-fg-subtle border-og-border bg-og-status-cancelled/10",
    pulse: false,
  },
  idle: {
    label: "Idle",
    dotClassName: "bg-og-status-idle",
    badgeClassName: "text-og-status-idle border-og-status-idle/30 bg-og-status-idle/10",
    pulse: false,
  },
  requires_action: {
    label: "Waiting on you",
    dotClassName: "bg-og-status-waiting",
    badgeClassName: "text-og-status-waiting border-og-status-waiting/35 bg-og-status-waiting/10",
    pulse: true,
  },
  failed: {
    label: "Failed",
    dotClassName: "bg-og-status-failed",
    badgeClassName: "text-og-status-failed border-og-status-failed/35 bg-og-status-failed/10",
    pulse: false,
  },
  cancelled: {
    label: "Cancelled",
    dotClassName: "bg-og-status-cancelled",
    badgeClassName: "text-og-fg-subtle border-og-border bg-og-status-cancelled/10",
    pulse: false,
  },
};

export type SessionStatusProps = {
  status: SessionStatusValue;
  /** Override the label ("Running" -> "Deploying", ...). */
  label?: string | undefined;
  size?: "sm" | "md" | undefined;
  className?: string | undefined;
};

/** Status badge with a breathing dot for live states. */
export function SessionStatus({ status, label, size = "md", className }: SessionStatusProps) {
  const meta = SESSION_STATUS_META[status];
  return (
    <span
      data-status={status}
      className={cn(
        "og-root inline-flex shrink-0 items-center rounded-full border font-medium",
        size === "sm" ? "gap-1 px-1.5 py-px text-og-xs" : "gap-1.5 px-2 py-0.5 text-xs",
        meta.badgeClassName,
        className,
      )}
    >
      <StatusDot status={status} className={size === "sm" ? "size-1" : "size-1.5"} />
      {label ?? meta.label}
    </span>
  );
}

export type StatusDotProps = {
  status: SessionStatusValue;
  className?: string | undefined;
};

/** Just the dot — for dense rows and tiles. */
export function StatusDot({ status, className }: StatusDotProps) {
  const meta = SESSION_STATUS_META[status];
  return (
    <span
      className={cn(
        "relative inline-flex size-1.5 shrink-0 rounded-full",
        meta.dotClassName,
        className,
      )}
    >
      {meta.pulse ? (
        <span className={cn("absolute inset-0 animate-og-pulse rounded-full", meta.dotClassName)} />
      ) : null}
    </span>
  );
}
