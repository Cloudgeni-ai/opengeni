import { ArrowUpRightIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { BillingReceipt, ChatClient, ListBillingReceiptsResponse } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { formatMoneyMicros } from "@opengeni/react/app/lib/format";
import { Button } from "@opengeni/react/ui/button";
import { EmptyState } from "@opengeni/react/ui/empty-state";
import { ListRow, ListRowSkeleton, RowList } from "@opengeni/react/ui/list-row";
import { MetaChip } from "@opengeni/react/ui/meta-chip";
import { RowButton } from "@opengeni/react/ui/page-actions";
import { Section } from "@opengeni/react/ui/section";
import { BillingLoadFailure } from "./billing-load-failure";

const PAGE_SIZE = 10;

/* ----------------------------------------------------------------------------
   Organization settings > Billing > Receipts: every payment the organization
   made (plans, credits, automatic top-ups), newest first, each with its
   receipt. Automatic top-ups have no invoice, so Stripe's portal can't list
   them; this list can.
   -------------------------------------------------------------------------- */

export function BillingReceiptsSection({
  client,
  accountId,
}: {
  client: Pick<ChatClient<OpenGeniBrowserClient>, "listBillingReceipts">;
  accountId: string;
}) {
  const [page, setPage] = useState<ListBillingReceiptsResponse | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [moreError, setMoreError] = useState<Error | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const current = ++generation.current;
    setPage(null);
    setError(null);
    setMoreError(null);
    try {
      const result = await client.listBillingReceipts({ accountId, limit: PAGE_SIZE });
      if (current === generation.current) setPage(result);
    } catch (caught) {
      if (current === generation.current) setError(asError(caught));
    }
  }, [accountId, client]);

  useEffect(() => {
    void load();
    return () => {
      generation.current += 1;
    };
  }, [load]);

  const loadMore = useCallback(async () => {
    const cursor = page?.nextCursor;
    if (!cursor) return;
    const current = generation.current;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const result = await client.listBillingReceipts({ accountId, cursor, limit: PAGE_SIZE });
      if (current !== generation.current) return;
      setPage((previous) => ({
        receipts: [...(previous?.receipts ?? []), ...result.receipts],
        nextCursor: result.nextCursor,
      }));
    } catch (caught) {
      if (current === generation.current) setMoreError(asError(caught));
    } finally {
      if (current === generation.current) setLoadingMore(false);
    }
  }, [accountId, client, page?.nextCursor]);

  return (
    <BillingReceiptsList
      receipts={page?.receipts ?? null}
      hasMore={Boolean(page?.nextCursor)}
      loadingMore={loadingMore}
      error={error}
      moreError={moreError}
      onRetry={() => void load()}
      onLoadMore={() => void loadMore()}
    />
  );
}

/** The Receipts section itself, for the page and the DEV preview. */
export function BillingReceiptsList(props: {
  /** null while the first page loads. */
  receipts: readonly BillingReceipt[] | null;
  hasMore: boolean;
  loadingMore?: boolean | undefined;
  error?: Error | null | undefined;
  moreError?: Error | null | undefined;
  onRetry: () => void;
  onLoadMore: () => void;
}) {
  if (props.error) {
    return (
      <Section title="Receipts">
        <BillingLoadFailure
          title="Couldn't load receipts"
          denied="You can't see receipts. Ask an organization owner for access."
          error={props.error}
          onRetry={props.onRetry}
        />
      </Section>
    );
  }
  if (!props.receipts) {
    return (
      <Section title="Receipts">
        <RowList label="Receipts" busy flush>
          <ListRowSkeleton count={3} />
        </RowList>
      </Section>
    );
  }
  if (props.receipts.length === 0) {
    return (
      <Section title="Receipts">
        <EmptyState
          title="No payments yet"
          description="Receipts for plans, credits and automatic top-ups appear here."
          className="py-6"
        />
      </Section>
    );
  }
  return (
    <Section title="Receipts">
      <div className="flex min-w-0 flex-col gap-3">
        <RowList label="Receipts" flush>
          {props.receipts.map((receipt) => (
            <ReceiptRow key={receipt.id} receipt={receipt} />
          ))}
        </RowList>
        {props.moreError ? (
          <BillingLoadFailure
            title="Couldn't load more receipts"
            denied="You can't see receipts. Ask an organization owner for access."
            error={props.moreError}
            onRetry={props.onLoadMore}
          />
        ) : null}
        {props.hasMore && !props.moreError ? (
          <div className="flex justify-center">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={props.loadingMore}
              onClick={props.onLoadMore}
              className="rounded-[10px] pointer-coarse:h-11"
            >
              {props.loadingMore ? "Loading…" : "Show more"}
            </Button>
          </div>
        ) : null}
      </div>
    </Section>
  );
}

function ReceiptRow({ receipt }: { receipt: BillingReceipt }) {
  const href = receipt.invoicePdfUrl ?? receipt.receiptUrl ?? receipt.invoiceUrl;
  const date = formatReceiptDate(receipt.createdAt);
  return (
    <ListRow
      title={receipt.description}
      meta={[date]}
      status={
        receipt.amountRefunded > 0 ? (
          <MetaChip variant="text">
            {receipt.refunded || receipt.amountRefunded >= receipt.amount
              ? "Refunded"
              : `${formatMinorAmount(receipt.amountRefunded, receipt.currency)} refunded`}
          </MetaChip>
        ) : undefined
      }
      control={
        <div className="flex items-center gap-4">
          <span className="min-w-16 text-right text-sm tabular-nums">
            {formatMinorAmount(receipt.amount, receipt.currency)}
          </span>
          {href ? (
            <RowButton asChild>
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                aria-label={`Receipt for ${receipt.description} on ${date}`}
              >
                Receipt
                <ArrowUpRightIcon aria-hidden="true" />
              </a>
            </RowButton>
          ) : null}
        </div>
      }
    />
  );
}

/** Stripe amounts are in the currency's smallest unit; every Opengeni price is in cents. */
export function formatMinorAmount(amount: number, currency: string): string {
  return formatMoneyMicros(amount * 10_000, currency);
}

function formatReceiptDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
