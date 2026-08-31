import type {
  SuperGrokAccount,
  SuperGrokAccountsResponse,
  SuperGrokAccountScope,
} from "@opengeni/sdk";
import {
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  ExternalLinkIcon,
  Loader2Icon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { MetaChip } from "@/components/ui/meta-chip";
import { XaiMark } from "@/components/xai-mark";
import { useAppContext } from "@/context";
import { cn } from "@/lib/utils";

import { pollSuperGrokDeviceLogin } from "./supergrok-device-poll";

type PendingDeviceCode = {
  userCode: string;
  verificationUri: string;
};

function SuperGrokScopeToggle({
  value,
  disabled,
  onChange,
}: {
  value: SuperGrokAccountScope;
  disabled: boolean;
  onChange: (scope: SuperGrokAccountScope) => void;
}) {
  return (
    <div
      role="group"
      aria-label="SuperGrok connection scope"
      className="flex rounded-md border border-border/70 p-0.5"
    >
      {(["workspace", "user"] as const).map((option) => (
        <button
          key={option}
          type="button"
          disabled={disabled}
          className={cn(
            "h-7 rounded px-2 text-xs disabled:opacity-50",
            value === option ? "bg-surface-2 text-fg" : "text-fg-subtle hover:text-fg",
          )}
          aria-pressed={value === option}
          onClick={() => onChange(option)}
        >
          {option === "workspace" ? "Workspace" : "Only me"}
        </button>
      ))}
    </div>
  );
}

export function SuperGrokDeviceCodePanel(props: PendingDeviceCode) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="grid gap-2 rounded-md border border-border bg-bg p-3">
      <div className="text-xs text-fg-muted">
        Enter this code at the xAI page (opened in a new tab).
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <code
          data-supergrok-device-code=""
          className="rounded bg-surface-2 px-3 py-1.5 font-mono text-lg font-semibold tracking-widest"
        >
          {props.userCode}
        </code>
        <Button
          type="button"
          variant="secondary"
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
        <Button asChild variant="secondary" size="sm">
          <a href={props.verificationUri} target="_blank" rel="noopener noreferrer">
            Open auth page <ExternalLinkIcon className="size-3.5" />
          </a>
        </Button>
      </div>
      <div className="flex items-center gap-2 text-xs text-fg-subtle">
        <Loader2Icon className="size-3.5 animate-spin" /> Waiting for authorization…
      </div>
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
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const cancelled = useRef(false);
  const pollAbort = useRef<AbortController | null>(null);
  const autoExpandedReloginRef = useRef(false);

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
      pollAbort.current?.abort();
      pollAbort.current = null;
    };
  }, [refresh]);

  const connect = useCallback(async () => {
    setBusy(true);
    try {
      const start = await client.supergrokConnectStart(workspaceId, scope);
      setPending({
        userCode: start.userCode,
        verificationUri: start.verificationUri,
      });
      window.open(
        start.verificationUriComplete ?? start.verificationUri,
        "_blank",
        "noopener,noreferrer",
      );
      pollAbort.current?.abort();
      const controller = new AbortController();
      pollAbort.current = controller;
      void pollSuperGrokDeviceLogin({
        poll: () => client.supergrokConnectPoll(workspaceId, start.state),
        initialIntervalSeconds: start.intervalSeconds,
        expiresAtMs: Date.now() + start.expiresInSeconds * 1_000,
        signal: controller.signal,
      })
        .then(async (result) => {
          if (!result || controller.signal.aborted || cancelled.current) return;
          setPending(null);
          if (result.status === "connected") {
            toast.success(
              result.scope === "workspace"
                ? "SuperGrok connected for the workspace"
                : "Private SuperGrok account connected",
            );
            await refresh();
            return;
          }
          toast.error(result.status === "expired" ? "The xAI code expired" : "xAI login denied");
        })
        .catch((error) => {
          if (!controller.signal.aborted && !cancelled.current) {
            setPending(null);
            toast.error(error instanceof Error ? error.message : "Failed to verify xAI login");
          }
        })
        .finally(() => {
          if (pollAbort.current === controller) pollAbort.current = null;
        });
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

  useEffect(() => {
    autoExpandedReloginRef.current = false;
    setExpandedId(null);
  }, [workspaceId]);

  useEffect(() => {
    if (autoExpandedReloginRef.current || expandedId != null || !data) return;
    const needsRelogin = data.accounts.find(
      (account) => account.status !== "active" && account.lastError != null,
    );
    if (!needsRelogin) return;
    autoExpandedReloginRef.current = true;
    setExpandedId(needsRelogin.id);
  }, [data, expandedId]);

  const connectControls = canManage ? (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <SuperGrokScopeToggle value={scope} disabled={busy} onChange={setScope} />
      {accounts.length === 0 ? (
        <Button type="button" size="sm" disabled={busy} onClick={connect}>
          {busy ? (
            <Loader2Icon className="size-3.5 animate-spin" />
          ) : (
            <XaiMark className="size-3.5" />
          )}{" "}
          Connect SuperGrok
        </Button>
      ) : (
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={connect}>
          <PlusIcon className="size-3.5" /> Connect
        </Button>
      )}
    </div>
  ) : null;

  return (
    <section aria-labelledby="supergrok-subscriptions-heading" className="grid gap-2">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2
            id="supergrok-subscriptions-heading"
            className="flex items-center gap-1.5 text-sm font-medium"
          >
            <XaiMark className="size-3.5 text-brand" />
            SuperGrok subscriptions
          </h2>
          <p className="mt-0.5 text-2xs text-fg-subtle">
            xAI plans for Grok models — subscription usage, not API credits.
          </p>
        </div>
        {accounts.length > 0 && !pending ? connectControls : null}
      </div>

      {accounts.length > 1 && canManage ? (
        <label
          className="flex cursor-pointer items-center justify-between gap-3 rounded-md border border-border/70 px-3 py-2"
          title="Spread new sessions across eligible SuperGrok accounts."
        >
          <span className="text-xs font-medium">Auto-rotate subscriptions</span>
          <input
            type="checkbox"
            className="size-4 accent-brand"
            checked={data?.settings.rotationEnabled ?? false}
            disabled={busy}
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
        </label>
      ) : null}

      {loading ? (
        <div className="flex items-center gap-2 text-xs text-fg-subtle">
          <Loader2Icon className="size-3.5 animate-spin" /> Loading subscriptions…
        </div>
      ) : pending ? (
        <SuperGrokDeviceCodePanel {...pending} />
      ) : accounts.length === 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-fg-subtle">
            Not connected. Connecting needs admin access and a SuperGrok plan.
          </p>
          {connectControls}
        </div>
      ) : (
        <div className="divide-y divide-border/70 overflow-hidden rounded-lg border border-border">
          {accounts.map((account) => {
            const expanded = expandedId === account.id;
            const isActive = account.id === data?.activeAccountId;
            const needsRelogin = account.status !== "active" && account.lastError != null;
            return (
              <article
                key={account.id}
                aria-label={`${accountLabel(account)} SuperGrok subscription`}
              >
                <Collapsible
                  open={expanded}
                  onOpenChange={(open) => setExpandedId(open ? account.id : null)}
                >
                  <div
                    className="flex min-w-0 cursor-pointer flex-wrap items-center gap-2 px-2.5 py-2 transition-colors hover:bg-surface-2/50"
                    onClick={() => setExpandedId(expanded ? null : account.id)}
                  >
                    <label
                      className="flex min-h-9 min-w-9 cursor-pointer items-center justify-center"
                      title="Used when a session isn't pinned to a specific subscription"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <input
                        type="radio"
                        name="supergrok-active"
                        className="size-3.5 accent-brand"
                        aria-label={`Use ${accountLabel(account)} as active SuperGrok account`}
                        checked={isActive}
                        disabled={!canManage || busy || account.status !== "active"}
                        onChange={() => {
                          if (!isActive) {
                            void mutate(
                              () => client.activateSuperGrokAccount(workspaceId, account.id),
                              "Active SuperGrok account updated",
                            );
                          }
                        }}
                      />
                    </label>
                    <div
                      className="flex min-w-0 flex-1 basis-36 items-center gap-1"
                      onClick={(event) => {
                        if (editing?.id === account.id) event.stopPropagation();
                      }}
                    >
                      {editing?.id === account.id ? (
                        <Input
                          autoFocus
                          value={editing.value}
                          className="h-7 text-sm"
                          onChange={(event) =>
                            setEditing({
                              id: account.id,
                              value: event.target.value,
                            })
                          }
                          onBlur={() => {
                            const label = editing.value.trim();
                            setEditing(null);
                            void mutate(
                              () =>
                                client.renameSuperGrokAccount(
                                  workspaceId,
                                  account.id,
                                  label || null,
                                ),
                              "SuperGrok account renamed",
                            );
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") event.currentTarget.blur();
                            if (event.key === "Escape") setEditing(null);
                          }}
                        />
                      ) : (
                        <>
                          <span className="min-w-0 truncate text-sm font-medium">
                            {accountLabel(account)}
                            {account.email && account.label ? (
                              <span className="font-normal text-fg-subtle"> · {account.email}</span>
                            ) : null}
                          </span>
                          {canManage ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              className="size-7 shrink-0"
                              aria-label={`Rename ${accountLabel(account)}`}
                              onClick={(event) => {
                                event.stopPropagation();
                                setEditing({
                                  id: account.id,
                                  value: account.label ?? "",
                                });
                              }}
                            >
                              <PencilIcon className="size-3.5" />
                            </Button>
                          ) : null}
                        </>
                      )}
                    </div>
                    <MetaChip rounded="full">
                      {account.scope === "workspace" ? "Workspace" : "Only me"}
                    </MetaChip>
                    {account.quota?.subscriptionTier ? (
                      <MetaChip
                        dot={account.status === "active" ? "running" : "waiting"}
                        rounded="full"
                      >
                        {account.quota.subscriptionTier}
                      </MetaChip>
                    ) : account.status !== "active" ? (
                      <MetaChip dot="waiting" rounded="full">
                        {account.status.replaceAll("_", " ")}
                      </MetaChip>
                    ) : null}
                    {needsRelogin ? (
                      <span className="flex items-center gap-1 text-2xs text-status-waiting">
                        <TriangleAlertIcon className="size-3" /> Reconnect
                      </span>
                    ) : account.quota?.usedPercent != null ? (
                      <span className="shrink-0 text-2xs text-fg-subtle">
                        {Math.round(account.quota.usedPercent)}%
                      </span>
                    ) : null}
                    <CollapsibleTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="shrink-0"
                        aria-label={
                          expanded
                            ? `Hide details for ${accountLabel(account)}`
                            : `Show details for ${accountLabel(account)}`
                        }
                        onClick={(event) => event.stopPropagation()}
                      >
                        <ChevronDownIcon
                          className={cn(
                            "size-4 text-fg-subtle transition-transform",
                            expanded ? "rotate-180" : "",
                          )}
                        />
                      </Button>
                    </CollapsibleTrigger>
                  </div>
                  <CollapsibleContent className="grid gap-2 border-t border-border/60 px-2.5 py-2.5">
                    <label className="flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-md border border-border/70 bg-surface/50 px-2.5">
                      <span className="text-xs font-medium">Use for new automatic turns</span>
                      <span className="flex items-center gap-2 text-xs text-fg-muted">
                        <input
                          type="checkbox"
                          className="size-4 accent-brand"
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
                        <span aria-hidden="true">
                          {account.allocatorEnabled ? "Enabled" : "Paused"}
                        </span>
                      </span>
                    </label>
                    {needsRelogin ? (
                      <div className="flex items-center gap-1.5 rounded-md border border-status-waiting/30 bg-status-waiting/10 p-2 text-xs text-status-waiting">
                        <TriangleAlertIcon className="size-3.5" />{" "}
                        {account.lastError ?? "Reconnect needed."}
                      </div>
                    ) : null}
                    {canManage ? (
                      <div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() =>
                            void mutate(
                              () => client.disconnectSuperGrokAccount(workspaceId, account.id),
                              "SuperGrok account disconnected",
                            )
                          }
                        >
                          <Trash2Icon className="size-3.5" /> Disconnect
                        </Button>
                      </div>
                    ) : null}
                  </CollapsibleContent>
                </Collapsible>
              </article>
            );
          })}
        </div>
      )}

      {accounts.length > 0 && !pending && !loading ? (
        <p className="text-2xs text-fg-subtle">
          {data?.settings.rotationEnabled && accounts.length > 1 ? (
            <>
              Sessions are spread across all {accounts.length} subscriptions. Pinned sessions stay
              on their pin.
            </>
          ) : (
            <>
              The <span className="font-medium">active</span> subscription runs every session that
              isn't pinned to a specific one.
            </>
          )}
        </p>
      ) : null}
    </section>
  );
}
