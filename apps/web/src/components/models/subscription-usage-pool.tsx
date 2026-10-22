import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import type { SubscriptionUsagePool } from "@opengeni/sdk";
import { RelativeTime, formatShortTime, useMinuteNow } from "@opengeni/react/ui/relative-time";
import { UsageMeter, UsageReadout } from "@opengeni/react/ui/usage-meter";
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
    if (Date.parse(forecast.runsOutAt) <= now) {
      return forecast.nextResetAt && Date.parse(forecast.nextResetAt) > now
        ? `No capacity available. Next reset ${formatShortTime(forecast.nextResetAt, { now })}.`
        : "No capacity available. Waiting for updated limits.";
    }
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
  const shortWindow = pool.windows.find((item) => item.id === "five_hour");
  // A known short-window block contributes zero even without a weekly reading.
  const unreported = window.accounts.filter(
    (account) =>
      account.remainingPercent === null &&
      !shortWindow?.accounts.some(
        (other) => other.id === account.id && other.remainingPercent === 0,
      ),
  );
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
      <UsageMeter label="Available now" percent={window.remainingPercent} />
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
/** One provider's pooled limits for an organization or workspace, from the one shared read. */
export function useSubscriptionUsagePool(
  client: OpenGeniBrowserClient,
  scope: "organization" | "workspace",
  id: string | undefined,
  provider: SubscriptionUsagePool["provider"],
): { pool: SubscriptionUsagePool | null; loading: boolean; error: boolean } {
  const query = useSharedQuery(
    client,
    [...SUBSCRIPTION_USAGE_POOL_QUERY_PREFIX, scope, id ?? ""],
    () =>
      scope === "organization"
        ? client.getOrganizationSubscriptionUsagePools(id!)
        : client.getWorkspaceSubscriptionUsagePools(id!),
    { staleTimeMs: 60_000, enabled: Boolean(id) },
  );
  return {
    pool: query.data?.pools.find((item) => item.provider === provider) ?? null,
    loading: Boolean(id) && query.loading,
    error: Boolean(query.error),
  };
}

/**
 * A provider's heading in an accounts list, with everything worth a glance:
 * how many accounts, how many are on or need reconnecting, and what is left
 * of the pooled weekly limit with the forecast. Its height is fixed while
 * anything loads, so the rows below never move.
 */
export function ProviderGroupHeading({
  title,
  facts,
  pool,
}: {
  title: string;
  /** "12 accounts", "9 on", "1 needs reconnecting"; null while unknown. */
  facts: readonly (string | null)[] | null;
  /** The pooled limits, when this provider reports them. */
  pool?: { pool: SubscriptionUsagePool | null; loading: boolean } | undefined;
}) {
  const minuteNow = useMinuteNow();
  const weekly = pool?.pool?.windows.find((item) => item.id === "weekly") ?? null;
  const shown = weekly && weekly.accounts.length > 0 ? weekly : null;
  const forecast =
    shown && shown.remainingPercent !== null
      ? poolForecastSentence(shown.forecast, minuteNow)
      : null;
  const words = facts?.filter((fact): fact is string => Boolean(fact)) ?? null;
  return (
    <li className="col-span-full list-none px-3 pt-6 pb-3 first:pt-2">
      <div className="flex min-h-10 items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="m-0 text-sm font-semibold text-fg">{title}</h3>
          <p className="m-0 mt-0.5 min-h-4 text-xs leading-4 text-fg-muted">
            {words === null ? (
              <span
                aria-hidden="true"
                className="inline-block h-3 w-40 rounded bg-surface-3 align-middle motion-safe:animate-pulse"
              />
            ) : (
              words.join(" · ")
            )}
          </p>
          {forecast ? (
            <p className="m-0 mt-0.5 text-xs leading-4 text-fg-subtle">{forecast}</p>
          ) : pool?.loading ? (
            // The forecast's lines are held while the limits load, so rows stay
            // put: two on a phone, where the sentence wraps, one on wider screens.
            <p aria-hidden="true" className="m-0 mt-0.5 flex h-8 flex-col justify-around sm:h-4">
              <span className="block h-3 w-56 max-w-full rounded bg-surface-3 motion-safe:animate-pulse" />
              <span className="block h-3 w-32 rounded bg-surface-3 motion-safe:animate-pulse sm:hidden" />
            </p>
          ) : null}
        </div>
        {pool && (pool.loading || shown) ? (
          <UsageReadout
            className="shrink-0 pt-0.5"
            percent={shown?.remainingPercent ?? null}
            loading={pool.loading}
            window="available now"
            fallback="No limits reported yet"
          />
        ) : null}
      </div>
    </li>
  );
}

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
