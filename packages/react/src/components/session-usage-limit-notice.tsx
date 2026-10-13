import type {
  ParsedSessionUsageLimitReachedRefusal,
  SessionUsageLimit,
} from "@opengeni/sdk/session-usage-limits";
import { GaugeIcon, XIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { cn } from "../lib/cn";
import {
  sessionUsageLimitLabels,
  sessionUsageLimitPercent,
  summarizeSessionUsageLimit,
  summarizeSessionUsageLimitRefusal,
  type SessionUsageLimitLabels,
  type SessionUsageLimitSummary,
} from "../usage/session-usage-limit";

export type SessionUsageLimitNoticeProps = {
  /** The task's usage-limit projection (`GET .../usage-limit` or `session.usageLimit`). */
  usage: SessionUsageLimit | null | undefined;
  /**
   * A refused Send's typed refusal (`OpenGeniSessionUsageLimitReachedError`),
   * shown as reached until a re-read projection replaces it. Clear it when a
   * newer `usage` arrives: a projection that already says reached wins.
   */
  refusal?: Pick<
    ParsedSessionUsageLimitReachedRefusal,
    "limitMicros" | "usedMicros" | "rootSessionId"
  > | null;
  /** Opens the limit editor. Absent: the notice says who can change it instead. */
  onChangeLimit?: (() => void) | undefined;
  /** A child chat: link to the main task that owns the limit, instead of an editor. */
  mainTaskHref?: string | undefined;
  /** The goal paused at the limit: changing it never resumes, so say Resume is next. */
  goalPaused?: boolean;
  /**
   * The last refresh of `usage` failed. The last known amount and any reached
   * state stay, with a note that they may be out of date and that the limit
   * still applies. Pass the read hook's error state; never zero the amount.
   */
  stale?: boolean;
  /**
   * Remember a dismissed near-limit notice for this tab. The key should name
   * the workspace; the task and limit version are added, so a changed limit
   * shows it again. Reaching the limit is never dismissible.
   */
  dismissStorageKey?: string | undefined;
  labels?: Partial<SessionUsageLimitLabels> | undefined;
  className?: string | undefined;
};

function readDismissed(key: string | null): boolean {
  if (!key || typeof sessionStorage === "undefined") return false;
  try {
    return sessionStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

/**
 * The calm composer line for a task's usage limit: a dismissible note near
 * the limit and a status once it is reached, with one action (Change limit).
 * Renders nothing while usage is comfortable, unlimited, unknown or loading.
 * Never a purchase or credits remedy: the limit is a person's own setting.
 */
export function SessionUsageLimitNotice({
  usage,
  refusal,
  onChangeLimit,
  mainTaskHref,
  goalPaused = false,
  stale = false,
  dismissStorageKey,
  labels: overrides,
  className,
}: SessionUsageLimitNoticeProps) {
  const labels = sessionUsageLimitLabels(overrides);
  const fromUsage = summarizeSessionUsageLimit(usage, overrides, { stale });
  const summary: SessionUsageLimitSummary =
    refusal && fromUsage.state !== "reached"
      ? summarizeSessionUsageLimitRefusal(refusal, overrides)
      : fromUsage;
  const near = summary.state === "near";
  const key =
    dismissStorageKey && near && summary.rootSessionId
      ? `${dismissStorageKey}:session-usage-limit:${summary.rootSessionId}:${summary.version ?? 0}`
      : null;
  const [dismissed, setDismissed] = useState(() => readDismissed(key));
  useEffect(() => setDismissed(readDismissed(key)), [key]);
  if (summary.state !== "reached" && !near) return null;
  if (near && dismissed) return null;
  const reached = summary.state === "reached";
  const amount = summary.amountText ?? "";
  const dismiss = () => {
    setDismissed(true);
    if (!key) return;
    try {
      sessionStorage.setItem(key, "1");
    } catch {
      // Storage can be unavailable (privacy mode); the in-memory dismissal holds.
    }
  };
  let action: ReactNode = null;
  if (onChangeLimit) {
    action = (
      <button
        type="button"
        onClick={onChangeLimit}
        data-og-session-usage-limit-action="change"
        className={cn(
          "inline-flex h-8 shrink-0 items-center rounded-og-sm border px-3 text-og-control font-medium transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-og-accent pointer-coarse:h-11",
          reached
            ? "border-og-primary-border bg-og-primary text-og-primary-fg hover:bg-og-primary-hover"
            : "border-og-border bg-og-surface-1 text-og-fg hover:bg-og-surface-2",
        )}
      >
        {labels.changeLimit}
      </button>
    );
  } else if (mainTaskHref) {
    action = (
      <a href={mainTaskHref} className="og-link shrink-0 text-og-control font-medium">
        {labels.openMainTask}
      </a>
    );
  }
  const remedy =
    !onChangeLimit && reached
      ? labels.reachedReadOnlyRemedy
      : goalPaused
        ? labels.reachedGoalRemedy
        : labels.reachedRemedy;
  return (
    <div
      role="status"
      data-og-session-usage-limit={reached ? "reached" : "near"}
      className={cn(
        "og-root flex min-w-0 flex-wrap items-start gap-x-2 gap-y-2 px-3.5 pt-2.5 text-og-sm md:px-4",
        className,
      )}
    >
      <GaugeIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-og-status-waiting" />
      <div className="min-w-0 flex-1 basis-48">
        {reached ? (
          <>
            <p className="font-medium text-og-fg">{labels.reachedTitle}</p>
            <p className="mt-0.5 text-og-fg-muted">
              {amount ? `${labels.reachedAmount(amount)} ` : ""}
              {remedy}
              {summary.stale ? ` ${labels.staleNote}` : ""}
            </p>
          </>
        ) : (
          <p className="text-og-fg-muted">
            {labels.near(sessionUsageLimitPercent(summary.fraction ?? 0), amount)}
            {summary.stale ? ` ${labels.staleNote}` : ""}
          </p>
        )}
      </div>
      {action}
      {!reached ? (
        <button
          type="button"
          aria-label={labels.dismiss}
          onClick={dismiss}
          className="-mt-0.5 -mr-1 grid size-6 shrink-0 place-items-center rounded-og-sm text-og-fg-subtle transition hover:bg-og-surface-2 hover:text-og-fg focus-visible:outline-2 focus-visible:outline-og-accent pointer-coarse:size-9"
        >
          <XIcon aria-hidden className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}
