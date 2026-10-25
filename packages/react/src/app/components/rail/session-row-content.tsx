import {
  CalendarClockIcon,
  Clock3Icon,
  HourglassIcon,
  Loader2Icon,
  TriangleAlertIcon,
  ZapIcon,
} from "lucide-react";
import { Children, isValidElement, useId } from "react";

import { CreatorMonogram } from "../creator-monogram";
import { type CreatorRef, creatorAnnouncement, creatorInitials } from "../../lib/creator-initials";
import { formatWaitingSince } from "../../lib/format";
import { t } from "../../lib/console-text";
import { cn } from "../../lib/utils";
import type { RailAggregateStatus } from "../../lib/sessions-group";
import {
  sessionAutomationWaitLabel,
  type SessionAutomationWait,
} from "../../../session-list-model";

export function ActiveWorkMark({ className }: { className?: string | undefined }) {
  const maskId = `active-work-${useId().replaceAll(":", "")}`;
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 108 108"
      className={cn("size-2.5 shrink-0 text-session-update", className)}
    >
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
  if (summary.kind === "queued") {
    return <Clock3Icon aria-hidden="true" className="size-3 shrink-0 text-fg-subtle" />;
  }
  if (summary.kind === "waiting") {
    // Parked until input or its wake-up time: nothing is executing, so no spinner.
    return <HourglassIcon aria-hidden="true" className="size-3 shrink-0 text-fg-subtle" />;
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
        : "bg-session-update";
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
  spawnedLabel?: string | null | undefined;
  creator?: CreatorRef | null | undefined;
}): string {
  const spokenCreator = creatorAnnouncement(creator ?? null);
  return `Open ${title}. ${stateLabel}${pinned ? ". Pinned" : ""}. ${statusLabel}${
    spawnedLabel ? `. ${spawnedLabel}` : ""
  }${spokenCreator ? `. Created by ${spokenCreator}` : ""}`;
}

/**
 * The quiet mark for a chat an automation will post into: a clock while it
 * waits for its schedule, a bolt while it waits for an event. `label` says
 * what exactly ("Waiting for deploy.finished from Deploys"); without it the
 * plain wait is named.
 */
export function AutomationWaitIcon({
  wait,
  label: detail,
  className,
}: {
  wait: SessionAutomationWait;
  label?: string | undefined;
  className?: string | undefined;
}) {
  const Icon = wait === "event" ? ZapIcon : CalendarClockIcon;
  const label = detail || sessionAutomationWaitLabel(t, wait);
  return (
    <span role="img" aria-label={label} title={label} className="inline-flex shrink-0">
      <Icon
        aria-hidden="true"
        data-automation-wait={wait}
        className={cn("size-3.5 shrink-0 text-fg-subtle", className)}
      />
    </span>
  );
}

export function RailTrailingMetadata({
  summary,
  automationWait = null,
  automationWaitLabel,
  relativeTime,
  jumpKey,
  creator,
  quickActionSlots = 0,
}: {
  summary: RailAggregateStatus;
  /** What an automation posting into this chat is waiting for; null for none. */
  automationWait?: SessionAutomationWait | null | undefined;
  /** That wait in words, for the mark's tooltip and accessible name. */
  automationWaitLabel?: string | undefined;
  relativeTime?: string | undefined;
  /** The key that opens this row ("⌘3"), shown in place of the time while ⌘ is held. */
  jumpKey?: string | undefined;
  /** Rightmost items replaced in place by the row's desktop quick actions. */
  quickActionSlots?: number | undefined;
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
  if (
    !automationWait &&
    !hasStatusMarker &&
    !hasRelativeTime &&
    !jumpKey &&
    !hasMonogram &&
    !quickActionSlots
  )
    return null;
  const items = Children.toArray([
    automationWait ? (
      <AutomationWaitIcon key="automation" wait={automationWait} label={automationWaitLabel} />
    ) : null,
    hasMonogram && creator ? (
      <CreatorMonogram key="creator" createdBy={creator} showTitle={false} />
    ) : null,
    waitingFor ? (
      <span
        key="waiting"
        data-session-row-waiting
        title={summary.label}
        className="shrink-0 whitespace-nowrap text-2xs tabular-nums text-status-waiting"
      >
        {waitingFor}
      </span>
    ) : null,
    hasStatusMarker ? (
      <span key="status" className="flex size-3 items-center justify-center" title={summary.label}>
        <RailAggregateDot summary={summary} />
      </span>
    ) : null,
    jumpKey ? (
      <kbd
        key="time"
        data-session-row-jump-key
        className="inline-flex h-4.5 min-w-9 shrink-0 items-center justify-center rounded-[4px] border border-border bg-surface-2 px-1 font-sans text-2xs leading-none font-medium whitespace-nowrap text-fg-muted"
      >
        {jumpKey}
      </kbd>
    ) : hasRelativeTime ? (
      <span
        key="time"
        className="min-w-9 shrink-0 whitespace-nowrap text-right text-2xs tabular-nums text-fg"
      >
        {relativeTime}
      </span>
    ) : null,
  ]).filter(isValidElement);
  if (!quickActionSlots) {
    return (
      <span
        data-session-row-metadata
        className="inline-flex shrink-0 items-center justify-end gap-1"
      >
        {items}
      </span>
    );
  }
  // Empty rows still reserve their action footprint. Visibility (never display
  // or padding) swaps the last items, keeping every other box stationary.
  while (items.length < quickActionSlots) items.unshift(<span key={`empty-${items.length}`} />);
  return (
    <span data-session-row-metadata className="inline-flex shrink-0 items-center justify-end">
      {items.map((item, index) => (
        <span
          key={item.key}
          data-session-row-slot
          className={cn(
            "inline-flex min-w-6 shrink-0 items-center justify-center last:min-w-10",
            index >= items.length - quickActionSlots &&
              "pointer-fine:group-hover:invisible pointer-fine:group-focus-within:invisible",
          )}
        >
          {item}
        </span>
      ))}
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
  automationWait = null,
  automationWaitLabel,
  relativeTime,
  jumpKey,
  creator,
  quickActionSlots = 0,
}: {
  title: string;
  stateLabel: string;
  depthLabel?: string | null | undefined;
  descendantLabel?: string | null | undefined;
  mobile: boolean;
  summary: RailAggregateStatus;
  /** What an automation posting into this chat is waiting for; null for none. */
  automationWait?: SessionAutomationWait | null | undefined;
  /** See RailTrailingMetadata. */
  automationWaitLabel?: string | undefined;
  relativeTime?: string | undefined;
  /** See RailTrailingMetadata. */
  jumpKey?: string | undefined;
  quickActionSlots?: number | undefined;
  /** Session creator for a top-level row, else null. See RailTrailingMetadata. */
  creator?: CreatorRef | null | undefined;
}) {
  return (
    <>
      {/* Inert for the row's accessible name, which its `aria-label` owns -
          including the creator. Kept as-is so this change regresses nothing. */}
      <span className="sr-only">{stateLabel}. </span>
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span data-session-row-title className="block min-w-0 overflow-hidden whitespace-nowrap">
          {title}
        </span>
        {mobile ? (
          <span
            data-session-row-state
            className="mt-0.5 truncate text-2xs font-normal text-fg-muted"
          >
            {[stateLabel, depthLabel, descendantLabel, relativeTime].filter(Boolean).join(" · ")}
          </span>
        ) : null}
      </span>
      <RailTrailingMetadata
        quickActionSlots={quickActionSlots}
        summary={summary}
        automationWait={automationWait}
        automationWaitLabel={automationWaitLabel}
        relativeTime={relativeTime}
        jumpKey={jumpKey}
        creator={creator}
      />
    </>
  );
}
