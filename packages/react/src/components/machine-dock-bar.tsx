import { LaptopIcon, CpuIcon, UsersIcon } from "lucide-react";
import { cn } from "../lib/cn";
import type { MachineKind, MachineState } from "../types/machines";
import { ConnectionStatusPill, MACHINE_STATE_BADGE_META } from "./machine-status-pill";
import { connectionStatusForState } from "../types/machines";

export type MachineDockBarProps = {
  /** The active machine's display name. */
  name: string;
  kind: MachineKind;
  state: MachineState;
  /** Live sessions sharing this whole-machine lease (>1 ⇒ shared disclosure). */
  sharedSessionCount?: number | undefined;
  className?: string | undefined;
};

/**
 * A slim bar that surfaces WHICH machine the dock surfaces (Files/Terminal/
 * Desktop) are bound to + its connection status. Mounted above the dock tabs so
 * the user always knows whether they are looking at the Modal box or their own
 * machine, and whether it is online / reconnecting / offline. The surfaces below
 * render IDENTICALLY regardless of backend — this bar is the only backend-aware
 * chrome (the dock-parity contract: selfhosted == Modal for the surfaces).
 */
export function MachineDockBar({ name, kind, state, className }: MachineDockBarProps) {
  const Icon = kind === "selfhosted" ? LaptopIcon : CpuIcon;
  const stateBadge = MACHINE_STATE_BADGE_META[state];
  return (
    <div
      data-machine-dock-bar
      className={cn(
        "flex shrink-0 items-center justify-between gap-2 border-b border-og-border bg-og-surface-1 px-2.5 py-1",
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <Icon className="size-3.5 shrink-0 text-og-fg-subtle" aria-hidden />
        <span className="truncate text-[11px] font-medium text-og-fg">{name}</span>
        {stateBadge ? (
          <span
            data-state-badge={state}
            className={cn(
              "shrink-0 rounded-full border px-1.5 py-px text-[10px] font-medium",
              stateBadge.badgeClassName,
            )}
          >
            {stateBadge.label}
          </span>
        ) : null}
      </div>
      <ConnectionStatusPill
        status={connectionStatusForState(state)}
        size="sm"
        className="shrink-0"
      />
    </div>
  );
}

export type SharedMachineDisclosureProps = {
  sharedSessionCount: number;
  /** Compact (inline strip) vs full (a notice block). */
  density?: "compact" | "full" | undefined;
  className?: string | undefined;
};

/**
 * The "shared — another session is on this machine" disclosure. Surfaced in the
 * dock (and reused on the desktop take-control gate) so the user knows others are
 * driving the same whole-machine lease. Render when `sharedSessionCount > 1`.
 */
export function SharedMachineDisclosure({
  sharedSessionCount,
  density = "compact",
  className,
}: SharedMachineDisclosureProps) {
  const others = Math.max(0, sharedSessionCount - 1);
  return (
    <div
      data-shared-disclosure
      className={cn(
        "flex items-center gap-1.5 border-og-accent/25 bg-og-accent-soft text-og-fg-muted",
        density === "full"
          ? "rounded-og-md border px-3 py-2 text-[12px]"
          : "border-b px-2.5 py-1 text-[11px]",
        className,
      )}
    >
      <UsersIcon className="size-3.5 shrink-0 text-og-accent" aria-hidden />
      <span>
        Shared — {others === 1 ? "another session is" : `${others} other sessions are`} on this
        machine. They see the same terminal, files, and desktop.
      </span>
    </div>
  );
}
