// Codex (ChatGPT) subscriptions card for workspace settings: connect MULTIPLE
// ChatGPT accounts via device code, list them with an ACTIVE radio (the account
// unpinned sessions use), inline rename, per-account refresh/disconnect, and
// "connect another". A connected `codex/*` model run uses the active/pinned
// subscription instead of spending API credits.
import type { CodexAccount, CodexAccountsResponse, CodexUsage } from "@opengeni/sdk";
import { ExternalLinkIcon, Loader2Icon, PlusIcon, RefreshCwIcon, SparklesIcon, Trash2Icon, TriangleAlertIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAppContext } from "@/context";

type Window = { used_percent?: number; reset_after_seconds?: number; limit_window_seconds?: number };
type UsagePayload = { plan_type?: string; rate_limit?: { primary_window?: Window; secondary_window?: Window } };

export function windowOf(usage: CodexUsage | null, key: "primary_window" | "secondary_window"): Window | null {
  const payload = (usage?.usage ?? null) as UsagePayload | null;
  return payload?.rate_limit?.[key] ?? null;
}

export function resetLabel(seconds: number | undefined): string {
  if (typeof seconds !== "number" || seconds <= 0) return "";
  const h = Math.floor(seconds / 3600);
  const d = Math.floor(h / 24);
  if (d >= 1) return `resets in ~${d}d`;
  if (h >= 1) return `resets in ~${h}h`;
  return `resets in ~${Math.max(1, Math.round(seconds / 60))}m`;
}

export function UsageBar({ label, window }: { label: string; window: Window | null }) {
  if (!window || typeof window.used_percent !== "number") return null;
  const pct = Math.min(100, Math.max(0, window.used_percent));
  const danger = pct >= 90;
  return (
    <div className="grid gap-1">
      <div className="flex items-center justify-between text-xs text-[color:var(--color-fg-muted)]">
        <span>{label}</span>
        <span>{pct}% used{window.reset_after_seconds ? ` · ${resetLabel(window.reset_after_seconds)}` : ""}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-[color:var(--color-surface-2)]">
        <div className={`h-full rounded-full ${danger ? "bg-amber-500" : "bg-[color:var(--color-brand)]"}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function accountDisplay(account: CodexAccount): string {
  return account.label ?? account.email ?? account.plan ?? account.chatgptAccountId ?? "Codex account";
}

export function CodexSubscriptionsCard({ workspaceId, canManage }: { workspaceId: string; canManage: boolean }) {
  const client = useAppContext().client;
  const [data, setData] = useState<CodexAccountsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ userCode: string; verificationUri: string } | null>(null);
  // The row whose label is being edited + its draft value.
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);
  const cancelled = useRef(false);

  const refreshAccounts = useCallback(async () => {
    try {
      setData(await client.listCodexAccounts(workspaceId));
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [client, workspaceId]);

  useEffect(() => {
    cancelled.current = false;
    setLoading(true);
    void refreshAccounts();
    return () => { cancelled.current = true; };
  }, [refreshAccounts]);

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
          toast.error(error instanceof Error ? error.message : "Failed to verify Codex authorization. Try again.");
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

  const activate = useCallback(async (accountId: string) => {
    setBusy(true);
    try {
      await client.activateCodexAccount(workspaceId, accountId);
      await refreshAccounts();
      toast.success("Active subscription updated");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to switch active subscription");
    } finally {
      setBusy(false);
    }
  }, [client, workspaceId, refreshAccounts]);

  const disconnect = useCallback(async (accountId: string) => {
    setBusy(true);
    try {
      await client.disconnectCodexAccount(workspaceId, accountId);
      await refreshAccounts();
      toast.success("Subscription disconnected");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to disconnect");
    } finally {
      setBusy(false);
    }
  }, [client, workspaceId, refreshAccounts]);

  const commitRename = useCallback(async (accountId: string, label: string) => {
    setEditing(null);
    setBusy(true);
    try {
      await client.renameCodexAccount(workspaceId, accountId, label.trim() === "" ? null : label.trim());
      await refreshAccounts();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to rename");
    } finally {
      setBusy(false);
    }
  }, [client, workspaceId, refreshAccounts]);

  const accounts = data?.accounts ?? [];
  const activeAccountId = data?.activeAccountId ?? null;

  return (
    <section className="grid gap-3 rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)] p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-1.5 text-sm font-medium">
            <SparklesIcon className="size-3.5 text-[color:var(--color-brand)]" />
            Codex subscriptions
          </h2>
          <p className="mt-1 text-xs text-[color:var(--color-fg-muted)]">
            Connect one or more ChatGPT plans to run agents on your subscription. Turns using a <span className="font-medium">Codex</span> model spend
            your ChatGPT usage — <span className="font-medium">no API credits</span>.
          </p>
        </div>
        {canManage && accounts.length > 0 && !pending ? (
          <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => void connect()}>
            <PlusIcon className="size-3.5" /> Connect another subscription
          </Button>
        ) : null}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-xs text-[color:var(--color-fg-subtle)]"><Loader2Icon className="size-3.5 animate-spin" /> Loading subscriptions…</div>
      ) : pending ? (
        <div className="grid gap-2 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] p-3">
          <div className="text-xs text-[color:var(--color-fg-muted)]">Enter this code at the OpenAI page (opened in a new tab), then leave this open:</div>
          <div className="flex items-center gap-2">
            <code className="rounded bg-[color:var(--color-surface-2)] px-3 py-1.5 text-lg font-semibold tracking-widest">{pending.userCode}</code>
            <Button asChild type="button" variant="secondary" size="sm">
              <a href={pending.verificationUri} target="_blank" rel="noopener noreferrer">Open auth page <ExternalLinkIcon className="size-3.5" /></a>
            </Button>
          </div>
          <div className="flex items-center gap-2 text-xs text-[color:var(--color-fg-subtle)]"><Loader2Icon className="size-3.5 animate-spin" /> Waiting for authorization…</div>
        </div>
      ) : accounts.length === 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-[color:var(--color-fg-subtle)]">Not connected. Connecting needs admin access and a ChatGPT Plus/Pro/Team plan.</p>
          {canManage ? (
            <Button type="button" size="sm" disabled={busy} onClick={() => void connect()}>
              {busy ? <Loader2Icon className="size-3.5 animate-spin" /> : <SparklesIcon className="size-3.5" />} Connect Codex
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="grid gap-2">
          {accounts.map((account) => {
            const isActive = account.id === activeAccountId;
            const needsRelogin = account.status !== "active" && account.lastError != null;
            return (
              <div key={account.id} className="grid gap-2 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] p-3">
                <div className="flex items-center gap-3">
                  <label className="flex cursor-pointer items-center" title="Used when a session isn't pinned to a specific subscription">
                    <input
                      type="radio"
                      name="codex-active"
                      className="size-3.5 accent-[color:var(--color-brand)]"
                      checked={isActive}
                      disabled={!canManage || busy}
                      onChange={() => { if (!isActive) void activate(account.id); }}
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
                    <div className="mt-0.5 truncate text-xs text-[color:var(--color-fg-subtle)]">
                      {account.email ? `${account.email} · ` : ""}
                      {account.status === "active" ? "Token valid" : account.status}
                      {account.expiresAt ? ` · expires ${new Date(account.expiresAt).toLocaleString()}` : ""}
                    </div>
                  </div>
                  {account.plan ? (
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-300">
                      {account.plan} plan
                    </span>
                  ) : null}
                  {isActive ? (
                    <span className="shrink-0 text-[10px] uppercase tracking-wide text-[color:var(--color-fg-subtle)]">Active</span>
                  ) : null}
                </div>
                {needsRelogin ? (
                  <div className="flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-200">
                    <TriangleAlertIcon className="size-3.5" /> {account.lastError ?? "Reconnect needed."}
                  </div>
                ) : null}
                {canManage ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void refreshAccounts()}>
                      <RefreshCwIcon className="size-3.5" /> Refresh
                    </Button>
                    <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void disconnect(account.id)}>
                      <Trash2Icon className="size-3.5" /> Disconnect
                    </Button>
                  </div>
                ) : null}
              </div>
            );
          })}
          <p className="text-[11px] text-[color:var(--color-fg-subtle)]">
            The <span className="font-medium">active</span> subscription runs every session that isn't pinned to a specific one.
          </p>
        </div>
      )}
    </section>
  );
}
