import {
  CpuIcon,
  LaptopIcon,
  MonitorIcon,
  MonitorOffIcon,
  ServerIcon,
  UsersIcon,
} from "lucide-react";
import { cn } from "../lib/cn";
import { formatRelativeTime } from "../lib/format";
import type { MachineView } from "../types/machines";
import { MachineMetrics } from "./machine-metrics";
import { MachineStatusPill } from "./machine-status-pill";

export type MachineCardProps = {
  machine: MachineView;
  /** Attach/swap the session's active sandbox to this machine. */
  onAttach?: ((machine: MachineView) => void) | undefined;
  /** Whether an attach/swap is currently in flight (disables the affordance). */
  attaching?: boolean | undefined;
  className?: string | undefined;
};

function KindIcon({ machine }: { machine: MachineView }) {
  if (machine.isSessionGroup) return <ServerIcon className="size-4 text-og-fg-subtle" aria-hidden />;
  if (machine.kind === "modal") return <CpuIcon className="size-4 text-og-fg-subtle" aria-hidden />;
  return <LaptopIcon className="size-4 text-og-fg-subtle" aria-hidden />;
}

/**
 * One machine in the Machines dashboard: name + kind + OS/arch, the composite
 * connection/state/shared status, latest resource meters, last-seen recency, and
 * an attach/swap affordance. The session's currently-active sandbox carries an
 * accent edge + an "Active" marker (never an attach button — it's already active).
 */
export function MachineCard({ machine, onAttach, attaching, className }: MachineCardProps) {
  const offline = machine.state === "offline";
  const attachable = !machine.active && !offline && Boolean(onAttach);
  const shared = machine.sharedSessionCount > 1;

  return (
    <div
      data-machine-card={machine.sandboxId}
      data-active={machine.active ? "true" : "false"}
      className={cn(
        "og-root relative flex flex-col gap-3 overflow-hidden rounded-og-lg border border-og-border",
        "bg-og-surface-1 p-4 shadow-og-sm",
        machine.active && "border-og-accent/40",
        className,
      )}
    >
      {machine.active ? (
        <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-og-accent" />
      ) : null}

      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="mt-0.5 shrink-0">
            <KindIcon machine={machine} />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium text-og-fg">{machine.name}</span>
              {machine.active ? (
                <span
                  data-active-marker
                  className="shrink-0 rounded-full border border-og-accent/30 bg-og-accent-soft px-1.5 py-px text-[10px] font-medium text-og-accent"
                >
                  Active
                </span>
              ) : null}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-og-fg-subtle">
              <span className="capitalize">{machine.isSessionGroup ? "session sandbox" : machine.kind}</span>
              <span aria-hidden>·</span>
              <span className="font-og-mono">
                {machine.os}/{machine.arch}
              </span>
              <span aria-hidden>·</span>
              <span className="inline-flex items-center gap-1">
                {machine.hasDisplay ? (
                  <MonitorIcon className="size-3" aria-hidden />
                ) : (
                  <MonitorOffIcon className="size-3" aria-hidden />
                )}
                {machine.hasDisplay ? "display" : "headless"}
              </span>
            </div>
          </div>
        </div>
        <MachineStatusPill state={machine.state} sharedSessionCount={machine.sharedSessionCount} size="sm" className="shrink-0" />
      </div>

      {shared ? (
        <p
          data-shared-disclosure
          className="flex items-center gap-1.5 rounded-og-md border border-og-accent/25 bg-og-accent-soft px-2.5 py-1.5 text-[11px] text-og-fg-muted"
        >
          <UsersIcon className="size-3.5 shrink-0 text-og-accent" aria-hidden />
          Shared — {machine.sharedSessionCount} sessions are on this machine.
        </p>
      ) : null}

      <MachineMetrics metrics={machine.metrics} />

      <div className="mt-1 flex items-center justify-between gap-3 text-[11px] text-og-fg-subtle">
        <span>
          {machine.lastSeenAt ? <>Last seen {formatRelativeTime(machine.lastSeenAt)}</> : "Never connected"}
        </span>
        {machine.active ? (
          <span className="text-og-accent">Routing here</span>
        ) : attachable ? (
          <button
            type="button"
            data-attach
            disabled={attaching}
            onClick={() => onAttach?.(machine)}
            className={cn(
              "rounded-og-sm border border-og-border px-2.5 py-1 text-[11px] font-medium text-og-fg-muted transition-colors",
              "hover:border-og-border-strong hover:text-og-fg disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            {attaching ? "Switching…" : "Attach"}
          </button>
        ) : (
          <span className="text-og-fg-subtle/70">{offline ? "Unavailable" : "—"}</span>
        )}
      </div>
    </div>
  );
}
