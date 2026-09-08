import { ConnectionAccessSettings } from "@/components/connection-access-settings";
import { SubscriptionConnectAction } from "@/components/subscription-connect-action";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { trackModelConnection } from "@/lib/analytics-observer";

import type {
  SuperGrokAccount,
  SuperGrokAccountsResponse,
  SuperGrokAccountScope,
  SuperGrokConnectStart,
  SuperGrokConnectPoll,
} from "@opengeni/sdk";
import {
  CheckIcon,
  SparklesIcon,
  CopyIcon,
  ExternalLinkIcon,
  Loader2Icon,
  Trash2Icon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";

import { ModelConnectionSection } from "@/components/model-connection-section";
import { Button } from "@/components/ui/button";
import { SubscriptionAccountRow } from "@/components/subscription-account-row";
import { MetaChip } from "@/components/ui/meta-chip";
import { Select } from "@/components/ui/select";
import { useAppContext } from "@/context";

import { pollSuperGrokDeviceLogin } from "./supergrok-device-poll";

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

type SubscriptionScope =
  | { workspaceId: string; organizationId?: never; canManage: boolean }
  | { organizationId: string; workspaceId?: never; canManage: boolean };

export function SuperGrokSubscriptionsCard(props: SubscriptionScope) {
  const client = useAppContext().client;
  return (
    <SuperGrokSubscriptionsCardWithClient
      key={props.organizationId ?? props.workspaceId}
      {...props}
      client={client}
    />
  );
}

/** Isolated product fixture seam; production callers use SuperGrokSubscriptionsCard. */
export function SuperGrokSubscriptionsCardWithClient({
  workspaceId,
  organizationId,
  canManage,
  client,
}: SubscriptionScope & { client: OpenGeniBrowserClient }) {
  const [data, setData] = useState<SuperGrokAccountsResponse | null>(null);
  const [scope, setScope] = useState<Exclude<SuperGrokAccountScope, "organization">>("workspace");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingDeviceCode | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const cancelled = useRef(false);
  const pollAbort = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    try {
      setData(
        organizationId
          ? await client.requestJson<SuperGrokAccountsResponse>(
              "GET",
              `/v1/organizations/${organizationId}/supergrok/accounts`,
            )
          : await client.listSuperGrokAccounts(workspaceId!),
      );
      setLoadError(null);
    } catch (error) {
      setData(null);
      setLoadError(error instanceof Error ? error.message : "Could not load subscriptions");
    } finally {
      setLoading(false);
    }
  }, [client, workspaceId, organizationId]);

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
    const recordOutcome = workspaceId ? trackModelConnection("supergrok", workspaceId) : () => {};
    setBusy(true);
    try {
      const start = organizationId
        ? await client.requestJson<SuperGrokConnectStart>(
            "POST",
            `/v1/organizations/${organizationId}/supergrok/connect/start`,
            {},
          )
        : await client.supergrokConnectStart(workspaceId!, scope);
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
        poll: () =>
          organizationId
            ? client.requestJson<SuperGrokConnectPoll>(
                "POST",
                `/v1/organizations/${organizationId}/supergrok/connect/poll`,
                { state: start.state },
              )
            : client.supergrokConnectPoll(workspaceId!, start.state),
        initialIntervalSeconds: start.intervalSeconds,
        expiresAtMs: Date.now() + start.expiresInSeconds * 1_000,
        signal: controller.signal,
      })
        .then(async (result) => {
          if (!result || controller.signal.aborted || cancelled.current) return;
          setPending(null);
          if (result.status === "connected") {
            recordOutcome("connected");
            toast.success(
              result.scope === "organization"
                ? "SuperGrok connected for the organization"
                : result.scope === "workspace"
                  ? "SuperGrok connected for the workspace"
                  : "Private SuperGrok account connected",
            );
            await refresh();
            return;
          }
          recordOutcome(result.status === "expired" ? "expired" : "denied");
          toast.error(result.status === "expired" ? "The xAI code expired" : "xAI login denied");
        })
        .catch((error) => {
          recordOutcome("outcome_unknown");
          if (!controller.signal.aborted && !cancelled.current) {
            setPending(null);
            toast.error(error instanceof Error ? error.message : "Failed to verify xAI login");
          }
        })
        .finally(() => {
          if (pollAbort.current === controller) pollAbort.current = null;
        });
    } catch (error) {
      recordOutcome("outcome_unknown");
      setPending(null);
      toast.error(error instanceof Error ? error.message : "Failed to start xAI login");
    } finally {
      setBusy(false);
    }
  }, [client, refresh, scope, workspaceId, organizationId]);

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
  const inherited = !organizationId && data?.source === "organization";
  const canManageAccounts = canManage && !inherited;
  const connectionPath = organizationId
    ? `/v1/organizations/${organizationId}/supergrok`
    : `/v1/workspaces/${workspaceId}/supergrok`;
  return (
    <ModelConnectionSection
      title="SuperGrok"
      description={`SuperGrok subscription · ${organizationId ? "Shared with your workspaces" : inherited ? "From your organization" : "Workspace account"}`}
      mark={<SparklesIcon className="size-4" />}
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
        Use Grok models with a SuperGrok subscription. Usage is included in the connected plan.
      </p>
      {inherited && data?.organizationId ? (
        <div className="grid gap-2 border-y border-border py-3 text-xs">
          <p className="font-medium">Using organization subscriptions</p>
          <Link
            className="text-brand hover:underline"
            to="/workspaces/$workspaceId/organization"
            params={{ workspaceId: workspaceId! }}
            search={{ section: "models" }}
          >
            Manage in organization settings
          </Link>
          <p className="text-fg-subtle">
            Connect a workspace account to use its subscriptions instead.
          </p>
        </div>
      ) : null}
      {accounts.length > 1 && canManageAccounts ? (
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
                  organizationId
                    ? client.requestJson("PATCH", `${connectionPath}/settings`, {
                        rotationEnabled: event.target.checked,
                      })
                    : client.setSuperGrokRotationSettings(workspaceId!, {
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
      ) : loadError ? (
        <div role="alert" className="flex items-center justify-between gap-3">
          <p className="text-xs text-destructive">{loadError}</p>
          <Button size="sm" variant="secondary" onClick={() => void refresh()}>
            Retry
          </Button>
        </div>
      ) : pending ? (
        <SuperGrokDeviceCodePanel {...pending} />
      ) : accounts.length === 0 ? (
        !canManage ? (
          <p className="text-xs text-fg-subtle">No SuperGrok subscriptions connected.</p>
        ) : null
      ) : (
        <div className="divide-y divide-border/70 overflow-hidden rounded-lg border border-border">
          {accounts.map((account) => {
            const expanded = expandedId === account.id;
            const isActive = account.id === data?.activeAccountId;
            return (
              <SubscriptionAccountRow
                key={account.id}
                provider="SuperGrok"
                name={accountLabel(account)}
                label={account.label}
                email={account.email}
                plan={account.plan ?? account.quota?.subscriptionTier}
                group={`supergrok-active-${workspaceId}`}
                selected={isActive}
                disabled={!canManageAccounts || busy}
                unavailable={account.status !== "active"}
                selectionLabel={`Use ${accountLabel(account)} as active SuperGrok account`}
                expanded={expanded}
                onExpandedChange={(open) => setExpandedId(open ? account.id : null)}
                onSelect={() =>
                  void mutate(
                    () =>
                      organizationId
                        ? client.requestJson(
                            "POST",
                            `${connectionPath}/accounts/${account.id}/activate`,
                            {},
                          )
                        : client.activateSuperGrokAccount(workspaceId!, account.id),
                    "Active SuperGrok account updated",
                  )
                }
                onRename={
                  canManageAccounts
                    ? (label) =>
                        void mutate(
                          () =>
                            organizationId
                              ? client.requestJson(
                                  "PATCH",
                                  `${connectionPath}/accounts/${account.id}`,
                                  { label: label || null },
                                )
                              : client.renameSuperGrokAccount(
                                  workspaceId!,
                                  account.id,
                                  label || null,
                                ),
                          "SuperGrok account renamed",
                        )
                    : undefined
                }
                meta={
                  <>
                    {account.scope === "user" ? <MetaChip rounded="full">Only me</MetaChip> : null}
                    {account.status !== "active" ? (
                      <MetaChip dot="waiting" rounded="full">
                        {account.status.replaceAll("_", " ")}
                      </MetaChip>
                    ) : null}
                    {account.quota?.usedPercent != null ? (
                      <span className="shrink-0 text-2xs text-fg-subtle">
                        {Math.round(account.quota.usedPercent)}%
                      </span>
                    ) : null}
                  </>
                }
              >
                <label className="flex min-h-10 cursor-pointer items-center justify-between gap-3 rounded-md border border-border/70 bg-surface/50 px-2.5">
                  <span className="text-xs font-medium">Use for new automatic turns</span>
                  <span className="flex items-center gap-2 text-xs text-fg-muted">
                    <input
                      type="checkbox"
                      className="size-4 accent-brand"
                      checked={account.allocatorEnabled}
                      disabled={!canManageAccounts || busy}
                      onChange={(event) =>
                        void mutate(
                          () =>
                            organizationId
                              ? client.requestJson(
                                  "PATCH",
                                  `${connectionPath}/accounts/${account.id}/allocator`,
                                  {
                                    enabled: event.target.checked,
                                    expectedVersion: account.allocatorVersion,
                                  },
                                )
                              : client.setSuperGrokAccountAllocator(workspaceId!, account.id, {
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
                {account.lastError ? (
                  <p className="rounded-md border border-status-waiting/30 bg-status-waiting/10 p-2 text-xs text-status-waiting">
                    {account.lastError}
                  </p>
                ) : null}
                {canManageAccounts ? (
                  <div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void mutate(
                          () =>
                            organizationId
                              ? client.requestJson(
                                  "DELETE",
                                  `${connectionPath}/accounts/${account.id}`,
                                )
                              : client.disconnectSuperGrokAccount(workspaceId!, account.id),
                          "SuperGrok account disconnected",
                        )
                      }
                    >
                      <Trash2Icon className="size-3.5" /> Disconnect
                    </Button>
                  </div>
                ) : null}
                {canManageAccounts ? (
                  <ConnectionAccessSettings
                    client={client}
                    organizationId={organizationId}
                    workspaceId={workspaceId}
                    kind="supergrok"
                    connectionId={account.id}
                    canManage={canManageAccounts}
                  />
                ) : null}
              </SubscriptionAccountRow>
            );
          })}
        </div>
      )}

      {canManage && !pending && !loading && !loadError ? (
        <SubscriptionConnectAction
          analyticsAction="connect_supergrok"
          provider="SuperGrok"
          count={accounts.length}
          busy={busy}
          onConnect={() => void connect()}
          scopeControl={
            !organizationId ? (
              <Select
                aria-label="SuperGrok connection scope"
                className="w-auto"
                value={scope}
                disabled={busy}
                onChange={(event) =>
                  setScope(event.target.value as Exclude<SuperGrokAccountScope, "organization">)
                }
              >
                <option value="workspace">This workspace</option>
                <option value="user">Only me</option>
              </Select>
            ) : undefined
          }
        />
      ) : null}
      {accounts.length > 0 && !pending && !loading ? (
        <p className="text-2xs text-fg-subtle">
          {data?.settings.rotationEnabled && accounts.length > 1
            ? `New sessions rotate across ${accounts.length} eligible subscriptions.`
            : "The active subscription runs sessions that aren't pinned to a specific account."}
        </p>
      ) : null}
    </ModelConnectionSection>
  );
}
