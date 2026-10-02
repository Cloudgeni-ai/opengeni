import type { ReactNode } from "react";
import type { InsightsModelUsageRow, InsightsProjectRow, InsightsSpendDriver } from "@opengeni/sdk";

import { LockGlyph } from "./lock-glyph";
import { LogoTile } from "@/components/ui/logo-tile";
import { ListRow, RowList, type RowListColumn } from "@/components/ui/list-row";
import { MetaChip } from "@/components/ui/meta-chip";
import { StatGroup, StatTile, type StatDelta } from "@/components/ui/stat-tile";

import { formatCachePct, formatTokens, formatUsd, providerLabel } from "./mock-data";
import { payerLabel, rowPayerLabel, type PayerTotal } from "./payer";

/* ----------------------------------------------------------------------------
   The usage half of Insights: how much was spent, who paid for it, and on
   which models, projects and sessions. Every list is a RowList table, so the
   fact columns fold into the meta line on a phone instead of scrolling.
   -------------------------------------------------------------------------- */

/** "$12.40", "~$3.10" for a list-price estimate, "Unknown" when nothing was priced. */
export function amountLabel(amountUsd: number, estimated: boolean, pricedCalls: number): string {
  if (estimated && pricedCalls === 0) return "Unknown";
  return `${estimated ? "~" : ""}${formatUsd(amountUsd, 2)}`;
}

/** "3 of 5 calls priced" when an estimate leaves calls out; nothing otherwise. */
function pricedNote(total: { estimated: boolean; pricedCalls: number; calls: number }) {
  return total.estimated && total.pricedCalls < total.calls
    ? `${total.pricedCalls.toLocaleString()} of ${total.calls.toLocaleString()} calls priced`
    : null;
}

function Amount(props: { children: ReactNode; title?: string }) {
  return (
    <span className="text-fg tabular-nums" title={props.title}>
      {props.children}
    </span>
  );
}

function Quiet(props: { children: ReactNode }) {
  return <span className="text-fg-muted tabular-nums">{props.children}</span>;
}

/* ------------------------------------------------------------- Stat tiles */

export interface UsageStatsProps {
  label: string;
  spend: { value: string; caption: string; delta?: StatDelta | undefined };
  tokens: { value: string; caption?: string | undefined; delta?: StatDelta | undefined };
  calls: { value: string; caption?: string | undefined; delta?: StatDelta | undefined };
  cache: { value: string; caption?: string | undefined; delta?: StatDelta | undefined };
}

export function UsageStats(props: UsageStatsProps) {
  return (
    <StatGroup label={props.label}>
      <StatTile
        label="Spend"
        value={props.spend.value}
        delta={props.spend.delta}
        caption={props.spend.caption}
      />
      <StatTile
        label="Tokens"
        value={props.tokens.value}
        delta={props.tokens.delta}
        caption={props.tokens.caption}
      />
      <StatTile
        label="Model calls"
        value={props.calls.value}
        delta={props.calls.delta}
        caption={props.calls.caption}
      />
      <StatTile
        label="Cache hit"
        value={props.cache.value}
        delta={props.cache.delta}
        caption={props.cache.caption}
      />
    </StatGroup>
  );
}

/** A percent change as a StatTile delta; undefined when there is nothing to compare. */
export function percentDelta(
  pct: number | null,
  comparison: string,
  unit: "%" | " pts" = "%",
): StatDelta | undefined {
  if (pct === null) return undefined;
  return {
    value: `${pct > 0 ? "+" : ""}${pct}${unit}`,
    trend: pct > 0 ? "up" : pct < 0 ? "down" : "flat",
    comparison,
  };
}

/* --------------------------------------------------------------- Paid with */

const PAID_WITH_COLUMNS: RowListColumn[] = [
  { id: "calls", label: "Calls", width: 96, align: "end" },
  { id: "tokens", label: "Tokens", width: 96, align: "end" },
  { id: "amount", label: "Amount", width: 120, align: "end" },
];

const PAYER_MONOGRAM = { opengeni_credits: "C", subscription: "S", own_key: "K" } as const;

export function PaidWithList(props: { totals: readonly PayerTotal[] }) {
  return (
    <RowList
      variant="table"
      label="Spend by who pays"
      nameLabel="Paid with"
      columns={PAID_WITH_COLUMNS}
    >
      {props.totals.map((total) => {
        const note = pricedNote(total);
        return (
          <ListRow
            key={total.payer}
            leading={
              <LogoTile monogram={PAYER_MONOGRAM[total.payer]} name={payerLabel(total.payer)} />
            }
            title={payerLabel(total.payer)}
            meta={[
              total.estimated ? "At list price, not charged" : "Charged",
              ...(note ? [note] : []),
            ]}
            cells={{
              calls: <Quiet>{total.calls.toLocaleString()}</Quiet>,
              tokens: <Quiet>{formatTokens(total.tokens)}</Quiet>,
              amount: (
                <Amount>{amountLabel(total.amountUsd, total.estimated, total.pricedCalls)}</Amount>
              ),
            }}
          />
        );
      })}
    </RowList>
  );
}

/* --------------------------------------------------------------- By model */

const MODEL_COLUMNS: RowListColumn[] = [
  { id: "payer", label: "Paid with", width: 128 },
  { id: "calls", label: "Calls", width: 80, align: "end" },
  { id: "tokens", label: "Tokens", width: 88, align: "end" },
  { id: "cache", label: "Cache hit", width: 80, align: "end" },
  { id: "amount", label: "Amount", width: 104, align: "end" },
];

function hitPct(cached: number, input: number): number | null {
  if (input <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((cached / input) * 100)));
}

/** Input, cache and output as one tooltip line, so the column stays one number. */
function tokenBreakdown(row: InsightsModelUsageRow): string | undefined {
  if (row.tokenKnownCalls === 0) return undefined;
  const parts = [
    `${formatTokens(row.inputTokens)} input`,
    ...(row.cacheKnownCalls > 0 ? [`${formatTokens(row.cachedTokens)} from cache`] : []),
    `${formatTokens(row.outputTokens)} output`,
  ];
  return parts.join(" · ");
}

export function ModelUsageList(props: {
  models: readonly InsightsModelUsageRow[];
  /** The model the page is filtered to, if any. */
  selected: { provider: string; model: string } | null;
  onSelect: (row: InsightsModelUsageRow) => void;
}) {
  return (
    <RowList variant="table" label="Usage by model" nameLabel="Model" columns={MODEL_COLUMNS}>
      {props.models.map((row) => {
        const estimated = row.billing !== "opengeni_credits";
        const amount = estimated ? row.estimatedProviderUsd : row.creditUsd;
        const priced = estimated ? row.estimatedProviderCostKnownCalls : row.calls;
        const selected =
          props.selected?.provider === row.provider && props.selected.model === row.model;
        return (
          <ListRow
            key={row.id}
            leading={<LogoTile name={row.model} />}
            title={row.model}
            meta={[providerLabel(row.provider)]}
            selected={selected}
            onOpen={selected ? undefined : () => props.onSelect(row)}
            cells={{
              payer: <Quiet>{rowPayerLabel(row.billing, row.provider)}</Quiet>,
              calls: <Quiet>{row.calls.toLocaleString()}</Quiet>,
              tokens: (
                <Amount title={tokenBreakdown(row)}>
                  {row.tokenKnownCalls === 0 ? "Unknown" : formatTokens(row.totalTokens)}
                </Amount>
              ),
              cache: (
                <Quiet>
                  {row.cacheKnownCalls === 0
                    ? "Unknown"
                    : formatCachePct(hitPct(row.cachedTokens, row.cacheInputTokens))}
                </Quiet>
              ),
              amount: (
                <Amount title={estimated ? "At list price, not charged" : "Charged"}>
                  {amountLabel(amount, estimated, priced)}
                </Amount>
              ),
            }}
          />
        );
      })}
    </RowList>
  );
}

/* ------------------------------------------------------------- By project */

const PROJECT_COLUMNS: RowListColumn[] = [
  { id: "tokens", label: "Tokens", width: 88, align: "end" },
  { id: "sessions", label: "Sessions", width: 88, align: "end" },
  { id: "share", label: "Share", width: 72, align: "end" },
  { id: "credits", label: "Credits", width: 96, align: "end" },
  { id: "listPrice", label: "At list price", width: 112, align: "end" },
];

const PROJECT_META: Record<InsightsProjectRow["kind"], string | null> = {
  project: null,
  other: "Smaller projects together",
  unfiled: "Sessions outside a project",
  unavailable: "Other people's private chats. Amounts only.",
};

export function ProjectUsageList(props: { projects: readonly InsightsProjectRow[] }) {
  const tokenTotal = props.projects.reduce((sum, project) => sum + project.tokens, 0);
  return (
    <RowList variant="table" label="Usage by project" nameLabel="Project" columns={PROJECT_COLUMNS}>
      {props.projects.map((project) => {
        const meta = PROJECT_META[project.kind];
        return (
          <ListRow
            key={project.id}
            leading={
              project.kind === "unavailable" ? (
                <LogoTile icon={<LockGlyph />} name="Private chats" />
              ) : (
                <LogoTile name={project.label} />
              )
            }
            title={project.kind === "unavailable" ? "Private chats" : project.label}
            meta={meta ? [meta] : undefined}
            cells={{
              sessions: <Quiet>{project.rootSessions.toLocaleString()}</Quiet>,
              tokens: <Amount>{formatTokens(project.tokens)}</Amount>,
              share: (
                <Quiet>
                  {tokenTotal > 0 ? `${Math.round((project.tokens / tokenTotal) * 100)}%` : "-"}
                </Quiet>
              ),
              credits: <Amount>{formatUsd(project.creditUsd, 2)}</Amount>,
              listPrice: (
                <Quiet>
                  {amountLabel(
                    project.estimatedProviderUsd,
                    true,
                    project.estimatedProviderCostKnownCalls,
                  )}
                </Quiet>
              ),
            }}
          />
        );
      })}
    </RowList>
  );
}

/* ------------------------------------------------------------ By session */

/** Amounts from other people's private chats: a person and a sum, never a session. */
export interface PrivateSpendRow {
  key: string;
  person: string;
  you: boolean;
  calls: number;
  tokens: number;
  creditUsd: number;
  listPriceUsd: number;
  listPricedCalls: number;
}

const SESSION_COLUMNS: RowListColumn[] = [
  { id: "tokens", label: "Tokens", width: 88, align: "end" },
  { id: "share", label: "Share", width: 72, align: "end" },
  { id: "cache", label: "Cache hit", width: 80, align: "end" },
  { id: "credits", label: "Credits", width: 96, align: "end" },
  { id: "listPrice", label: "At list price", width: 112, align: "end" },
];

export function SessionUsageList(props: {
  drivers: readonly InsightsSpendDriver[];
  privateRows: readonly PrivateSpendRow[];
  /** Every token in the selection, so a share is of the whole and not of the rows shown. */
  totalTokens: number;
  /** The root session the page is scoped to, if any. */
  selectedRootId: string | null;
  rootIdOf: (driver: InsightsSpendDriver) => string | null;
  onSelect: (rootId: string, label: string) => void;
}) {
  const share = (tokens: number) =>
    props.totalTokens > 0 ? `${Math.round((tokens / props.totalTokens) * 100)}%` : "-";
  return (
    <RowList variant="table" label="Usage by session" nameLabel="Session" columns={SESSION_COLUMNS}>
      {props.drivers.map((driver) => {
        const rootId = props.rootIdOf(driver);
        const selected = rootId !== null && rootId === props.selectedRootId;
        return (
          <ListRow
            key={driver.id}
            leading={<LogoTile name={driver.label} />}
            title={driver.label}
            selected={selected}
            onOpen={rootId && !selected ? () => props.onSelect(rootId, driver.label) : undefined}
            cells={{
              tokens: <Amount>{formatTokens(driver.tokens)}</Amount>,
              share: <Quiet>{share(driver.tokens)}</Quiet>,
              cache: <Quiet>{formatCachePct(driver.cacheHitPct)}</Quiet>,
              credits: <Amount>{formatUsd(driver.creditUsd, 2)}</Amount>,
              listPrice: (
                <Quiet>
                  {amountLabel(
                    driver.estimatedProviderUsd,
                    true,
                    driver.estimatedProviderCostKnownCalls,
                  )}
                </Quiet>
              ),
            }}
          />
        );
      })}
      {props.privateRows.map((row) => (
        <ListRow
          key={row.key}
          leading={<LogoTile icon={<LockGlyph />} name={row.person} />}
          title={`${row.person}: private chats`}
          titleAddon={row.you ? <MetaChip variant="outline">You</MetaChip> : undefined}
          meta={["Amounts only. The chats stay private."]}
          cells={{
            tokens: <Amount>{formatTokens(row.tokens)}</Amount>,
            share: <Quiet>{share(row.tokens)}</Quiet>,
            cache: <Quiet>-</Quiet>,
            credits: <Amount>{formatUsd(row.creditUsd, 2)}</Amount>,
            listPrice: <Quiet>{amountLabel(row.listPriceUsd, true, row.listPricedCalls)}</Quiet>,
          }}
        />
      ))}
    </RowList>
  );
}
