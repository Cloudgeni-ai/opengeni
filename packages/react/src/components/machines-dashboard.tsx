import { type ReactNode } from "react";
import { LaptopIcon, PlusIcon, RefreshCwIcon } from "lucide-react";
import { cn } from "../lib/cn";
import type { MachineView } from "../types/machines";
import { MachineCard } from "./machine-card";

export type MachinesDashboardProps = {
  machines: MachineView[];
  /** The session's active sandbox id (drives the per-card "Active" marker). */
  activeSandboxId?: string | null | undefined;
  loading?: boolean | undefined;
  error?: Error | null | undefined;
  /** Attach/swap the session's active sandbox to a machine. */
  onAttach?: ((machine: MachineView) => void) | undefined;
  /** The sandbox id currently being attached/swapped to (disables that card). */
  attachingSandboxId?: string | null | undefined;
  /** Open the enrollment flow (the "Enroll a machine" CTA). */
  onEnroll?: (() => void) | undefined;
  onRefresh?: (() => void) | undefined;
  className?: string | undefined;
};

function EmptyState({ onEnroll }: { onEnroll?: (() => void) | undefined }) {
  return (
    <div
      data-machines-empty
      className="flex flex-col items-center justify-center gap-3 rounded-og-lg border border-dashed border-og-border bg-og-surface-1 px-6 py-12 text-center"
    >
      <span className="flex size-10 items-center justify-center rounded-full bg-og-surface-2 text-og-fg-subtle">
        <LaptopIcon className="size-5" aria-hidden />
      </span>
      <div className="space-y-1">
        <p className="text-og-base font-medium text-og-fg">No machines yet</p>
        <p className="max-w-xs text-og-sm text-og-fg-muted">
          Enroll your own computer to run the agent on it — your files, your terminal, your desktop.
        </p>
      </div>
      {onEnroll ? (
        <button
          type="button"
          data-enroll-cta
          onClick={onEnroll}
          className="inline-flex items-center gap-1.5 rounded-og-sm bg-og-accent px-3 py-1.5 text-og-sm font-medium text-og-accent-fg transition-colors hover:bg-og-accent-strong pointer-coarse:min-h-10"
        >
          <PlusIcon className="size-3.5" aria-hidden />
          Enroll a machine
        </button>
      ) : null}
    </div>
  );
}

function Header({
  count,
  onEnroll,
  onRefresh,
  loading,
}: {
  count: number;
  onEnroll?: (() => void) | undefined;
  onRefresh?: (() => void) | undefined;
  loading?: boolean | undefined;
}): ReactNode {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-baseline gap-2">
        <h2 className="text-og-base font-semibold text-og-fg">Machines</h2>
        <span className="font-og-mono text-og-xs text-og-fg-subtle">{count}</span>
      </div>
      <div className="flex items-center gap-1.5">
        {onRefresh ? (
          <button
            type="button"
            data-refresh
            onClick={onRefresh}
            title="Refresh"
            className="rounded-og-sm p-1.5 text-og-fg-subtle transition-colors hover:bg-og-surface-2 hover:text-og-fg"
          >
            <RefreshCwIcon className={cn("size-3.5", loading && "animate-og-spin")} aria-hidden />
          </button>
        ) : null}
        {onEnroll ? (
          <button
            type="button"
            data-enroll-cta
            onClick={onEnroll}
            className="inline-flex items-center gap-1.5 rounded-og-sm border border-og-border px-2.5 py-1 text-og-sm font-medium text-og-fg-muted transition-colors hover:border-og-border-strong hover:text-og-fg pointer-coarse:min-h-10"
          >
            <PlusIcon className="size-3.5" aria-hidden />
            Enroll machine
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The workspace Machines dashboard: the fleet of selfhosted enrollments + the
 * session's managed sandbox, each with its connection-status pill, state badges,
 * latest metrics, and an attach/swap affordance. Renders the empty state (no
 * machines → enroll CTA), a load error, and the populated grid. The component
 * is purely presentational — feed it `MachinesResponse` data via `useMachines`.
 */
export function MachinesDashboard({
  machines,
  activeSandboxId,
  loading,
  error,
  onAttach,
  attachingSandboxId,
  onEnroll,
  onRefresh,
  className,
}: MachinesDashboardProps) {
  const isEmpty = !loading && !error && machines.length === 0;

  return (
    <section data-machines-dashboard className={cn("og-root flex flex-col gap-3", className)}>
      <Header count={machines.length} onEnroll={onEnroll} onRefresh={onRefresh} loading={loading} />

      {error ? (
        <div
          data-machines-error
          className="flex flex-wrap items-center justify-between gap-2 rounded-og-md border border-og-status-failed/30 bg-og-status-failed/10 px-3 py-2 text-og-sm text-og-status-failed"
        >
          <span>Could not load machines: {error.message}</span>
          {onRefresh ? (
            <button
              type="button"
              data-machines-retry
              onClick={onRefresh}
              disabled={loading}
              className="inline-flex items-center gap-1.5 rounded-og-sm border border-og-status-failed/30 px-2 py-1 text-og-xs font-medium transition-colors hover:border-og-status-failed/50 disabled:cursor-not-allowed disabled:opacity-60 pointer-coarse:min-h-10"
            >
              <RefreshCwIcon className={cn("size-3.5", loading && "animate-og-spin")} aria-hidden />
              {loading ? "Retrying…" : "Retry"}
            </button>
          ) : null}
        </div>
      ) : null}

      {loading && machines.length === 0 ? (
        <div data-machines-loading className="grid gap-3 sm:grid-cols-2">
          {[0, 1].map((i) => (
            <div key={i} className="h-36 animate-og-pulse rounded-og-lg border border-og-border bg-og-surface-1" />
          ))}
        </div>
      ) : isEmpty ? (
        <EmptyState onEnroll={onEnroll} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-machines-grid>
          {machines.map((machine) => (
            <MachineCard
              key={machine.sandboxId}
              machine={{ ...machine, active: machine.active || machine.sandboxId === activeSandboxId }}
              onAttach={onAttach}
              attaching={attachingSandboxId === machine.sandboxId}
            />
          ))}
        </div>
      )}
    </section>
  );
}
