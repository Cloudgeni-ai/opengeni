/**
 * What an automation listens for, read-only: one line per trigger with its
 * source's logo, the events, where they come from and only-when conditions,
 * and why a trigger is held back when it is.
 */
import type { MouseEvent } from "react";

import type { EventSource, EventTrigger } from "@opengeni/sdk";

import { StatusBadge } from "../../ui/status-badge";
import { eventSourceStatusBadge } from "./event-source-model";
import { EventSourceTile, type EventSourceLogoResolver } from "./event-source-tile";
import { eventTriggerWords } from "./event-trigger-model";

export interface EventTriggerSummaryProps {
  triggers: readonly EventTrigger[];
  /** The sources the viewer can see; a trigger on any other reads as hidden. */
  sources: readonly EventSource[] | undefined;
  sourceLogo?: EventSourceLogoResolver | undefined;
  /** A link to a source's page, when the host has one. */
  sourceHref?: ((sourceId: string) => string) | undefined;
  /** In-app navigation for that link; a plain link without it. */
  onOpenSource?: ((sourceId: string, event: MouseEvent<HTMLAnchorElement>) => void) | undefined;
}

export function EventTriggerSummary({
  triggers,
  sources,
  sourceLogo,
  sourceHref,
  onOpenSource,
}: EventTriggerSummaryProps) {
  return (
    <ul className="m-0 flex min-w-0 list-none flex-col gap-3 p-0">
      {triggers.map((trigger) => {
        const source = sources?.find((candidate) => candidate.id === trigger.sourceId);
        const words = eventTriggerWords(trigger, sources ?? []);
        const held = eventSourceStatusBadge(trigger);
        return (
          <li key={trigger.id} className="flex min-w-0 items-start gap-3">
            <EventSourceTile
              source={
                source ?? { kind: trigger.sourceKind, adapter: null, name: words.source, mcp: null }
              }
              logo={sourceLogo}
              size="sm"
            />
            <div className="min-w-0 flex-1">
              <p className="m-0 text-sm leading-5 break-words text-fg">{words.events}</p>
              <p className="m-0 text-xs leading-4.5 break-words text-fg-muted">
                From{" "}
                {!source ? (
                  "a source you can't see"
                ) : sourceHref ? (
                  <a
                    className="og-link"
                    href={sourceHref(source.id)}
                    onClick={onOpenSource ? (event) => onOpenSource(source.id, event) : undefined}
                  >
                    {source.name}
                  </a>
                ) : (
                  source.name
                )}
                {words.conditions ? `, ${words.conditions}` : null}
              </p>
            </div>
            {held ? (
              <StatusBadge
                variant="dot"
                status={held.status}
                reason={held.reason ?? undefined}
                className="shrink-0"
              >
                {held.label}
              </StatusBadge>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
