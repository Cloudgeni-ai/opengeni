import { cn } from "../lib/cn";
import {
  type ConnectionStatus,
  connectionStatusForState,
  type MachineState,
} from "../types/machines";

export type ConnectionStatusMeta = {
  label: string;
  dotClassName: string;
  badgeClassName: string;
  /** Live/transient states breathe; settled states hold still. */
  pulse: boolean;
};

/** Token-backed meta for the three connection-status pill values. */
export const CONNECTION_STATUS_META: Record<ConnectionStatus, ConnectionStatusMeta> = {
  online: {
    label: "Online",
    dotClassName: "bg-og-status-running",
    badgeClassName: "text-og-status-running border-og-status-running/30 bg-og-status-running/10",
    pulse: false,
  },
  reconnecting: {
    label: "Reconnecting",
    dotClassName: "bg-og-status-waiting",
    badgeClassName: "text-og-status-waiting border-og-status-waiting/35 bg-og-status-waiting/10",
    pulse: true,
  },
  offline: {
    label: "Offline",
    dotClassName: "bg-og-status-failed",
    badgeClassName: "text-og-fg-subtle border-og-border bg-og-status-failed/10",
    pulse: false,
  },
};

export type MachineStateBadgeMeta = {
  label: string;
  badgeClassName: string;
};

/**
 * The non-connection state badges that ride ALONGSIDE the connection pill —
 * `consent_required` / `display_unavailable` / `enrolling` describe a capability
 * limitation, not reachability, so they render as their own tinted chip.
 */
export const MACHINE_STATE_BADGE_META: Partial<Record<MachineState, MachineStateBadgeMeta>> = {
  consent_required: {
    label: "Consent required",
    badgeClassName: "text-og-status-waiting border-og-status-waiting/35 bg-og-status-waiting/10",
  },
  display_unavailable: {
    label: "No display",
    badgeClassName: "text-og-fg-muted border-og-border bg-og-surface-2",
  },
  enrolling: {
    label: "Enrolling",
    badgeClassName: "text-og-accent border-og-accent/30 bg-og-accent-soft",
  },
};

export type ConnectionStatusPillProps = {
  status: ConnectionStatus;
  /** Override the label ("Online" -> "Connected", ...). */
  label?: string | undefined;
  size?: "sm" | "md" | undefined;
  className?: string | undefined;
};

/**
 * The connection-status pill (online / reconnecting / offline) surfaced across
 * the Machines dashboard, the dock header, and the session timeline. Reconnecting
 * breathes (the resiliency-as-headline blip), online/offline hold still.
 */
export function ConnectionStatusPill({ status, label, size = "md", className }: ConnectionStatusPillProps) {
  const meta = CONNECTION_STATUS_META[status];
  return (
    <span
      data-connection-status={status}
      className={cn(
        "og-root inline-flex shrink-0 items-center rounded-full border font-medium",
        size === "sm" ? "gap-1 px-1.5 py-px text-[10px]" : "gap-1.5 px-2 py-0.5 text-xs",
        meta.badgeClassName,
        className,
      )}
    >
      <ConnectionDot status={status} className={size === "sm" ? "size-1" : "size-1.5"} />
      {label ?? meta.label}
    </span>
  );
}

export type ConnectionDotProps = {
  status: ConnectionStatus;
  className?: string | undefined;
};

/** Just the dot — for dense rows, the dock header, and timeline notices. */
export function ConnectionDot({ status, className }: ConnectionDotProps) {
  const meta = CONNECTION_STATUS_META[status];
  return (
    <span className={cn("relative inline-flex size-1.5 shrink-0 rounded-full", meta.dotClassName, className)}>
      {meta.pulse ? <span className={cn("absolute inset-0 animate-og-pulse rounded-full", meta.dotClassName)} /> : null}
    </span>
  );
}

export type MachineStatusPillProps = {
  /** The machine's full state — drives the connection pill + any state badge. */
  state: MachineState;
  /** How many live sessions share this lease (renders a "Shared" chip when >1). */
  sharedSessionCount?: number | undefined;
  size?: "sm" | "md" | undefined;
  className?: string | undefined;
};

/**
 * The composite machine status surface: the connection pill PLUS any
 * consent/display/enrolling badge PLUS a shared-in-use chip. One component the
 * dashboard row, the dock header, and the timeline all reuse so the status
 * language is identical everywhere.
 */
export function MachineStatusPill({ state, sharedSessionCount, size = "md", className }: MachineStatusPillProps) {
  const stateBadge = MACHINE_STATE_BADGE_META[state];
  const shared = (sharedSessionCount ?? 0) > 1;
  return (
    <span className={cn("og-root inline-flex flex-wrap items-center gap-1", className)} data-machine-state={state}>
      <ConnectionStatusPill status={connectionStatusForState(state)} size={size} />
      {stateBadge ? (
        <span
          data-state-badge={state}
          className={cn(
            "inline-flex shrink-0 items-center rounded-full border font-medium",
            size === "sm" ? "px-1.5 py-px text-[10px]" : "px-2 py-0.5 text-xs",
            stateBadge.badgeClassName,
          )}
        >
          {stateBadge.label}
        </span>
      ) : null}
      {shared ? (
        <span
          data-shared-chip
          className={cn(
            "inline-flex shrink-0 items-center gap-1 rounded-full border font-medium",
            "text-og-accent border-og-accent/30 bg-og-accent-soft",
            size === "sm" ? "px-1.5 py-px text-[10px]" : "px-2 py-0.5 text-xs",
          )}
          title={`${sharedSessionCount} sessions are on this machine`}
        >
          Shared · {sharedSessionCount}
        </span>
      ) : null}
    </span>
  );
}
