// ----------------------------------------------------------------------------
// MachineDetail — the marquee per-machine telemetry view.
//
// Opens from a machine card. Answers, at a glance and then in depth: is this
// machine healthy right now (one fused verdict), what are its live numbers, and
// how have they moved over the chosen window. Built entirely on the existing
// `og-*` token system — no new visual language, just the missing depth.
// ----------------------------------------------------------------------------
import {
  ArrowLeftIcon,
  BuildingIcon,
  ChevronRightIcon,
  CpuIcon,
  LaptopIcon,
  PlugIcon,
  RadioIcon,
  ServerIcon,
  TriangleAlertIcon,
  Trash2Icon,
  UserIcon,
  UsersIcon,
} from "lucide-react";
import { cn } from "../../lib/cn";
import { formatRelativeTime } from "../../lib/format";
import type { MachineView, MetricSample } from "../../types/machines";
import { AgentStatusIcon } from "./agent-status-icon";
import { deriveHealth, HEALTH_TOKEN, healthPulses } from "./health";
import {
  describeAgentConnection,
  describeAgentRuntime,
  runnerConflict,
  STATUS_TONE_TEXT,
} from "./machine-status";
import { MetricHistoryChart } from "./metric-history-chart";
import { MetricSparkline } from "./metric-sparkline";
import { METRICS, METRIC_WINDOWS, pointsFor, WINDOW_LABEL, type MetricWindow } from "./series";
import { MachineOperationPolicyEditor } from "./machine-operation-policy";
import type { UpdateMachineOperationPolicyRequest } from "@opengeni/sdk";

export type MachineDetailProps = {
  machine: MachineView;
  /** Downsampled history for the active window (from `fetchSeries`). */
  series: MetricSample[];
  window: MetricWindow;
  onWindowChange: (w: MetricWindow) => void;
  loadingSeries?: boolean | undefined;
  onBack?: (() => void) | undefined;
  /** Open the workspace-admin removal confirmation for a self-hosted machine. */
  onRemove?: ((machine: MachineView) => void) | undefined;
  onUpdateOperationPolicy?:
    | ((machine: MachineView, request: UpdateMachineOperationPolicyRequest) => Promise<unknown>)
    | undefined;
  updatingOperationPolicy?: boolean | undefined;
  /** Open "Who can use it?" for a connected machine. Omit when the viewer
   * can't change it; the row then shows the current audience read-only. */
  onChangeAudience?: ((machine: MachineView) => void) | undefined;
  /** Start, retry or resend the signed agent update. Omit when the viewer can't. */
  onUpdateAgent?: ((machine: MachineView) => void) | undefined;
  updatingAgent?: boolean | undefined;
  now?: number | undefined;
  className?: string | undefined;
};

const AUDIENCE: Record<
  MachineView["scope"],
  { label: string; description: string; Icon: typeof UserIcon }
> = {
  user: { label: "Only me", description: "Only its owner can run chats on it.", Icon: UserIcon },
  workspace: {
    label: "This workspace",
    description: "Everyone in this workspace can run chats on it.",
    Icon: UsersIcon,
  },
  organization: {
    label: "Whole organization",
    description: "Every workspace in the organization can use it.",
    Icon: BuildingIcon,
  },
};

/** Who can use a connected machine. A navigational row when it can change. */
function MachineAudienceRow({
  machine,
  onChange,
}: {
  machine: MachineView;
  onChange?: ((machine: MachineView) => void) | undefined;
}) {
  const audience = AUDIENCE[machine.scope];
  const changeable = onChange !== undefined && machine.scope !== "organization";
  const content = (
    <>
      <audience.Icon className="size-4 shrink-0 text-og-fg-subtle" aria-hidden />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
        <span className="text-og-sm font-medium text-og-fg">Who can use it?</span>
        <span className="text-og-xs text-og-fg-muted">{audience.description}</span>
      </span>
      <span className="shrink-0 text-og-sm text-og-fg-muted">{audience.label}</span>
      {changeable ? (
        <ChevronRightIcon className="size-4 shrink-0 text-og-fg-subtle" aria-hidden />
      ) : null}
    </>
  );
  const frame =
    "flex w-full min-h-14 items-center gap-3 rounded-og-lg border border-og-border bg-og-surface-1 px-4 py-3 shadow-og-sm";
  return changeable ? (
    <button
      type="button"
      data-machine-audience={machine.scope}
      onClick={() => onChange(machine)}
      aria-label={`Who can use ${machine.name}: ${audience.label}. Change`}
      className={cn(
        frame,
        "transition-colors hover:bg-og-surface-2 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-og-accent/50",
      )}
    >
      {content}
    </button>
  ) : (
    <div data-machine-audience={machine.scope} className={frame}>
      {content}
    </div>
  );
}

function KindIcon({ kind, session }: { kind: string; session: boolean }) {
  if (kind === "local" || kind === "selfhosted")
    return <LaptopIcon className="size-4 text-og-fg-subtle" aria-hidden />;
  if (kind === "docker" || session)
    return <ServerIcon className="size-4 text-og-fg-subtle" aria-hidden />;
  if (kind === "modal") return <CpuIcon className="size-4 text-og-fg-subtle" aria-hidden />;
  return <ServerIcon className="size-4 text-og-fg-subtle" aria-hidden />;
}

/**
 * The connected agent: its build and update on one row, its connection on the
 * next. Past events read as quiet history; only a live problem gets a color.
 */
function MachineAgentPanel({
  machine,
  now,
  onUpdateAgent,
  updatingAgent,
}: {
  machine: MachineView;
  now: number;
  onUpdateAgent?: ((machine: MachineView) => void) | undefined;
  updatingAgent?: boolean | undefined;
}) {
  const authority = machine.connectionAuthority;
  const runtime = machine.runtime;
  if (!runtime && authority.state === "not_applicable") return null;
  const agent = runtime ? describeAgentRuntime(runtime, now) : null;
  const action =
    agent?.action && machine.enrollmentId && onUpdateAgent && machine.state !== "offline"
      ? agent.action
      : null;
  const connection =
    authority.state === "not_applicable" ? null : describeAgentConnection(authority);
  const conflict = runnerConflict(authority, now);
  const conflictAgo = conflict?.lastAt ? formatRelativeTime(conflict.lastAt, new Date(now)) : null;

  return (
    <section
      data-machine-agent
      aria-label="Agent"
      className="flex flex-col divide-y divide-og-border rounded-og-lg border border-og-border bg-og-surface-1 shadow-og-sm"
    >
      {agent ? (
        <div data-agent-runtime className="flex min-h-14 items-center gap-3 px-4 py-3">
          <AgentStatusIcon tone={agent.tone} className="size-4" />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-og-sm font-medium text-og-fg">{agent.title}</span>
            <span
              data-agent-status={agent.tone}
              className={cn("text-og-xs", STATUS_TONE_TEXT[agent.tone])}
            >
              {agent.status}
            </span>
            {agent.note ? <span className="text-og-xs text-og-fg-muted">{agent.note}</span> : null}
          </div>
          {action ? (
            <button
              type="button"
              data-update-agent
              data-update-action={action.kind}
              disabled={updatingAgent}
              onClick={() => onUpdateAgent?.(machine)}
              className="inline-flex min-h-9 shrink-0 items-center rounded-og-sm border border-og-border px-3 py-1 text-og-xs font-medium text-og-fg-muted transition-colors hover:border-og-border-strong hover:text-og-fg focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-og-accent/50 disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:min-h-11"
            >
              {updatingAgent ? "Starting…" : action.label}
            </button>
          ) : null}
        </div>
      ) : null}
      {connection ? (
        <div
          data-connection-authority={authority.state}
          className="flex min-h-14 items-start gap-3 px-4 py-3"
        >
          <PlugIcon className="mt-0.5 size-4 shrink-0 text-og-fg-subtle" aria-hidden />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-og-sm font-medium text-og-fg">{connection.label}</span>
            {connection.detail ? (
              <span className="text-og-xs text-og-fg-muted">{connection.detail}</span>
            ) : null}
            {conflict?.active ? (
              <span
                data-runner-conflict="active"
                className="mt-1 flex items-start gap-1.5 text-og-xs text-og-fg-muted"
              >
                <TriangleAlertIcon
                  className="mt-px size-3.5 shrink-0 text-og-status-waiting"
                  aria-hidden
                />
                A second copy of the agent is running on this machine. It's kept out, so work isn't
                affected. Stop the extra copy.
              </span>
            ) : conflict ? (
              <span data-runner-conflict="past" className="text-og-xs text-og-fg-subtle">
                Kept out {conflict.count} extra {conflict.count === 1 ? "copy" : "copies"} of the
                agent
                {conflictAgo
                  ? `, most recently ${conflictAgo === "now" ? "just now" : `${conflictAgo} ago`}`
                  : ""}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}

export function MachineDetail({
  machine,
  series,
  window,
  onWindowChange,
  loadingSeries,
  onBack,
  onRemove,
  onUpdateOperationPolicy,
  updatingOperationPolicy,
  onChangeAudience,
  onUpdateAgent,
  updatingAgent,
  now = Date.now(),
  className,
}: MachineDetailProps) {
  const health = deriveHealth(machine.state, machine.metrics, now);
  const tone = HEALTH_TOKEN[health.level];
  const latest = machine.metrics;
  const sampledAgo = latest ? formatRelativeTime(latest.sampledAt, new Date(now)) : null;

  // Only render metrics that have a value (GPU is dropped on headless boxes).
  const visible = METRICS.filter((m) => !(m.key === "gpu" && latest?.gpuUtilPct == null));
  // The tile grid tracks the metric count exactly so it never leaves a dead cell.
  const tileCols =
    visible.length >= 5
      ? "grid-cols-2 sm:grid-cols-3 lg:grid-cols-5"
      : "grid-cols-2 sm:grid-cols-4";

  return (
    <div className={cn("og-root mx-auto flex w-full max-w-5xl flex-col gap-5", className)}>
      {/* ── top bar ─────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="flex size-7 shrink-0 items-center justify-center rounded-og-sm border border-og-border bg-og-surface-1 text-og-fg-muted transition-colors hover:bg-og-surface-2 hover:text-og-fg"
              aria-label="Back to machines"
            >
              <ArrowLeftIcon className="size-3.5" aria-hidden />
            </button>
          )}
          <KindIcon kind={machine.kind} session={machine.isSessionGroup} />
          <h1 className="truncate text-og-md font-semibold text-og-fg">{machine.name}</h1>
          <span className="hidden shrink-0 rounded-og-sm border border-og-border bg-og-surface-1 px-1.5 py-0.5 font-og-mono text-og-xs text-og-fg-subtle sm:inline">
            {machine.os} · {machine.arch}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {onRemove && machine.enrollmentId && !machine.isSessionGroup ? (
            <button
              type="button"
              data-remove-machine
              aria-label={`Remove machine ${machine.name}`}
              onClick={() => onRemove(machine)}
              className="inline-flex min-h-9 items-center gap-1.5 rounded-og-sm border border-og-status-failed/40 px-2.5 py-1 font-medium text-og-xs text-og-status-failed transition-colors hover:bg-og-status-failed/10 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-og-status-failed/50 pointer-coarse:min-h-11"
            >
              <Trash2Icon className="size-3.5" aria-hidden />
              <span className="hidden sm:inline">Remove machine</span>
            </button>
          ) : null}
          {/* range selector */}
          <div className="flex items-center gap-0.5 rounded-og-md border border-og-border bg-og-surface-1 p-0.5">
            {METRIC_WINDOWS.map((w) => (
              <button
                key={w}
                type="button"
                onClick={() => onWindowChange(w)}
                data-active={w === window}
                className={cn(
                  "rounded-og-sm px-2 py-1 font-og-mono text-og-xs transition-colors",
                  w === window
                    ? "bg-og-surface-3 text-og-fg shadow-og-sm"
                    : "text-og-fg-subtle hover:text-og-fg-muted",
                )}
              >
                {w}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── health hero ─────────────────────────────────────────────────── */}
      <div
        className={cn(
          "relative flex flex-col gap-4 overflow-hidden rounded-og-lg border p-5 shadow-og-sm",
          tone.soft,
        )}
      >
        <span aria-hidden className={cn("absolute inset-y-0 left-0 w-1", tone.dot)} />
        <div className="flex flex-wrap items-center justify-between gap-3 pl-1">
          <div className="flex items-center gap-3">
            <span className="relative flex size-3">
              {healthPulses(health.level) && (
                <span
                  className={cn(
                    "absolute inline-flex size-full animate-og-pulse rounded-full opacity-60",
                    tone.dot,
                  )}
                />
              )}
              <span className={cn("relative inline-flex size-3 rounded-full", tone.dot)} />
            </span>
            <div className="flex flex-col">
              <span className={cn("text-og-md font-semibold", tone.text)}>{health.label}</span>
              <span className="text-og-sm text-og-fg-muted">{health.reason}</span>
            </div>
          </div>
          <div className="flex items-start gap-5 pr-1">
            {sampledAgo && (
              <div className="flex flex-col items-end gap-0.5">
                <span className="text-[10px] font-medium uppercase tracking-wide text-og-fg-subtle">
                  Sampled
                </span>
                <span className="flex items-center gap-1 font-og-mono text-og-sm tabular-nums text-og-fg">
                  <RadioIcon
                    className={cn("size-3", health.stale ? "text-og-fg-subtle" : tone.text)}
                    aria-hidden
                  />
                  {sampledAgo === "now" ? "live" : `${sampledAgo} ago`}
                </span>
              </div>
            )}
            {machine.lastSeenAt && (
              <div className="hidden flex-col items-end gap-0.5 sm:flex">
                <span className="text-[10px] font-medium uppercase tracking-wide text-og-fg-subtle">
                  Last seen
                </span>
                <span className="font-og-mono text-og-sm tabular-nums text-og-fg-muted">
                  {formatRelativeTime(machine.lastSeenAt, new Date(now))}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* current-stat tiles */}
        {latest && (
          <div
            className={cn(
              "grid gap-px overflow-hidden rounded-og-md border border-og-border bg-og-border",
              tileCols,
            )}
          >
            {visible.map((m) => {
              const pts = pointsFor(m, series);
              return (
                <div key={m.key} className="flex flex-col gap-1.5 bg-og-surface-1 p-3">
                  <span className="text-[10px] font-medium uppercase tracking-wide text-og-fg-subtle">
                    {m.title}
                  </span>
                  <span className="font-og-mono text-og-md font-medium tabular-nums text-og-fg">
                    {m.current(latest)}
                  </span>
                  <MetricSparkline points={pts} color={m.color} yMax={m.yMax} height={22} />
                  {m.sub && (
                    <span className="truncate font-og-mono text-[10px] text-og-fg-subtle">
                      {m.sub(latest)}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <MachineAgentPanel
        machine={machine}
        now={now}
        onUpdateAgent={onUpdateAgent}
        updatingAgent={updatingAgent}
      />

      {machine.enrollmentId && !machine.isSessionGroup ? (
        <MachineAudienceRow machine={machine} onChange={onChangeAudience} />
      ) : null}

      {onUpdateOperationPolicy && machine.enrollmentId && machine.operationPolicy ? (
        <MachineOperationPolicyEditor
          policy={machine.operationPolicy}
          memorySupported={machine.runtime?.capabilities.operationResourcePolicy === true}
          cpuSupported={machine.runtime?.capabilities.operationCpuQuota === true}
          saving={updatingOperationPolicy}
          onSave={(request) => onUpdateOperationPolicy(machine, request)}
        />
      ) : null}

      {/* ── history charts ──────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {visible.map((m) => {
          const pts = pointsFor(m, series);
          return (
            <div
              key={m.key}
              className="flex flex-col gap-3 rounded-og-lg border border-og-border bg-og-surface-1 p-4 shadow-og-sm"
            >
              <div className="flex items-baseline justify-between">
                <span className="text-og-sm font-medium text-og-fg">{m.title}</span>
                {latest && (
                  <span className="font-og-mono text-og-sm tabular-nums text-og-fg-muted">
                    {m.current(latest)}
                  </span>
                )}
              </div>
              <MetricHistoryChart
                points={pts}
                yMax={m.yMax}
                unit={m.unit}
                color={m.color}
                thresholds={m.thresholds}
                rangeLabel={WINDOW_LABEL[window]}
                height={128}
                className={cn(loadingSeries && "opacity-50 transition-opacity")}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
