import { trackModelConnection } from "@/lib/analytics-observer";

// Codex (ChatGPT) subscriptions for Settings > Models: the data and every
// mutation (useCodexSubscriptions), the usage-limit reset list, the device-code
// panel and the redemption confirm. The list rows, the account page and the
// Connect page that present them live in components/models/codex-models.tsx.
// A connected `codex/*` model run uses the active/pinned subscription instead
// of spending API credits.
import type {
  CodexAccount,
  CodexAccountOverview,
  CodexAccountsResponse,
  CodexOverviewResponse,
  CodexResetCredit,
  CodexResetRedemptionRecovery,
  CodexUsageMap,
  CodexUsageWindow,
  WorkspaceCodexSubscriptionMode,
} from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { pollDeviceAuthorization } from "@opengeni/connect";
import { SubscriptionDeviceCodePanel } from "@/components/subscription-device-code-panel";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { formatAbsoluteTime } from "@/components/ui/relative-time";
import { SettingRow, SettingRowGroup } from "@/components/ui/setting-row";
import type { UsageWindowReading } from "@/components/ui/usage-meter";
import {
  ApiError,
  prepareCodexResetRedemption,
  redeemCodexResetCredit,
  type CodexResetRedemptionPreparation,
} from "@/api";

type StoredRedemptionAttempt = {
  attemptId: string;
  creditId: string;
  title: string | null;
  expiresAt: number | null;
};

export type RedemptionAttemptView = StoredRedemptionAttempt & {
  status: "local" | CodexResetRedemptionRecovery["status"];
  outcome: CodexResetRedemptionRecovery["outcome"];
};

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

function redemptionOutcomeCopy(outcome: NonNullable<CodexResetRedemptionRecovery["outcome"]>) {
  return {
    reset: "Usage limits reset.",
    alreadyRedeemed: "The earlier redemption succeeded; usage was refreshed.",
    nothingToReset: "ChatGPT found no usage limit to reset.",
    noCredit: "ChatGPT found no reset to use.",
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

/** Unix seconds or an ISO string, as a Date. */
function toDate(value: string | number): Date {
  return new Date(typeof value === "number" ? value * 1000 : value);
}

function expiryLabel(expiresAt: number | null): string {
  return expiresAt == null ? "Doesn't expire" : `Expires ${formatAbsoluteTime(toDate(expiresAt))}`;
}

/* ----------------------------------------------------------------------------
   Usage.
   -------------------------------------------------------------------------- */

// Seconds until reset, computed CLIENT-SIDE off the absolute resetAt (skew-free,
// preferred) and falling back to the snapshot's resetAfterSeconds.
function resetDate(window: CodexUsageWindow, now: number): Date | null {
  if (window.resetAt) {
    const date = new Date(window.resetAt);
    if (!Number.isNaN(date.getTime())) return date;
  }
  if (typeof window.resetAfterSeconds === "number" && window.resetAfterSeconds > 0) {
    return new Date(now + window.resetAfterSeconds * 1000);
  }
  return null;
}

/** One provider window as a meter reading: percent LEFT, and when it resets. */
export function codexUsageReading(
  label: string,
  window: CodexUsageWindow | null | undefined,
  now: number,
): UsageWindowReading {
  if (!window) return { label, percent: null };
  const reset = resetDate(window, now);
  return {
    label,
    percent: Math.round(Math.min(100, Math.max(0, window.remaining))),
    ...(reset ? { resetsLabel: formatAbsoluteTime(reset, { now }) } : {}),
  };
}

/** Weekly first (the limit people run out of), then the 5-hour window. */
export function codexUsageReadings(
  usage: { fiveHour: CodexUsageWindow | null; weekly: CodexUsageWindow | null } | null | undefined,
  now: number,
): UsageWindowReading[] {
  return [
    codexUsageReading("Weekly", usage?.weekly, now),
    codexUsageReading("5-hour", usage?.fiveHour, now),
  ];
}

/* ----------------------------------------------------------------------------
   Usage limit resets.
   -------------------------------------------------------------------------- */

/** One muted line: who can redeem, or why the list is view only. */
export function resetAuthorityNote(overview: CodexAccountOverview): string | null {
  const reset = overview.resetCredits;
  const count = reset.availableCount ?? 0;
  const detail: Record<typeof reset.detailState, string | null> = {
    detailed: null,
    count_only: `ChatGPT reports ${count} reset${count === 1 ? "" : "s"} but no details, so they are view only.`,
    capped: "ChatGPT returned fewer details than its count, so these are view only.",
    unsupported: "This plan doesn't report usage limit resets.",
    unknown: "ChatGPT returned reset data Opengeni doesn't recognize, so these are view only.",
    error: "Couldn't check usage limit resets. Refresh usage to try again.",
  };
  if (detail[reset.detailState]) return detail[reset.detailState];
  if (count === 0) return null;
  if (overview.canRedeem) {
    return "Each gives this account a fresh usage limit. Only you can redeem them, as the person who connected it.";
  }
  switch (overview.redemptionAccess.ownership) {
    case "unowned":
      return "No one is recorded as the owner of this older connection, so its resets are view only. Reconnect the same ChatGPT account while signed in as yourself to claim it.";
    case "managed_human_unavailable":
      return "Resets are view only here: Opengeni couldn't confirm who is signed in to this browser, so ownership can't be claimed or changed.";
    case "different_human":
      return "Only the person who connected this account can redeem its resets. Disconnecting it is the only way to change who owns it.";
    default:
      return null;
  }
}

/** True when the reset list has anything worth a section. */
export function hasResetInventory(
  overview: CodexAccountOverview | undefined,
  recoveryAttempts: readonly RedemptionAttemptView[],
): boolean {
  if (!overview) return false;
  const reset = overview.resetCredits;
  return (
    (reset.availableCount ?? 0) > 0 ||
    reset.credits.length > 0 ||
    reset.detailState === "error" ||
    (overview.canResumeRedemption && recoveryAttempts.length > 0)
  );
}

/**
 * Flat list of usage limit resets: one row per reset with its expiry, and a
 * Redeem button only when it can actually be redeemed by this person.
 */
export function ResetCreditInventory({
  overview,
  busy,
  recoveryAttempts,
  onRedeem,
  onReconnectSameAccount,
}: {
  overview: CodexAccountOverview | undefined;
  /** Kept for callers that tick a clock; expiry labels use the absolute time. */
  now?: number;
  busy: boolean;
  recoveryAttempts: RedemptionAttemptView[];
  onRedeem: (credit: CodexResetCredit, recovery?: RedemptionAttemptView) => void;
  onReconnectSameAccount: () => void;
}) {
  if (!overview) return null;
  const reset = overview.resetCredits;
  const note = resetAuthorityNote(overview);
  const visibleCreditIds = new Set(reset.credits.map((credit) => credit.id));
  const hiddenRecoveries = overview.canResumeRedemption
    ? recoveryAttempts.filter((attempt) => !visibleCreditIds.has(attempt.creditId))
    : [];
  const canClaim =
    !overview.canRedeem &&
    (reset.availableCount ?? 0) > 0 &&
    overview.redemptionAccess.ownership === "unowned" &&
    overview.redemptionAccess.canClaimUnownedViaReconnect;
  return (
    <div className="flex min-w-0 flex-col gap-3" aria-live="polite">
      {note ? (
        <p role="status" className="text-xs leading-4.5 text-fg-muted">
          {note}
        </p>
      ) : null}
      {canClaim ? (
        <div>
          <Button
            type="button"
            size="sm"
            className="rounded-[10px] pointer-coarse:h-11"
            disabled={busy}
            onClick={onReconnectSameAccount}
          >
            Reconnect same account
          </Button>
        </div>
      ) : null}
      {reset.credits.length > 0 || hiddenRecoveries.length > 0 ? (
        <SettingRowGroup role="list" aria-label="Usage limit resets" className="-mb-3">
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
            const state =
              credit.status === "redeeming"
                ? "Being redeemed"
                : credit.status === "redeemed"
                  ? "Redeemed"
                  : null;
            const description = [
              state,
              priorNonConsumingOutcome
                ? `Earlier attempt: ${priorNonConsumingOutcome}${credit.actionable ? " It's available again." : ""}`
                : null,
            ]
              .filter(Boolean)
              .join(" · ");
            return (
              <SettingRow
                key={credit.id}
                role="listitem"
                label={expiryLabel(credit.expiresAt)}
                description={description || undefined}
                control={
                  completedSuccessfulOutcome ? (
                    <span className="text-xs text-status-idle">{completedSuccessfulOutcome}</span>
                  ) : credit.actionable || resumable ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="rounded-[10px] pointer-coarse:h-11"
                      disabled={busy}
                      aria-label={`${resumable ? "Resume redemption of" : "Redeem"} ${credit.title ?? "usage limit reset"}`}
                      onClick={() =>
                        onRedeem(
                          credit,
                          resumable || priorNonConsumingOutcome ? recovery : undefined,
                        )
                      }
                    >
                      {resumable ? "Resume" : "Redeem"}
                    </Button>
                  ) : null
                }
              />
            );
          })}
          {hiddenRecoveries.map((attempt) => (
            <SettingRow
              key={attempt.attemptId}
              role="listitem"
              label={
                attempt.expiresAt != null ? expiryLabel(attempt.expiresAt) : "Usage limit reset"
              }
              description={
                attempt.status === "completed" && attempt.outcome
                  ? redemptionOutcomeCopy(attempt.outcome)
                  : "ChatGPT no longer lists this reset. Resume only the same uncertain attempt; Opengeni never starts a new one for it."
              }
              control={
                attempt.status !== "completed" ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="rounded-[10px] pointer-coarse:h-11"
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
                    Resume
                  </Button>
                ) : null
              }
            />
          ))}
        </SettingRowGroup>
      ) : null}
    </div>
  );
}

export function codexAccountName(account: CodexAccount): string {
  // Never fall back to the raw chatgpt account id as a display label.
  return account.label ?? account.email ?? account.plan ?? "Codex account";
}

/** Plans come back lowercase ("pro"); show them as the plan name. */
export function planLabel(plan: string | null | undefined, provider: string): string {
  if (!plan) return `${provider} plan`;
  return `${provider} ${plan.charAt(0).toLocaleUpperCase()}${plan.slice(1)}`;
}

type ClipboardModule = {
  copyTextToClipboard: (text: string) => Promise<boolean>;
};

const loadSharedClipboard = (): Promise<ClipboardModule> => import("@opengeni/react/clipboard");

export function CodexDeviceCodePanel({
  userCode,
  verificationUri,
  loadClipboard = loadSharedClipboard,
}: {
  userCode: string;
  verificationUri: string;
  loadClipboard?: () => Promise<ClipboardModule>;
}) {
  return (
    <SubscriptionDeviceCodePanel
      provider="codex"
      userCode={userCode}
      verificationUri={verificationUri}
      loadClipboard={loadClipboard}
      onCopyResult={(copied) =>
        copied
          ? toast.success("Code copied")
          : toast.error("Couldn't copy the code", { description: "Copy it manually instead." })
      }
    />
  );
}

/* ----------------------------------------------------------------------------
   The data and every mutation. One instance per Models page mount: the list
   and the account pages share it, so opening an account never re-reads the
   provider, and a device-code sign-in keeps polling while you navigate.
   -------------------------------------------------------------------------- */

export type CodexRedemption = {
  accountId: string;
  credit: CodexResetCredit;
  preparation: CodexResetRedemptionPreparation;
  /** True after a POST failure where provider acceptance may be ambiguous. */
  uncertain: boolean;
};

export type CodexWorking =
  | "source"
  | "rotation"
  | `allocator:${string}`
  | `apps:${string}`
  | `activate:${string}`
  | `rename:${string}`
  | `disconnect:${string}`;

export type CodexSubscriptions = ReturnType<typeof useCodexSubscriptions>;

export function useCodexSubscriptions({
  client,
  workspaceId,
  canManage,
}: {
  client: OpenGeniBrowserClient;
  workspaceId: string;
  canManage: boolean;
}) {
  const [data, setData] = useState<CodexAccountsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [working, setWorking] = useState<CodexWorking | null>(null);
  const [pending, setPending] = useState<{
    userCode: string;
    verificationUri: string;
  } | null>(null);
  // True while a LIVE batched usage refresh is in flight (drives the meter skeleton).
  const [refreshingUsage, setRefreshingUsage] = useState(true);
  // The latest LIVE usage per account (carries the explicit ok/limit/error/no-data
  // status the cached columns can't). Never merge it with cached account windows.
  const [usageMap, setUsageMap] = useState<CodexUsageMap>({});
  const [overviewMap, setOverviewMap] = useState<CodexOverviewResponse["accounts"]>({});
  // The last live overview read failed as a whole (not one account's usage).
  const [usageError, setUsageError] = useState(false);
  // The account whose single-account live refresh is in flight (per-page spinner).
  const [refreshingRow, setRefreshingRow] = useState<string | null>(null);
  const [preparingReset, setPreparingReset] = useState<string | null>(null);
  const [redemption, setRedemption] = useState<CodexRedemption | null>(null);
  const cancelled = useRef(false);
  const usageRefreshedRef = useRef(false);
  // A clock for reset times and usage labels - one timer, never a backend re-hit.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const refreshAccounts = useCallback(async () => {
    try {
      setData(await client.listCodexAccounts(workspaceId));
      setLoadError(null);
    } catch (error) {
      setData(null);
      setLoadError(error instanceof Error ? error.message : "Could not load subscriptions");
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
            Object.entries(result.accounts).map(([id, overview]) => [
              id,
              {
                status: overview.usage.value?.status ?? "no-data",
                usage: overview.usage.value ?? null,
              },
            ]),
          ) as CodexUsageMap,
        );
        setNow(Date.now());
        setUsageError(false);
      }
    } catch {
      // Per-account errors are each account's own "usage unavailable" state.
      if (!cancelled.current) setUsageError(true);
    } finally {
      await refreshAccounts();
      if (!cancelled.current) setRefreshingUsage(false);
    }
  }, [client, workspaceId, refreshAccounts]);

  // Explicit retry still uses the independently-settled batch so reset detail
  // authority and usage can never drift.
  const refreshAccountUsage = useCallback(
    async (accountId: string) => {
      setRefreshingRow(accountId);
      try {
        const result = await client.codexOverview(workspaceId);
        if (!cancelled.current) {
          setOverviewMap(result.accounts);
          const usage = result.accounts[accountId]?.usage.value;
          setUsageMap((prev) => ({
            ...prev,
            [accountId]: { status: usage?.status ?? "no-data", usage: usage ?? null },
          }));
          setNow(Date.now());
        }
      } catch {
        /* surfaced as the account's "usage unavailable" state */
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
  // account identity renders immediately, but usage waits for this read rather
  // than flashing cached limits. Navigation/explicit refresh only, never an interval.
  useEffect(() => {
    if (loading || !data || usageRefreshedRef.current) return;
    if (data.accounts.length > 0) {
      usageRefreshedRef.current = true;
      void refreshUsage();
    } else {
      setRefreshingUsage(false);
    }
  }, [loading, data, refreshUsage]);

  const setSourceMode = useCallback(
    async (mode: WorkspaceCodexSubscriptionMode, success?: string): Promise<boolean> => {
      setBusy(true);
      setWorking("source");
      try {
        await client.requestJson("PATCH", `/v1/workspaces/${workspaceId}/codex/source`, { mode });
        usageRefreshedRef.current = false;
        await refreshAccounts();
        if (success) toast.success(success);
        return true;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Couldn't change the Codex source");
        return false;
      } finally {
        setBusy(false);
        setWorking(null);
      }
    },
    [client, workspaceId, refreshAccounts],
  );

  /**
   * Start a device-code sign-in. `useFor` answers "use this account instead of
   * the organization's subscriptions?" when the organization pool is in use:
   * "organization" pins the source first so connecting doesn't switch it;
   * "workspace" switches to this workspace's accounts once the account exists.
   */
  const connect = useCallback(
    async (options?: {
      useFor?: "workspace" | "organization";
      onConnected?: (accountId: string | null) => void;
    }) => {
      const recordOutcome = trackModelConnection("codex", workspaceId);
      const mode = data?.source?.mode;
      if (options?.useFor === "organization" && mode === "automatic") {
        const kept = await setSourceMode("organization");
        if (!kept) return;
      }
      setBusy(true);
      try {
        const start = await client.codexConnectStart(workspaceId);
        setPending({
          userCode: start.userCode,
          verificationUri: start.verificationUri,
        });
        window.open(start.verificationUri, "_blank", "noopener,noreferrer");
        // Preserve server-side completion after this page unmounts, but bound it
        // by the provider's 15-minute device window. Shared headless pacing has no
        // UI dependency and never blindly retries an uncertain token exchange.
        void pollDeviceAuthorization({
          poll: () => client.codexConnectPoll(workspaceId, start.state),
          expired: { status: "expired" } as Awaited<ReturnType<typeof client.codexConnectPoll>>,
          initialIntervalSeconds: Math.max(2, start.intervalSeconds),
          expiresAtMs: Date.now() + 15 * 60_000,
          signal: new AbortController().signal,
        })
          .then(async (result) => {
            if (!result) return;
            if (result.status === "connected") {
              recordOutcome("connected");
              if (options?.useFor === "workspace" && mode === "organization") {
                await client
                  .requestJson("PATCH", `/v1/workspaces/${workspaceId}/codex/source`, {
                    mode: "workspace",
                  })
                  .catch((error: unknown) =>
                    toast.error(
                      error instanceof Error
                        ? error.message
                        : "Connected, but couldn't switch to this workspace's accounts",
                    ),
                  );
                usageRefreshedRef.current = false;
              }
              if (!cancelled.current) {
                setPending(null);
                toast.success(
                  `Codex connected${result.plan ? ` (${planLabel(result.plan, "ChatGPT")})` : ""}`,
                );
                await refreshUsage();
                options?.onConnected?.(
                  "accountId" in result && typeof result.accountId === "string"
                    ? result.accountId
                    : null,
                );
              }
              return;
            }
            if (result.status === "expired") {
              recordOutcome("expired");
              if (!cancelled.current) {
                setPending(null);
                toast.error("The code expired before it was used. Try again.");
              }
              return;
            }
          })
          .catch((error) => {
            recordOutcome("outcome_unknown");
            if (!cancelled.current) {
              setPending(null);
              toast.error(
                error instanceof Error
                  ? error.message
                  : "Couldn't confirm the ChatGPT sign-in. Try again.",
              );
            }
          });
      } catch (error) {
        recordOutcome("outcome_unknown");
        setPending(null);
        toast.error(error instanceof Error ? error.message : "Couldn't start the ChatGPT sign-in");
      } finally {
        setBusy(false);
      }
    },
    [client, workspaceId, refreshUsage, data?.source?.mode, setSourceMode],
  );

  const activate = useCallback(
    async (account: CodexAccount) => {
      setBusy(true);
      setWorking(`activate:${account.id}`);
      try {
        await client.activateCodexAccount(workspaceId, account.id);
        await refreshAccounts();
        toast.success(`${codexAccountName(account)} is now the primary account`);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Couldn't change the primary account");
      } finally {
        setBusy(false);
        setWorking(null);
      }
    },
    [client, workspaceId, refreshAccounts],
  );

  // Spread work across accounts (rotation on) or use the primary only (off).
  const setRotation = useCallback(
    async (patch: { rotationEnabled: boolean }) => {
      setBusy(true);
      setWorking("rotation");
      try {
        await client.setCodexRotationSettings(workspaceId, patch);
        await refreshAccounts();
        toast.success(
          patch.rotationEnabled
            ? "New work is spread across accounts"
            : "New work uses the primary account only",
        );
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Couldn't change how accounts are picked",
        );
      } finally {
        setBusy(false);
        setWorking(null);
      }
    },
    [client, workspaceId, refreshAccounts],
  );

  const setAllocator = useCallback(
    async (account: CodexAccount, enabled: boolean) => {
      setBusy(true);
      setWorking(`allocator:${account.id}`);
      try {
        await client.setCodexAccountAllocator(workspaceId, account.id, {
          enabled,
          expectedVersion: account.allocatorVersion,
        });
        await refreshAccounts();
        toast.success(
          enabled
            ? `${codexAccountName(account)} is used for new work again`
            : `${codexAccountName(account)} won't be used for new work`,
        );
      } catch (error) {
        await refreshAccounts();
        toast.error(error instanceof Error ? error.message : "Couldn't change this account");
      } finally {
        setBusy(false);
        setWorking(null);
      }
    },
    [client, workspaceId, refreshAccounts],
  );

  const setAppsCredential = useCallback(
    async (account: CodexAccount, enabled: boolean) => {
      if (!data?.apps) return;
      setBusy(true);
      setWorking(`apps:${account.id}`);
      try {
        if (enabled) {
          await client.designateCodexAppsAccount(workspaceId, account.id, data.apps.version);
          toast.success(`Codex Apps uses ${codexAccountName(account)}`);
        } else {
          await client.clearCodexAppsAccount(workspaceId, data.apps.version);
          toast.success("Codex Apps turned off");
        }
        await refreshAccounts();
      } catch (error) {
        await refreshAccounts();
        toast.error(error instanceof Error ? error.message : "Couldn't change Codex Apps");
      } finally {
        setBusy(false);
        setWorking(null);
      }
    },
    [client, data, workspaceId, refreshAccounts],
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
          toast.error("This reset was not sent to ChatGPT and can't be redeemed any more.");
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
        toast.error(error instanceof Error ? error.message : "Couldn't prepare the reset");
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
        toast.error(error instanceof Error ? error.message : "The reset was not sent");
        return false;
      }
      // Preserve only genuinely ambiguous provider work under the same logical
      // id. The overview is the durable discovery authority after tab loss.
      setRedemption((current) => (current ? { ...current, uncertain: true } : current));
      toast.error(
        error instanceof Error
          ? error.message
          : "The outcome is uncertain. Retry this same attempt.",
      );
      return false;
    }
  }, [redemption, workspaceId, refreshUsage]);

  const closeRedemption = useCallback(() => {
    setRedemption((current) => {
      if (!current) return current;
      // Cancel before the first POST has no durable/provider side effect,
      // so clear the local UUID instead of presenting it as uncertain.
      // Once a prior attempt is resumable or a POST failed, preserve the
      // exact logical id for ambiguity-safe retry after close/reload.
      if (!current.preparation.resumable && !current.uncertain) {
        removeStoredRedemptionAttempt(workspaceId, current.accountId, current.credit.id);
      }
      return null;
    });
  }, [workspaceId]);

  /** Throws with a user-facing message so the confirm dialog can show it. */
  const disconnect = useCallback(
    async (account: CodexAccount): Promise<void> => {
      setBusy(true);
      setWorking(`disconnect:${account.id}`);
      try {
        await client.disconnectCodexAccount(workspaceId, account.id);
        await refreshAccounts();
        toast.success(`Disconnected ${codexAccountName(account)}`);
      } catch (error) {
        throw new Error(
          error instanceof Error && error.message
            ? error.message
            : `Couldn't disconnect ${codexAccountName(account)}. Try again.`,
          { cause: error },
        );
      } finally {
        setBusy(false);
        setWorking(null);
      }
    },
    [client, workspaceId, refreshAccounts],
  );

  /** Throws with a user-facing message so the rename prompt can show it. */
  const rename = useCallback(
    async (account: CodexAccount, label: string): Promise<void> => {
      setBusy(true);
      setWorking(`rename:${account.id}`);
      try {
        await client.renameCodexAccount(
          workspaceId,
          account.id,
          label.trim() === "" ? null : label.trim(),
        );
        await refreshAccounts();
        toast.success("Name saved");
      } catch (error) {
        throw new Error(
          error instanceof Error && error.message ? error.message : "Couldn't save the name.",
          { cause: error },
        );
      } finally {
        setBusy(false);
        setWorking(null);
      }
    },
    [client, workspaceId, refreshAccounts],
  );

  const source = data?.source;
  const accounts = data?.accounts ?? [];
  return {
    client,
    workspaceId,
    canManage,
    data,
    accounts,
    source,
    activeAccountId: data?.activeAccountId ?? null,
    rotationEnabled: data?.settings?.rotationEnabled ?? false,
    /** Accounts here are this workspace's own and can be changed here. */
    workspaceManaged: source?.effectiveSource !== "organization",
    sourceDisabled: source?.effectiveSource === "disabled",
    loading,
    loadError,
    busy,
    working,
    pending,
    refreshingUsage,
    usageError,
    usageMap,
    overviewMap,
    refreshingRow,
    preparingReset,
    redemption,
    now,
    refreshAccounts,
    refreshAccountUsage,
    setSourceMode,
    connect,
    activate,
    setRotation,
    setAllocator,
    setAppsCredential,
    beginRedemption,
    confirmRedemption,
    closeRedemption,
    disconnect,
    rename,
    redemptionAttempts: (accountId: string) =>
      redemptionAttemptViews(workspaceId, accountId, overviewMap[accountId]),
  };
}

/** The irreversible "redeem a reset" confirm. Mount once per page. */
export function CodexRedemptionDialog({ codex }: { codex: CodexSubscriptions }) {
  const { redemption, now } = codex;
  return (
    <ConfirmDialog
      open={redemption != null}
      onOpenChange={(open) => {
        if (!open) codex.closeRedemption();
      }}
      title="Redeem this usage limit reset?"
      description="This uses one usage limit reset from ChatGPT. It can reset this account's 5-hour and weekly limits, and can't be undone."
      confirmLabel="Redeem reset"
      cancelLabel="Cancel"
      cancelAutoFocus
      onConfirm={codex.confirmRedemption}
    >
      {redemption ? (
        <dl className="m-0 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 rounded-[10px] bg-surface-2 px-3 py-2.5 text-xs">
          <dt className="text-fg-muted">Reset</dt>
          <dd className="m-0 break-words text-fg">
            {redemption.credit.title ?? "Full usage limit reset"}
          </dd>
          <dt className="text-fg-muted">Expires</dt>
          <dd className="m-0 text-fg">
            {redemption.credit.expiresAt == null
              ? "Doesn't expire"
              : formatAbsoluteTime(toDate(redemption.credit.expiresAt), { now })}
          </dd>
          <dt className="text-fg-muted">Note</dt>
          <dd className="m-0 break-words text-fg-muted">
            {redemption.uncertain
              ? "The outcome is uncertain. Retry only this same attempt; Opengeni reuses its original request so it can't be redeemed twice."
              : redemption.preparation.resumable
                ? "This resumes the same uncertain attempt; Opengeni reuses its original request so it can't be redeemed twice."
                : `This confirmation expires ${formatAbsoluteTime(toDate(redemption.preparation.expiresAt), { now })}.`}
          </dd>
        </dl>
      ) : null}
    </ConfirmDialog>
  );
}
