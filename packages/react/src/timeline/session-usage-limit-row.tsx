import { formatSessionUsageMicros } from "@opengeni/sdk/session-usage-limits";
import { GaugeIcon } from "lucide-react";

import { cn } from "../lib/cn";
import { DEFAULT_SESSION_USAGE_LIMIT_LABELS } from "../usage/session-usage-limit";
import { useEntranceAnimation } from "./entrance";
import type { SessionUsageLimitStop } from "./types";

/**
 * A compact historical marker: the task's usage limit stopped further model
 * requests here. One calm line with the amounts at the stop (the overshoot is
 * kept, without implying only the final request caused it). The current
 * state and the one recovery action live in the host's composer notice, so
 * this row repeats neither. Never a credits or purchase remedy.
 */
export function SessionUsageLimitRow({ stop }: { stop: SessionUsageLimitStop }) {
  const enter = useEntranceAnimation();
  const labels = DEFAULT_SESSION_USAGE_LIMIT_LABELS;
  const amount =
    stop.usedMicros !== null && stop.limitMicros !== null
      ? labels.usedOfLimit(
          formatSessionUsageMicros(stop.usedMicros),
          formatSessionUsageMicros(stop.limitMicros),
        )
      : null;
  return (
    <p
      className={cn(
        enter && "animate-og-enter",
        "flex min-w-0 items-center gap-2 text-og-sm text-og-fg-muted",
      )}
      role="status"
      data-og-session-usage-limit-stop=""
    >
      <GaugeIcon aria-hidden className="size-3.5 shrink-0 text-og-status-waiting" />
      <span className="min-w-0">
        <span className="font-medium text-og-fg">{labels.reachedTitle}</span>
        {amount ? ` · ${amount}` : ""}
      </span>
    </p>
  );
}
