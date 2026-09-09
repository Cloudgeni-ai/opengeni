import { ConnectionAccessSettings } from "@/components/connection-access-settings";
import { SubscriptionConnectAction } from "@/components/subscription-connect-action";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import type {
  CodexAccount,
  CodexConnectPoll,
  CodexConnectStart,
  OrganizationCodexAccountsResponse,
} from "@opengeni/sdk";
import { Loader2Icon, Trash2Icon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { SubscriptionAccountRow } from "@/components/subscription-account-row";
import { ModelConnectionSection } from "@/components/model-connection-section";
import { ChatGptMark } from "@/components/chatgpt-mark";
import { CodexDeviceCodePanel } from "@/components/codex-connection";
import { Button } from "@/components/ui/button";
import { useAppContext } from "@/context";

function accountDisplay(account: CodexAccount): string {
  return account.label ?? account.email ?? account.plan ?? account.chatgptAccountId ?? "ChatGPT";
}

export function OrganizationCodexSubscriptions(props: { organizationId: string }) {
  const client = useAppContext().client;
  return (
    <OrganizationCodexSubscriptionsWithClient
      key={props.organizationId}
      {...props}
      client={client}
    />
  );
}

/** Isolated product fixture seam; production callers use OrganizationCodexSubscriptions. */
export function OrganizationCodexSubscriptionsWithClient({
  organizationId,
  client,
}: { organizationId: string } & { client: OpenGeniBrowserClient }) {
  const [data, setData] = useState<OrganizationCodexAccountsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [pending, setPending] = useState<{
    userCode: string;
    verificationUri: string;
  } | null>(null);
  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const result = await client.requestJson<OrganizationCodexAccountsResponse>(
        "GET",
        `/v1/organizations/${organizationId}/codex/accounts`,
      );
      setData(result);
    } catch (error) {
      setData(null);
      const message = error instanceof Error ? error.message : "Failed to load subscriptions";
      setLoadError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }, [client, organizationId]);

  useEffect(() => {
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
        {},
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
        {},
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
    <ModelConnectionSection
      title="Codex"
      description="ChatGPT subscription · Shared with your workspaces"
      mark={<ChatGptMark className="size-4" />}
      status={
        loading
          ? "Loading…"
          : loadError
            ? "Unavailable"
            : pending
              ? "Awaiting sign-in"
              : accounts.length === 0
                ? "Not connected"
                : accounts.some((account) => account.status === "active")
                  ? "Connected"
                  : "Needs attention"
      }
    >
      <p className="text-xs leading-5 text-fg-subtle">
        Use Codex models with a ChatGPT subscription. Usage is included in the connected plan.
      </p>
      {accounts.length > 1 ? (
        <label className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
          <span className="text-xs font-medium">Auto-rotate subscriptions</span>
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
      ) : loadError ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-danger/30 bg-danger/5 p-4"
        >
          <p className="text-xs text-danger">{loadError}</p>
          <Button type="button" size="sm" variant="ghost" onClick={() => void refresh()}>
            Retry
          </Button>
        </div>
      ) : pending ? (
        <CodexDeviceCodePanel
          userCode={pending.userCode}
          verificationUri={pending.verificationUri}
        />
      ) : accounts.length === 0 ? null : (
        <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
          {accounts.map((account) => {
            const active = account.id === data?.activeAccountId;
            return (
              <SubscriptionAccountRow
                key={account.id}
                provider="Codex"
                name={accountDisplay(account)}
                label={account.label}
                email={account.email}
                plan={account.plan}
                selected={active}
                disabled={busy}
                unavailable={account.status !== "active"}
                group={`organization-codex-active-${organizationId}`}
                selectionLabel={`Use ${accountDisplay(account)} as the organization default`}
                expanded={expandedId === account.id}
                onExpandedChange={(open) => setExpandedId(open ? account.id : null)}
                onSelect={() => void activate(account.id)}
                onRename={(label) => {
                  setBusy(true);
                  void client
                    .requestJson(
                      "PATCH",
                      `/v1/organizations/${organizationId}/codex/accounts/${account.id}`,
                      { label: label || null },
                    )
                    .then(refresh)
                    .catch((error) =>
                      toast.error(
                        error instanceof Error ? error.message : "Failed to rename subscription",
                      ),
                    )
                    .finally(() => setBusy(false));
                }}
              >
                <p className="text-xs text-fg-subtle">
                  {account.status === "active" ? "Connected" : account.status.replaceAll("_", " ")}
                </p>
                {account.lastError ? (
                  <p className="text-xs text-status-waiting">{account.lastError}</p>
                ) : null}
                <div>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    aria-label={`Disconnect ${accountDisplay(account)}`}
                    onClick={() => void disconnect(account.id)}
                  >
                    <Trash2Icon className="size-3.5" /> Disconnect
                  </Button>
                </div>
                <ConnectionAccessSettings
                  client={client}
                  organizationId={organizationId}
                  kind="codex"
                  connectionId={account.id}
                  canManage
                />
              </SubscriptionAccountRow>
            );
          })}
        </div>
      )}
      {!pending && !loading && !loadError ? (
        <SubscriptionConnectAction
          provider="Codex"
          count={accounts.length}
          busy={busy}
          onConnect={() => void connect()}
        />
      ) : null}
    </ModelConnectionSection>
  );
}
