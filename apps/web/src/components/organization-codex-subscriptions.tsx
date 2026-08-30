import type {
  CodexAccount,
  CodexConnectPoll,
  CodexConnectStart,
  OrganizationCodexAccountsResponse,
} from "@opengeni/sdk";
import { Loader2Icon, PlusIcon, Trash2Icon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { ChatGptMark } from "@/components/chatgpt-mark";
import { CodexDeviceCodePanel } from "@/components/codex-connection";
import { Button } from "@/components/ui/button";
import { useAppContext } from "@/context";

function accountDisplay(account: CodexAccount): string {
  return account.label ?? account.email ?? account.plan ?? account.chatgptAccountId ?? "ChatGPT";
}

export function OrganizationCodexSubscriptions({ organizationId }: { organizationId: string }) {
  const client = useAppContext().client;
  const [data, setData] = useState<OrganizationCodexAccountsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{
    userCode: string;
    verificationUri: string;
  } | null>(null);
  const refresh = useCallback(async () => {
    try {
      const result = await client.requestJson<OrganizationCodexAccountsResponse>(
        "GET",
        `/v1/organizations/${organizationId}/codex/accounts`,
      );
      setData(result);
    } catch (error) {
      setData(null);
      toast.error(error instanceof Error ? error.message : "Failed to load subscriptions");
    } finally {
      setLoading(false);
    }
  }, [client, organizationId]);

  useEffect(() => {
    setLoading(true);
    void refresh();
  }, [refresh]);

  const connect = useCallback(async () => {
    setBusy(true);
    try {
      const start = await client.requestJson<CodexConnectStart>(
        "POST",
        `/v1/organizations/${organizationId}/codex/connect/start`,
        {},
      );
      setPending({ userCode: start.userCode, verificationUri: start.verificationUri });
      window.open(start.verificationUri, "_blank", "noopener,noreferrer");
      const interval = Math.max(2, start.intervalSeconds) * 1000;
      const poll = async (): Promise<void> => {
        try {
          const result = await client.requestJson<CodexConnectPoll>(
            "POST",
            `/v1/organizations/${organizationId}/codex/connect/poll`,
            { state: start.state },
          );
          if (result.status === "pending") {
            setTimeout(() => void poll(), interval);
            return;
          }
          setPending(null);
          if (result.status === "expired") {
            toast.error("The code expired before it was authorized. Try again.");
            return;
          }
          toast.success(`Organization Codex connected${result.plan ? ` (${result.plan})` : ""}`);
          await refresh();
        } catch (error) {
          setPending(null);
          toast.error(
            error instanceof Error ? error.message : "Failed to verify Codex authorization",
          );
        }
      };
      setTimeout(() => void poll(), interval);
    } catch (error) {
      setPending(null);
      toast.error(error instanceof Error ? error.message : "Failed to start Codex login");
    } finally {
      setBusy(false);
    }
  }, [client, organizationId, refresh]);

  const activate = async (accountId: string): Promise<void> => {
    setBusy(true);
    try {
      await client.requestJson(
        "POST",
        `/v1/organizations/${organizationId}/codex/accounts/${accountId}/activate`,
      );
      await refresh();
      toast.success("Organization default subscription updated");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to switch subscription");
    } finally {
      setBusy(false);
    }
  };

  const setRotation = async (rotationEnabled: boolean): Promise<void> => {
    setBusy(true);
    try {
      await client.requestJson("PATCH", `/v1/organizations/${organizationId}/codex/settings`, {
        rotationEnabled,
      });
      await refresh();
      toast.success("Organization rotation settings updated");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update rotation");
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async (accountId: string): Promise<void> => {
    setBusy(true);
    try {
      await client.requestJson(
        "DELETE",
        `/v1/organizations/${organizationId}/codex/accounts/${accountId}`,
      );
      await refresh();
      toast.success("Organization subscription disconnected");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to disconnect subscription");
    } finally {
      setBusy(false);
    }
  };

  const accounts = data?.accounts ?? [];
  return (
    <section className="grid gap-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-medium text-fg">
            <ChatGptMark className="size-4 text-brand" /> Organization Codex subscriptions
          </h2>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-fg-muted">
            Connect once for the organization. Current and future shared workspaces inherit this
            pool by default; personal workspaces keep their own subscriptions.
          </p>
        </div>
        {accounts.length > 0 && !pending ? (
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={connect}>
            <PlusIcon className="size-3.5" /> Connect
          </Button>
        ) : null}
      </div>

      {accounts.length > 1 ? (
        <label className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
          <span className="text-xs font-medium">Auto-rotate organization subscriptions</span>
          <input
            type="checkbox"
            className="size-4 accent-brand"
            checked={data?.settings.rotationEnabled ?? false}
            disabled={busy}
            onChange={(event) => void setRotation(event.target.checked)}
          />
        </label>
      ) : null}

      {loading ? (
        <p role="status" className="flex items-center gap-2 text-xs text-fg-muted">
          <Loader2Icon className="size-3.5 animate-spin" /> Loading subscriptions…
        </p>
      ) : pending ? (
        <CodexDeviceCodePanel
          userCode={pending.userCode}
          verificationUri={pending.verificationUri}
        />
      ) : accounts.length === 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-dashed border-border p-4">
          <p className="text-xs text-fg-muted">No organization Codex subscription is connected.</p>
          <Button type="button" size="sm" disabled={busy} onClick={connect}>
            {busy ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : (
              <ChatGptMark className="size-3.5" />
            )}
            Connect Codex
          </Button>
        </div>
      ) : (
        <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
          {accounts.map((account) => {
            const active = account.id === data?.activeAccountId;
            return (
              <article key={account.id} className="flex flex-wrap items-center gap-2 px-3 py-2.5">
                <input
                  type="radio"
                  name="organization-codex-active"
                  className="size-3.5 accent-brand"
                  checked={active}
                  disabled={busy}
                  aria-label={`Use ${accountDisplay(account)} as the organization default`}
                  onChange={() => {
                    if (!active) void activate(account.id);
                  }}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{accountDisplay(account)}</p>
                  <p className="truncate text-2xs text-fg-subtle">
                    {[account.email ?? account.chatgptAccountId, account.plan, account.status]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  disabled={busy}
                  aria-label={`Disconnect ${accountDisplay(account)}`}
                  onClick={() => void disconnect(account.id)}
                >
                  <Trash2Icon className="size-3.5" />
                </Button>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
