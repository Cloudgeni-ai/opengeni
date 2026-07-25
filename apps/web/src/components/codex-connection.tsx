// Codex (ChatGPT) subscriptions card for workspace settings: connect MULTIPLE
// ChatGPT accounts via device code, list them with an ACTIVE radio (the account
// unpinned sessions use), inline rename, per-account refresh/disconnect, and
// "connect another". A connected `codex/*` model run uses the active/pinned
// subscription instead of spending API credits.
import type {
  CodexAccount,
  CodexAccountOverview,
  CodexAccountsResponse,
  CodexOverviewResponse,
  CodexResetCredit,
  CodexResetRedemptionRecovery,
  CodexRotationSettings,
  CodexUsage,
  CodexUsageMap,
  CodexUsageWindow,
} from "@opengeni/sdk";
import {
  ExternalLinkIcon,
  Loader2Icon,
  PlusIcon,
  RefreshCwIcon,
  SparklesIcon,
  TicketCheckIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { MetaChip } from "@/components/ui/meta-chip";
import { useAppContext } from "@/context";
import {
  ApiError,
  prepareCodexResetRedemption,
  redeemCodexResetCredit,
  type CodexResetRedemptionPreparation,
} from "@/api";

function relativeTimestamp(value: string | number | null | undefined, now: number): string {
  if (value == null) return "";
  const timestamp = typeof value === "number" ? value * 1000 : new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "";
  const delta = timestamp - now;
  const future = delta >= 0;
  const absolute = Math.abs(delta);
  const minutes = Math.max(1, Math.round(absolute / 60_000));
  const amount =
    minutes >= 1440
      ? `${Math.round(minutes / 1440)}d`
      : minutes >= 60
        ? `${Math.round(minutes / 60)}h`
        : `${minutes}m`;
  return future ? `in ${amount}` : `${amount} ago`;
}

function absoluteTimestamp(value: string | number | null | undefined): string {
  if (value == null) return "";
  const date = new Date(typeof value === "number" ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

type StoredRedemptionAttempt = {
  attemptId: string;
  creditId: string;
  title: string | null;
  expiresAt: number | null;
};

type RedemptionAttemptView = StoredRedemptionAttempt & {
  status: "local" | CodexResetRedemptionRecovery["status"];
  outcome: CodexResetRedemptionRecovery["outcome"];
};

function redemptionOutcomeCopy(outcome: NonNullable<CodexResetRedemptionRecovery["outcome"]>) {
  return {
    reset: "Usage limits reset.",
    alreadyRedeemed: "The earlier redemption succeeded; usage was refreshed.",
    nothingToReset: "The provider found no eligible usage window to reset.",
    noCredit: "The provider found no reset credit to use.",
  }[outcome];
}

function managedRedemptionErrorStatus(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  try {
    const parsed = JSON.parse(error.body) as { status?: unknown };
    return typeof parsed.status === "string" ? parsed.status : null;
  } catch {
    return null;
  }
}

function redemptionAttemptStoragePrefix(workspaceId: string, accountId: string): string {
  return `opengeni.codexResetAttempt:${workspaceId}:${accountId}:`;
}

function redemptionAttemptStorageKey(workspaceId: string, accountId: string, creditId: string) {
  return `${redemptionAttemptStoragePrefix(workspaceId, accountId)}${encodeURIComponent(creditId)}`;
}

function storedRedemptionAttempt(
  workspaceId: string,
  accountId: string,
  creditId: string,
): StoredRedemptionAttempt | null {
  if (typeof sessionStorage === "undefined") return null;
  let value: string | null;
  try {
    value = sessionStorage.getItem(redemptionAttemptStorageKey(workspaceId, accountId, creditId));
  } catch {
    return null;
  }
  if (!value) return null;
  // Tolerate the initial UUID-only checkpoint format. No deployed server
  // depends on it, but preserving it makes a same-tab development reload safe.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    return { attemptId: value, creditId, title: null, expiresAt: null };
  }
  try {
    const parsed = JSON.parse(value) as Partial<StoredRedemptionAttempt>;
    return typeof parsed.attemptId === "string" && parsed.creditId === creditId
      ? {
          attemptId: parsed.attemptId,
          creditId,
          title: typeof parsed.title === "string" ? parsed.title : null,
          expiresAt: typeof parsed.expiresAt === "number" ? parsed.expiresAt : null,
        }
      : null;
  } catch {
    return null;
  }
}

function storeRedemptionAttempt(
  workspaceId: string,
  accountId: string,
  attempt: StoredRedemptionAttempt,
): boolean {
  if (typeof sessionStorage === "undefined") return false;
  try {
    sessionStorage.setItem(
      redemptionAttemptStorageKey(workspaceId, accountId, attempt.creditId),
      JSON.stringify(attempt),
    );
    return true;
  } catch {
    return false;
  }
}

function removeStoredRedemptionAttempt(
  workspaceId: string,
  accountId: string,
  creditId: string,
): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.removeItem(redemptionAttemptStorageKey(workspaceId, accountId, creditId));
  } catch {
    // Browser-local state has no authority. If storage becomes unavailable, the
    // server-side attempt and provider key remain the durable replay fence.
  }
}

function storedRedemptionAttempts(
  workspaceId: string,
  accountId: string,
): StoredRedemptionAttempt[] {
  if (typeof sessionStorage === "undefined") return [];
  const prefix = redemptionAttemptStoragePrefix(workspaceId, accountId);
  const attempts: StoredRedemptionAttempt[] = [];
  try {
    for (let index = 0; index < sessionStorage.length; index += 1) {
      const key = sessionStorage.key(index);
      if (!key?.startsWith(prefix)) continue;
      const creditId = decodeURIComponent(key.slice(prefix.length));
      const attempt = storedRedemptionAttempt(workspaceId, accountId, creditId);
      if (attempt) attempts.push(attempt);
    }
  } catch {
    // A malformed key or unavailable browser store has no authority and stays
    // invisible. A new irreversible attempt will fail closed in storeRedemptionAttempt.
  }
  return attempts.sort((left, right) => left.creditId.localeCompare(right.creditId));
}

function redemptionAttemptViews(
  workspaceId: string,
  accountId: string,
  overview: CodexAccountOverview | undefined,
): RedemptionAttemptView[] {
  const local = storedRedemptionAttempts(workspaceId, accountId);
  const localByCredit = new Map(local.map((attempt) => [attempt.creditId, attempt]));
  const creditById = new Map(
    (overview?.resetCredits.credits ?? []).map((credit) => [credit.id, credit]),
  );
  const server = (overview?.redemptions ?? []).map((recovery) => {
    const saved = localByCredit.get(recovery.creditId);
    const credit = creditById.get(recovery.creditId);
    return {
      attemptId: recovery.attemptId,
      creditId: recovery.creditId,
      title: credit?.title ?? saved?.title ?? null,
      expiresAt: credit?.expiresAt ?? saved?.expiresAt ?? null,
      status: recovery.status,
      outcome: recovery.outcome,
    } satisfies RedemptionAttemptView;
  });
  const serverCreditIds = new Set(server.map((attempt) => attempt.creditId));
  return [
    ...server,
    ...local
      .filter((attempt) => !serverCreditIds.has(attempt.creditId))
      .map(
        (attempt): RedemptionAttemptView => ({
          ...attempt,
          status: "local",
          outcome: null,
        }),
      ),
  ].sort((left, right) => left.creditId.localeCompare(right.creditId));
}

export function resetLabel(seconds: number | null | undefined): string {
  if (typeof seconds !== "number" || seconds <= 0) return "";
  const h = Math.floor(seconds / 3600);
  const d = Math.floor(h / 24);
  if (d >= 1) return `resets in ~${d}d`;
  if (h >= 1) return `resets in ~${h}h`;
  return `resets in ~${Math.max(1, Math.round(seconds / 60))}m`;
}

// Seconds until reset, computed CLIENT-SIDE off the absolute resetAt (skew-free,
// preferred) and falling back to the snapshot's resetAfterSeconds. Driven by the
// row's `now` tick so the countdown ticks without re-hitting the backend.
function secondsUntilReset(window: CodexUsageWindow, now: number): number | null {
  if (window.resetAt) {
    const ms = new Date(window.resetAt).getTime() - now;
    if (!Number.isNaN(ms)) return Math.max(0, Math.round(ms / 1000));
  }
  return window.resetAfterSeconds;
}

function resetTimestamp(window: CodexUsageWindow, now: number): string {
  if (window.resetAt) {
    const absolute = absoluteTimestamp(window.resetAt);
    const relative = relativeTimestamp(window.resetAt, now);
    if (absolute && relative) return `resets ${absolute} (${relative})`;
  }
  const seconds = secondsUntilReset(window, now);
  return seconds == null ? "" : resetLabel(seconds);
}

export function UsageBar({
  label,
  window,
  now,
}: {
  label: string;
  window: CodexUsageWindow | null;
  now: number;
}) {
  if (!window) return null;
  const pct = Math.min(100, Math.max(0, window.percent));
  const danger = pct >= 90;
  const limitReached = pct >= 100;
  const reset = resetTimestamp(window, now);
  return (
    <div className="grid gap-1">
      <div className="flex flex-wrap items-center justify-between gap-x-2 text-xs text-fg-muted">
        <span>{label}</span>
        <span className="min-w-0 text-right">
          {limitReached ? "limit reached" : `${pct}% used`}
          {reset ? ` · ${reset}` : ""}
        </span>
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-surface-2"
        role="progressbar"
        aria-label={`${label} usage`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        <div
          className={`h-full rounded-full ${danger ? "bg-status-waiting" : "bg-brand"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

/**
 * A row's two usage bars (5h + weekly) with all four component states. Prefers the
 * LIVE refresh payload (which carries an explicit status) over the cached windows.
 */
function AccountUsage({
  account,
  live,
  overview,
  now,
  refreshing,
  onRetry,
}: {
  account: CodexAccount;
  live: CodexUsage | undefined;
  overview: CodexAccountOverview | undefined;
  now: number;
  refreshing: boolean;
  onRetry: () => void;
}) {
  const status = live?.status;
  const fiveHour = live?.usage?.fiveHour ?? account.fiveHour ?? null;
  const weekly = live?.usage?.weekly ?? account.weekly ?? null;

  // loading — a live refresh is in flight and we have nothing cached yet.
  if (refreshing && !fiveHour && !weekly) {
    return <div className="h-3 w-2/3 animate-pulse rounded bg-surface-2" />;
  }
  // error — a refresh/needs_relogin or transient 401. Subtle inline, not a hard block.
  if (status === "error" && !fiveHour && !weekly) {
    return (
      <div className="text-xs text-fg-subtle">
        usage unavailable ·{" "}
        <button type="button" className="underline hover:text-fg" onClick={onRetry}>
          retry
        </button>
      </div>
    );
  }
  // no-data — no windows and the call succeeded: render nothing (the plan badge stands in).
  if (!fiveHour && !weekly) {
    return null;
  }
  const limitReached =
    status === "limit_reached" || (fiveHour?.percent ?? 0) >= 100 || (weekly?.percent ?? 0) >= 100;
  return (
    <div className="grid gap-2" aria-live="polite">
      {overview ? (
        <div className="text-2xs text-fg-subtle">
          {overview.usage.source === "provider" ? "Provider reported" : "Cached by OpenGeni"}
          {overview.usage.fetchedAt
            ? ` · ${absoluteTimestamp(overview.usage.fetchedAt)} (${relativeTimestamp(overview.usage.fetchedAt, now)})`
            : " · never checked"}
          {overview.usage.stale ? " · stale" : ""}
        </div>
      ) : null}
      <UsageBar label="5-hour" window={fiveHour} now={now} />
      <UsageBar label="Weekly" window={weekly} now={now} />
      {limitReached ? (
        <div className="flex items-center gap-1.5 text-xs text-status-waiting">
          <TriangleAlertIcon className="size-3.5" /> Usage limit reached
        </div>
      ) : null}
    </div>
  );
}

function ResetCreditInventory({
  overview,
  now,
  busy,
  recoveryAttempts,
  onRedeem,
}: {
  overview: CodexAccountOverview | undefined;
  now: number;
  busy: boolean;
  recoveryAttempts: RedemptionAttemptView[];
  onRedeem: (credit: CodexResetCredit, recovery?: RedemptionAttemptView) => void;
}) {
  if (!overview) return null;
  const reset = overview.resetCredits;
  const count = reset.availableCount;
  const authorityCopy: Record<typeof reset.detailState, string> = {
    detailed: count === 0 ? "No usage limit resets available." : "Provider detail is complete.",
    count_only: `Provider reports ${count ?? 0} reset${count === 1 ? "" : "s"}, but individual details are unavailable. View only.`,
    capped: "The provider returned fewer details than its count. View only.",
    unsupported: "This subscription does not expose reset-credit details.",
    unknown: "The provider returned reset data OpenGeni does not recognize. View only.",
    error: "Reset-credit inventory is unavailable. Refresh to retry.",
  };
  const visibleCreditIds = new Set(reset.credits.map((credit) => credit.id));
  const hiddenRecoveries = recoveryAttempts.filter(
    (attempt) => !visibleCreditIds.has(attempt.creditId),
  );
  return (
    <div className="grid min-w-0 gap-2 rounded-md border border-border/70 bg-surface/60 p-2.5">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5 text-xs font-medium">
          <TicketCheckIcon className="size-3.5 shrink-0 text-brand" />
          Usage limit resets
          {count != null ? <span className="text-fg-muted">· {count} available</span> : null}
        </div>
        <span className="text-2xs text-fg-subtle">
          {reset.source === "provider"
            ? "Provider reported"
            : reset.source === "cache"
              ? "OpenGeni cache"
              : "No provider data"}
          {reset.stale ? " · stale" : ""}
        </span>
      </div>
      <p className="text-2xs text-fg-subtle" aria-live="polite">
        {authorityCopy[reset.detailState]}
        {reset.fetchedAt
          ? ` Checked ${absoluteTimestamp(reset.fetchedAt)} (${relativeTimestamp(reset.fetchedAt, now)}).`
          : ""}
      </p>
      {reset.credits.length > 0 ? (
        <div className="grid min-w-0 gap-1.5">
          {reset.credits.map((credit) => {
            const recovery = recoveryAttempts.find((attempt) => attempt.creditId === credit.id);
            const resumable = Boolean(
              overview.canResumeRedemption && recovery && recovery.status !== "completed",
            );
            const completedSuccessfulOutcome =
              recovery?.status === "completed" &&
              (recovery.outcome === "reset" || recovery.outcome === "alreadyRedeemed")
                ? redemptionOutcomeCopy(recovery.outcome)
                : null;
            const priorNonConsumingOutcome =
              recovery?.status === "completed" &&
              (recovery.outcome === "nothingToReset" || recovery.outcome === "noCredit")
                ? redemptionOutcomeCopy(recovery.outcome)
                : null;
            const expiry =
              credit.expiresAt == null
                ? "Does not expire"
                : `Expires ${absoluteTimestamp(credit.expiresAt)} (${relativeTimestamp(credit.expiresAt, now)})`;
            return (
              <div
                key={credit.id}
                className="flex min-w-0 flex-wrap items-start justify-between gap-2 rounded border border-border/70 bg-bg p-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="break-words text-xs font-medium">
                    {credit.title ?? "Full usage limit reset"}
                  </div>
                  <div className="mt-0.5 break-words text-2xs text-fg-subtle">
                    {expiry} · {credit.status.replaceAll("_", " ")}
                  </div>
                  {credit.description ? (
                    <div className="mt-1 break-words text-2xs text-fg-muted">
                      {credit.description}
                    </div>
                  ) : null}
                  {priorNonConsumingOutcome ? (
                    <div className="mt-1 break-words text-2xs text-fg-muted" aria-live="polite">
                      Earlier attempt: {priorNonConsumingOutcome}
                      {credit.actionable
                        ? " The provider currently lists this reset as available again."
                        : ""}
                    </div>
                  ) : null}
                </div>
                {completedSuccessfulOutcome ? (
                  <div
                    className="max-w-56 text-right text-2xs text-status-success"
                    aria-live="polite"
                  >
                    {completedSuccessfulOutcome}
                  </div>
                ) : credit.actionable || resumable ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="min-h-11 shrink-0"
                    disabled={busy}
                    aria-label={`${resumable ? "Resume redemption of" : "Redeem"} ${credit.title ?? "usage limit reset"}`}
                    onClick={() =>
                      onRedeem(credit, resumable || priorNonConsumingOutcome ? recovery : undefined)
                    }
                  >
                    {resumable ? "Resume uncertain attempt" : "Redeem"}
                  </Button>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
      {overview.canResumeRedemption && hiddenRecoveries.length > 0 ? (
        <div className="grid min-w-0 gap-1.5">
          {hiddenRecoveries.map((attempt) => (
            <div
              key={attempt.attemptId}
              className="flex min-w-0 flex-wrap items-start justify-between gap-2 rounded border border-status-waiting/30 bg-status-waiting/10 p-2"
            >
              <div className="min-w-0 flex-1">
                <div className="break-words text-xs font-medium">
                  {attempt.title ?? "Usage limit reset"}
                </div>
                <div className="mt-0.5 break-words text-2xs text-fg">
                  {attempt.status === "completed" && attempt.outcome
                    ? redemptionOutcomeCopy(attempt.outcome)
                    : "The provider no longer lists this reset. Resume only the same uncertain attempt; OpenGeni will never mint a replacement key."}
                </div>
              </div>
              {attempt.status !== "completed" ? (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  className="min-h-11 shrink-0"
                  disabled={busy}
                  aria-label={`Resume uncertain redemption of ${attempt.title ?? "usage limit reset"}`}
                  onClick={() =>
                    onRedeem(
                      {
                        id: attempt.creditId,
                        resetType: "codexRateLimits",
                        status: "redeeming",
                        grantedAt: 0,
                        expiresAt: attempt.expiresAt,
                        title: attempt.title,
                        description: null,
                        actionable: false,
                      },
                      attempt,
                    )
                  }
                >
                  Resume uncertain attempt
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function accountDisplay(account: CodexAccount): string {
  // Never fall back to the raw chatgpt account id as a display label.
  return account.label ?? account.email ?? account.plan ?? "Codex account";
}

export function CodexSubscriptionsCard({
  workspaceId,
  canManage,
}: {
  workspaceId: string;
  canManage: boolean;
}) {
  const client = useAppContext().client;
  const [data, setData] = useState<CodexAccountsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{
    userCode: string;
    verificationUri: string;
  } | null>(null);
  // The row whose label is being edited + its draft value.
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);
  // True while a LIVE batched usage refresh is in flight (drives the bar skeleton).
  const [refreshingUsage, setRefreshingUsage] = useState(false);
  // The latest LIVE usage per account (carries the explicit ok/limit/error/no-data
  // status the cached columns can't). Merged over the cached windows for display.
  const [usageMap, setUsageMap] = useState<CodexUsageMap>({});
  const [overviewMap, setOverviewMap] = useState<CodexOverviewResponse["accounts"]>({});
  // The row whose single-account live refresh is in flight (per-row spinner).
  const [refreshingRow, setRefreshingRow] = useState<string | null>(null);
  const [preparingReset, setPreparingReset] = useState<string | null>(null);
  const [redemption, setRedemption] = useState<{
    accountId: string;
    credit: CodexResetCredit;
    preparation: CodexResetRedemptionPreparation;
    /** True after a POST failure where provider acceptance may be ambiguous. */
    uncertain: boolean;
  } | null>(null);
  const cancelled = useRef(false);
  const usageRefreshedRef = useRef(false);
  // A monotonic clock the rows tick off for the reset countdown — one timer for
  // the whole card, never a backend re-hit.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const refreshAccounts = useCallback(async () => {
    try {
      setData(await client.listCodexAccounts(workspaceId));
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [client, workspaceId]);

  // LIVE batched overview refresh: usage + reset-credit details settle
  // independently per account under the server's max-four provider-call cap.
  const refreshUsage = useCallback(async () => {
    setRefreshingUsage(true);
    try {
      const result = await client.codexOverview(workspaceId);
      if (!cancelled.current) {
        setOverviewMap(result.accounts);
        setUsageMap(
          Object.fromEntries(
            Object.entries(result.accounts).flatMap(([id, overview]) =>
              overview.usage.value
                ? [
                    [
                      id,
                      {
                        status: overview.usage.value.status,
                        usage: overview.usage.value,
                      },
                    ],
                  ]
                : [],
            ),
          ) as CodexUsageMap,
        );
      }
    } catch {
      /* per-account errors are surfaced as the row's "usage unavailable" state */
    } finally {
      await refreshAccounts();
      if (!cancelled.current) setRefreshingUsage(false);
    }
  }, [client, workspaceId, refreshAccounts]);

  // Explicit row retry still uses the independently-settled batch so reset
  // detail authority and usage can never drift.
  const refreshAccountUsage = useCallback(
    async (accountId: string) => {
      setRefreshingRow(accountId);
      try {
        const result = await client.codexOverview(workspaceId);
        if (!cancelled.current) {
          setOverviewMap(result.accounts);
          const usage = result.accounts[accountId]?.usage.value;
          if (usage) {
            setUsageMap((prev) => ({
              ...prev,
              [accountId]: { status: usage.status, usage },
            }));
          }
        }
      } catch {
        /* surfaced as the row's "usage unavailable" state */
      } finally {
        await refreshAccounts();
        if (!cancelled.current) setRefreshingRow(null);
      }
    },
    [client, workspaceId, refreshAccounts],
  );

  useEffect(() => {
    cancelled.current = false;
    setLoading(true);
    void refreshAccounts();
    return () => {
      cancelled.current = true;
    };
  }, [refreshAccounts]);

  // Detailed reset rows are deliberately never cached as redemption authority, so
  // every mount performs exactly ONE independently-settled live overview read. The
  // cached usage/count summary still renders immediately while that read is in
  // flight. This is event-driven by navigation/explicit refresh, never an interval.
  useEffect(() => {
    if (loading || !data || usageRefreshedRef.current) return;
    if (data.accounts.length > 0) {
      usageRefreshedRef.current = true;
      void refreshUsage();
    }
  }, [loading, data, refreshUsage]);

  const connect = useCallback(async () => {
    setBusy(true);
    try {
      const start = await client.codexConnectStart(workspaceId);
      setPending({
        userCode: start.userCode,
        verificationUri: start.verificationUri,
      });
      window.open(start.verificationUri, "_blank", "noopener,noreferrer");
      const interval = Math.max(2, start.intervalSeconds) * 1000;
      const poll = async (): Promise<void> => {
        if (cancelled.current) return;
        // The recursive poll runs detached via setTimeout, so a rejection here
        // (a 500/502/400 from the poll route) would otherwise be swallowed,
        // leaving the card stuck on "Waiting for authorization…" forever with no
        // credential ever persisted. Catch it, surface a toast, and clear pending
        // so the failure is visible and the user can retry.
        let result: Awaited<ReturnType<typeof client.codexConnectPoll>>;
        try {
          result = await client.codexConnectPoll(workspaceId, start.state);
        } catch (error) {
          setPending(null);
          toast.error(
            error instanceof Error
              ? error.message
              : "Failed to verify Codex authorization. Try again.",
          );
          return;
        }
        if (result.status === "connected") {
          setPending(null);
          toast.success(`Codex connected${result.plan ? ` (${result.plan} plan)` : ""}`);
          await refreshAccounts();
          return;
        }
        if (result.status === "expired") {
          setPending(null);
          toast.error("The code expired before it was authorized. Try again.");
          return;
        }
        setTimeout(() => void poll(), interval);
      };
      setTimeout(() => void poll(), interval);
    } catch (error) {
      setPending(null);
      toast.error(error instanceof Error ? error.message : "Failed to start Codex login");
    } finally {
      setBusy(false);
    }
  }, [client, workspaceId, refreshAccounts]);

  const activate = useCallback(
    async (accountId: string) => {
      setBusy(true);
      try {
        await client.activateCodexAccount(workspaceId, accountId);
        await refreshAccounts();
        toast.success("Active subscription updated");
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Failed to switch active subscription",
        );
      } finally {
        setBusy(false);
      }
    },
    [client, workspaceId, refreshAccounts],
  );

  // P3: enable/disable auto-rotation or change the strategy, then re-read settings.
  const setRotation = useCallback(
    async (patch: {
      rotationEnabled?: boolean;
      rotationStrategy?: CodexRotationSettings["rotationStrategy"];
    }) => {
      setBusy(true);
      try {
        await client.setCodexRotationSettings(workspaceId, patch);
        await refreshAccounts();
        toast.success("Rotation settings updated");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to update rotation settings");
      } finally {
        setBusy(false);
      }
    },
    [client, workspaceId, refreshAccounts],
  );

  const setAllocator = useCallback(
    async (account: CodexAccount, enabled: boolean) => {
      setBusy(true);
      try {
        await client.setCodexAccountAllocator(workspaceId, account.id, {
          enabled,
          expectedVersion: account.allocatorVersion,
        });
        await refreshAccounts();
        toast.success(
          enabled
            ? "Subscription enabled for new automatic turns"
            : "Subscription paused for new automatic turns",
        );
      } catch (error) {
        await refreshAccounts();
        toast.error(
          error instanceof Error ? error.message : "Failed to update automatic-turn eligibility",
        );
      } finally {
        setBusy(false);
      }
    },
    [client, workspaceId, refreshAccounts],
  );

  const beginRedemption = useCallback(
    async (accountId: string, credit: CodexResetCredit, recovery?: RedemptionAttemptView) => {
      setPreparingReset(credit.id);
      let createdLocalAttempt = false;
      try {
        const startsFreshAfterNonConsumingCompletion = Boolean(
          recovery?.status === "completed" &&
          (recovery.outcome === "nothingToReset" || recovery.outcome === "noCredit"),
        );
        // A lost HTTP response may leave the old completed UUID in
        // sessionStorage. nothingToReset/noCredit did not consume the provider
        // credit, so a newly provider-authorized click must mint a fresh
        // logical/upstream key rather than replay that completed attempt.
        if (startsFreshAfterNonConsumingCompletion) {
          removeStoredRedemptionAttempt(workspaceId, accountId, credit.id);
        }
        const resumableRecovery = startsFreshAfterNonConsumingCompletion ? undefined : recovery;
        const stored = startsFreshAfterNonConsumingCompletion
          ? null
          : storedRedemptionAttempt(workspaceId, accountId, credit.id);
        const attempt: StoredRedemptionAttempt = resumableRecovery ??
          stored ?? {
            attemptId: crypto.randomUUID(),
            creditId: credit.id,
            title: credit.title,
            expiresAt: credit.expiresAt,
          };
        createdLocalAttempt = resumableRecovery == null && stored == null;
        // Session storage is only a convenience checkpoint. Durable server
        // discovery restores provider_started/completed attempts if storage is
        // unavailable or the owning human opens a new browser session.
        storeRedemptionAttempt(workspaceId, accountId, attempt);
        const preparation = await prepareCodexResetRedemption(workspaceId, accountId, {
          attemptId: attempt.attemptId,
          creditId: credit.id,
        });
        if (resumableRecovery && !preparation.resumable) {
          removeStoredRedemptionAttempt(workspaceId, accountId, credit.id);
          toast.error("This reset was not sent to the provider and is no longer actionable.");
          await refreshUsage();
          return;
        }
        setRedemption({ accountId, credit, preparation, uncertain: false });
      } catch (error) {
        // Preparation itself never calls or claims the provider. If this was a
        // fresh local UUID, do not leave a false "uncertain/resume" affordance.
        // A pre-existing attempt is preserved because it may already be
        // provider_started or completed in durable server state.
        if (createdLocalAttempt) {
          removeStoredRedemptionAttempt(workspaceId, accountId, credit.id);
        }
        toast.error(error instanceof Error ? error.message : "Could not prepare reset redemption");
      } finally {
        setPreparingReset(null);
      }
    },
    [workspaceId, refreshUsage],
  );

  const confirmRedemption = useCallback(async (): Promise<boolean> => {
    if (!redemption) return false;
    try {
      const result = await redeemCodexResetCredit(workspaceId, redemption.accountId, {
        attemptId: redemption.preparation.attemptId,
        creditId: redemption.credit.id,
        confirmationToken: redemption.preparation.confirmationToken,
        confirmation: "REDEEM_USAGE_LIMIT_RESET",
      });
      removeStoredRedemptionAttempt(workspaceId, redemption.accountId, redemption.credit.id);
      toast.success(redemptionOutcomeCopy(result.outcome));
      setRedemption(null);
      await refreshUsage();
      return true;
    } catch (error) {
      const status = managedRedemptionErrorStatus(error);
      const definitePreProviderFailure =
        redemption.preparation.recoveryStatus == null &&
        ((error instanceof ApiError && (error.status === 400 || error.status === 403)) ||
          status === "not_actionable" ||
          status === "preflight_unavailable" ||
          status === "provider_unavailable" ||
          status === "confirmation_expired");
      if (definitePreProviderFailure) {
        removeStoredRedemptionAttempt(workspaceId, redemption.accountId, redemption.credit.id);
        setRedemption(null);
        await refreshUsage();
        toast.error(error instanceof Error ? error.message : "Redemption was not sent");
        return false;
      }
      // Preserve only genuinely ambiguous provider work under the same logical
      // id. The overview is the durable discovery authority after tab loss.
      setRedemption((current) => (current ? { ...current, uncertain: true } : current));
      toast.error(
        error instanceof Error
          ? error.message
          : "Redemption outcome is uncertain. Retry this same attempt.",
      );
      return false;
    }
  }, [redemption, workspaceId, refreshUsage]);

  const disconnect = useCallback(
    async (accountId: string) => {
      setBusy(true);
      try {
        await client.disconnectCodexAccount(workspaceId, accountId);
        await refreshAccounts();
        toast.success("Subscription disconnected");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to disconnect subscription");
      } finally {
        setBusy(false);
      }
    },
    [client, workspaceId, refreshAccounts],
  );

  const commitRename = useCallback(
    async (accountId: string, label: string) => {
      setEditing(null);
      setBusy(true);
      try {
        await client.renameCodexAccount(
          workspaceId,
          accountId,
          label.trim() === "" ? null : label.trim(),
        );
        await refreshAccounts();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to rename subscription");
      } finally {
        setBusy(false);
      }
    },
    [client, workspaceId, refreshAccounts],
  );

  const accounts = data?.accounts ?? [];
  const activeAccountId = data?.activeAccountId ?? null;
  const rotationEnabled = data?.settings?.rotationEnabled ?? false;

  return (
    <section
      aria-labelledby="codex-subscriptions-heading"
      className="grid gap-3 rounded-lg border border-border bg-surface p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2
            id="codex-subscriptions-heading"
            className="flex items-center gap-1.5 text-sm font-medium"
          >
            <SparklesIcon className="size-3.5 text-brand" />
            Codex subscriptions
          </h2>
          <p className="mt-1 text-xs text-fg-muted">
            Connect one or more ChatGPT plans to run agents on your subscription. Turns using a{" "}
            <span className="font-medium">Codex</span> model spend your ChatGPT usage —{" "}
            <span className="font-medium">no API credits</span>.
          </p>
        </div>
        {canManage && accounts.length > 0 && !pending ? (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => void connect()}
          >
            <PlusIcon className="size-3.5" /> Connect another subscription
          </Button>
        ) : null}
      </div>

      {accounts.length > 1 && canManage ? (
        <div className="grid gap-2 rounded-md border border-border bg-bg p-3">
          <label className="flex cursor-pointer items-center justify-between gap-3">
            <span className="text-xs">
              <span className="font-medium">Auto-rotate subscriptions</span>
              <span className="ml-1 text-fg-subtle">
                — each session sticks to one plan for maximum prompt-cache reuse, spread across all
                of them; a capped plan hands its sessions to the others, never mid-turn.
              </span>
            </span>
            <input
              type="checkbox"
              className="size-4 accent-brand"
              checked={rotationEnabled}
              disabled={busy}
              onChange={(e) => void setRotation({ rotationEnabled: e.target.checked })}
            />
          </label>
        </div>
      ) : null}

      {loading ? (
        <div className="flex items-center gap-2 text-xs text-fg-subtle">
          <Loader2Icon className="size-3.5 animate-spin" /> Loading subscriptions…
        </div>
      ) : pending ? (
        <div className="grid gap-2 rounded-md border border-border bg-bg p-3">
          <div className="text-xs text-fg-muted">
            Enter this code at the OpenAI page (opened in a new tab), then leave this open:
          </div>
          <div className="flex items-center gap-2">
            <code className="rounded bg-surface-2 px-3 py-1.5 text-lg font-semibold tracking-widest">
              {pending.userCode}
            </code>
            <Button asChild type="button" variant="secondary" size="sm">
              <a href={pending.verificationUri} target="_blank" rel="noopener noreferrer">
                Open auth page <ExternalLinkIcon className="size-3.5" />
              </a>
            </Button>
          </div>
          <div className="flex items-center gap-2 text-xs text-fg-subtle">
            <Loader2Icon className="size-3.5 animate-spin" /> Waiting for authorization…
          </div>
        </div>
      ) : accounts.length === 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-fg-subtle">
            Not connected. Connecting needs admin access and a ChatGPT Plus/Pro/Team plan.
          </p>
          {canManage ? (
            <Button type="button" size="sm" disabled={busy} onClick={() => void connect()}>
              {busy ? (
                <Loader2Icon className="size-3.5 animate-spin" />
              ) : (
                <SparklesIcon className="size-3.5" />
              )}{" "}
              Connect Codex
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="grid gap-2">
          {accounts.map((account) => {
            const isActive = account.id === activeAccountId;
            const needsRelogin = account.status !== "active" && account.lastError != null;
            return (
              <article
                key={account.id}
                className="grid gap-2 rounded-md border border-border bg-bg p-3"
                aria-label={`${accountDisplay(account)} Codex subscription`}
              >
                <div className="flex flex-wrap items-center gap-3">
                  <label
                    className="flex min-h-11 min-w-11 cursor-pointer items-center justify-center"
                    title="Used when a session isn't pinned to a specific subscription"
                  >
                    <input
                      type="radio"
                      name="codex-active"
                      className="size-3.5 accent-brand"
                      checked={isActive}
                      disabled={!canManage || busy}
                      aria-label={`Use ${accountDisplay(account)} as active subscription`}
                      onChange={() => {
                        if (!isActive) void activate(account.id);
                      }}
                    />
                  </label>
                  <div className="min-w-0 flex-1">
                    {editing?.id === account.id ? (
                      <Input
                        autoFocus
                        value={editing.value}
                        onChange={(e) => setEditing({ id: account.id, value: e.target.value })}
                        onBlur={() => void commitRename(account.id, editing.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void commitRename(account.id, editing.value);
                          if (e.key === "Escape") setEditing(null);
                        }}
                        className="h-7 text-sm"
                      />
                    ) : (
                      <button
                        type="button"
                        className="truncate text-left text-sm font-medium hover:underline disabled:cursor-default disabled:no-underline"
                        disabled={!canManage}
                        onClick={() =>
                          setEditing({
                            id: account.id,
                            value: account.label ?? "",
                          })
                        }
                        title={canManage ? "Click to rename" : undefined}
                      >
                        {accountDisplay(account)}
                      </button>
                    )}
                    <div className="mt-0.5 truncate text-xs text-fg-subtle">
                      {account.email ? `${account.email} · ` : ""}
                      {account.status === "active"
                        ? "Token valid"
                        : account.status.replaceAll("_", " ")}
                      {account.expiresAt
                        ? ` · expires ${new Date(account.expiresAt).toLocaleString()}`
                        : ""}
                    </div>
                  </div>
                  {account.plan ? (
                    <MetaChip dot="idle" rounded="full">
                      {account.plan} plan
                    </MetaChip>
                  ) : null}
                  {(() => {
                    const coolingSecs = account.exhaustedUntil
                      ? Math.max(
                          0,
                          Math.round((new Date(account.exhaustedUntil).getTime() - now) / 1000),
                        )
                      : 0;
                    if (coolingSecs > 0) {
                      return (
                        <MetaChip
                          dot="waiting"
                          rounded="full"
                          title="Rotated off after hitting its cap; skipped until reset"
                        >
                          Cooling down · {resetLabel(coolingSecs)}
                        </MetaChip>
                      );
                    }
                    if (isActive) {
                      return (
                        <span className="shrink-0 text-2xs uppercase tracking-wide text-fg-subtle">
                          {rotationEnabled ? "Active · default when idle" : "Active"}
                        </span>
                      );
                    }
                    return null;
                  })()}
                </div>
                <div className="flex min-w-0 flex-wrap items-start justify-between gap-2 rounded-md border border-border/70 bg-surface/50 p-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium">Use for new automatic turns</div>
                    <p className="mt-0.5 break-words text-2xs text-fg-subtle">
                      Pausing affects only new automatic selection. Current leased or frozen turns
                      continue; quota, cooldown, and relogin state still gate eligibility.
                    </p>
                  </div>
                  <label className="flex min-h-11 shrink-0 cursor-pointer items-center gap-2 text-xs">
                    <span className="sr-only">
                      {account.allocatorEnabled ? "Pause" : "Enable"} {accountDisplay(account)} for
                      new automatic turns
                    </span>
                    <input
                      type="checkbox"
                      className="size-4 accent-brand"
                      checked={account.allocatorEnabled}
                      disabled={!canManage || busy}
                      aria-label={`Use ${accountDisplay(account)} for new automatic turns`}
                      onChange={(event) => void setAllocator(account, event.target.checked)}
                    />
                    <span aria-hidden="true" className="text-fg-muted">
                      {account.allocatorEnabled ? "Enabled" : "Paused"}
                    </span>
                  </label>
                </div>
                {needsRelogin ? (
                  <div className="flex items-center gap-1.5 rounded-md border border-status-waiting/30 bg-status-waiting/10 p-2 text-xs text-status-waiting">
                    <TriangleAlertIcon className="size-3.5" />{" "}
                    {account.lastError ?? "Reconnect needed."}
                  </div>
                ) : (
                  <AccountUsage
                    account={account}
                    live={usageMap[account.id]}
                    overview={overviewMap[account.id]}
                    now={now}
                    refreshing={refreshingUsage || refreshingRow === account.id}
                    onRetry={() => void refreshAccountUsage(account.id)}
                  />
                )}
                <ResetCreditInventory
                  overview={overviewMap[account.id]}
                  now={now}
                  busy={busy || preparingReset != null}
                  recoveryAttempts={redemptionAttemptViews(
                    workspaceId,
                    account.id,
                    overviewMap[account.id],
                  )}
                  onRedeem={(credit, recovery) =>
                    void beginRedemption(account.id, credit, recovery)
                  }
                />
                {canManage ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy || refreshingRow === account.id}
                      onClick={() => void refreshAccountUsage(account.id)}
                    >
                      {refreshingRow === account.id ? (
                        <Loader2Icon className="size-3.5 animate-spin" />
                      ) : (
                        <RefreshCwIcon className="size-3.5" />
                      )}{" "}
                      Refresh
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => void disconnect(account.id)}
                    >
                      <Trash2Icon className="size-3.5" /> Disconnect
                    </Button>
                  </div>
                ) : null}
              </article>
            );
          })}
          <p className="text-2xs text-fg-subtle">
            {rotationEnabled ? (
              <>
                Sessions are spread across all {accounts.length} subscriptions, each sticking to its
                own plan for maximum prompt-cache reuse. Pinned sessions stay on their pin.
              </>
            ) : (
              <>
                The <span className="font-medium">active</span> subscription runs every session that
                isn't pinned to a specific one.
              </>
            )}
          </p>
        </div>
      )}
      <ConfirmDialog
        open={redemption != null}
        onOpenChange={(open) => {
          if (!open && redemption) {
            // Cancel before the first POST has no durable/provider side effect,
            // so clear the local UUID instead of presenting it as uncertain.
            // Once a prior attempt is resumable or a POST failed, preserve the
            // exact logical id for ambiguity-safe retry after close/reload.
            if (!redemption.preparation.resumable && !redemption.uncertain) {
              removeStoredRedemptionAttempt(
                workspaceId,
                redemption.accountId,
                redemption.credit.id,
              );
            }
            setRedemption(null);
          }
        }}
        title="Redeem this usage limit reset?"
        description="This consumes one provider rate-limit reset credit. It may reset eligible 5-hour and weekly usage windows, is irreversible, and cannot be undone."
        confirmLabel="Redeem usage limit reset"
        cancelLabel="Cancel"
        cancelAutoFocus
        onConfirm={confirmRedemption}
      >
        {redemption ? (
          <div className="grid min-w-0 gap-2 rounded-md border border-status-waiting/30 bg-status-waiting/10 p-3 text-xs">
            <div className="break-words font-medium">
              {redemption.credit.title ?? "Full usage limit reset"}
            </div>
            <div className="break-words text-fg-muted">
              {redemption.credit.expiresAt == null
                ? "The provider reports no expiry."
                : `Expires ${absoluteTimestamp(redemption.credit.expiresAt)} (${relativeTimestamp(redemption.credit.expiresAt, now)}).`}
            </div>
            <div className="break-words text-fg-subtle">
              {redemption.uncertain
                ? "The provider outcome is uncertain. Retry only this same attempt; OpenGeni will reuse its original idempotency key."
                : redemption.preparation.resumable
                  ? "This resumes the same uncertain provider attempt; OpenGeni will reuse its original idempotency key."
                  : `Confirmation expires ${absoluteTimestamp(redemption.preparation.expiresAt)} (${relativeTimestamp(redemption.preparation.expiresAt, now)}).`}
            </div>
          </div>
        ) : null}
      </ConfirmDialog>
    </section>
  );
}
