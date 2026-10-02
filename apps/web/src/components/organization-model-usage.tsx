import type { OrganizationUsagePeriod } from "@opengeni/contracts";
import type {
  OrganizationModelUsage,
  OrganizationModelUsageTotals,
} from "@opengeni/contracts/organization-model-usage";
import { useEffect, useState } from "react";
import { useAppContext } from "@/context";
import { ListRow, RowList, type RowListColumn } from "@/components/ui/list-row";
import { LogoTile } from "@/components/ui/logo-tile";
import { Notice } from "@/components/ui/notice";
import { ErrorMessage } from "@/components/ui/error-message";
import { RowButton } from "@/components/ui/page-actions";
import { Section } from "@/components/ui/section";
import { providerLabel } from "@/components/insights/mock-data";
import {
  payerLabel,
  PAYER_ORDER,
  rowPayerLabel,
  usagePayer,
  type UsagePayer,
} from "@/components/insights/payer";
import { apiErrorAdvice, apiErrorDetails } from "@/lib/api-error";

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
  const halfUp =
    (summary.cachedTokens * 200n + summary.cacheInputTokens) / (summary.cacheInputTokens * 2n);
  return `${Number(halfUp)}%`;
}

/** Credits are charged; external spend is only an estimate, and only when priced. */
export function externalSpendLabel(summary: Summary): string {
  if (summary.externalCalls === 0n) return formatMicrosUsd(0n);
  if (summary.externalPricedCalls === 0n) return "Unknown";
  return `~${formatMicrosUsd(summary.externalEstimateMicros)}`;
}

/** Table cells have no detail line, so a partial estimate names its coverage inline. */
export function externalSpendCellLabel(summary: Summary): string {
  const label = externalSpendLabel(summary);
  if (summary.externalPricedCalls === 0n || summary.externalPricedCalls === summary.externalCalls) {
    return label;
  }
  return `${label} · ${summary.externalPricedCalls.toLocaleString("en-US")}/${summary.externalCalls.toLocaleString("en-US")} priced`;
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
    ? `${formatMicrosUsd(gap)} of the ${formatMicrosUsd(ledger)} charged has no per-call record yet, so the lists below add up to ${formatMicrosUsd(breakdownCreditMicros)}. Missing records are rebuilt from each call's usage automatically.`
    : `The per-call records add up to ${formatMicrosUsd(-gap)} more than the ${formatMicrosUsd(ledger)} charged in this period.`;
}

type PayerRow = {
  payer: UsagePayer;
  calls: bigint;
  tokens: bigint;
  /** Credits charged, or the list-price estimate for a plan or own key. */
  micros: bigint;
  pricedCalls: bigint;
};

type PayerTotals = Omit<Totals, "billingPath"> & { payer: UsagePayer };

/**
 * Spend by who pays. Uses the server's per-payer totals; an older API replica
 * without them falls back to the listed models, which may be capped.
 */
export function organizationPayerRows(data: {
  payers?: readonly PayerTotals[] | undefined;
  models: OrganizationModelUsage["models"];
}): PayerRow[] {
  const rows = new Map<UsagePayer, PayerRow>();
  const add = (payer: UsagePayer, totals: Omit<Totals, "billingPath">) => {
    const row = rows.get(payer) ?? { payer, calls: 0n, tokens: 0n, micros: 0n, pricedCalls: 0n };
    row.calls += BigInt(totals.calls);
    row.tokens += BigInt(totals.totalTokens);
    if (payer === "opengeni_credits") {
      row.micros += BigInt(totals.creditMicros);
      row.pricedCalls += BigInt(totals.calls);
    } else {
      row.micros += BigInt(totals.estimatedProviderMicros);
      row.pricedCalls += BigInt(totals.estimatedProviderKnownCalls);
    }
    rows.set(payer, row);
  };
  if (data.payers) for (const row of data.payers) add(row.payer, row);
  else
    for (const row of data.models)
      add(usagePayer(row.totals.billingPath, row.provider), row.totals);
  return PAYER_ORDER.flatMap((payer) => {
    const row = rows.get(payer);
    return row && row.calls > 0n ? [row] : [];
  });
}

function payerAmount(row: PayerRow): string {
  if (row.payer === "opengeni_credits") return formatMicrosUsd(row.micros);
  if (row.pricedCalls === 0n) return "Unknown";
  return `~${formatMicrosUsd(row.micros)}`;
}

function modelAmount(row: Totals): string {
  if (row.billingPath === "opengeni_credits") return formatMicrosUsd(BigInt(row.creditMicros));
  if (row.estimatedProviderKnownCalls === "0") return "Unknown";
  return `~${formatMicrosUsd(BigInt(row.estimatedProviderMicros))}`;
}

const PAYER_COLUMNS: RowListColumn[] = [
  // Amount first: on a phone the row folds to its first fact.
  { id: "amount", label: "Amount", width: 120, align: "end" },
  { id: "calls", label: "Calls", width: 96, align: "end" },
  { id: "tokens", label: "Tokens", width: 96, align: "end" },
];

const MODEL_COLUMNS: RowListColumn[] = [
  { id: "amount", label: "Amount", width: 112, align: "end" },
  { id: "tokens", label: "Tokens", width: 88, align: "end" },
  { id: "calls", label: "Calls", width: 88, align: "end" },
  { id: "cache", label: "Cache hit", width: 80, align: "end" },
];

const PAYER_MONOGRAM = { opengeni_credits: "C", subscription: "S", own_key: "K" } as const;

function Quiet(props: { children: string }) {
  return <span className="text-fg-muted tabular-nums">{props.children}</span>;
}

/**
 * Organization model spend from per-call records: who paid, and on which
 * models. Every workspace counts, other people's private chats included.
 */
export function OrganizationModelUsagePanel(props: {
  accountId: string;
  period: OrganizationUsagePeriod;
  revision: number;
  /** Charged model credits from the ledger summary for the same period, when loaded. */
  ledgerCreditMicros?: string | undefined;
}) {
  const { client } = useAppContext();
  const [attempt, setAttempt] = useState(0);
  const key = JSON.stringify([props.accountId, props.period, props.revision, attempt]);
  const [state, setState] = useState<{ key: string; data?: OrganizationModelUsage; error?: Error }>(
    { key: "" },
  );
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setState({ key });
    void (async () => {
      try {
        const data = await client.getOrganizationModelUsage(
          { accountId: props.accountId, period: props.period },
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
  }, [client, key, props.accountId, props.period]);
  const data = state.key === key ? state.data : undefined;
  const error = state.key === key ? state.error : undefined;

  if (error) {
    return (
      <Section title="Paid with">
        <ErrorMessage
          variant="block"
          title="Couldn't load model spend"
          announce
          action={<RowButton onClick={() => setAttempt((value) => value + 1)}>Try again</RowButton>}
          {...apiErrorDetails(error)}
        >
          {apiErrorAdvice(error)}
        </ErrorMessage>
      </Section>
    );
  }
  // The usage section above already says when a period is loading or empty.
  if (!data || data.billing.length === 0) return null;
  const total = summarizeModelUsage(data.billing);
  const coverage = ledgerCoverageNote(props.ledgerCreditMicros, total.creditMicros);
  const payers = organizationPayerRows(
    data as OrganizationModelUsage & { payers?: readonly PayerTotals[] },
  );
  return (
    <>
      <Section
        title="Paid with"
        description="Credits are what Opengeni charged. A connected plan or your own API key is paid outside Opengeni, so its amount is the provider's list price."
      >
        {coverage ? (
          <Notice tone="waiting" title="Some charges aren't broken down yet">
            {coverage}
          </Notice>
        ) : null}
        <RowList
          variant="table"
          label="Spend by who pays"
          nameLabel="Paid with"
          columns={PAYER_COLUMNS}
          flush
        >
          {payers.map((row) => (
            <ListRow
              key={row.payer}
              leading={
                <LogoTile monogram={PAYER_MONOGRAM[row.payer]} name={payerLabel(row.payer)} />
              }
              title={payerLabel(row.payer)}
              meta={[
                row.payer === "opengeni_credits" ? "Charged" : "At list price, not charged",
                ...(row.payer !== "opengeni_credits" && row.pricedCalls < row.calls
                  ? [
                      `${row.pricedCalls.toLocaleString("en-US")} of ${row.calls.toLocaleString("en-US")} calls priced`,
                    ]
                  : []),
              ]}
              cells={{
                calls: <Quiet>{row.calls.toLocaleString("en-US")}</Quiet>,
                tokens: <Quiet>{formatTokenCount(row.tokens)}</Quiet>,
                amount: <span className="text-fg tabular-nums">{payerAmount(row)}</span>,
              }}
            />
          ))}
        </RowList>
      </Section>
      <Section
        title="By model"
        description={
          data.modelsTruncated
            ? "The 50 models that used the most tokens in every workspace."
            : "Every workspace, private chats included."
        }
      >
        <RowList
          variant="table"
          label="Spend by model"
          nameLabel="Model"
          columns={MODEL_COLUMNS}
          flush
        >
          {data.models.map((row) => (
            <ListRow
              key={`${row.provider}:${row.model}:${row.totals.billingPath}`}
              leading={<LogoTile name={row.model} />}
              title={row.model}
              meta={[
                providerLabel(row.provider),
                rowPayerLabel(row.totals.billingPath, row.provider),
              ]}
              cells={{
                calls: <Quiet>{BigInt(row.totals.calls).toLocaleString("en-US")}</Quiet>,
                tokens: (
                  <span className="text-fg tabular-nums">
                    {formatTokenCount(BigInt(row.totals.totalTokens))}
                  </span>
                ),
                cache: (
                  <Quiet>
                    {cacheHitLabel({
                      cachedTokens: BigInt(row.totals.cachedTokens),
                      cacheInputTokens: BigInt(row.totals.cacheInputTokens),
                    })}
                  </Quiet>
                ),
                amount: <span className="text-fg tabular-nums">{modelAmount(row.totals)}</span>,
              }}
            />
          ))}
        </RowList>
      </Section>
    </>
  );
}
