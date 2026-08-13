import type {
  SuperGrokAccount,
  SuperGrokAccountsResponse,
  SuperGrokAccountScope,
} from "@opengeni/sdk";
import {
  CheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  Loader2Icon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useAppContext } from "@/context";

type PendingDeviceCode = {
  userCode: string;
  verificationUri: string;
};

export function SuperGrokDeviceCodePanel(props: PendingDeviceCode) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="grid gap-3 rounded-lg border border-brand/30 bg-brand/5 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <code data-supergrok-device-code="" className="rounded bg-bg px-2 py-1 font-mono text-sm">
          {props.userCode}
        </code>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={copied ? "Code copied" : "Copy code"}
          onClick={() => {
            void navigator.clipboard
              .writeText(props.userCode)
              .then(() => setCopied(true))
              .catch(() => setCopied(false));
          }}
        >
          {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
          {copied ? "Copied" : "Copy code"}
        </Button>
        <Button asChild variant="outline" size="sm">
          <a href={props.verificationUri} target="_blank" rel="noopener noreferrer">
            Open xAI <ExternalLinkIcon className="size-3.5" />
          </a>
        </Button>
      </div>
      <p className="flex items-center gap-2 text-xs text-fg-subtle">
        <Loader2Icon className="size-3.5 animate-spin" /> Waiting for xAI authorization…
      </p>
    </div>
  );
}

function accountLabel(account: SuperGrokAccount): string {
  return account.label ?? account.email ?? account.subject;
}

export function SuperGrokSubscriptionsCard({
  workspaceId,
  canManage,
}: {
  workspaceId: string;
  canManage: boolean;
}) {
  const client = useAppContext().client;
  const [data, setData] = useState<SuperGrokAccountsResponse | null>(null);
  const [scope, setScope] = useState<SuperGrokAccountScope>("workspace");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingDeviceCode | null>(null);
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);
  const cancelled = useRef(false);

  const refresh = useCallback(async () => {
    try {
      setData(await client.listSuperGrokAccounts(workspaceId));
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [client, workspaceId]);

  useEffect(() => {
    cancelled.current = false;
    setLoading(true);
    void refresh();
    return () => {
      cancelled.current = true;
    };
  }, [refresh]);

  const connect = useCallback(async () => {
    setBusy(true);
    try {
      const start = await client.supergrokConnectStart(workspaceId, scope);
      setPending({ userCode: start.userCode, verificationUri: start.verificationUri });
      window.open(
        start.verificationUriComplete ?? start.verificationUri,
        "_blank",
        "noopener,noreferrer",
      );
      const poll = async (delaySeconds: number): Promise<void> => {
        let result: Awaited<ReturnType<typeof client.supergrokConnectPoll>>;
        try {
          result = await client.supergrokConnectPoll(workspaceId, start.state);
        } catch (error) {
          if (!cancelled.current) {
            setPending(null);
            toast.error(error instanceof Error ? error.message : "Failed to verify xAI login");
          }
          return;
        }
        if (result.status === "connected") {
          if (!cancelled.current) {
            setPending(null);
            toast.success(
              result.scope === "workspace"
                ? "SuperGrok connected for the workspace"
                : "Private SuperGrok account connected",
            );
            await refresh();
          }
          return;
        }
        if (result.status === "expired" || result.status === "denied") {
          if (!cancelled.current) {
            setPending(null);
            toast.error(result.status === "expired" ? "The xAI code expired" : "xAI login denied");
          }
          return;
        }
        if (result.status === "pending" || result.status === "slow_down") {
          const nextDelay = Math.max(1, result.intervalSeconds ?? delaySeconds);
          setTimeout(() => void poll(nextDelay), nextDelay * 1_000);
        }
      };
      setTimeout(() => void poll(start.intervalSeconds), start.intervalSeconds * 1_000);
    } catch (error) {
      setPending(null);
      toast.error(error instanceof Error ? error.message : "Failed to start xAI login");
    } finally {
      setBusy(false);
    }
  }, [client, refresh, scope, workspaceId]);

  const mutate = useCallback(
    async (operation: () => Promise<unknown>, success: string) => {
      setBusy(true);
      try {
        await operation();
        await refresh();
        toast.success(success);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "SuperGrok update failed");
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const accounts = data?.accounts ?? [];
  return (
    <section aria-labelledby="supergrok-heading" className="rounded-lg border border-border">
      <div className="grid gap-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="grid gap-1">
            <h2 id="supergrok-heading" className="text-sm font-medium">
              SuperGrok / xAI subscription
            </h2>
            <p className="max-w-2xl text-xs text-fg-subtle">
              Use connected SuperGrok accounts for Grok models without OpenGeni credits. Workspace
              accounts are available to members; private accounts remain usable only by you.
            </p>
          </div>
          {canManage ? (
            <div className="flex items-center gap-2">
              <Select
                aria-label="SuperGrok connection scope"
                value={scope}
                disabled={busy || pending !== null}
                onChange={(event) => setScope(event.target.value as SuperGrokAccountScope)}
              >
                <option value="workspace">Workspace</option>
                <option value="user">Only me</option>
              </Select>
              <Button type="button" size="sm" disabled={busy || pending !== null} onClick={connect}>
                {busy ? (
                  <Loader2Icon className="size-3.5 animate-spin" />
                ) : (
                  <PlusIcon className="size-3.5" />
                )}
                Connect
              </Button>
            </div>
          ) : null}
        </div>

        {pending ? <SuperGrokDeviceCodePanel {...pending} /> : null}

        {loading ? (
          <p className="text-xs text-fg-subtle">Loading SuperGrok accounts…</p>
        ) : accounts.length === 0 ? (
          <p className="rounded-md bg-surface-2/70 px-3 py-2 text-xs text-fg-subtle">
            No SuperGrok accounts connected.
          </p>
        ) : (
          <div className="divide-y divide-border/70 rounded-lg border border-border">
            {accounts.map((account) => (
              <div key={account.id} className="grid gap-2 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="radio"
                    aria-label={`Use ${accountLabel(account)} as active SuperGrok account`}
                    checked={account.id === data?.activeAccountId}
                    disabled={!canManage || busy || account.status !== "active"}
                    onChange={() =>
                      void mutate(
                        () => client.activateSuperGrokAccount(workspaceId, account.id),
                        "Active SuperGrok account updated",
                      )
                    }
                  />
                  {editing?.id === account.id ? (
                    <Input
                      value={editing.value}
                      className="h-8 max-w-xs"
                      onChange={(event) =>
                        setEditing({ id: account.id, value: event.target.value })
                      }
                      onBlur={() => {
                        const label = editing.value.trim();
                        setEditing(null);
                        void mutate(
                          () =>
                            client.renameSuperGrokAccount(workspaceId, account.id, label || null),
                          "SuperGrok account renamed",
                        );
                      }}
                    />
                  ) : (
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                      {accountLabel(account)}
                    </span>
                  )}
                  <span className="rounded-full border border-border px-2 py-0.5 text-2xs text-fg-subtle">
                    {account.scope === "workspace" ? "Workspace" : "Only me"}
                  </span>
                  <span className="text-2xs text-fg-subtle">{account.status}</span>
                  {canManage ? (
                    <>
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        aria-label="Rename SuperGrok account"
                        onClick={() => setEditing({ id: account.id, value: account.label ?? "" })}
                      >
                        <PencilIcon className="size-3.5" />
                      </Button>
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        aria-label="Disconnect SuperGrok account"
                        disabled={busy}
                        onClick={() =>
                          void mutate(
                            () => client.disconnectSuperGrokAccount(workspaceId, account.id),
                            "SuperGrok account disconnected",
                          )
                        }
                      >
                        <Trash2Icon className="size-3.5" />
                      </Button>
                    </>
                  ) : null}
                </div>
                <label className="flex items-center gap-2 text-xs text-fg-subtle">
                  <input
                    type="checkbox"
                    checked={account.allocatorEnabled}
                    disabled={!canManage || busy}
                    onChange={(event) =>
                      void mutate(
                        () =>
                          client.setSuperGrokAccountAllocator(workspaceId, account.id, {
                            enabled: event.target.checked,
                            expectedVersion: account.allocatorVersion,
                          }),
                        "Automatic-turn eligibility updated",
                      )
                    }
                  />
                  Available for new automatic turns
                </label>
              </div>
            ))}
          </div>
        )}

        {canManage && data ? (
          <label className="flex items-center gap-2 text-xs text-fg-subtle">
            <input
              type="checkbox"
              checked={data.settings.rotationEnabled}
              disabled={busy || accounts.length < 2}
              onChange={(event) =>
                void mutate(
                  () =>
                    client.setSuperGrokRotationSettings(workspaceId, {
                      rotationEnabled: event.target.checked,
                    }),
                  "SuperGrok rotation updated",
                )
              }
            />
            Rotate new turns across eligible accounts
          </label>
        ) : null}
      </div>
    </section>
  );
}
