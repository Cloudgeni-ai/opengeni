import type { OrganizationUsagePeriod } from "@opengeni/contracts";
import type {
  OrganizationModelUsage,
  OrganizationModelUsageTotals,
} from "@opengeni/contracts/organization-model-usage";
import { useEffect, useState } from "react";
import { useAppContext } from "@/context";
import { LoadErrorState } from "@/components/common";
import { Button } from "@/components/ui/button";

type Totals = OrganizationModelUsageTotals;
type Summary = {
  calls: bigint;
  totalTokens: bigint;
  cachedTokens: bigint;
  cacheInputTokens: bigint;
  creditMicros: bigint;
  creditCalls: bigint;
  externalCalls: bigint;
  externalEstimateMicros: bigint;
  externalPricedCalls: bigint;
};

/** Sum per-billing-path rows exactly; bigint strings never pass through a float. */
export function summarizeModelUsage(rows: readonly Totals[]): Summary {
  const summary: Summary = {
    calls: 0n,
    totalTokens: 0n,
    cachedTokens: 0n,
    cacheInputTokens: 0n,
    creditMicros: 0n,
    creditCalls: 0n,
    externalCalls: 0n,
    externalEstimateMicros: 0n,
    externalPricedCalls: 0n,
  };
  for (const row of rows) {
    summary.calls += BigInt(row.calls);
    summary.totalTokens += BigInt(row.totalTokens);
    summary.cachedTokens += BigInt(row.cachedTokens);
    summary.cacheInputTokens += BigInt(row.cacheInputTokens);
    if (row.billingPath === "opengeni_credits") {
      summary.creditMicros += BigInt(row.creditMicros);
      summary.creditCalls += BigInt(row.calls);
    } else {
      summary.externalCalls += BigInt(row.calls);
      summary.externalEstimateMicros += BigInt(row.estimatedProviderMicros);
      summary.externalPricedCalls += BigInt(row.estimatedProviderKnownCalls);
    }
  }
  return summary;
}

export function formatMicrosUsd(micros: bigint): string {
  const cents = (micros + 5_000n) / 10_000n;
  const dollars = cents / 100n;
  return `$${dollars.toLocaleString("en-US")}.${(cents % 100n).toString().padStart(2, "0")}`;
}

export function formatTokenCount(value: bigint): string {
  const scaled = (unit: bigint) => (Number((value * 10n + unit / 2n) / unit) / 10).toFixed(1);
  if (value >= 1_000_000_000n) return `${scaled(1_000_000_000n)}B`;
  if (value >= 1_000_000n) return `${scaled(1_000_000n)}M`;
  if (value >= 1_000n) return `${scaled(1_000n)}K`;
  return value.toString();
}

export function cacheHitLabel(summary: Pick<Summary, "cachedTokens" | "cacheInputTokens">): string {
  if (summary.cacheInputTokens === 0n) return "Unknown";
  return `${Number((summary.cachedTokens * 100n) / summary.cacheInputTokens)}%`;
}

/** Credits are charged; external spend is only an estimate, and only when priced. */
export function externalSpendLabel(summary: Summary): string {
  if (summary.externalCalls === 0n) return formatMicrosUsd(0n);
  if (summary.externalPricedCalls === 0n) return "Unknown";
  return `~${formatMicrosUsd(summary.externalEstimateMicros)}`;
}

/**
 * States how much of the charged ledger the per-call breakdown covers. Null when
 * the ledger is not loaded or the two agree to the cent.
 */
export function ledgerCoverageNote(
  ledgerCreditMicros: string | undefined,
  breakdownCreditMicros: bigint,
): string | null {
  if (ledgerCreditMicros === undefined) return null;
  const ledger = BigInt(ledgerCreditMicros);
  const gap = ledger - breakdownCreditMicros;
  if (gap > -10_000n && gap < 10_000n) return null;
  return gap > 0n
    ? `Per-call records cover ${formatMicrosUsd(breakdownCreditMicros)} of the ${formatMicrosUsd(ledger)} charged. ${formatMicrosUsd(gap)} has no per-call record yet; recent gaps are rebuilt automatically from each call's usage event.`
    : `Per-call records exceed the ${formatMicrosUsd(ledger)} charged in this period by ${formatMicrosUsd(-gap)}.`;
}

function costLabel(row: Totals): string {
  if (row.billingPath === "opengeni_credits") return formatMicrosUsd(BigInt(row.creditMicros));
  if (row.estimatedProviderKnownCalls === "0") return "Unknown";
  const estimate = `~${formatMicrosUsd(BigInt(row.estimatedProviderMicros))} est.`;
  return row.estimatedProviderKnownCalls === row.calls
    ? estimate
    : `${estimate} · ${BigInt(row.estimatedProviderKnownCalls).toLocaleString("en-US")}/${BigInt(row.calls).toLocaleString("en-US")} priced`;
}

function Kpi(props: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface/40 px-3.5 py-3">
      <p className="text-2xs font-medium text-fg-subtle">{props.label}</p>
      <p className="mt-1.5 text-xl font-semibold tracking-[-0.03em] tabular-nums text-fg">
        {props.value}
      </p>
      <p className="mt-1 text-2xs tabular-nums text-fg-muted">{props.detail}</p>
    </div>
  );
}

function WorkspaceRow(props: { name: string; detail?: string; billing: readonly Totals[] }) {
  const summary = summarizeModelUsage(props.billing);
  return (
    <tr className="border-b border-border">
      <td className="py-3 pr-4">
        <span className="text-fg">{props.name}</span>
        {props.detail ? <span className="mt-1 block text-fg-subtle">{props.detail}</span> : null}
      </td>
      <td className="py-3 text-right tabular-nums">{summary.calls.toLocaleString("en-US")}</td>
      <td className="py-3 text-right tabular-nums">{formatTokenCount(summary.totalTokens)}</td>
      <td className="py-3 text-right tabular-nums">{cacheHitLabel(summary)}</td>
      <td className="py-3 text-right tabular-nums">{formatMicrosUsd(summary.creditMicros)}</td>
      <td className="py-3 text-right tabular-nums">{externalSpendLabel(summary)}</td>
    </tr>
  );
}

export function OrganizationModelUsagePanel(props: {
  accountId: string;
  period: OrganizationUsagePeriod;
  revision: number;
  /** Charged model credits from the ledger summary for the same period, when loaded. */
  ledgerCreditMicros?: string | undefined;
}) {
  const { client } = useAppContext();
  const [cursor, setCursor] = useState<string | undefined>();
  const [attempt, setAttempt] = useState(0);
  const key = JSON.stringify([props.accountId, props.period, props.revision, cursor, attempt]);
  const [state, setState] = useState<{ key: string; data?: OrganizationModelUsage; error?: Error }>(
    { key: "" },
  );
  useEffect(() => setCursor(undefined), [props.accountId, props.period, props.revision]);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setState({ key });
    void (async () => {
      try {
        const data = await client.getOrganizationModelUsage(
          {
            accountId: props.accountId,
            period: props.period,
            ...(cursor ? { afterWorkspaceId: cursor } : {}),
          },
          { signal: controller.signal },
        );
        if (active) setState({ key, data });
      } catch (error) {
        if (active)
          setState({ key, error: error instanceof Error ? error : new Error(String(error)) });
      }
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, [client, key, props.accountId, props.period, cursor]);
  const data = state.key === key ? state.data : undefined;
  const error = state.key === key ? state.error : undefined;

  return (
    <section
      className="space-y-4 border-t border-border pt-5"
      aria-label="Organization model usage"
    >
      <div>
        <h2 className="text-sm font-semibold text-fg">Model spend</h2>
        <p className="mt-1 text-xs text-fg-muted">
          From per-call records. Credits are what OpenGeni charged; external spend is billed by
          another provider and estimated at list rates.
        </p>
      </div>
      {error ? (
        <LoadErrorState
          title="Couldn't load model usage"
          error={error}
          onRetry={() => setAttempt((value) => value + 1)}
        />
      ) : !data ? (
        <p role="status" className="text-xs text-fg-muted">
          Loading model usage
        </p>
      ) : data.billing.length === 0 ? (
        <p className="text-xs text-fg-muted">No visible model calls in this period.</p>
      ) : (
        <ModelUsageBody
          data={data}
          cursor={cursor}
          onCursor={setCursor}
          ledgerCreditMicros={props.ledgerCreditMicros}
        />
      )}
    </section>
  );
}

function ModelUsageBody(props: {
  data: OrganizationModelUsage;
  cursor: string | undefined;
  onCursor: (cursor: string | undefined) => void;
  ledgerCreditMicros: string | undefined;
}) {
  const { data } = props;
  const total = summarizeModelUsage(data.billing);
  const coverage = ledgerCoverageNote(props.ledgerCreditMicros, total.creditMicros);
  const personalCount = BigInt(data.personal.workspacesWithUsage);
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi
          label="Credits spent"
          value={formatMicrosUsd(total.creditMicros)}
          detail={`${total.creditCalls.toLocaleString("en-US")} credit-paid calls`}
        />
        <Kpi
          label="External spend · estimate"
          value={externalSpendLabel(total)}
          detail={
            total.externalCalls === 0n
              ? "No externally paid calls"
              : `${total.externalPricedCalls.toLocaleString("en-US")}/${total.externalCalls.toLocaleString("en-US")} calls priced`
          }
        />
        <Kpi
          label="Tokens"
          value={formatTokenCount(total.totalTokens)}
          detail={`${total.calls.toLocaleString("en-US")} calls`}
        />
        <Kpi
          label="Cache hit"
          value={cacheHitLabel(total)}
          detail="Share of reported input served from cache"
        />
      </div>

      {coverage ? (
        <p className="rounded-md border border-status-waiting/30 bg-status-waiting/5 px-3 py-2 text-2xs leading-5 text-fg-muted">
          {coverage}
        </p>
      ) : null}

      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <caption className="pb-3 text-left text-sm font-semibold text-fg">By model</caption>
          <thead>
            <tr className="border-b border-border text-fg-muted">
              <th className="py-2 font-medium">Model</th>
              <th className="py-2 font-medium">Billing</th>
              <th className="py-2 text-right font-medium">Calls</th>
              <th className="py-2 text-right font-medium">Tokens</th>
              <th className="py-2 text-right font-medium">Cache hit</th>
              <th className="py-2 text-right font-medium">Cost</th>
            </tr>
          </thead>
          <tbody>
            {data.models.map((row) => (
              <tr
                key={`${row.provider}:${row.model}:${row.totals.billingPath}`}
                className="border-b border-border"
              >
                <td className="py-3 pr-4">
                  <span className="text-fg">{row.model}</span>
                  <span className="mt-1 block text-fg-subtle">{row.provider}</span>
                </td>
                <td className="py-3 pr-4 text-fg-muted">
                  {row.totals.billingPath === "opengeni_credits" ? "OpenGeni credits" : "External"}
                </td>
                <td className="py-3 text-right tabular-nums">
                  {BigInt(row.totals.calls).toLocaleString("en-US")}
                </td>
                <td className="py-3 text-right tabular-nums">
                  {formatTokenCount(BigInt(row.totals.totalTokens))}
                </td>
                <td className="py-3 text-right tabular-nums">
                  {cacheHitLabel({
                    cachedTokens: BigInt(row.totals.cachedTokens),
                    cacheInputTokens: BigInt(row.totals.cacheInputTokens),
                  })}
                </td>
                <td className="py-3 text-right tabular-nums">{costLabel(row.totals)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data.modelsTruncated ? (
          <p className="pt-2 text-xs text-fg-subtle">Top 50 models by tokens; more exist.</p>
        ) : null}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <caption className="pb-3 text-left text-sm font-semibold text-fg">By workspace</caption>
          <thead>
            <tr className="border-b border-border text-fg-muted">
              <th className="py-2 font-medium">Workspace</th>
              <th className="py-2 text-right font-medium">Calls</th>
              <th className="py-2 text-right font-medium">Tokens</th>
              <th className="py-2 text-right font-medium">Cache hit</th>
              <th className="py-2 text-right font-medium">Credits</th>
              <th className="py-2 text-right font-medium">External est.</th>
            </tr>
          </thead>
          <tbody>
            {data.workspaces.map((workspace) => (
              <WorkspaceRow
                key={workspace.workspaceId}
                name={workspace.name ?? "Workspace"}
                detail={workspace.workspaceId}
                billing={workspace.billing}
              />
            ))}
            {personalCount > 0n ? (
              <WorkspaceRow
                name={`Personal workspaces (${personalCount.toLocaleString("en-US")})`}
                detail="Combined; individual Personal workspaces are not listed"
                billing={data.personal.billing}
              />
            ) : null}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-fg-subtle">
        Shared workspace rows plus the Personal workspaces row add up to the totals above when every
        shared workspace fits on this page.
      </p>
      {(props.cursor || data.nextWorkspaceCursor) && (
        <div className="flex gap-2">
          {props.cursor && (
            <Button variant="outline" size="sm" onClick={() => props.onCursor(undefined)}>
              First workspaces
            </Button>
          )}
          {data.nextWorkspaceCursor && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => props.onCursor(data.nextWorkspaceCursor!)}
            >
              Next workspaces
            </Button>
          )}
        </div>
      )}
    </>
  );
}
