import type { ClaudeSubscriptionAccount } from "@opengeni/sdk";
import { useState } from "react";
import {
  ConnectionAccessFormPage,
  useConnectionAccess,
} from "@/components/connection-access-settings";
import {
  SubscriptionAccountPage,
  type SubscriptionAccountPlaces,
} from "./subscription-account-detail";
import {
  SubscriptionAccountPoolRows,
  subscriptionListedCount,
  type OrganizationSubscriptionRows,
} from "./subscription-account-rows";
import { SubscriptionAccountRow, SubscriptionRotationSettingRows } from "./subscription-account-ui";
import { subscriptionAccountName } from "./use-subscription-account-pool";
import type { ClaudeSubscriptions } from "./use-claude-subscriptions";
import { ClaudeUsage, ClaudeUsageReadout, useClaudeUsage } from "./claude-usage";
import { ClaudeSignInPage } from "./claude-signin";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  ProviderCustomModels,
  type ProviderConnection,
  type ReadOnlyProviderCatalog,
} from "@/components/ai-gateway-connection";

export type ClaudePlaces = SubscriptionAccountPlaces;
export type OrganizationClaudePool = OrganizationSubscriptionRows<ClaudeSubscriptionAccount>;
export const claudeListedCount = subscriptionListedCount<ClaudeSubscriptionAccount>;
export function claudePlan(account: ClaudeSubscriptionAccount) {
  if (!account.plan) return "Claude plan";
  const words = account.plan.replace(/^claude_/, "").replaceAll("_", " ");
  return "Claude " + words.charAt(0).toUpperCase() + words.slice(1);
}
export function ClaudeRow({
  claude,
  account,
  places,
  onOpen,
  scopeLabel,
}: {
  claude: ClaudeSubscriptions;
  account: ClaudeSubscriptionAccount;
  places: ClaudePlaces;
  onOpen: () => void;
  scopeLabel?: string;
}) {
  const usage = {
    value: account.usage ?? null,
    loading: false,
    refreshing: false,
    error: false,
    canRefresh: false,
    refresh: async () => {},
  };
  return (
    <SubscriptionAccountRow
      provider="claude_subscription"
      title={subscriptionAccountName(account)}
      email={account.email}
      primary={account.id === claude.activeAccountId}
      meta={[
        scopeLabel ??
          (claude.organizationId || claude.inherited
            ? places.scope.organization
            : account.scope === "user"
              ? places.scope.user
              : places.scope.workspace),
        claudePlan(account),
      ]}
      cells={{
        usage:
          account.status !== "active" ? null : !account.allocatorEnabled ? (
            <StatusBadge status="paused" variant="dot" />
          ) : (
            <ClaudeUsageReadout state={usage} />
          ),
      }}
      indicator={
        account.status !== "active" ? { kind: "attention", label: "Needs reconnect" } : "open"
      }
      onOpen={onOpen}
    />
  );
}
export function ClaudeAccountRows({
  claude,
  places,
  organization = null,
}: {
  claude: ClaudeSubscriptions;
  places: ClaudePlaces;
  organization?: OrganizationClaudePool | null;
}) {
  return (
    <SubscriptionAccountPoolRows
      pool={claude}
      organization={organization}
      places={places}
      provider="claude_subscription"
      kind="claude_subscription"
      providerName="Claude"
      plan={claudePlan}
      renderRow={(account, onOpen, scopeLabel) => (
        <ClaudeRow
          claude={claude}
          account={account}
          places={places}
          onOpen={onOpen}
          {...(scopeLabel ? { scopeLabel } : {})}
        />
      )}
    />
  );
}
export function ClaudeSettingRows({ claude }: { claude: ClaudeSubscriptions }) {
  return (
    <SubscriptionRotationSettingRows
      rotationEnabled={claude.rotationEnabled}
      pending={claude.working === "rotation"}
      disabled={!claude.canManageAccounts || claude.busy}
      onChange={(value) => void claude.setRotation(value)}
    />
  );
}
function AccountUsage({
  claude,
  account,
  onReconnect,
}: {
  claude: ClaudeSubscriptions;
  account: ClaudeSubscriptionAccount;
  onReconnect?: (() => void) | undefined;
}) {
  const usage = useClaudeUsage({
    client: claude.client,
    scope: claude.organizationId ? "organization" : "workspace",
    scopeId: claude.organizationId ?? claude.workspaceId!,
    enabled: true,
    connected: true,
    credentialId: account.id,
    credentialVersion: account.version,
    canManage: claude.canManageAccounts,
    onCredentialChanged: claude.refresh,
    accountPool: true,
  });
  return <ClaudeUsage state={usage} onReconnect={onReconnect} />;
}
export function ClaudeAccountPage({
  claude,
  accountId,
  places,
  models,
  readOnlyCatalog,
}: {
  claude: ClaudeSubscriptions;
  accountId: string;
  places: ClaudePlaces;
  models?: ProviderConnection;
  readOnlyCatalog?: ReadOnlyProviderCatalog | undefined;
}) {
  return (
    <SubscriptionAccountPage
      pool={claude}
      accountId={accountId}
      places={places}
      client={claude.client}
      provider="claude_subscription"
      providerName="Claude"
      connectionKind="claude_subscription"
      plan={claudePlan}
      renderUsage={(account) => (
        <AccountUsage
          key={account.id}
          claude={claude}
          account={account}
          onReconnect={
            claude.canManageAccounts && !claude.inherited
              ? () => places.openConnect(account.id)
              : undefined
          }
        />
      )}
      renderModels={
        models
          ? () => <ProviderCustomModels state={models} readOnlyCatalog={readOnlyCatalog} />
          : undefined
      }
    />
  );
}
export function ClaudeAccessPage({
  claude,
  accountId,
  onClose,
}: {
  claude: ClaudeSubscriptions;
  accountId: string;
  onClose: () => void;
}) {
  const account = claude.accounts.find((candidate) => candidate.id === accountId);
  const access = useConnectionAccess({
    client: claude.client,
    organizationId: claude.organizationId,
    workspaceId: claude.workspaceId,
    kind: "claude_subscription",
    connectionId: accountId,
  });
  return (
    <ConnectionAccessFormPage
      access={access}
      organization={!!claude.organizationId}
      canManage={claude.canManageAccounts}
      name={account ? subscriptionAccountName(account) : "this account"}
      onClose={onClose}
    />
  );
}
export function ClaudeConnectPage({
  claude,
  onClose,
  onConnected,
  reconnectAccountId,
  scope,
  scopeName = "this workspace",
  allowPrivate = true,
  fields,
  footerStart,
  blockedReason,
  afterSave,
}: {
  claude: ClaudeSubscriptions;
  onClose: () => void;
  onConnected: (accountId?: string) => void;
  reconnectAccountId?: string | undefined;
  scope?: "workspace" | "user";
  scopeName?: string;
  allowPrivate?: boolean;
  fields?: React.ReactNode;
  footerStart?: React.ReactNode;
  blockedReason?: string | null | undefined;
  afterSave?: ((accountId?: string) => Promise<void>) | undefined;
}) {
  const [chosenScope, setChosenScope] = useState<"workspace" | "user">("workspace");
  const reconnectAccount = reconnectAccountId
    ? claude.accounts.find((account) => account.id === reconnectAccountId)
    : undefined;
  const connectionScope = reconnectAccount
    ? reconnectAccount.scope === "user"
      ? "user"
      : "workspace"
    : (scope ?? chosenScope);
  const reconnectBlocked =
    reconnectAccountId && !reconnectAccount
      ? claude.loading
        ? "Loading this account…"
        : claude.loadError
          ? "Couldn't load this account. Return to Models and try again."
          : "This account isn't connected here. Return to Models to connect an account."
      : null;
  return (
    <ClaudeSignInPage
      key={
        (claude.organizationId ?? claude.workspaceId) +
        ":" +
        connectionScope +
        ":" +
        (reconnectAccountId ?? "add")
      }
      accountPool
      connectionScope={connectionScope}
      scopeChoice={
        !claude.organizationId && !reconnectAccountId && scope === undefined && allowPrivate
          ? { scopeName, onChange: setChosenScope }
          : undefined
      }
      reconnectAccountId={reconnectAccountId}
      reconnectCredentialVersion={reconnectAccount?.version}
      onClose={onClose}
      onConnected={onConnected}
      fields={fields}
      footerStart={footerStart}
      blockedReason={reconnectBlocked ?? blockedReason}
      afterSave={afterSave}
      state={{
        organization: !!claude.organizationId,
        connected: !!reconnectAccountId,
        canManageConnection:
          claude.canManage && !reconnectBlocked && (!reconnectAccountId || !claude.inherited),
        accessTarget: {
          client: claude.client,
          workspaceId: claude.workspaceId,
          organizationId: claude.organizationId,
          kind: "claude_subscription",
          connectionId: reconnectAccountId ?? "current",
        },
        refreshConnection: claude.refresh,
        saveKey: async () => false,
      }}
    />
  );
}
