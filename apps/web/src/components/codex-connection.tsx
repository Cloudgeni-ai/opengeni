// Codex (ChatGPT) subscription connection card for workspace settings: connect via
// device code, show connection + plan + validity, display remaining usage, and
// disconnect. Turns on a connected `codex/*` model run on the user's ChatGPT plan
// instead of spending API credits.
import type { CodexConnectionStatus, CodexUsage } from "@opengeni/sdk";
import { CheckCircle2Icon, ExternalLinkIcon, Loader2Icon, RefreshCwIcon, SparklesIcon, Trash2Icon, TriangleAlertIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useAppContext } from "@/context";

type Window = { used_percent?: number; reset_after_seconds?: number; limit_window_seconds?: number };
type UsagePayload = { plan_type?: string; rate_limit?: { primary_window?: Window; secondary_window?: Window } };

function windowOf(usage: CodexUsage | null, key: "primary_window" | "secondary_window"): Window | null {
  const payload = (usage?.usage ?? null) as UsagePayload | null;
  return payload?.rate_limit?.[key] ?? null;
}

function resetLabel(seconds: number | undefined): string {
  if (typeof seconds !== "number" || seconds <= 0) return "";
  const h = Math.floor(seconds / 3600);
  const d = Math.floor(h / 24);
  if (d >= 1) return `resets in ~${d}d`;
  if (h >= 1) return `resets in ~${h}h`;
  return `resets in ~${Math.max(1, Math.round(seconds / 60))}m`;
}

function UsageBar({ label, window }: { label: string; window: Window | null }) {
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

export function CodexConnectionCard({ workspaceId, canManage }: { workspaceId: string; canManage: boolean }) {
  const client = useAppContext().client;
  const [status, setStatus] = useState<CodexConnectionStatus | null>(null);
  const [usage, setUsage] = useState<CodexUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ userCode: string; verificationUri: string } | null>(null);
  const cancelled = useRef(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await client.codexStatus(workspaceId);
      setStatus(next);
      if (next.connected) {
        try { setUsage(await client.codexUsage(workspaceId)); } catch { /* usage best-effort */ }
      } else {
        setUsage(null);
      }
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, [client, workspaceId]);

  useEffect(() => {
    cancelled.current = false;
    void refresh();
    return () => { cancelled.current = true; };
  }, [refresh]);

  const connect = useCallback(async () => {
    setBusy(true);
    try {
      const start = await client.codexConnectStart(workspaceId);
      setPending({ userCode: start.userCode, verificationUri: start.verificationUri });
      window.open(start.verificationUri, "_blank", "noopener,noreferrer");
      const interval = Math.max(2, start.intervalSeconds) * 1000;
      const poll = async (): Promise<void> => {
        if (cancelled.current) return;
        const result = await client.codexConnectPoll(workspaceId, start.state);
        if (result.status === "connected") {
          setPending(null);
          toast.success(`Codex connected${result.plan ? ` (${result.plan} plan)` : ""}`);
          await refresh();
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
  }, [client, workspaceId, refresh]);

  const disconnect = useCallback(async () => {
    setBusy(true);
    try {
      await client.codexDisconnect(workspaceId);
      setPending(null);
      toast.success("Codex subscription disconnected");
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to disconnect");
    } finally {
      setBusy(false);
    }
  }, [client, workspaceId, refresh]);

  const connected = status?.connected === true;
  const needsRelogin = status?.lastError != null && !connected;

  return (
    <section className="grid gap-3 rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)] p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-1.5 text-sm font-medium">
            <SparklesIcon className="size-3.5 text-[color:var(--color-brand)]" />
            Codex subscription
          </h2>
          <p className="mt-1 text-xs text-[color:var(--color-fg-muted)]">
            Connect your ChatGPT plan to run agents on your subscription. Turns using a <span className="font-medium">Codex</span> model spend
            your ChatGPT usage — <span className="font-medium">no API credits</span>.
          </p>
        </div>
        {connected ? (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-300">
            <CheckCircle2Icon className="size-3" /> {status?.plan ? `${status.plan} plan` : "Connected"}
          </span>
        ) : null}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-xs text-[color:var(--color-fg-subtle)]"><Loader2Icon className="size-3.5 animate-spin" /> Checking connection…</div>
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
      ) : connected ? (
        <div className="grid gap-3">
          {needsRelogin ? (
            <div className="flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-200">
              <TriangleAlertIcon className="size-3.5" /> {status?.lastError ?? "Reconnect needed."}
            </div>
          ) : null}
          <div className="text-xs text-[color:var(--color-fg-muted)]">
            {status?.valid ? "Token verified with OpenAI." : "Connected (token not re-verified)."}
            {status?.expiresAt ? ` · access token expires ${new Date(status.expiresAt).toLocaleString()}` : ""}
          </div>
          <UsageBar label="5-hour limit" window={windowOf(usage, "primary_window")} />
          <UsageBar label="Weekly limit" window={windowOf(usage, "secondary_window")} />
          {canManage ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void refresh()}>
                <RefreshCwIcon className="size-3.5" /> Refresh
              </Button>
              <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void disconnect()}>
                <Trash2Icon className="size-3.5" /> Disconnect
              </Button>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-[color:var(--color-fg-subtle)]">Not connected. Connecting needs admin access and a ChatGPT Plus/Pro/Team plan.</p>
          {canManage ? (
            <Button type="button" size="sm" disabled={busy} onClick={() => void connect()}>
              {busy ? <Loader2Icon className="size-3.5 animate-spin" /> : <SparklesIcon className="size-3.5" />} Connect Codex
            </Button>
          ) : null}
        </div>
      )}
    </section>
  );
}
