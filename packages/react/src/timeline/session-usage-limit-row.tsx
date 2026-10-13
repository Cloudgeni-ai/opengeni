import { formatSessionUsageMicros } from "@opengeni/sdk/session-usage-limits";
import { GaugeIcon } from "lucide-react";

import { cn } from "../lib/cn";
import { DEFAULT_SESSION_USAGE_LIMIT_LABELS } from "../usage/session-usage-limit";
import { useEntranceAnimation } from "./entrance";
import type { SessionUsageLimitStop } from "./types";

/**
 * The task's usage limit stopped further model requests. Calm by design:
 * nothing failed, the conversation is kept, and the row names the amounts
 * without implying only the final request caused the overshoot. Never a
 * credits or purchase remedy; the editor lives with the host's notice.
 */
export function SessionUsageLimitRow({ stop }: { stop: SessionUsageLimitStop }) {
  const enter = useEntranceAnimation();
  const labels = DEFAULT_SESSION_USAGE_LIMIT_LABELS;
  const amount =
    stop.usedMicros !== null && stop.limitMicros !== null
      ? labels.reachedAmount(
          labels.usedOfLimit(
            formatSessionUsageMicros(stop.usedMicros),
            formatSessionUsageMicros(stop.limitMicros),
          ),
        )
      : null;
  return (
    <div
      className={cn(
        enter && "animate-og-enter",
        "flex items-start gap-2.5 rounded-og-md border border-og-border bg-og-surface-1 px-3.5 py-2.5 text-og-menu text-og-fg",
      )}
      role="status"
      data-og-session-usage-limit-stop=""
    >
      <GaugeIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-og-status-waiting" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{labels.reachedTitle}</p>
        <p className="mt-0.5 text-og-fg-muted">
          {amount ? `${amount} ` : ""}
          {labels.reachedRemedy}
        </p>
      </div>
    </div>
  );
}
