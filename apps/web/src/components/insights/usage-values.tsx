import type { ReactNode } from "react";

import { ReasonTooltip } from "@opengeni/react/ui/disabled-reason";

import { formatCount } from "./usage-format";

/** One look for numbers in every Insights table: tabular, and quiet unless it is the row's point. */
export function Quiet(props: { children: ReactNode }) {
  return <span className="text-sm text-fg-muted tabular-nums">{props.children}</span>;
}

/** A dash with its reason, for an amount the data can't back. */
export function Unpriced(props: { reason?: string }) {
  return (
    <ReasonTooltip reason={props.reason ?? "No list price is recorded for these models yet."}>
      <span tabIndex={0} className="cursor-help text-fg-subtle" aria-label="Not priced">
        —
      </span>
    </ReasonTooltip>
  );
}

/** The small asterisk after an amount that leaves out calls without a list price. */
export function PartlyUnpricedMark(props: { calls: number; pricedCalls: number }) {
  return (
    <ReasonTooltip
      reason={`${formatCount(props.calls - props.pricedCalls)} of ${formatCount(props.calls)} calls have no list price yet and aren't counted.`}
    >
      <span tabIndex={0} className="ml-0.5 cursor-help align-super text-2xs text-fg-subtle">
        *
      </span>
    </ReasonTooltip>
  );
}
