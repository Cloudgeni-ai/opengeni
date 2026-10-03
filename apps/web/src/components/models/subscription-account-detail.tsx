import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { CheckIcon, PencilIcon, UnplugIcon } from "lucide-react";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { ConnectionAccessRows, useConnectionAccess } from "@/components/connection-access-settings";
import {
  ProviderTile,
  organizationReachLabel,
  RenameAccountDialog,
  type ModelsScopeLabels,
  useModelsListLabel,
} from "./models-ui";
import {
  subscriptionAccountName,
  type SubscriptionPoolAccount,
} from "./use-subscription-account-pool";
import { MoreMenu, RowButton } from "@/components/ui/page-actions";
import { Button } from "@/components/ui/button";
import { DestructiveConfirm } from "@/components/ui/destructive-confirm";
import { DetailPage, DetailPageBody, DetailPageHeader } from "@/components/ui/detail-page";
import {
  DetailFact,
  DetailFacts,
  DetailSection,
  DetailSkeleton,
} from "@/components/ui/detail-sheet";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { ErrorMessage } from "@/components/ui/error-message";
import { EmptyState } from "@/components/ui/empty-state";
import { Notice } from "@/components/ui/notice";
import { SettingRow, SettingRowGroup } from "@/components/ui/setting-row";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { FLUSH_DETAIL_PAGE_CLASS } from "@/components/ui/flush-form-page";

export type SubscriptionAccountPlaces = {
  scopeName: string;
  organizationName: string;
  scope: ModelsScopeLabels;
  openAccount: (id: string) => void;
  openConnect: (id?: string) => void;
  openAccess: (id: string) => void;
  backToList: () => void;
};
type AccountSummary = SubscriptionPoolAccount & {
  status: string;
  allocatorEnabled: boolean;
  lastError?: string | null;
};
type AccountPool<Account extends AccountSummary> = {
  accounts: Account[];
  loading: boolean;
  loadError: string | null;
  refresh: () => Promise<void>;
  canManageAccounts: boolean;
  inherited: boolean;
  organizationId?: string | undefined;
  workspaceId?: string | undefined;
  activeAccountId: string | null;
  working: string | null;
  busy: boolean;
  setAllocator: (account: Account, enabled: boolean) => Promise<void>;
  activate: (account: Account) => Promise<void>;
  rename: (account: Account, label: string) => Promise<void>;
  disconnect: (account: Account) => Promise<void>;
};
export function SubscriptionAccountPage<Account extends AccountSummary>({
  pool,
  provider,
  providerName,
  connectionKind,
  plan,
  renderUsage,
  renderModels,
  accountId,
  places,
  client,
}: {
  pool: AccountPool<Account>;
  provider: "supergrok" | "claude_subscription";
  providerName: string;
  connectionKind: "supergrok" | "claude_subscription";
  plan: (account: Account) => string;
  renderUsage: (account: Account) => ReactNode;
  renderModels?: ((account: Account) => ReactNode) | undefined;
  accountId: string;
  places: SubscriptionAccountPlaces;
  client: OpenGeniBrowserClient;
}) {
  const listLabel = useModelsListLabel();
  const pageKey = `${provider}:${pool.organizationId ?? pool.workspaceId}:${accountId}`;
  const pageLifetime = useMemo(() => ({ key: pageKey, active: true }), [pageKey]);
  useEffect(() => {
    pageLifetime.active = true;
    return () => {
      pageLifetime.active = false;
    };
  }, [pageLifetime]);
  const account = pool.accounts.find((candidate) => candidate.id === accountId) ?? null;
  const back = { label: listLabel, onClick: places.backToList };
  if (pool.loading) {
    return (
      <DetailPage back={back} className={FLUSH_DETAIL_PAGE_CLASS}>
        <DetailSkeleton />
      </DetailPage>
    );
  }
  if (pool.loadError)
    return (
      <DetailPage back={back} className={FLUSH_DETAIL_PAGE_CLASS}>
        <ErrorMessage
          title={`Couldn't load ${providerName} accounts`}
          action={<RowButton onClick={() => void pool.refresh()}>Try again</RowButton>}
        >
          {pool.loadError}
        </ErrorMessage>
      </DetailPage>
    );
  if (!account) {
    return (
      <DetailPage back={back} className={FLUSH_DETAIL_PAGE_CLASS}>
        <EmptyState
          variant="page"
          icon={<UnplugIcon />}
          title="This account isn't connected here"
          description="It may have been disconnected."
          action={<RowButton onClick={places.backToList}>Back to Models</RowButton>}
        />
      </DetailPage>
    );
  }
  return (
    <SubscriptionAccountDetail
      pool={pool}
      provider={provider}
      providerName={providerName}
      connectionKind={connectionKind}
      plan={plan}
      renderUsage={renderUsage}
      renderModels={renderModels}
      account={account}
      places={{
        ...places,
        backToList: () => {
          if (pageLifetime.active) places.backToList();
        },
      }}
      client={client}
    />
  );
}

function SubscriptionAccountDetail<Account extends AccountSummary>({
  pool,
  provider,
  providerName,
  connectionKind,
  plan,
  renderUsage,
  renderModels,
  account,
  places,
  client,
}: {
  pool: AccountPool<Account>;
  provider: "supergrok" | "claude_subscription";
  providerName: string;
  connectionKind: "supergrok" | "claude_subscription";
  plan: (account: Account) => string;
  renderUsage: (account: Account) => ReactNode;
  renderModels?: ((account: Account) => ReactNode) | undefined;
  account: Account;
  places: SubscriptionAccountPlaces;
  client: OpenGeniBrowserClient;
}) {
  const listLabel = useModelsListLabel();
  const [renaming, setRenaming] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const name = subscriptionAccountName(account);
  const canEdit = pool.canManageAccounts;
  const organization = Boolean(pool.organizationId);
  const status =
    account.status !== "active"
      ? "needs_reconnect"
      : account.allocatorEnabled
        ? "connected"
        : "paused";
  const access = useConnectionAccess({
    client,
    organizationId: pool.organizationId,
    workspaceId: pool.workspaceId,
    kind: connectionKind,
    connectionId: account.id,
    enabled: canEdit,
  });
  const scopeLabel = pool.organizationId
    ? organizationReachLabel(places.scope, access.data)
    : pool.inherited
      ? places.scope.organization
      : account.scope === "user"
        ? places.scope.user
        : places.scope.workspace;
  return (
    <DetailPage
      back={{ label: listLabel, onClick: places.backToList }}
      className={FLUSH_DETAIL_PAGE_CLASS}
    >
      <DetailPageHeader
        leading={<ProviderTile provider={provider} />}
        title={name}
        chips={status === "connected" ? null : <StatusBadge status={status} variant="outline" />}
        meta={[
          plan(account),
          account.email && account.email !== name ? account.email : null,
          scopeLabel,
        ]}
        actions={
          canEdit ? (
            <MoreMenu label={`More actions for ${name}`}>
              {provider === "claude_subscription" ? (
                <DropdownMenuItem onSelect={() => places.openConnect(account.id)}>
                  Sign in again
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem variant="destructive" onSelect={() => setDisconnecting(true)}>
                <UnplugIcon />
                Disconnect
              </DropdownMenuItem>
            </MoreMenu>
          ) : null
        }
      />
      <DetailPageBody>
        {pool.inherited ? (
          <ManagedNote>{`Managed by the owners and admins of ${places.organizationName}.`}</ManagedNote>
        ) : !canEdit ? (
          <ManagedNote>Only people who can manage connections can change this account.</ManagedNote>
        ) : null}
        {account.lastError || account.status !== "active" ? (
          <DetailSection>
            <Notice
              tone="waiting"
              title={
                account.status !== "active" ? `Sign in to ${providerName} again` : "Last problem"
              }
              action={
                canEdit && account.status !== "active" ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="default"
                    onClick={() => places.openConnect(account.id)}
                    className="rounded-[10px] pointer-coarse:h-11"
                  >
                    Sign in again
                  </Button>
                ) : undefined
              }
            >
              {account.lastError ?? "This account can't be used until someone signs in again."}
            </Notice>
          </DetailSection>
        ) : null}
        {renderUsage(account)}
        {renderModels?.(account)}
        {canEdit ? (
          <DetailSection title="Settings">
            <SettingRowGroup className="-my-3">
              <SettingRow
                label="Use for new work"
                description="When off, this account isn't picked for new chats or schedules. Work already running continues."
                control={
                  <Switch
                    aria-label={`Use ${name} for new work`}
                    checked={account.allocatorEnabled}
                    pending={pool.working === `allocator:${account.id}`}
                    disabled={pool.busy}
                    onCheckedChange={(next) => void pool.setAllocator(account, next)}
                  />
                }
              />
              {pool.accounts.length > 1 ? (
                <SettingRow
                  label="Primary account"
                  description={
                    account.id === pool.activeAccountId
                      ? "With Primary only, this is the only account used for new work."
                      : "Choose the account used when allocation is set to Primary only."
                  }
                  control={
                    account.id === pool.activeAccountId ? (
                      <span className="inline-flex h-8 items-center gap-1.5 text-sm font-medium text-fg-muted">
                        <CheckIcon aria-hidden="true" className="size-4 text-status-idle" />
                        Primary
                      </span>
                    ) : (
                      <RowButton
                        disabled={pool.busy || account.status !== "active"}
                        onClick={() => void pool.activate(account)}
                      >
                        Make primary
                      </RowButton>
                    )
                  }
                />
              ) : null}
              <SettingRow
                label="Name"
                description={name}
                control={
                  <RowButton aria-label={`Rename ${name}`} onClick={() => setRenaming(true)}>
                    <PencilIcon aria-hidden="true" />
                    Rename
                  </RowButton>
                }
              />
              <ConnectionAccessRows
                access={access}
                organization={organization}
                canManage={canEdit}
                onEdit={() => places.openAccess(account.id)}
              />
            </SettingRowGroup>
          </DetailSection>
        ) : (
          <DetailSection title="Details">
            <DetailFacts>
              <DetailFact label="Use for new work">
                {account.allocatorEnabled ? "On" : "Off"}
              </DetailFact>
              {pool.accounts.length > 1 ? (
                <DetailFact label="Primary">
                  {account.id === pool.activeAccountId ? "Yes" : "No"}
                </DetailFact>
              ) : null}
            </DetailFacts>
          </DetailSection>
        )}
      </DetailPageBody>
      <RenameAccountDialog
        open={renaming}
        onOpenChange={setRenaming}
        name={name}
        label={account.label}
        provider={providerName}
        onSave={(label) => pool.rename(account, label)}
      />
      <DestructiveConfirm
        open={disconnecting}
        onOpenChange={setDisconnecting}
        title={`Disconnect ${name}?`}
        consequences={[
          organization
            ? `Workspaces that use ${name} stop using it for new work.`
            : `${name} stops paying for new work in ${places.scopeName}.`,
          "Work already running finishes first.",
          `You'll need to sign in to ${providerName} again to reconnect it.`,
        ]}
        confirmLabel="Disconnect"
        pendingLabel="Disconnecting…"
        onConfirm={async () => {
          await pool.disconnect(account);
          places.backToList();
        }}
      />
    </DetailPage>
  );
}

function ManagedNote({ children }: { children: ReactNode }) {
  return <p className="m-0 pt-2 pb-6 text-sm leading-5 text-fg-muted">{children}</p>;
}
