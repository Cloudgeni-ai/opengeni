import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import type { SubscriptionUsagePool } from "@opengeni/sdk";
import { RelativeTime, formatShortTime, useMinuteNow } from "@opengeni/react/ui/relative-time";
import { UsageMeter } from "@opengeni/react/ui/usage-meter";
import { useSharedQuery } from "@opengeni/react/app/lib/shared-query";

export const SUBSCRIPTION_USAGE_POOL_QUERY_PREFIX = ["subscription-usage-pools"] as const;
const PROVIDER_LABELS = { codex: "Codex", claude: "Claude", xai: "SuperGrok" };

export function poolForecastSentence(
  forecast: SubscriptionUsagePool["windows"][number]["forecast"],
  now: number,
): string {
  if (forecast.kind === "insufficient_history")
    return "Not enough history to forecast this week's usage yet.";
  if (forecast.kind === "runs_out" && forecast.runsOutAt) {
    const gap = forecast.nextResetAt
      ? Math.max(
          0,
          Math.round((Date.parse(forecast.nextResetAt) - Date.parse(forecast.runsOutAt)) / 60_000),
        )
      : null;
    const duration =
      gap === null
        ? null
        : gap >= 1440
          ? `${Math.round(gap / 1440)} ${Math.round(gap / 1440) === 1 ? "day" : "days"}`
          : gap >= 60
            ? `${Math.floor(gap / 60)}h${gap % 60 ? ` ${gap % 60}m` : ""}`
            : `${gap}m`;
    return `At this pace you'll run out ${formatShortTime(forecast.runsOutAt, { now })}${duration === null ? "" : `, ${duration} before the next reset`}.`;
  }
  const utilization =
    forecast.utilizationPercent ??
    (forecast.unusedPercent === null ? null : 100 - forecast.unusedPercent);
  return utilization === null
    ? "Not enough history to forecast this week's usage yet."
    : `At this pace you'll use about ${Math.round(utilization)}% of this week's included usage.`;
}

function forecastBasis(forecast: SubscriptionUsagePool["windows"][number]["forecast"]): string {
  if (forecast.kind === "insufficient_history")
    return "Waiting for current limits and enough usage history.";
  if (forecast.basis.startsWith("Observed pool exhaustion")) return "Current reported limits.";
  if (forecast.basis.startsWith("Last-reset"))
    return "Pace since the last reset · limited history.";
  return forecast.historyDays >= 7
    ? "Last 7 days, adjusted to this week's pace."
    : `Last ${Math.max(1, Math.ceil(forecast.historyDays))} ${forecast.historyDays <= 1 ? "day" : "days"}, adjusted to this week's pace · limited history.`;
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
  const window = pool.windows.find((item) => item.id === "weekly");
  if (!window || window.accounts.length === 0) return null;
  // Accounts with no current reading are left out of the total, and the card says so.
  const unreported = window.accounts.filter((account) => account.remainingPercent === null);
  const blocked =
    pool.windows
      .find((item) => item.id === "five_hour")
      ?.accounts.filter(
        (account) =>
          account.remainingPercent === 0 &&
          account.resetsAt !== null &&
          Date.parse(account.resetsAt) > now,
      ) ?? [];
  return (
    <section
      className="flex min-w-0 flex-col gap-4 px-3 py-5"
      aria-label={`${PROVIDER_LABELS[pool.provider]} pooled limits`}
    >
      <h3 className="m-0 text-sm font-semibold text-fg">
        {PROVIDER_LABELS[pool.provider]} this week
      </h3>
      <div className="space-y-1">
        <p className="m-0 text-sm leading-5 text-fg">
          {window.remainingPercent === null
            ? "No account has reported its limit yet."
            : poolForecastSentence(window.forecast, now)}
        </p>
        <p className="m-0 text-xs leading-4 text-fg-muted">{forecastBasis(window.forecast)}</p>
      </div>
      <UsageMeter label="Total remaining" percent={window.remainingPercent} />
      {blocked.length > 0 ? (
        <p className="m-0 text-xs leading-4 text-fg-muted">
          {blocked
            .map(
              (account) =>
                `${account.label} is at its 5-hour limit until ${formatShortTime(account.resetsAt!, { now })}`,
            )
            .join("; ")}
          .
        </p>
      ) : null}
      <p className="m-0 text-xs leading-4 text-fg-subtle">
        {window.remainingPercent !== null && unreported.length > 0
          ? `Leaves out ${unreported.map((account) => account.label).join(", ")}, which ${unreported.length === 1 ? "hasn't" : "haven't"} reported ${unreported.length === 1 ? "its" : "their"} limit yet. `
          : null}
        {pool.observedAt ? (
          <>
            Read <RelativeTime date={pool.observedAt} now={now} inSentence />.
          </>
        ) : (
          "Not read yet."
        )}
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
  // No workspace pool is shown until its scoped read establishes available accounts.
  if (scope === "workspace" && !pool) return null;
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
