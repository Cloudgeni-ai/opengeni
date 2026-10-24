/**
 * Rows for a source's events and its delivery log. Each row expands in place
 * to show what arrived. Use them inside a RowList with the matching columns.
 */
import { ExternalLinkIcon, RotateCcwIcon } from "lucide-react";

import { EVENT_DELIVERY_BODY_RETENTION_DAYS } from "@opengeni/contracts/event-triggers";
import type { EventDelivery, InboundEvent, InboundEventSummary } from "@opengeni/sdk";

import { useOpenGeniText, type OpenGeniText } from "../../messages/runtime";
import { DropdownMenuItem } from "../../ui/dropdown-menu";
import { ListRow, type RowListColumn } from "../../ui/list-row";
import { RelativeTime } from "../../ui/relative-time";
import { StatusBadge } from "../../ui/status-badge";
import {
  byteSizeLabel,
  deliveryTitle,
  eventActorLabel,
  eventDeliveryStatusBadge,
} from "./event-source-model";
import { eventTypeLabel } from "./event-trigger-model";

/** The columns of a RowList of InboundEventRow or EventDeliveryRow: when it arrived. */
export function eventRowColumns(t: OpenGeniText): RowListColumn[] {
  return [
    {
      id: "received",
      label: t("automations.rows.received"),
      width: 132,
      align: "end",
      hideLabel: true,
    },
  ];
}

/** The quiet facts under an event: its type, who caused it and what it is about. */
export function inboundEventMeta(t: OpenGeniText, event: InboundEventSummary): string[] {
  return [eventTypeLabel(t, event.type), eventActorLabel(t, event.actor), event.subject].filter(
    (part): part is string => Boolean(part),
  );
}

/** One normalized event; expands to its data. */
export function InboundEventRow({
  event,
  expanded,
  onToggle,
}: {
  event: InboundEvent;
  expanded: boolean;
  onToggle: () => void;
}) {
  const t = useOpenGeniText();
  return (
    <ListRow
      title={event.summary}
      meta={inboundEventMeta(t, event)}
      status={
        event.gapBefore ? (
          <StatusBadge variant="dot" tone="attention" reason={t("automations.rows.gapReason")}>
            {t("automations.rows.gap")}
          </StatusBadge>
        ) : undefined
      }
      cells={{ received: <RelativeTime date={event.receivedAt} /> }}
      expanded={expanded}
      onOpen={onToggle}
      panel={<InboundEventDetail event={event} />}
    />
  );
}

export function InboundEventDetail({ event }: { event: InboundEvent }) {
  const t = useOpenGeniText();
  return (
    <div className="flex min-w-0 flex-col gap-2 pb-3">
      <dl className="m-0 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs leading-4.5">
        <dt className="text-fg-muted">{t("automations.rows.type")}</dt>
        <dd className="m-0 min-w-0 font-mono break-all text-fg">{event.type}</dd>
        <dt className="text-fg-muted">{t("automations.rows.happened")}</dt>
        <dd className="m-0 text-fg">
          <RelativeTime date={event.occurredAt} format="absolute" />
        </dd>
        {event.url ? (
          <>
            <dt className="text-fg-muted">{t("automations.rows.link")}</dt>
            <dd className="m-0 min-w-0">
              <a
                href={event.url}
                target="_blank"
                rel="noreferrer"
                className="og-link inline-flex max-w-full items-center gap-1"
              >
                <span className="min-w-0 truncate">{event.url}</span>
                <ExternalLinkIcon aria-hidden="true" className="size-3 shrink-0" />
              </a>
            </dd>
          </>
        ) : null}
      </dl>
      <pre className="m-0 max-h-72 min-w-0 overflow-auto rounded-md border border-border bg-surface-2 p-3 font-mono text-xs leading-4.5 text-fg">
        {JSON.stringify(event.data, null, 2)}
      </pre>
      {event.dataTruncated ? (
        <p className="m-0 text-xs leading-4.5 text-fg-muted">
          {t("automations.rows.dataTruncated")}
        </p>
      ) : null}
    </div>
  );
}

/** One delivery in a source's log; replay sits in its menu. */
export function EventDeliveryRow({
  delivery,
  canReplay,
  replaying = false,
  onReplay,
  expanded,
  onToggle,
}: {
  delivery: EventDelivery;
  /** The viewer manages the source and the raw body is still kept. */
  canReplay: boolean;
  replaying?: boolean | undefined;
  onReplay: () => void;
  expanded: boolean;
  onToggle: () => void;
}) {
  const t = useOpenGeniText();
  const status = eventDeliveryStatusBadge(t, delivery.status);
  const meta = [
    byteSizeLabel(t, delivery.bodyBytes),
    delivery.duplicateCount > 0
      ? t("automations.rows.sentAgain", { count: delivery.duplicateCount })
      : null,
    delivery.replayOfDeliveryId ? t("automations.rows.replay") : null,
  ].filter((part): part is string => Boolean(part));
  return (
    <ListRow
      title={deliveryTitle(t, delivery)}
      description={delivery.reason ?? undefined}
      meta={meta}
      status={
        <StatusBadge variant="dot" status={status.status}>
          {status.label}
        </StatusBadge>
      }
      cells={{ received: <RelativeTime date={delivery.receivedAt} /> }}
      menu={
        canReplay ? (
          <DropdownMenuItem disabled={replaying} onSelect={onReplay}>
            <RotateCcwIcon />
            {t("automations.rows.replay")}
          </DropdownMenuItem>
        ) : undefined
      }
      menuLabel={t("automations.rows.deliveryActions")}
      expanded={expanded}
      onOpen={onToggle}
      panel={
        <div className="pb-3 text-xs leading-4.5 text-fg-muted">
          {delivery.bodyRetained
            ? t("automations.rows.bodyKept", { days: EVENT_DELIVERY_BODY_RETENTION_DAYS })
            : t("automations.rows.bodyGone")}{" "}
          {delivery.eventIds.length > 0
            ? t("automations.rows.became", { count: delivery.eventIds.length })
            : t("automations.rows.noEvents")}
        </div>
      }
    />
  );
}
