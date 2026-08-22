import { CalendarClockIcon, Loader2Icon, TriangleAlertIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import type { RailAggregateStatus } from "@/lib/sessions-group";

/** The one descendant-aware status marker shared by rows and section headers. */
function RailAggregateDot({ summary }: { summary: RailAggregateStatus }) {
  if (summary.kind === "neutral") return null;
  if (summary.kind === "active") {
    return (
      <Loader2Icon
        aria-hidden="true"
        className="size-3 shrink-0 animate-spin text-fg-subtle motion-reduce:animate-none"
      />
    );
  }
  if (summary.kind === "active_work") {
    return (
      <span
        aria-hidden="true"
        className="inline-flex size-2.5 shrink-0 rounded-full border border-brand"
        style={{
          backgroundImage:
            "repeating-linear-gradient(-12deg, var(--og-color-accent) 0 2px, transparent 2px 3.5px)",
        }}
      />
    );
  }
  if (summary.kind === "send_failed") {
    return (
      <TriangleAlertIcon aria-hidden="true" className="size-3.5 shrink-0 text-status-failed" />
    );
  }
  const tone =
    summary.kind === "needs_attention"
      ? "bg-status-waiting"
      : summary.kind === "failed"
        ? "bg-status-failed"
        : "bg-brand";
  return (
    <span
      aria-hidden="true"
      className={cn("relative inline-flex size-2 shrink-0 rounded-full", tone)}
    />
  );
}

export function RailTrailingMetadata({
  summary,
  scheduled = false,
  relativeTime,
}: {
  summary: RailAggregateStatus;
  scheduled?: boolean;
  relativeTime?: string | undefined;
}) {
  const hasStatusMarker = summary.kind !== "neutral";
  const hasRelativeTime = Boolean(relativeTime);
  if (!scheduled && !hasStatusMarker && !hasRelativeTime) return null;
  return (
    <span data-session-row-metadata className="inline-flex shrink-0 items-center justify-end gap-1">
      {scheduled ? (
        <CalendarClockIcon
          aria-label="Scheduled task"
          className="size-3.5 shrink-0 text-fg-subtle"
        />
      ) : null}
      {hasStatusMarker ? (
        <span className="flex size-3 items-center justify-center" title={summary.label}>
          <RailAggregateDot summary={summary} />
        </span>
      ) : null}
      {hasRelativeTime ? (
        <span className="min-w-9 shrink-0 whitespace-nowrap text-right text-2xs tabular-nums text-fg group-hover:invisible group-focus-within:invisible pointer-coarse:group-hover:visible">
          {relativeTime}
        </span>
      ) : null}
    </span>
  );
}

export function SessionRowContent({
  title,
  stateLabel,
  depthLabel,
  descendantLabel,
  mobile,
  summary,
  scheduled = false,
  relativeTime,
}: {
  title: string;
  stateLabel: string;
  depthLabel?: string | null;
  descendantLabel?: string | null;
  mobile: boolean;
  summary: RailAggregateStatus;
  scheduled?: boolean;
  relativeTime?: string;
}) {
  return (
    <>
      <span className="sr-only">{stateLabel}. </span>
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span data-session-row-title className="block min-w-0 truncate">
          {title}
        </span>
        {mobile ? (
          <span className="mt-0.5 truncate text-2xs font-normal text-fg-muted">
            {[stateLabel, depthLabel, descendantLabel, relativeTime].filter(Boolean).join(" · ")}
          </span>
        ) : null}
      </span>
      <RailTrailingMetadata summary={summary} scheduled={scheduled} relativeTime={relativeTime} />
    </>
  );
}
