import type { UsageAllowancePeriod, WorkspaceUsageResponse } from "@opengeni/sdk/usage-allowances";
import type { ReactNode } from "react";

import { useUsage, type UsageClientLike } from "../hooks/use-usage";
import { cn } from "../lib/cn";
import {
  allowanceLabels,
  allowanceResetSentence,
  formatAllowanceInstant,
  type AllowanceLabels,
} from "../usage/allowance-copy";
import {
  summarizeUsage,
  usagePercentLabel,
  type UsageReading,
  type UsageSummary,
} from "../usage/summary";

export type UsageMeterLabels = AllowanceLabels & {
  /** Heading for the member's own ceiling. */
  title: string;
  /** Heading when only the shared workspace pool applies. */
  workspaceTitle: string;
  /** "38% left" — `percent` is preformatted ("38", "<1"). */
  left: (percent: string) => string;
  /** "62% used". */
  used: (percent: string) => string;
  limitReached: string;
  /** Status chip beside a hero meter that is close to its limit. */
  nearLimit: string;
  /** "$13.00 left" for a hero meter with amounts. */
  amountLeft: (amount: string) => string;
  /** No ceiling applies to this member. */
  unlimited: string;
  loading: string;
  error: string;
  retry: string;
  /** "$31.00 of $50.00 used" when the host passes `formatAmount`. */
  amounts: (used: string, limit: string) => string;
  /** The shared pool, under a member's own meter: "Workspace: 9% left". */
  workspaceLine: (value: string) => string;
};

export const DEFAULT_USAGE_METER_LABELS: UsageMeterLabels = {
  ...allowanceLabels(),
  title: "Your usage",
  workspaceTitle: "Workspace usage",
  left: (percent) => `${percent}% left`,
  used: (percent) => `${percent}% used`,
  limitReached: "Limit reached",
  nearLimit: "Near limit",
  amountLeft: (amount) => `${amount} left`,
  unlimited: "No usage limit",
  loading: "Checking usage…",
  error: "Couldn't load usage",
  retry: "Try again",
  amounts: (used, limit) => `${used} of ${limit} used`,
  workspaceLine: (value) => `Workspace: ${value}`,
};

export type UsageMeterBaseProps = {
  /** "left" (default) reads like a battery; "used" reads like spend. */
  measure?: "left" | "used" | undefined;
  /**
   * Opt in to amounts. Receives USD micros; return your own unit ("$31.00",
   * "3.1 credits", "1.5× plan"). Without it the meter shows only shares.
   */
  formatAmount?: ((micros: number) => string) | undefined;
  labels?: Partial<UsageMeterLabels> | undefined;
  /**
   * `compact` is one line for menus and headers; `hero` leads a page with the
   * amount (or share) left in large type. An empty `labels.title` hides the
   * heading when the page already names it.
   */
  density?: "default" | "compact" | "hero" | undefined;
  /** Show the shared pool under the member's own meter when it is the tighter one. Default true. */
  showWorkspace?: boolean | undefined;
  className?: string | undefined;
};

export type UsageMeterProps = UsageMeterBaseProps & {
  /**
   * A usage response you already loaded (for example from `useUsage`).
   * Omit it to let the meter read `/usage/me` itself.
   */
  usage?: WorkspaceUsageResponse | null | undefined;
  client?: UsageClientLike | undefined;
  workspaceId?: string | undefined;
  period?: UsageAllowancePeriod | undefined;
  /** Re-read when this changes (see `useUsage`). */
  refreshKey?: unknown;
};

/**
 * The signed-in member's own usage: how much of their limit is left and when
 * it resets. Shares only by default; hosts opt in to amounts.
 */
export function UsageMeter({
  usage,
  client,
  workspaceId,
  period,
  refreshKey,
  ...view
}: UsageMeterProps) {
  if (usage !== undefined) {
    return (
      <UsageMeterView
        {...view}
        summary={usage ? summarizeUsage(usage) : null}
        loading={usage === null}
      />
    );
  }
  return (
    <LoadingUsageMeter
      {...view}
      client={client}
      workspaceId={workspaceId}
      period={period}
      refreshKey={refreshKey}
    />
  );
}

function LoadingUsageMeter({
  client,
  workspaceId,
  period,
  refreshKey,
  ...view
}: UsageMeterBaseProps &
  Pick<UsageMeterProps, "client" | "workspaceId" | "period" | "refreshKey">) {
  const state = useUsage({ client, workspaceId, period, refreshKey });
  return (
    <UsageMeterView
      {...view}
      summary={state.summary}
      loading={state.loading && !state.summary}
      error={state.summary ? null : state.error}
      onRetry={() => void state.refresh()}
    />
  );
}

export type UsageMeterViewProps = UsageMeterBaseProps & {
  summary: UsageSummary | null;
  loading?: boolean | undefined;
  error?: Error | null | undefined;
  onRetry?: (() => void) | undefined;
};

const FILL: Record<UsageReading["status"], string> = {
  ok: "bg-og-accent",
  warning: "bg-og-status-waiting",
  exhausted: "bg-og-danger",
};

function valueText(
  reading: UsageReading,
  measure: "left" | "used",
  labels: UsageMeterLabels,
): string {
  if (reading.status === "exhausted") return labels.limitReached;
  return measure === "left"
    ? labels.left(usagePercentLabel(Math.max(0, 1 - reading.fraction)))
    : labels.used(usagePercentLabel(reading.fraction));
}

/** Presentational meter for a summary you computed (`summarizeUsage`). */
export function UsageMeterView({
  summary,
  loading = false,
  error = null,
  onRetry,
  measure = "left",
  formatAmount,
  labels: overrides,
  density = "default",
  showWorkspace = true,
  className,
}: UsageMeterViewProps) {
  const labels = { ...DEFAULT_USAGE_METER_LABELS, ...overrides };
  const compact = density === "compact";
  if (loading || error || !summary) {
    return (
      <div
        className={cn("og-root min-w-0 text-og-sm", className)}
        data-og-usage-meter={error ? "error" : "loading"}
        aria-busy={loading || undefined}
      >
        {error ? (
          <p className="flex flex-wrap items-center gap-x-2 text-og-fg-muted" role="alert">
            {labels.error}
            {onRetry ? (
              <button
                type="button"
                onClick={onRetry}
                className="rounded-og-sm text-og-fg underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-og-accent"
              >
                {labels.retry}
              </button>
            ) : null}
          </p>
        ) : (
          <span className="text-og-fg-subtle">{labels.loading}</span>
        )}
      </div>
    );
  }
  const primary = summary.member ?? summary.workspace;
  if (!primary) {
    return (
      <div
        className={cn("og-root min-w-0 text-og-sm text-og-fg-muted", className)}
        data-og-usage-meter="unlimited"
      >
        {compact ? null : <span className="font-medium text-og-fg">{labels.title} · </span>}
        {labels.unlimited}
      </div>
    );
  }
  const title = summary.member ? labels.title : labels.workspaceTitle;
  const value = valueText(primary, measure, labels);
  // The bar always fills with what's used, so "near the limit" reads as a
  // nearly full bar whichever way the words count.
  const fill = Math.min(1, Math.max(0, primary.fraction));
  const reset = allowanceResetSentence(labels, primary.resetsAt);
  const pool =
    showWorkspace &&
    summary.member &&
    summary.workspace &&
    (summary.binding?.scope === "workspace" || summary.workspace.status !== "ok")
      ? summary.workspace
      : null;
  const meterProps = {
    role: "meter" as const,
    "aria-label": title || labels.title,
    "aria-valuemin": 0,
    "aria-valuemax": 100,
    "aria-valuenow": Math.round(fill * 100),
    "aria-valuetext": `${value}. ${reset}${
      pool ? ` ${labels.workspaceLine(valueText(pool, measure, labels))}.` : ""
    }`,
  };
  const bar = (
    <span
      aria-hidden
      className={cn(
        "relative block overflow-hidden rounded-full",
        density === "hero" ? "h-1.5" : "h-1",
        primary.status === "exhausted" ? "bg-og-danger/15" : "bg-og-surface-3",
        compact ? "w-16 shrink-0" : "w-full",
      )}
    >
      <span
        className={cn("absolute inset-y-0 left-0 rounded-full", FILL[primary.status])}
        style={{ width: `${Math.round(fill * 1000) / 10}%` }}
      />
    </span>
  );
  const valueClass = cn(
    "shrink-0 whitespace-nowrap tabular-nums",
    primary.status === "ok" ? "text-og-fg-muted" : "font-medium",
    primary.status === "warning" && "text-og-status-waiting",
    primary.status === "exhausted" && "text-og-danger",
  );
  if (compact) {
    return (
      <span
        {...meterProps}
        data-og-usage-meter={primary.status}
        title={primary.resetsAt ? `${reset} ${formatAllowanceInstant(primary.resetsAt)}` : reset}
        className={cn("og-root inline-flex min-w-0 items-center gap-2 text-og-xs", className)}
      >
        <span className={valueClass}>{value}</span>
        {bar}
      </span>
    );
  }
  const amounts = formatAmount
    ? labels.amounts(formatAmount(primary.used), formatAmount(primary.limit))
    : null;
  if (density === "hero") {
    // Lead with what's left, even at zero; the chip names the state.
    const headline = formatAmount
      ? labels.amountLeft(formatAmount(primary.remaining))
      : labels.left(usagePercentLabel(Math.max(0, 1 - primary.fraction)));
    return (
      <div
        {...meterProps}
        data-og-usage-meter={primary.status}
        className={cn("og-root flex min-w-0 flex-col gap-3", className)}
      >
        {title ? <span className="text-og-sm font-medium text-og-fg-muted">{title}</span> : null}
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-2xl leading-8 font-semibold tracking-[-0.5px] text-og-fg tabular-nums">
            {headline}
          </span>
          {primary.status !== "ok" ? (
            <span
              className={cn(
                "inline-flex h-[22px] items-center gap-1.5 rounded-full border px-2 text-og-xs font-medium",
                primary.status === "warning"
                  ? "border-og-status-waiting/30 text-og-status-waiting"
                  : "border-og-danger/30 text-og-danger",
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "size-1.5 rounded-full",
                  primary.status === "warning" ? "bg-og-status-waiting" : "bg-og-danger",
                )}
              />
              {primary.status === "warning" ? labels.nearLimit : labels.limitReached}
            </span>
          ) : null}
        </div>
        {bar}
        <p className="text-og-xs text-og-fg-muted tabular-nums">
          {[
            amounts ?? labels.used(usagePercentLabel(primary.fraction)),
            amounts ? `${usagePercentLabel(primary.fraction)}%` : null,
          ]
            .filter(Boolean)
            .join(" · ")}{" "}
          ·{" "}
          <span title={primary.resetsAt ? formatAllowanceInstant(primary.resetsAt) : undefined}>
            {reset}
          </span>
        </p>
        {pool ? <PoolLine reading={pool} measure={measure} labels={labels} /> : null}
      </div>
    );
  }
  return (
    <div
      {...meterProps}
      data-og-usage-meter={primary.status}
      className={cn("og-root flex min-w-0 flex-col gap-2 text-og-sm", className)}
    >
      <div className="flex min-w-0 items-baseline justify-between gap-3">
        <span className="min-w-0 truncate font-medium text-og-fg">{title}</span>
        <span className={valueClass}>{value}</span>
      </div>
      {bar}
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-og-xs text-og-fg-subtle">
        <span title={primary.resetsAt ? formatAllowanceInstant(primary.resetsAt) : undefined}>
          {reset}
        </span>
        {amounts ? <span className="tabular-nums">{amounts}</span> : null}
      </div>
      {pool ? <PoolLine reading={pool} measure={measure} labels={labels} /> : null}
    </div>
  );
}

function PoolLine({
  reading,
  measure,
  labels,
}: {
  reading: UsageReading;
  measure: "left" | "used";
  labels: UsageMeterLabels;
}): ReactNode {
  return (
    <p
      className={cn(
        "text-og-xs",
        reading.status === "exhausted"
          ? "font-medium text-og-danger"
          : reading.status === "warning"
            ? "text-og-status-waiting"
            : "text-og-fg-muted",
      )}
    >
      {labels.workspaceLine(valueText(reading, measure, labels))}
    </p>
  );
}
