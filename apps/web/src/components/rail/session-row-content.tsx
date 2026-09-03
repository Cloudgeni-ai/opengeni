import {
  BotIcon,
  CalendarClockIcon,
  Clock3Icon,
  GitForkIcon,
  Loader2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import { useId } from "react";

import { CreatorMonogram } from "@/components/creator-monogram";
import {
  type CreatorRef,
  creatorAnnouncement,
  creatorInitials,
  creatorLabel,
} from "@/lib/creator-initials";
import { formatWaitingSince } from "@/lib/format";
import { sessionDescendantCountText } from "@/lib/session-tree-count";
import { cn } from "@/lib/utils";
import type { RailAggregateStatus } from "@/lib/sessions-group";

function ActiveWorkMark() {
  const maskId = `active-work-${useId().replaceAll(":", "")}`;
  return (
    <svg aria-hidden="true" viewBox="0 0 108 108" className="size-2.5 shrink-0 text-brand">
      <defs>
        <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="108" height="108">
          <circle cx="54" cy="54" r="48" fill="white" />
          <g fill="none" stroke="black" strokeWidth="21" strokeLinecap="round">
            <path d="M-8 43 C35 40 71 29 116 16" />
            <path d="M-8 86 C35 83 71 72 116 59" />
          </g>
        </mask>
      </defs>
      <circle cx="54" cy="54" r="48" fill="currentColor" mask={`url(#${maskId})`} />
      <circle cx="54" cy="54" r="48" fill="none" stroke="currentColor" strokeWidth="2.5" />
    </svg>
  );
}

/** The one descendant-aware status marker shared by rows and section headers. */
function RailAggregateDot({ summary }: { summary: RailAggregateStatus }) {
  if (summary.kind === "neutral") return null;
  if (summary.kind === "active") {
    return (
      <Loader2Icon
        aria-hidden="true"
        className="size-3 shrink-0 animate-spin text-fg-subtle motion-reduce:animate-none"
        style={{ animationDuration: "1.333333s" }}
      />
    );
  }
  if (summary.kind === "active_work") {
    return <ActiveWorkMark />;
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

/**
 * The row's announced name.
 *
 * `aria-label` replaces name-from-content, so this string is the whole of what
 * a screen reader hears for the row: the creator chip is `aria-hidden`, and
 * even the sr-only state line inside the link is inert for it. Every fact a
 * sighted user reads off the row belongs here, and in exactly one place.
 */
export function sessionRowAccessibleName({
  title,
  stateLabel,
  pinned,
  statusLabel,
  spawnedLabel,
  creator,
}: {
  title: string;
  stateLabel: string;
  pinned: boolean;
  statusLabel: string;
  spawnedLabel?: string | null;
  creator?: CreatorRef | null | undefined;
}): string {
  const spokenCreator = creatorAnnouncement(creator ?? null);
  return `Open ${title}. ${stateLabel}${pinned ? ". Pinned" : ""}. ${statusLabel}${
    spawnedLabel ? `. ${spawnedLabel}` : ""
  }${spokenCreator ? `. Created by ${spokenCreator}` : ""}`;
}

export function RailTrailingMetadata({
  summary,
  scheduled = false,
  relativeTime,
  creator,
}: {
  summary: RailAggregateStatus;
  scheduled?: boolean;
  relativeTime?: string | undefined;
  /**
   * Session creator for a top-level row, else null; callers decide which rows
   * are roots. A chip is its own reason to render this block: a mobile root row
   * can have no status marker and no time and still name who started it.
   */
  creator?: CreatorRef | null | undefined;
}) {
  const hasStatusMarker = summary.kind !== "neutral";
  const hasRelativeTime = Boolean(relativeTime);
  const hasMonogram = creator ? creatorInitials(creator) !== null : false;
  // How long the longest-waiting session behind a "needs you" marker has been
  // blocked on a human. A collapsed parent with a child parked for ten hours
  // must say so, not hide it behind a dot.
  const waitingFor =
    summary.kind === "needs_attention" && summary.attentionSince
      ? formatWaitingSince(summary.attentionSince)
      : "";
  if (!scheduled && !hasStatusMarker && !hasRelativeTime && !hasMonogram) return null;
  return (
    <span data-session-row-metadata className="inline-flex shrink-0 items-center justify-end gap-1">
      {scheduled ? (
        <CalendarClockIcon
          aria-label="Scheduled task"
          className="size-3.5 shrink-0 text-fg-subtle"
        />
      ) : null}
      {creator ? <CreatorMonogram createdBy={creator} showTitle={false} /> : null}
      {waitingFor ? (
        <span
          data-session-row-waiting
          title={summary.label}
          className="shrink-0 whitespace-nowrap text-2xs tabular-nums text-status-waiting"
        >
          {waitingFor}
        </span>
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

/**
 * Dense, non-redundant context for a session row hover. The row itself already
 * carries lifecycle and access signals, so this surface spends its space on
 * facts the narrow rail cannot show: the complete title, creator identity,
 * session age, and server-authoritative sub-agent total.
 */
export function SessionRowHoverDetails({
  title,
  createdAt,
  createdBy,
  descendantCount,
  descendantCountTruncated,
}: {
  title: string;
  createdAt: string;
  createdBy: CreatorRef;
  descendantCount: number;
  descendantCountTruncated: boolean;
}) {
  const age = formatWaitingSince(createdAt);
  const creatorName =
    createdBy.kind === "service" || creatorInitials(createdBy) !== null
      ? creatorLabel(createdBy)
      : null;
  const descendantTotal = sessionDescendantCountText(descendantCount, descendantCountTruncated);
  const descendantNoun =
    descendantCount === 1 && !descendantCountTruncated ? "sub-agent" : "sub-agents";

  return (
    <div data-session-row-hover-details className="grid gap-2.5">
      <div className="flex items-start gap-3">
        <p className="min-w-0 flex-1 text-sm font-medium leading-snug text-fg">{title}</p>
        {age ? (
          <span
            aria-label={`Created ${age} ago`}
            className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-2xs tabular-nums text-fg-subtle"
          >
            <Clock3Icon aria-hidden="true" className="size-3" />
            {age} ago
          </span>
        ) : null}
      </div>
      <div className="grid gap-1.5 text-xs text-fg-muted">
        {creatorName ? (
          <div className="flex min-w-0 items-center gap-2">
            {createdBy.kind === "subject" ? (
              <CreatorMonogram createdBy={createdBy} showTitle={false} />
            ) : (
              <span className="flex size-4 shrink-0 items-center justify-center">
                <BotIcon aria-hidden="true" className="size-3.5" />
              </span>
            )}
            <span className="min-w-0 truncate">Created by {creatorName}</span>
          </div>
        ) : null}
        <div className="flex items-center gap-2">
          <span className="flex size-4 shrink-0 items-center justify-center">
            <GitForkIcon aria-hidden="true" className="size-3.5" />
          </span>
          <span>
            {descendantTotal} {descendantNoun}
          </span>
        </div>
      </div>
    </div>
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
  creator,
}: {
  title: string;
  stateLabel: string;
  depthLabel?: string | null;
  descendantLabel?: string | null;
  mobile: boolean;
  summary: RailAggregateStatus;
  scheduled?: boolean;
  relativeTime?: string;
  /** Session creator for a top-level row, else null. See RailTrailingMetadata. */
  creator?: CreatorRef | null | undefined;
}) {
  return (
    <>
      {/* Inert for the row's accessible name, which its `aria-label` owns -
          including the creator. Kept as-is so this change regresses nothing. */}
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
      <RailTrailingMetadata
        summary={summary}
        scheduled={scheduled}
        relativeTime={relativeTime}
        creator={creator}
      />
    </>
  );
}
