import {
  AlertTriangleIcon,
  ArrowRightIcon,
  CpuIcon,
  CircleCheckIcon,
  DownloadIcon,
  LaptopIcon,
  MonitorIcon,
  MonitorOffIcon,
  LoaderCircleIcon,
  ServerIcon,
  UsersIcon,
} from "lucide-react";
import { cn } from "../lib/cn";
import { formatRelativeTime } from "../lib/format";
import type { MachineView, MetricSample } from "../types/machines";
import { MachineHealthPill } from "./machine-health-pill";
import { MachineMetrics } from "./machine-metrics";
import { MetricSparkline } from "./machines/metric-sparkline";

export type MachineCardProps = {
  machine: MachineView;
  /** Attach/swap the session's active sandbox to this machine. */
  onAttach?: ((machine: MachineView) => void) | undefined;
  /** Whether an attach/swap is currently in flight (disables the affordance). */
  attaching?: boolean | undefined;
  /** Start/retry the exact signed Connected Machine agent update. */
  onUpdateAgent?: ((machine: MachineView) => void) | undefined;
  updatingAgent?: boolean | undefined;
  /** Short recent history (e.g. 15m) — drives the card's CPU trend + preview. */
  series?: MetricSample[] | undefined;
  /** Open the full per-machine telemetry detail. Makes the whole card actionable. */
  onOpenDetail?: ((machine: MachineView) => void) | undefined;
  now?: number | undefined;
  className?: string | undefined;
};

function KindIcon({ machine }: { machine: MachineView }) {
  if (machine.isSessionGroup)
    return <ServerIcon className="size-4 text-og-fg-subtle" aria-hidden />;
  if (machine.kind === "modal") return <CpuIcon className="size-4 text-og-fg-subtle" aria-hidden />;
  return <LaptopIcon className="size-4 text-og-fg-subtle" aria-hidden />;
}

/**
 * One machine in the Machines dashboard: name + kind + OS/arch, the fused HEALTH
 * verdict, latest resource meters, a CPU trend that previews the history, live
 * freshness, and attach/swap. The whole card opens the telemetry detail when
 * `onOpenDetail` is wired. The session's active sandbox carries an accent edge.
 */
export function MachineCard({
  machine,
  onAttach,
  attaching,
  onUpdateAgent,
  updatingAgent,
  series,
  onOpenDetail,
  now,
  className,
}: MachineCardProps) {
  const offline = machine.state === "offline";
  const attachable = !machine.active && !offline && Boolean(onAttach);
  const shared = machine.sharedSessionCount > 1;
  const clockNow = now ?? Date.now();
  const sampledAgo = machine.metrics
    ? formatRelativeTime(machine.metrics.sampledAt, new Date(clockNow))
    : null;
  const cpuPts = (series ?? []).map((s) => ({ t: new Date(s.sampledAt).getTime(), v: s.cpuPct }));
  const openable = Boolean(onOpenDetail);
  const runtime = machine.runtime;
  const updateRunning = runtime?.versionState === "updating";
  const dispatchConfirmationStalled =
    runtime?.update?.status === "requested" &&
    clockNow - new Date(runtime.update.updatedAt).getTime() >= 30_000;
  const canUpdate =
    Boolean(machine.enrollmentId && onUpdateAgent) &&
    !offline &&
    (runtime?.versionState === "outdated" ||
      runtime?.versionState === "update_failed" ||
      dispatchConfirmationStalled);
  const updateLabel = (() => {
    const update = runtime?.update;
    if (!update) return null;
    switch (update.status) {
      case "requested":
        return dispatchConfirmationStalled
          ? "Agent confirmation delayed"
          : "Confirming with agent";
      case "accepted":
        return "Update accepted";
      case "waiting_for_idle":
        return "Waiting for current work";
      case "downloading":
      case "verifying":
      case "applying":
        return `${update.status}…`;
      case "restarting":
        return "Restarting agent";
      case "succeeded":
        return `Updated · v${update.targetVersion}`;
      case "failed": {
        const detail = update.errorCode?.replaceAll("_", " ");
        return update.rolledBack
          ? `Update rolled back safely${detail ? ` · ${detail}` : ""}`
          : `Update failed${detail ? ` · ${detail}` : ""}`;
      }
    }
  })();

  return (
    <div
      data-machine-card={machine.sandboxId}
      data-active={machine.active ? "true" : "false"}
      role={openable ? "button" : undefined}
      tabIndex={openable ? 0 : undefined}
      onClick={openable ? () => onOpenDetail?.(machine) : undefined}
      onKeyDown={
        openable
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onOpenDetail?.(machine);
              }
            }
          : undefined
      }
      className={cn(
        "og-root group relative flex flex-col gap-3 overflow-hidden rounded-og-lg border border-og-border",
        "bg-og-surface-1 p-4 shadow-og-sm transition-colors",
        openable &&
          "cursor-pointer hover:border-og-border-strong focus-visible:border-og-accent/60 focus-visible:outline-hidden",
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
              <span className="truncate text-og-base font-medium text-og-fg">{machine.name}</span>
              {machine.active ? (
                <span
                  data-active-marker
                  className="shrink-0 rounded-full border border-og-accent/30 bg-og-accent-soft px-1.5 py-px text-og-xs font-medium text-og-accent"
                >
                  Active
                </span>
              ) : null}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-og-xs text-og-fg-subtle">
              <span className="capitalize">
                {machine.isSessionGroup ? "session sandbox" : machine.kind}
              </span>
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
        <MachineHealthPill
          state={machine.state}
          metrics={machine.metrics}
          now={clockNow}
          size="sm"
          className="shrink-0"
        />
      </div>

      {shared ? (
        <p
          data-shared-disclosure
          className="flex items-center gap-1.5 rounded-og-md border border-og-accent/25 bg-og-accent-soft px-2.5 py-1.5 text-og-xs text-og-fg-muted"
        >
          <UsersIcon className="size-3.5 shrink-0 text-og-accent" aria-hidden />
          Shared — {machine.sharedSessionCount} sessions are on this machine.
        </p>
      ) : null}

      {machine.connectionAuthority.duplicateRunnerDeniedCount > 0 ? (
        <p
          data-runner-conflict
          className="flex items-center gap-1.5 rounded-og-md border border-og-status-failed/30 bg-og-status-failed/5 px-2.5 py-1.5 text-og-xs text-og-status-failed"
        >
          <AlertTriangleIcon className="size-3.5 shrink-0" aria-hidden />
          Competing agent process blocked. Open diagnostics for details.
        </p>
      ) : null}

      {runtime ? (
        <div
          data-agent-runtime
          className="flex items-center justify-between gap-3 rounded-og-md border border-og-border/70 bg-og-surface-2/35 px-2.5 py-2 text-og-xs"
        >
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-og-fg-muted">
              {runtime.versionState === "current" ? (
                <CircleCheckIcon className="size-3.5 text-og-status-idle" aria-hidden />
              ) : updateRunning ? (
                <LoaderCircleIcon className="size-3.5 animate-og-spin text-og-accent" aria-hidden />
              ) : (
                <DownloadIcon className="size-3.5" aria-hidden />
              )}
              <span className="truncate">
                Agent{" "}
                {runtime.installedVersion ? `v${runtime.installedVersion}` : "version unknown"}
              </span>
            </div>
            <p className="mt-0.5 truncate text-og-fg-subtle">
              {updateLabel ??
                (runtime.versionState === "current"
                  ? `Current · ${runtime.updateChannel ?? "channel unknown"}`
                  : runtime.desiredVersion
                    ? `Promoted v${runtime.desiredVersion}`
                    : "No promoted version configured")}
            </p>
          </div>
          {canUpdate ? (
            <button
              type="button"
              data-update-agent
              disabled={updatingAgent}
              onClick={(event) => {
                event.stopPropagation();
                onUpdateAgent?.(machine);
              }}
              className="shrink-0 rounded-og-sm border border-og-border px-2 py-1 font-medium text-og-fg-muted transition-colors hover:border-og-border-strong hover:text-og-fg disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:min-h-11"
            >
              {updatingAgent
                ? "Starting…"
                : dispatchConfirmationStalled
                  ? "Retry delivery"
                  : runtime.versionState === "update_failed"
                    ? "Retry"
                    : "Update"}
            </button>
          ) : null}
        </div>
      ) : null}

      <MachineMetrics metrics={machine.metrics} />

      {/* CPU trend — previews the history and invites opening the detail. */}
      {cpuPts.length > 1 ? (
        <div className="flex flex-col gap-1 rounded-og-md bg-og-surface-2/40 p-2.5">
          <div className="flex items-center justify-between text-[10px] font-medium uppercase tracking-wide text-og-fg-subtle">
            <span>CPU · last 15m</span>
            {openable ? (
              <span className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                Telemetry <ArrowRightIcon className="size-2.5" aria-hidden />
              </span>
            ) : null}
          </div>
          <MetricSparkline points={cpuPts} color="var(--og-color-accent)" yMax={100} height={26} />
        </div>
      ) : null}

      <div className="mt-1 flex items-center justify-between gap-3 text-og-xs text-og-fg-subtle">
        <span className="inline-flex items-center gap-1.5">
          {sampledAgo ? (
            <>
              <span
                className={cn(
                  "size-1.5 rounded-full",
                  sampledAgo === "now" ? "bg-og-status-idle" : "bg-og-fg-subtle",
                )}
                aria-hidden
              />
              {sampledAgo === "now" ? "Live" : `Updated ${sampledAgo} ago`}
            </>
          ) : machine.lastSeenAt ? (
            <>Last seen {formatRelativeTime(machine.lastSeenAt, new Date(clockNow))}</>
          ) : (
            "Never connected"
          )}
        </span>
        {machine.active ? (
          <span className="text-og-accent">Routing here</span>
        ) : attachable ? (
          <button
            type="button"
            data-attach
            disabled={attaching}
            onClick={(e) => {
              e.stopPropagation();
              onAttach?.(machine);
            }}
            className={cn(
              "rounded-og-sm border border-og-border px-2.5 py-1 text-og-xs font-medium text-og-fg-muted transition-colors pointer-coarse:min-h-11",
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
