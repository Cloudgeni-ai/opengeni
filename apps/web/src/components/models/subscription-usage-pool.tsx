import { useState } from "react";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import type { SubscriptionUsagePool } from "@opengeni/sdk";
import { UsageMeter } from "@/components/ui/usage-meter";
import { RelativeTime, formatShortTime, useMinuteNow } from "@/components/ui/relative-time";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useSharedQuery } from "@/lib/shared-query";

export const SUBSCRIPTION_USAGE_POOL_QUERY_PREFIX = ["subscription-usage-pools"] as const;
const PROVIDER_LABELS = { codex: "Codex", claude: "Claude", xai: "SuperGrok" };

export function poolForecastSentence(
  forecast: SubscriptionUsagePool["windows"][number]["forecast"],
  now: number,
): string {
  if (forecast.kind === "insufficient_history")
    return `Forecast unavailable — ${forecast.basis.replace(/\.$/, "")}.`;
  if (forecast.kind === "runs_out" && forecast.runsOutAt) {
    const gap = forecast.nextResetAt
      ? Math.max(
          0,
          Math.round((Date.parse(forecast.nextResetAt) - Date.parse(forecast.runsOutAt)) / 60_000),
        )
      : null;
    const until =
      gap === null
        ? ""
        : ` (${gap >= 60 ? `${Math.floor(gap / 60)}h ${gap % 60}m` : `${gap}m`} before the next reset)`;
    return `Runs out about ${formatShortTime(forecast.runsOutAt, { now })}${until} — ${forecast.basis}.`;
  }
  return `Won't run out; about ${Math.round(forecast.unusedPercent ?? 0)}% will go unused (lowest ${Math.round(forecast.lowestPercent ?? 0)}%) — ${forecast.basis}.`;
}

/** The same real component is used by the page, tests and UI-kit preview. */
export function SubscriptionUsagePoolView({
  pool,
  now: fixedNow,
}: {
  pool: SubscriptionUsagePool;
  now?: number;
}) {
  const minuteNow = useMinuteNow();
  const now = fixedNow ?? minuteNow;
  const [selected, setSelected] = useState<"weekly" | "five_hour">("weekly");
  const window = pool.windows.find((item) => item.id === selected) ?? pool.windows[0];
  if (!window || window.accounts.length === 0) return null;
  const maxWeight = Math.max(...window.accounts.map((account) => account.weight));
  return (
    <section
      className="flex min-w-0 flex-col gap-4 py-5"
      aria-label={`${PROVIDER_LABELS[pool.provider]} pooled limits`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="m-0 text-sm font-semibold text-fg">{PROVIDER_LABELS[pool.provider]} pool</h3>
        <SegmentedControl<"weekly" | "five_hour">
          size="sm"
          value={window.id}
          onValueChange={setSelected}
          options={pool.windows.map((item) => ({
            value: item.id,
            label: item.id === "weekly" ? "Weekly" : "5-hour",
          }))}
        />
      </div>
      <UsageMeter
        label={window.id === "weekly" ? "Weekly" : "5-hour"}
        percent={window.remainingPercent}
        valueLabel={
          window.remainingPercent === null
            ? "Pool usage incomplete"
            : `${Math.round(window.remainingPercent)}% of the pool left`
        }
      />
      <p className="m-0 text-sm leading-5 text-fg-muted">
        {poolForecastSentence(window.forecast, now)}
      </p>
      <ul className="m-0 flex list-none flex-col gap-3 p-0" aria-label="Account limits">
        {window.accounts.map((account) => (
          <li key={account.id} className="flex min-w-0 flex-col gap-1.5">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-xs leading-4">
              <span className="min-w-0 truncate text-fg">{account.label}</span>
              <span className="text-fg-muted">
                {account.remainingPercent === null
                  ? "Not reported"
                  : `${Math.round(account.remainingPercent)}% left`}
                {account.resetsAt
                  ? ` · Resets ${formatShortTime(account.resetsAt, { now })}`
                  : " · Reset not reported"}
              </span>
            </div>
            <div
              style={{ width: `${(account.weight / maxWeight) * 100}%` }}
              title={`Relative limit size: ${account.weightBasis === "observed" ? "estimated from usage" : "plan estimate"}`}
            >
              <div
                className="h-1 overflow-hidden rounded-full bg-surface-3"
                role={account.remainingPercent === null ? "group" : "meter"}
                aria-label={`${account.label} remaining`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={account.remainingPercent ?? undefined}
                aria-valuetext={
                  account.remainingPercent === null
                    ? "Not reported"
                    : `${Math.round(account.remainingPercent)}% left`
                }
              >
                <div
                  className={
                    account.remainingPercent !== null && account.remainingPercent < 10
                      ? "h-full bg-danger"
                      : "h-full bg-brand"
                  }
                  style={{ width: `${account.remainingPercent ?? 0}%` }}
                />
              </div>
            </div>
          </li>
        ))}
      </ul>
      <p className="m-0 text-xs leading-4 text-fg-subtle">
        Bar sizes are estimates
        {window.accounts.some((account) => account.weightBasis === "plan_estimate")
          ? "; plan defaults where history is limited"
          : " from observed usage"}
        .
        {pool.observedAt ? (
          <>
            {" "}
            Read <RelativeTime date={pool.observedAt} now={now} />.
          </>
        ) : null}
      </p>
    </section>
  );
}

/** Shares one retained, caller-scoped read across all provider sections. */
export function ConnectedSubscriptionUsagePool({
  client,
  scope,
  id,
  provider,
}: {
  client: OpenGeniBrowserClient;
  scope: "organization" | "workspace";
  id: string;
  provider: SubscriptionUsagePool["provider"];
}) {
  const query = useSharedQuery(
    client,
    [...SUBSCRIPTION_USAGE_POOL_QUERY_PREFIX, scope, id],
    () =>
      scope === "organization"
        ? client.getOrganizationSubscriptionUsagePools(id)
        : client.getWorkspaceSubscriptionUsagePools(id),
    { staleTimeMs: 60_000 },
  );
  const pool = query.data?.pools.find((item) => item.provider === provider);
  if (query.loading)
    return (
      <li className="col-span-full list-none py-4 text-sm text-fg-muted" aria-busy="true">
        Loading {PROVIDER_LABELS[provider]} pool…
      </li>
    );
  if (query.error)
    return (
      <li className="col-span-full list-none py-4 text-sm text-fg-muted">
        Couldn't update {PROVIDER_LABELS[provider]} pool. Use Refresh to try again.
      </li>
    );
  if (!pool) return null;
  return (
    <li className="col-span-full list-none">
      <SubscriptionUsagePoolView pool={pool} />
    </li>
  );
}
