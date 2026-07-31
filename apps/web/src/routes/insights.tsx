import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowUpRightIcon, InfoIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { AreaChart, HorizontalBars, UsageMeter } from "@/components/insights/charts";
import { CausalSheet } from "@/components/insights/causal-sheet";
import { CountUp } from "@/components/insights/count-up";
import {
  ATTENTION,
  CREDIT_DRIVERS,
  DAYS,
  FLOOR_SESSIONS,
  INSIGHTS_DAYS,
  SCHEDULE_ROWS,
  TOKENS_BY_ORIGIN,
  WARM_LEASES,
  WINDOW,
  creditTotalUsd,
  formatDeltaUsd,
  formatTokens,
  formatUsd,
  pctDelta,
  priorCreditTotalUsd,
  type FloorSession,
  type TraceTarget,
  type UsageOrigin,
} from "@/components/insights/mock-data";
import { Button } from "@/components/ui/button";
import { ContentPage } from "@/components/ui/content-layout";
import { useAppContext } from "@/context";
import { cn } from "@/lib/utils";

/**
 * Workspace Insights (preview).
 * Single scroll: attention → dual consumption → drivers → live floor → schedules → caps.
 * Numbers are mocked but shaped like real usage_events / session / lease rollups.
 */
export function InsightsRoute({ workspaceId }: { workspaceId: string }) {
  const context = useAppContext();
  const workspace = context.workspaces.find((w) => w.id === workspaceId);
  const reduceMotion = useReducedMotion();
  const [trace, setTrace] = useState<TraceTarget | null>(null);
  const [floorFilter, setFloorFilter] = useState<"all" | "blocked" | "burning">("all");

  const creditUsd = creditTotalUsd();
  const priorCreditUsd = priorCreditTotalUsd();
  const creditDelta = pctDelta(creditUsd, priorCreditUsd);
  const tokenDelta = pctDelta(WINDOW.tokens, WINDOW.priorTokens);

  const openTrace = (driverId: string) => {
    const driver = CREDIT_DRIVERS.find((d) => d.id === driverId);
    setTrace({ driverId, label: driver?.label ?? driverId });
  };

  const floor = FLOOR_SESSIONS.filter((session) => {
    if (floorFilter === "blocked") {
      return (
        session.state === "approval" ||
        session.state === "capacity" ||
        session.state === "failed" ||
        session.state === "paused"
      );
    }
    if (floorFilter === "burning") return (session.burnUsdPerHour ?? 0) > 0.5;
    return true;
  });

  return (
    <ContentPage width="wide" data-insights className="gap-8">
      <motion.header
        initial={reduceMotion ? false : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
        className="flex flex-col gap-4 border-b border-border pb-5 sm:flex-row sm:items-end sm:justify-between"
      >
        <div className="min-w-0">
          <p className="text-2xs font-medium uppercase tracking-[0.14em] text-fg-subtle">
            {workspace?.name ?? "Workspace"} · {WINDOW.label}
          </p>
          <h1 className="mt-1 text-xl font-semibold tracking-[-0.03em] text-fg">Insights</h1>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-fg-muted">
            Workspace-attributed meters from{" "}
            <span className="text-fg">usage_events</span>, live session/turn state, sandbox
            leases, and Codex capacity waiters. Prepaid balance stays on Organization.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface/60 px-2 py-1 text-2xs text-fg-muted">
            <InfoIcon className="size-3" />
            Preview · illustrative rollups
          </span>
          <Button type="button" size="sm" variant="secondary" onClick={() => openTrace("drv-iam")}>
            Trace top driver
            <ArrowUpRightIcon className="size-3.5" />
          </Button>
        </div>
      </motion.header>

      {/* 1. Attention — live durable blockers */}
      <Section
        title="Needs attention"
        description="Open blockers from turn approval, capacity waiters, warm leases, and schedule admission — not inferred health scores."
      >
        <ul className="grid gap-2 lg:grid-cols-2">
          {ATTENTION.map((item, index) => (
            <motion.li
              key={item.id}
              initial={reduceMotion ? false : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.04 }}
            >
              <button
                type="button"
                onClick={() => {
                  if (item.source === "scheduled_task.denial_loop") openTrace("drv-tf");
                  else if (item.source === "sandbox.warm_idle") openTrace("drv-warm");
                  else openTrace("drv-iam");
                }}
                className="flex w-full items-start justify-between gap-3 rounded-lg border border-border bg-surface/40 px-3.5 py-3 text-left transition-colors hover:bg-surface-2/70"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-fg">{item.title}</p>
                  <p className="mt-0.5 text-xs leading-5 text-fg-muted">{item.detail}</p>
                  <p className="mt-1.5 font-mono text-2xs text-fg-subtle">{item.source}</p>
                </div>
                <span className="shrink-0 font-mono text-2xs tabular-nums text-fg-subtle">
                  {item.sinceLabel}
                </span>
              </button>
            </motion.li>
          ))}
        </ul>
      </Section>

      {/* 2. Dual consumption */}
      <Section
        title="Consumption"
        description="Two ledgers that must not be summed: OpenGeni credit dollars (model.cost + warm_cost) versus Codex-billed turn count."
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Metric
            label="Credit $ (model + warm)"
            value={formatUsd(creditUsd, 0)}
            delta={`${creditDelta > 0 ? "+" : ""}${creditDelta}% vs prior`}
            tone={creditDelta > 20 ? "warn" : "neutral"}
            source="usage_events · model.cost + sandbox.warm_cost"
          />
          <Metric
            label="Model tokens"
            value={formatTokens(WINDOW.tokens)}
            delta={`${tokenDelta > 0 ? "+" : ""}${tokenDelta}% vs prior`}
            source="usage_events · model.tokens"
          />
          <Metric
            label="Codex turns"
            value={<CountUp value={WINDOW.codexTurns} />}
            delta={`${WINDOW.priorCodexTurns} prior · $0 credit`}
            source="externally billed turns (not credit ledger)"
          />
          <Metric
            label="Runs completed"
            value={<CountUp value={WINDOW.runsCompleted} />}
            delta={`${WINDOW.priorRunsCompleted} prior`}
            source="usage_events · agent_run.completed"
          />
        </div>

        <div className="mt-4 grid gap-4 lg:grid-cols-[1.4fr_1fr]">
          <div className="rounded-lg border border-border bg-surface/35 p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <h3 className="text-sm font-medium text-fg">Daily credit meters</h3>
                <p className="mt-0.5 text-xs text-fg-muted">
                  Hover a day · model.cost vs sandbox.warm_cost
                </p>
              </div>
              <div className="flex gap-3 text-2xs text-fg-subtle">
                <LegendDot className="bg-status-failed" label="model.cost" />
                <LegendDot className="bg-status-running" label="warm_cost" />
              </div>
            </div>
            <AreaChart
              className="mt-3"
              labels={INSIGHTS_DAYS}
              valuePrefix="$"
              height={210}
              series={[
                {
                  id: "model",
                  label: "model.cost",
                  values: DAYS.map((d) => d.modelCostUsd),
                  className: "text-status-failed",
                },
                {
                  id: "warm",
                  label: "warm_cost",
                  values: DAYS.map((d) => d.warmCostUsd),
                  className: "text-status-running",
                },
              ]}
            />
          </div>

          <div className="rounded-lg border border-border bg-surface/35 p-4">
            <h3 className="text-sm font-medium text-fg">Tokens by origin</h3>
            <p className="mt-0.5 text-xs text-fg-muted">
              usage_events.origin · same window
            </p>
            <div className="mt-3">
              <HorizontalBars
                valuePrefix=""
                rows={TOKENS_BY_ORIGIN.filter((r) => r.tokens > 0).map((row) => ({
                  id: row.origin,
                  label: originLabel(row.origin),
                  value: row.tokens / 1_000_000,
                  hint: "M tok",
                  toneClass: originBarClass(row.origin),
                }))}
              />
            </div>
            <p className="mt-3 text-2xs leading-4 text-fg-subtle">
              Bar values are millions of tokens. Origin is stored on each usage row
              (user, goal, scheduled_task, compaction, api, system).
            </p>
          </div>
        </div>
      </Section>

      {/* 3. Drivers */}
      <Section
        title="Credit $ drivers"
        description="Ranked sum(model.cost + warm_cost) by root session, schedule, API key, or warm-idle residual. Click for causal breakdown."
      >
        <div className="overflow-hidden rounded-lg border border-border">
          <table className="min-w-full text-left text-xs">
            <thead className="border-b border-border bg-surface/50 text-fg-subtle">
              <tr>
                {["Driver", "Group", "Credit $", "Tokens", "Share", "Δ vs prior"].map((h) => (
                  <th key={h} className="whitespace-nowrap px-3 py-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {CREDIT_DRIVERS.map((driver) => (
                <tr
                  key={driver.id}
                  className="cursor-pointer border-b border-border/70 last:border-0 hover:bg-surface-2/60"
                  onClick={() => openTrace(driver.id)}
                >
                  <td className="px-3 py-2.5 font-medium text-fg">{driver.label}</td>
                  <td className="px-3 py-2.5 font-mono text-2xs text-fg-subtle">
                    {driver.groupBy}
                  </td>
                  <td className="px-3 py-2.5 font-mono tabular-nums text-fg-muted">
                    {formatUsd(driver.creditUsd)}
                  </td>
                  <td className="px-3 py-2.5 font-mono tabular-nums text-fg-muted">
                    {formatTokens(driver.tokens)}
                  </td>
                  <td className="px-3 py-2.5 font-mono tabular-nums text-fg-muted">
                    {driver.pctOfCreditUsd}%
                  </td>
                  <td
                    className={cn(
                      "px-3 py-2.5 font-mono tabular-nums",
                      driver.deltaUsdVsPrior > 0 ? "text-status-failed" : "text-fg-muted",
                    )}
                  >
                    {formatDeltaUsd(driver.deltaUsdVsPrior)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {/* 4. Live floor */}
      <Section
        title="Live sessions"
        description="Derived from sessions + active turn attempt + capacity waiters + pause fence. Burn is recent attributed credit $/h for the session tree."
      >
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <div className="flex gap-1 rounded-md border border-border p-0.5">
            {(
              [
                ["all", "All"],
                ["blocked", "Blocked"],
                ["burning", "Burning"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setFloorFilter(id)}
                className={cn(
                  "rounded px-2.5 py-1 text-2xs font-medium transition-colors",
                  floorFilter === id
                    ? "bg-surface-2 text-fg"
                    : "text-fg-muted hover:text-fg",
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="text-2xs text-fg-subtle">
            Now: {WINDOW.approvalWaitingNow} approval · {WINDOW.capacityWaitingNow} capacity ·{" "}
            {WINDOW.warmIdleNow} warm idle · {WINDOW.goalsActive} active goals
          </p>
        </div>
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="min-w-full text-left text-xs">
            <thead className="border-b border-border bg-surface/50 text-fg-subtle">
              <tr>
                {[
                  "Session",
                  "State",
                  "Age",
                  "Burn $/h",
                  "Billing",
                  "Origin",
                  "Route",
                  "Initiator",
                ].map((h) => (
                  <th key={h} className="whitespace-nowrap px-3 py-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <AnimatePresence initial={false}>
                {floor.map((session) => (
                  <tr
                    key={session.id}
                    className="border-b border-border/70 last:border-0 hover:bg-surface-2/50"
                  >
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        <StateDot state={session.state} />
                        <span className="font-medium text-fg">{session.title}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      <StatePill state={session.state} />
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 font-mono tabular-nums text-fg-muted">
                      {session.ageLabel}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 font-mono tabular-nums text-fg-muted">
                      {session.burnUsdPerHour == null
                        ? "—"
                        : `$${session.burnUsdPerHour.toFixed(2)}`}
                    </td>
                    <td className="px-3 py-2.5">
                      <BillingPill billing={session.billing} />
                    </td>
                    <td className="px-3 py-2.5 font-mono text-2xs text-fg-subtle">
                      {session.origin}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 font-mono text-2xs text-fg-subtle">
                      {session.route}
                    </td>
                    <td className="max-w-40 truncate px-3 py-2.5 text-fg-muted">
                      {session.initiatorLabel}
                    </td>
                  </tr>
                ))}
              </AnimatePresence>
            </tbody>
          </table>
        </div>
      </Section>

      {/* 5. Warm + schedules */}
      <div className="grid gap-8 lg:grid-cols-2">
        <Section
          title="Warm sandboxes"
          description="Lease rows + sandbox.warm_seconds / warm_cost. Idle = warm with zero active turns."
        >
          <ul className="grid gap-2">
            {WARM_LEASES.map((lease) => (
              <li
                key={lease.id}
                className={cn(
                  "flex items-center justify-between rounded-lg border px-3 py-2.5",
                  lease.status === "idle"
                    ? "border-status-failed/35 bg-status-failed/[0.04]"
                    : "border-border bg-surface/35",
                )}
              >
                <div className="min-w-0">
                  <p className="font-mono text-xs text-fg">{lease.id}</p>
                  <p className="text-2xs text-fg-subtle">
                    {lease.backend} · {lease.activeSessions} active sessions
                  </p>
                </div>
                <div className="text-right">
                  <p className="font-mono text-xs tabular-nums text-fg-muted">
                    {lease.warmLabel}
                  </p>
                  <p className="font-mono text-2xs tabular-nums text-fg-subtle">
                    {formatUsd(lease.warmCostUsd)} warm_cost
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </Section>

        <Section
          title="Schedules"
          description="scheduled_task.fired counts plus attributed credit meters and admission denials."
        >
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="min-w-full text-left text-xs">
              <thead className="border-b border-border bg-surface/50 text-fg-subtle">
                <tr>
                  {["Schedule", "Fires", "Credit $", "Tokens", "Denials", "Billing"].map((h) => (
                    <th key={h} className="whitespace-nowrap px-3 py-2 font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {SCHEDULE_ROWS.map((row) => (
                  <tr key={row.id} className="border-b border-border/70 last:border-0">
                    <td className="px-3 py-2.5 font-medium text-fg">{row.name}</td>
                    <td className="px-3 py-2.5 font-mono tabular-nums text-fg-muted">
                      {row.fires}
                    </td>
                    <td className="px-3 py-2.5 font-mono tabular-nums text-fg-muted">
                      {formatUsd(row.creditUsd)}
                    </td>
                    <td className="px-3 py-2.5 font-mono tabular-nums text-fg-muted">
                      {formatTokens(row.tokens)}
                    </td>
                    <td
                      className={cn(
                        "px-3 py-2.5 font-mono tabular-nums",
                        row.denials > 0 ? "text-status-failed" : "text-fg-muted",
                      )}
                    >
                      {row.denials}
                    </td>
                    <td className="px-3 py-2.5">
                      <BillingPill billing={row.billing} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      </div>

      {/* 6. Caps */}
      <Section
        title="Workspace caps"
        description="Headroom against static/managed usage limits (tokens & runs). Not the org credit balance."
      >
        <div className="grid gap-4 rounded-lg border border-border bg-surface/35 p-4 sm:grid-cols-2">
          <UsageMeter
            label="model.tokens vs monthly cap"
            detail={`${formatTokens(WINDOW.tokens)} / ${formatTokens(WINDOW.tokenCap)}`}
            total={WINDOW.tokenCap}
            segments={TOKENS_BY_ORIGIN.filter((r) => r.tokens > 0).map((row) => ({
              id: row.origin,
              value: row.tokens,
              className: originBarClass(row.origin),
              label: row.origin,
            }))}
          />
          <UsageMeter
            label="agent_run.completed vs monthly cap"
            detail={`${WINDOW.runsCompleted} / ${WINDOW.runCap}`}
            total={WINDOW.runCap}
            segments={[
              {
                id: "runs",
                value: WINDOW.runsCompleted,
                className: "bg-brand",
                label: "completed",
              },
            ]}
          />
        </div>
        <p className="mt-3 text-2xs leading-5 text-fg-subtle">
          Goals in window: {WINDOW.goalsCompleted} completed · {WINDOW.goalsActive} active
          (from goal rows / goal.* events). Codex capacity waits started this week:{" "}
          {DAYS.reduce((n, d) => n + d.capacityWaitsStarted, 0)} (codex_capacity_waiters).
        </p>
      </Section>

      <footer className="border-t border-border pt-4 text-2xs leading-5 text-fg-subtle">
        Preview data only. Production path: rollup APIs over{" "}
        <code className="text-fg-muted">usage_events</code> (workspace/session/origin/initiator),
        live joins to sessions/turns/goals/leases/capacity waiters, and entitlement caps.
        Collect next: product model id on each model.* row (join turn execution policy).
      </footer>

      <CausalSheet
        open={trace !== null}
        target={trace}
        onOpenChange={(open) => {
          if (!open) setTrace(null);
        }}
      />
    </ContentPage>
  );
}

function Section(props: { title: string; description: string; children: ReactNode }) {
  return (
    <section className="grid gap-3">
      <div>
        <h2 className="text-sm font-semibold tracking-[-0.02em] text-fg">{props.title}</h2>
        <p className="mt-0.5 max-w-3xl text-xs leading-5 text-fg-muted">{props.description}</p>
      </div>
      {props.children}
    </section>
  );
}

function Metric(props: {
  label: string;
  value: ReactNode;
  delta: string;
  source: string;
  tone?: "warn" | "neutral";
}) {
  return (
    <div className="rounded-lg border border-border bg-surface/40 px-3.5 py-3">
      <p className="text-2xs font-medium text-fg-subtle">{props.label}</p>
      <p
        className={cn(
          "mt-1.5 text-2xl font-semibold tracking-[-0.03em] tabular-nums",
          props.tone === "warn" ? "text-status-failed" : "text-fg",
        )}
      >
        {props.value}
      </p>
      <p className="mt-1 text-2xs tabular-nums text-fg-muted">{props.delta}</p>
      <p className="mt-2 font-mono text-[10px] leading-4 text-fg-subtle">{props.source}</p>
    </div>
  );
}

function LegendDot(props: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn("size-1.5 rounded-full", props.className)} />
      {props.label}
    </span>
  );
}

function BillingPill(props: { billing: "credits" | "codex" | "mixed" }) {
  return (
    <span
      className={cn(
        "inline-flex rounded border px-1.5 py-0.5 text-2xs font-medium",
        props.billing === "codex" && "border-brand/35 bg-brand/10 text-brand",
        props.billing === "credits" && "border-border bg-surface-2 text-fg-muted",
        props.billing === "mixed" && "border-border bg-surface-2 text-fg-subtle",
      )}
    >
      {props.billing}
    </span>
  );
}

function StateDot(props: { state: FloorSession["state"] }) {
  const live = props.state === "running" || props.state === "compacting";
  return (
    <span className="relative flex size-2 shrink-0">
      {live ? (
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-status-running opacity-40" />
      ) : null}
      <span className={cn("relative size-2 rounded-full", stateColor(props.state))} />
    </span>
  );
}

function StatePill(props: { state: FloorSession["state"] }) {
  return (
    <span
      className={cn(
        "inline-flex rounded border px-1.5 py-0.5 text-2xs font-medium capitalize",
        statePillClass(props.state),
      )}
    >
      {props.state}
    </span>
  );
}

function originLabel(origin: UsageOrigin): string {
  switch (origin) {
    case "user":
      return "user";
    case "goal":
      return "goal";
    case "scheduled_task":
      return "scheduled_task";
    case "compaction":
      return "compaction";
    case "api":
      return "api";
    case "system":
      return "system";
    default: {
      const _exhaustive: never = origin;
      return _exhaustive;
    }
  }
}

function originBarClass(origin: UsageOrigin): string {
  switch (origin) {
    case "goal":
      return "bg-brand";
    case "user":
      return "bg-fg-muted";
    case "scheduled_task":
      return "bg-status-running";
    case "compaction":
      return "bg-status-waiting";
    case "api":
      return "bg-status-idle";
    case "system":
      return "bg-fg-subtle";
    default: {
      const _exhaustive: never = origin;
      return _exhaustive;
    }
  }
}

function stateColor(state: FloorSession["state"]): string {
  switch (state) {
    case "approval":
    case "capacity":
      return "bg-status-waiting";
    case "running":
    case "compacting":
      return "bg-status-running";
    case "paused":
      return "bg-status-queued";
    case "failed":
      return "bg-status-failed";
    case "idle":
      return "bg-status-idle";
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

function statePillClass(state: FloorSession["state"]): string {
  switch (state) {
    case "approval":
    case "capacity":
      return "border-status-waiting/40 bg-status-waiting/10 text-status-waiting";
    case "running":
    case "compacting":
      return "border-status-running/40 bg-status-running/10 text-status-running";
    case "paused":
      return "border-border bg-surface-2 text-fg-muted";
    case "failed":
      return "border-status-failed/40 bg-status-failed/10 text-status-failed";
    case "idle":
      return "border-status-idle/40 bg-status-idle/10 text-status-idle";
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}
