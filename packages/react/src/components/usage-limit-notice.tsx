import type { UsageAllowancePeriod, WorkspaceUsageResponse } from "@opengeni/sdk/usage-allowances";
import { GaugeIcon, XIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { useUsage, type UsageClientLike } from "../hooks/use-usage";
import { cn } from "../lib/cn";
import {
  allowanceLabels,
  allowanceResetSentence,
  formatAllowanceInstant,
  type AllowanceLabels,
} from "../usage/allowance-copy";
import { summarizeUsage, usagePercentLabel, type UsageSummary } from "../usage/summary";

export type UsageLimitNoticeLabels = AllowanceLabels & {
  /** "You've used 85% of your usage limit." */
  memberWarning: (percent: string) => string;
  /** "This workspace has used 85% of its usage budget." */
  workspaceWarning: (percent: string) => string;
  memberExhausted: string;
  workspaceExhausted: string;
  dismiss: string;
};

export const DEFAULT_USAGE_LIMIT_NOTICE_LABELS: UsageLimitNoticeLabels = {
  ...allowanceLabels(),
  memberWarning: (percent) => `You've used ${percent}% of your usage limit.`,
  workspaceWarning: (percent) => `This workspace has used ${percent}% of its usage budget.`,
  memberExhausted: "You've reached your usage limit.",
  workspaceExhausted: "This workspace has reached its usage limit.",
  dismiss: "Dismiss",
};

type NoticeBaseProps = {
  labels?: Partial<UsageLimitNoticeLabels> | undefined;
  /**
   * Your own next step beside the message, for example an "Upgrade" or
   * "Request more" button. Receives the summary so it can differ by scope.
   */
  action?: ((summary: UsageSummary) => ReactNode) | undefined;
  /**
   * Remember a dismissed warning for this browser tab. The key should name the
   * workspace; the period and scope are added for you, so a new warning (or a
   * new period) shows again. Reaching the limit is never dismissible.
   */
  dismissStorageKey?: string | undefined;
  className?: string | undefined;
};

export type UsageLimitNoticeProps = NoticeBaseProps & {
  /** A usage response you already loaded; omit it to read `/usage/me`. */
  usage?: WorkspaceUsageResponse | null | undefined;
  client?: UsageClientLike | undefined;
  workspaceId?: string | undefined;
  period?: UsageAllowancePeriod | undefined;
  refreshKey?: unknown;
};

/**
 * A calm line for the composer when a member is close to, or at, a usage
 * limit: what happened, who can raise it, and when it resets. Renders nothing
 * while usage is comfortable, unlimited, loading, or unreadable.
 */
export function UsageLimitNotice({
  usage,
  client,
  workspaceId,
  period,
  refreshKey,
  ...view
}: UsageLimitNoticeProps) {
  if (usage !== undefined) {
    return <UsageLimitNoticeView {...view} summary={usage ? summarizeUsage(usage) : null} />;
  }
  return (
    <LoadingNotice
      {...view}
      client={client}
      workspaceId={workspaceId}
      period={period}
      refreshKey={refreshKey}
    />
  );
}

function LoadingNotice({
  client,
  workspaceId,
  period,
  refreshKey,
  ...view
}: NoticeBaseProps &
  Pick<UsageLimitNoticeProps, "client" | "workspaceId" | "period" | "refreshKey">) {
  const { summary } = useUsage({ client, workspaceId, period, refreshKey });
  return <UsageLimitNoticeView {...view} summary={summary} />;
}

function readDismissed(key: string | null): boolean {
  if (!key || typeof sessionStorage === "undefined") return false;
  try {
    return sessionStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

/** Presentational notice for a summary you computed (`summarizeUsage`). */
export function UsageLimitNoticeView({
  summary,
  labels: overrides,
  action,
  dismissStorageKey,
  className,
}: NoticeBaseProps & { summary: UsageSummary | null }) {
  const labels = { ...DEFAULT_USAGE_LIMIT_NOTICE_LABELS, ...overrides };
  const binding = summary?.binding ?? null;
  const state = summary?.state;
  const key =
    dismissStorageKey && binding && state === "warning"
      ? `${dismissStorageKey}:warning:${binding.scope}:${binding.resetsAt ?? "none"}`
      : null;
  const [dismissed, setDismissed] = useState(() => readDismissed(key));
  useEffect(() => setDismissed(readDismissed(key)), [key]);
  if (!summary || !binding || (state !== "warning" && state !== "exhausted")) return null;
  if (state === "warning" && dismissed) return null;
  const workspace = binding.scope === "workspace";
  const exhausted = state === "exhausted";
  const headline = exhausted
    ? workspace
      ? labels.workspaceExhausted
      : labels.memberExhausted
    : workspace
      ? labels.workspaceWarning(usagePercentLabel(binding.fraction))
      : labels.memberWarning(usagePercentLabel(binding.fraction));
  const reset = allowanceResetSentence(labels, binding.resetsAt);
  const dismiss = () => {
    setDismissed(true);
    if (!key) return;
    try {
      sessionStorage.setItem(key, "1");
    } catch {
      // Storage can be unavailable (privacy mode); the in-memory dismissal holds.
    }
  };
  return (
    <div
      role="status"
      data-og-usage-notice={exhausted ? "exhausted" : "warning"}
      data-og-usage-scope={binding.scope}
      className={cn(
        "og-root flex min-w-0 items-start gap-2 px-3.5 pt-2.5 text-og-sm md:px-4",
        className,
      )}
    >
      <GaugeIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-og-status-waiting" />
      <p className="min-w-0 flex-1 text-og-fg-muted">
        <span className={cn(exhausted && "font-medium text-og-fg")}>{headline}</span>{" "}
        {exhausted ? <>{workspace ? labels.workspaceRemedy : labels.memberRemedy} </> : null}
        <span
          className="whitespace-nowrap"
          title={binding.resetsAt ? formatAllowanceInstant(binding.resetsAt) : undefined}
        >
          {reset}
        </span>
      </p>
      {action ? <div className="shrink-0">{action(summary)}</div> : null}
      {!exhausted ? (
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
