// Codex (ChatGPT) subscriptions card for workspace settings: connect MULTIPLE
// ChatGPT accounts via device code, list them with an ACTIVE radio (the account
// unpinned sessions use), inline rename, per-account refresh/disconnect, and
// "connect another". A connected `codex/*` model run uses the active/pinned
// subscription instead of spending API credits.
import type {
  CodexAccount,
  CodexAccountsResponse,
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
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MetaChip } from "@/components/ui/meta-chip";
import { useAppContext } from "@/context";

// Cache TTL: a row whose cached snapshot is older than this (or never fetched)
// triggers an on-mount LIVE refresh. The 5h/weekly windows move slowly, so a
// short TTL is plenty and protects chatgpt.com from being hammered.
const USAGE_TTL_MS = 3 * 60 * 1000;

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
  const secs = secondsUntilReset(window, now);
  return (
    <div className="grid gap-1">
      <div className="flex items-center justify-between text-xs text-fg-muted">
        <span>{label}</span>
        <span>
          {limitReached ? "limit reached" : `${pct}% used`}
          {secs ? ` · ${resetLabel(secs)}` : ""}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
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
  now,
  refreshing,
  onRetry,
}: {
  account: CodexAccount;
  live: CodexUsage | undefined;
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
    <div className="grid gap-2">
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
  const [pending, setPending] = useState<{ userCode: string; verificationUri: string } | null>(
    null,
  );
  // The row whose label is being edited + its draft value.
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);
  // True while a LIVE batched usage refresh is in flight (drives the bar skeleton).
  const [refreshingUsage, setRefreshingUsage] = useState(false);
  // The latest LIVE usage per account (carries the explicit ok/limit/error/no-data
  // status the cached columns can't). Merged over the cached windows for display.
  const [usageMap, setUsageMap] = useState<CodexUsageMap>({});
  // The row whose single-account live refresh is in flight (per-row spinner).
  const [refreshingRow, setRefreshingRow] = useState<string | null>(null);
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

  // LIVE batched usage refresh: hit the provider for every account (server writes
  // the cache columns), capture the per-account statuses, then re-read the cached
  // metadata so the fresh windows land on the accounts list too.
  const refreshUsage = useCallback(async () => {
    setRefreshingUsage(true);
    try {
      const result = await client.refreshCodexUsage(workspaceId);
      if (!cancelled.current) setUsageMap(result.usage);
    } catch {
      /* per-account errors are surfaced as the row's "usage unavailable" state */
    } finally {
      await refreshAccounts();
      if (!cancelled.current) setRefreshingUsage(false);
    }
  }, [client, workspaceId, refreshAccounts]);

  // Per-row LIVE refresh (a single account): updates just that row's usage entry.
  const refreshAccountUsage = useCallback(
    async (accountId: string) => {
      setRefreshingRow(accountId);
      try {
        const usage = await client.codexAccountUsage(workspaceId, accountId);
        if (!cancelled.current) setUsageMap((prev) => ({ ...prev, [accountId]: usage }));
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

  // On mount, trigger ONE live refresh when at least one row is stale (cache TTL),
  // never a tighter poll. The `usageRefreshedRef` guard fires this at most once per
  // mount regardless of re-renders.
  useEffect(() => {
    if (loading || !data || usageRefreshedRef.current) return;
    const stale = data.accounts.some((account) => {
      const checked = account.usageCheckedAt ? new Date(account.usageCheckedAt).getTime() : 0;
      return Date.now() - checked > USAGE_TTL_MS;
    });
    if (stale) {
      usageRefreshedRef.current = true;
      void refreshUsage();
    }
  }, [loading, data, refreshUsage]);

  const connect = useCallback(async () => {
    setBusy(true);
    try {
      const start = await client.codexConnectStart(workspaceId);
      setPending({ userCode: start.userCode, verificationUri: start.verificationUri });
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
    <section className="grid gap-3 rounded-lg border border-border bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-1.5 text-sm font-medium">
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
              <div
                key={account.id}
                className="grid gap-2 rounded-md border border-border bg-bg p-3"
              >
                <div className="flex items-center gap-3">
                  <label
                    className="flex cursor-pointer items-center"
                    title="Used when a session isn't pinned to a specific subscription"
                  >
                    <input
                      type="radio"
                      name="codex-active"
                      className="size-3.5 accent-brand"
                      checked={isActive}
                      disabled={!canManage || busy}
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
                        onClick={() => setEditing({ id: account.id, value: account.label ?? "" })}
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
                {needsRelogin ? (
                  <div className="flex items-center gap-1.5 rounded-md border border-status-waiting/30 bg-status-waiting/10 p-2 text-xs text-status-waiting">
                    <TriangleAlertIcon className="size-3.5" />{" "}
                    {account.lastError ?? "Reconnect needed."}
                  </div>
                ) : (
                  <AccountUsage
                    account={account}
                    live={usageMap[account.id]}
                    now={now}
                    refreshing={refreshingUsage || refreshingRow === account.id}
                    onRetry={() => void refreshAccountUsage(account.id)}
                  />
                )}
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
              </div>
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
    </section>
  );
}
