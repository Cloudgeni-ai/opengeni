import type { ClaudeSubscriptionAccount } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { useState, type ReactNode } from "react";
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
import {
  SubscriptionAccountRow,
  SubscriptionRotationSettingRows,
} from "@/components/models/subscription-account-ui";
import {
  managesSubscriptionAccount,
  subscriptionAccountName,
} from "./use-subscription-account-pool";
import type { ClaudeSubscriptions } from "./use-claude-subscriptions";
import { ClaudeUsage, ClaudeUsageReadout, useClaudeUsage } from "./claude-usage";
import { ClaudeSignInPage } from "./claude-signin";
import { StatusBadge } from "@opengeni/react/ui/status-badge";
import { invalidateSharedQueries } from "@opengeni/react/app/lib/shared-query";
import { organizationReachLabel } from "@opengeni/react/app/components/models/models-ui";
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
/** The usage cell of a Claude account row, from the usage its listing carries. */
export function claudeUsageCell(account: ClaudeSubscriptionAccount): React.ReactNode {
  if (account.status !== "active") return null;
  if (!account.allocatorEnabled) return <StatusBadge status="disabled" variant="dot" />;
  return (
    <ClaudeUsageReadout
      state={{
        value: account.usage ?? null,
        loading: false,
        refreshing: false,
        error: false,
        canRefresh: false,
        refresh: async () => {},
      }}
    />
  );
}

// A usage check can discover a disconnected credential. Reload its metadata,
// not the usage query itself (which would repeat the live check it just made).
function refreshClaudeAccountMetadata(client: object): Promise<void> {
  return Promise.all([
    invalidateSharedQueries(client, ["subscription-pool", "Claude"]),
    invalidateSharedQueries(client, ["model-settings", "workspace-snapshots"]),
  ]).then(() => undefined);
}

/** Row and detail meters observe the same client/scoped live usage query. */
export function ClaudeAccountUsageReadout({
  client,
  scope,
  scopeId,
  account,
  canManage,
}: {
  client: OpenGeniBrowserClient;
  scope: "workspace" | "organization";
  scopeId: string;
  account: ClaudeSubscriptionAccount;
  canManage: boolean;
}) {
  const usage = useClaudeUsage({
    client,
    scope,
    scopeId,
    enabled: account.status === "active" && account.allocatorEnabled,
    connected: account.status === "active",
    credentialId: account.id,
    credentialVersion: account.version,
    canManage,
    accountPool: true,
    onCredentialChanged: () => refreshClaudeAccountMetadata(client),
  });
  if (account.status !== "active") return null;
  if (!account.allocatorEnabled) return <StatusBadge status="disabled" variant="dot" />;
  return <ClaudeUsageReadout state={usage} />;
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
  scopeLabel?: ReactNode;
}) {
  // An organization's own account says where it's available, like Codex and SuperGrok.
  const access = useConnectionAccess({
    client: claude.client,
    organizationId: claude.organizationId,
    kind: "claude_subscription",
    connectionId: account.id,
    enabled: Boolean(claude.organizationId) && scopeLabel === undefined,
  });
  return (
    <SubscriptionAccountRow
      provider="claude_subscription"
      title={subscriptionAccountName(account)}
      email={account.email}
      primary={claude.accounts.length > 1 && account.id === claude.activeAccountId}
      meta={[
        scopeLabel ??
          (claude.organizationId
            ? organizationReachLabel(places.scope, access.data)
            : claude.inherited || account.scope === "organization"
              ? places.scope.organization
              : account.scope === "user"
                ? places.scope.user
                : places.scope.workspace),
        claudePlan(account),
      ]}
      cells={{
        usage: (
          <ClaudeAccountUsageReadout
            client={claude.client}
            scope={claude.organizationId ? "organization" : "workspace"}
            scopeId={claude.organizationId ?? claude.workspaceId!}
            account={account}
            canManage={managesSubscriptionAccount(claude, account)}
          />
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
      providerName="Claude"
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
    canManage: managesSubscriptionAccount(claude, account),
    onCredentialChanged: () => refreshClaudeAccountMetadata(claude.client),
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
            managesSubscriptionAccount(claude, account)
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
      canManage={account ? managesSubscriptionAccount(claude, account) : claude.canManageAccounts}
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
  onPendingChange,
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
  onPendingChange?: ((pending: boolean) => void) | undefined;
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
      onPendingChange={onPendingChange}
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
