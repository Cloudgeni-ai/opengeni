import type { SuperGrokAccount } from "@opengeni/sdk";
import { CheckIcon, PencilIcon, UnplugIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import {
  ConnectionAccessFormPage,
  ConnectionAccessRows,
  useConnectionAccess,
} from "@/components/connection-access-settings";
import {
  ModelsFormPage,
  NOT_IN_USE,
  ProviderTile,
  organizationReachLabel,
  RenameAccountDialog,
  type ModelsScopeLabels,
} from "@/components/models/models-ui";
import { reachesWorkspace } from "@/components/models/organization-codex-models";
import { MoreMenu, RowButton } from "@/components/ui/page-actions";
import { DeviceSignInStatus } from "@/components/subscription-device-code-panel";
import {
  SuperGrokDeviceCodePanel,
  superGrokAccountName,
  type SuperGrokSubscriptions,
} from "@/components/supergrok-connection";
import { Button } from "@/components/ui/button";
import { ChoiceCard, ChoiceCards } from "@/components/ui/choice-cards";
import { DestructiveConfirm } from "@/components/ui/destructive-confirm";
import { DetailPage, DetailPageBody, DetailPageHeader } from "@/components/ui/detail-page";
import {
  DetailFact,
  DetailFacts,
  DetailSection,
  DetailSkeleton,
} from "@/components/ui/detail-sheet";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorMessage } from "@/components/ui/error-message";
import { FieldStack } from "@/components/ui/field";
import { ListRow, ListRowSkeleton } from "@/components/ui/list-row";
import { MetaChip } from "@/components/ui/meta-chip";
import { Notice } from "@/components/ui/notice";
import { RelativeTime } from "@/components/ui/relative-time";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SettingRow, SettingRowGroup } from "@/components/ui/setting-row";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { UsageMeterGroup, UsageReadout } from "@/components/ui/usage-meter";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { FLUSH_DETAIL_PAGE_CLASS } from "@/components/ui/flush-form-page";

/* ----------------------------------------------------------------------------
   SuperGrok on Settings > Models, at workspace and organization scope: the
   provider group, each account's page and the Connect page. Hidden entirely
   when the deployment has SuperGrok turned off.
   -------------------------------------------------------------------------- */

export interface SuperGrokPlaces {
  /** "Local" or the organization's name: where these accounts belong. */
  scopeName: string;
  organizationName: string;
  /** Who each account is for: "Everyone in Acme", "This workspace only", "Only you". */
  scope: ModelsScopeLabels;
  openAccount: (accountId: string) => void;
  /** Opens the connect step; with an account, to sign that account in again. */
  openConnect: (reconnectAccountId?: string) => void;
  openAccess: (accountId: string) => void;
  backToList: () => void;
}

function needsReconnect(account: SuperGrokAccount): boolean {
  return account.status !== "active";
}

function planOf(account: SuperGrokAccount): string {
  const plan = account.plan ?? account.quota?.subscriptionTier;
  return plan
    ? `SuperGrok ${plan.charAt(0).toLocaleUpperCase()}${plan.slice(1)}`
    : "SuperGrok plan";
}

function percentLeft(account: SuperGrokAccount): number | null {
  const used = account.quota?.usedPercent;
  return typeof used === "number" ? Math.max(0, Math.min(100, Math.round(100 - used))) : null;
}

function accountStatus(account: SuperGrokAccount): "connected" | "paused" | "needs_reconnect" {
  if (needsReconnect(account)) return "needs_reconnect";
  if (!account.allocatorEnabled) return "paused";
  return "connected";
}

/**
 * The organization's own SuperGrok accounts, for people who manage them: the
 * rows show every one of them, in use here or not, and open their organization page.
 */
export interface OrganizationSuperGrokPool {
  grok: SuperGrokSubscriptions;
  workspace: { id: string; personal: boolean };
  openAccount: (accountId: string) => void;
}

/** How many rows SuperGrok adds to the Accounts list once loaded. */
export function superGrokListedCount(
  grok: SuperGrokSubscriptions,
  organization: OrganizationSuperGrokPool | null = null,
): number {
  if (grok.unavailable || grok.loading) return 0;
  if (grok.loadError || grok.pending) return 1;
  const own = grok.inherited ? 0 : grok.accounts.length;
  const shared = organization
    ? organization.grok.accounts.length
    : grok.inherited
      ? grok.accounts.length
      : 0;
  return own + shared;
}

/** Who a SuperGrok account is for, in the one tag its row and page carry. */
function scopeOf(grok: SuperGrokSubscriptions, account: SuperGrokAccount, places: SuperGrokPlaces) {
  if (grok.inherited || grok.organizationId) return places.scope.organization;
  return account.scope === "user" ? places.scope.user : places.scope.workspace;
}

/** SuperGrok's rows in the Accounts list. Nothing when the deployment has it off. */
export function SuperGrokAccountRows({
  grok,
  places,
  organization = null,
}: {
  grok: SuperGrokSubscriptions;
  places: SuperGrokPlaces;
  organization?: OrganizationSuperGrokPool | null;
}) {
  if (grok.unavailable) return null;
  if (grok.loading || organization?.grok.loading) return <ListRowSkeleton count={1} />;
  if (grok.loadError) {
    return (
      <li className="col-span-full list-none px-3 py-3">
        <ErrorMessage
          variant="inline"
          title="Couldn't load SuperGrok accounts."
          action={<RowButton onClick={() => void grok.refresh()}>Try again</RowButton>}
        >
          {grok.loadError}
        </ErrorMessage>
      </li>
    );
  }
  const own = grok.inherited ? [] : grok.accounts;
  const shared = organization
    ? organization.grok.accounts.map((account) => {
        const live = grok.inherited
          ? grok.accounts.find((candidate) => candidate.id === account.id)
          : undefined;
        return live ? (
          <SharedSuperGrokInUseRow
            key={account.id}
            grok={grok}
            account={live}
            places={places}
            organization={organization}
          />
        ) : (
          <SharedSuperGrokSetAsideRow
            key={account.id}
            account={account}
            organization={organization}
            places={places}
            ownInUse={own.length > 0}
          />
        );
      })
    : grok.inherited
      ? grok.accounts.map((account) => (
          <SuperGrokRow
            key={account.id}
            grok={grok}
            account={account}
            places={places}
            onOpen={() => places.openAccount(account.id)}
          />
        ))
      : [];
  return (
    <>
      {shared}
      {own.map((account) => (
        <SuperGrokRow
          key={account.id}
          grok={grok}
          account={account}
          places={places}
          onOpen={() => places.openAccount(account.id)}
        />
      ))}
      {grok.pending ? (
        <ListRow
          leading={<ProviderTile provider="supergrok" size="lg" />}
          title="Signing in to xAI…"
          meta={["Finish signing in to add the account"]}
          indicator="open"
          onOpen={() => places.openConnect()}
        />
      ) : null}
    </>
  );
}

/** An organization SuperGrok account new work here uses, tagged with where it's available. */
function SharedSuperGrokInUseRow({
  grok,
  account,
  places,
  organization,
}: {
  grok: SuperGrokSubscriptions;
  account: SuperGrokAccount;
  places: SuperGrokPlaces;
  organization: OrganizationSuperGrokPool;
}) {
  const access = useConnectionAccess({
    client: organization.grok.client,
    organizationId: organization.grok.organizationId,
    kind: "supergrok",
    connectionId: account.id,
  });
  return (
    <SuperGrokRow
      grok={grok}
      account={account}
      places={places}
      scopeLabel={organizationReachLabel(places.scope, access.data)}
      onOpen={() => organization.openAccount(account.id)}
    />
  );
}

/** An organization SuperGrok account new work here doesn't use, with the plain reason. */
function SharedSuperGrokSetAsideRow({
  account,
  organization,
  places,
  ownInUse,
}: {
  account: SuperGrokAccount;
  organization: OrganizationSuperGrokPool;
  places: SuperGrokPlaces;
  /** This workspace has its own SuperGrok accounts, which new work uses instead. */
  ownInUse: boolean;
}) {
  const access = useConnectionAccess({
    client: organization.grok.client,
    organizationId: organization.grok.organizationId,
    kind: "supergrok",
    connectionId: account.id,
  });
  const reaches = ownInUse ? true : reachesWorkspace(access.data, organization.workspace);
  return (
    <ListRow
      leading={<ProviderTile provider="supergrok" size="lg" />}
      title={superGrokAccountName(account)}
      meta={[
        organizationReachLabel(places.scope, access.data),
        planOf(account),
        ownInUse
          ? "Set aside while this workspace has its own"
          : reaches === false
            ? `Not available in ${places.scopeName}`
            : null,
      ]}
      cells={{ usage: NOT_IN_USE }}
      indicator={needsReconnect(account) ? { kind: "attention", label: "Needs reconnect" } : "open"}
      onOpen={() => organization.openAccount(account.id)}
    />
  );
}

/** "When several accounts are connected", once there are two SuperGrok accounts. */
export function superGrokSectionVisible(grok: SuperGrokSubscriptions): boolean {
  return !grok.unavailable && !grok.loading && grok.canManageAccounts && grok.accounts.length >= 2;
}

export function SuperGrokSettingRows({
  grok,
  label = "When several accounts are connected",
}: {
  grok: SuperGrokSubscriptions;
  label?: string;
}) {
  return (
    <SettingRowGroup>
      <SettingRow
        label={label}
        description="Spread work sends new chats to the account with the most room left. Primary only uses the primary account."
        controlWidth="auto"
        control={
          <SegmentedControl<"spread" | "primary">
            size="sm"
            pending={grok.working === "rotation"}
            disabled={grok.busy && grok.working !== "rotation"}
            value={grok.rotationEnabled ? "spread" : "primary"}
            onValueChange={(value) => void grok.setRotation(value === "spread")}
            options={[
              { value: "spread", label: "Spread work" },
              { value: "primary", label: "Primary only" },
            ]}
          />
        }
      />
    </SettingRowGroup>
  );
}

function SuperGrokRow({
  grok,
  account,
  places,
  scopeLabel,
  onOpen,
}: {
  grok: SuperGrokSubscriptions;
  account: SuperGrokAccount;
  places: SuperGrokPlaces;
  /** Overrides the tag, for an organization account whose "Available in" is known. */
  scopeLabel?: string | undefined;
  onOpen: () => void;
}) {
  const primary = grok.accounts.length > 1 && account.id === grok.activeAccountId;
  const left = percentLeft(account);
  const status = accountStatus(account);
  return (
    <ListRow
      leading={<ProviderTile provider="supergrok" size="lg" />}
      title={superGrokAccountName(account)}
      titleAddon={primary ? <MetaChip variant="outline">Primary</MetaChip> : null}
      meta={[scopeLabel ?? scopeOf(grok, account, places), planOf(account)]}
      cells={{
        usage: needsReconnect(account) ? null : status === "paused" ? (
          <StatusBadge status="paused" variant="dot" />
        ) : (
          <UsageReadout
            percent={left}
            window="this period"
            {...(account.quota?.periodEnd
              ? { resetsLabel: formatReset(account.quota.periodEnd) }
              : {})}
          />
        ),
      }}
      indicator={needsReconnect(account) ? { kind: "attention", label: "Needs reconnect" } : "open"}
      onOpen={onOpen}
    />
  );
}

export function SuperGrokAccountPage({
  grok,
  accountId,
  places,
  client,
}: {
  grok: SuperGrokSubscriptions;
  accountId: string;
  places: SuperGrokPlaces;
  client: OpenGeniBrowserClient;
}) {
  const account = grok.accounts.find((candidate) => candidate.id === accountId) ?? null;
  const back = { label: "Models", onClick: places.backToList };
  if (grok.loading) {
    return (
      <DetailPage back={back} className={FLUSH_DETAIL_PAGE_CLASS}>
        <DetailSkeleton />
      </DetailPage>
    );
  }
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
  return <SuperGrokAccountDetail grok={grok} account={account} places={places} client={client} />;
}

function SuperGrokAccountDetail({
  grok,
  account,
  places,
  client,
}: {
  grok: SuperGrokSubscriptions;
  account: SuperGrokAccount;
  places: SuperGrokPlaces;
  client: OpenGeniBrowserClient;
}) {
  const [renaming, setRenaming] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const name = superGrokAccountName(account);
  const canEdit = grok.canManageAccounts;
  const organization = Boolean(grok.organizationId);
  const status = accountStatus(account);
  const left = percentLeft(account);
  const access = useConnectionAccess({
    client,
    organizationId: grok.organizationId,
    workspaceId: grok.workspaceId,
    kind: "supergrok",
    connectionId: account.id,
    enabled: canEdit,
  });
  const scopeLabel = grok.organizationId
    ? organizationReachLabel(places.scope, access.data)
    : scopeOf(grok, account, places);
  return (
    <DetailPage
      back={{ label: "Models", onClick: places.backToList }}
      className={FLUSH_DETAIL_PAGE_CLASS}
    >
      <DetailPageHeader
        leading={<ProviderTile provider="supergrok" />}
        title={name}
        chips={status === "connected" ? null : <StatusBadge status={status} variant="outline" />}
        meta={[
          planOf(account),
          account.email && account.email !== name ? account.email : null,
          scopeLabel,
        ]}
        actions={
          canEdit ? (
            <MoreMenu label={`More actions for ${name}`}>
              <DropdownMenuItem variant="destructive" onSelect={() => setDisconnecting(true)}>
                <UnplugIcon />
                Disconnect
              </DropdownMenuItem>
            </MoreMenu>
          ) : null
        }
      />
      <DetailPageBody>
        {grok.inherited ? (
          <ManagedNote>{`Managed by the owners and admins of ${places.organizationName}.`}</ManagedNote>
        ) : !canEdit ? (
          <ManagedNote>Only people who can manage connections can change this account.</ManagedNote>
        ) : null}
        {account.lastError || needsReconnect(account) ? (
          <DetailSection>
            <Notice
              tone="waiting"
              title={needsReconnect(account) ? "Sign in to xAI again" : "Last problem"}
              action={
                canEdit && needsReconnect(account) ? (
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
        {left !== null ? (
          <DetailSection title="Usage">
            <UsageMeterGroup
              windows={[
                {
                  label: "This period",
                  percent: left,
                  ...(account.quota?.periodEnd
                    ? { resetsLabel: formatReset(account.quota.periodEnd) }
                    : {}),
                },
              ]}
              checked={
                account.quota?.checkedAt ? (
                  <RelativeTime date={account.quota.checkedAt} prefix="Checked" />
                ) : undefined
              }
            />
          </DetailSection>
        ) : null}
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
                    pending={grok.working === `allocator:${account.id}`}
                    disabled={grok.busy}
                    onCheckedChange={(next) => void grok.setAllocator(account, next)}
                  />
                }
              />
              {grok.accounts.length > 1 ? (
                <SettingRow
                  label="Primary account"
                  description={
                    account.id === grok.activeAccountId
                      ? "New work starts here. With Primary only, it's the only account used."
                      : "Make this the account new work starts with."
                  }
                  control={
                    account.id === grok.activeAccountId ? (
                      <span className="inline-flex h-8 items-center gap-1.5 text-sm font-medium text-fg-muted">
                        <CheckIcon aria-hidden="true" className="size-4 text-status-idle" />
                        Primary
                      </span>
                    ) : (
                      <RowButton
                        disabled={grok.busy || needsReconnect(account)}
                        onClick={() => void grok.activate(account)}
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
              {grok.accounts.length > 1 ? (
                <DetailFact label="Primary">
                  {account.id === grok.activeAccountId ? "Yes" : "No"}
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
        provider="xAI"
        onSave={(label) => grok.rename(account, label)}
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
          "You'll need to sign in to xAI again to reconnect it.",
        ]}
        confirmLabel="Disconnect"
        pendingLabel="Disconnecting…"
        onConfirm={async () => {
          await grok.disconnect(account);
          places.backToList();
        }}
      />
    </DetailPage>
  );
}

function formatReset(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

function ManagedNote({ children }: { children: ReactNode }) {
  return <p className="m-0 pt-2 pb-6 text-sm leading-5 text-fg-muted">{children}</p>;
}

export function SuperGrokAccessPage({
  grok,
  accountId,
  client,
  onClose,
}: {
  grok: SuperGrokSubscriptions;
  accountId: string;
  client: OpenGeniBrowserClient;
  onClose: () => void;
}) {
  const account = grok.accounts.find((candidate) => candidate.id === accountId);
  const access = useConnectionAccess({
    client,
    organizationId: grok.organizationId,
    workspaceId: grok.workspaceId,
    kind: "supergrok",
    connectionId: accountId,
  });
  return (
    <ConnectionAccessFormPage
      access={access}
      organization={Boolean(grok.organizationId)}
      canManage={grok.canManageAccounts}
      name={account ? superGrokAccountName(account) : "this account"}
      onClose={onClose}
    />
  );
}

export function SuperGrokConnectPage({
  grok,
  places,
  onClose,
  footerStart,
  fields,
  blockedReason,
  onAccountConnected,
}: {
  grok: SuperGrokSubscriptions;
  places: SuperGrokPlaces;
  onClose: () => void;
  footerStart?: ReactNode;
  /** Fields above the sign-in, such as which workspaces can use the account. */
  fields?: ReactNode;
  /** Why the sign-in can't start yet (a choice above is incomplete). */
  blockedReason?: string | null;
  /** Runs once the account is connected, before its page opens, even if this page was left. */
  onAccountConnected?: ((accountId: string | null) => Promise<void> | void) | undefined;
}) {
  const organization = Boolean(grok.organizationId);
  const [scope, setScope] = useState<"workspace" | "user">("workspace");
  const [connected, setConnected] = useState(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const signingIn = Boolean(grok.pending);
  return (
    <ModelsFormPage
      title="Connect SuperGrok"
      description="Sign in with the xAI account whose SuperGrok plan should pay for Grok models."
      onClose={onClose}
      submitLabel="Sign in with xAI"
      pendingLabel="Opening xAI…"
      submitAnalyticsAction="connect_supergrok"
      // While the code waits, the step holds its own actions.
      footer={signingIn || connected ? false : undefined}
      submitDisabled={!grok.canManage || grok.busy || connected || Boolean(blockedReason)}
      disabledReason={
        grok.canManage
          ? (blockedReason ?? undefined)
          : "Only people who can manage connections can add an account."
      }
      footerStart={footerStart}
      onSubmit={async () => {
        if (signingIn) return false;
        await grok.connect(scope, {
          onConnected: (accountId) =>
            void (async () => {
              await onAccountConnected?.(accountId);
              if (!active.current) return;
              setConnected(true);
              if (accountId) places.openAccount(accountId);
              else places.backToList();
            })(),
        });
        return false;
      }}
    >
      <FieldStack>
        {fields}
        {!organization ? (
          <ChoiceCards
            label="Who can use it"
            value={scope}
            disabled={signingIn}
            onValueChange={(value) => setScope(value as "workspace" | "user")}
          >
            <ChoiceCard
              value="workspace"
              title="Everyone in this workspace"
              description={`New work in ${places.scopeName} can use it.`}
            />
            <ChoiceCard
              value="user"
              title="Only me"
              description="Only work you start uses it. Nobody else in the workspace can."
            />
          </ChoiceCards>
        ) : null}
        <DeviceSignInStatus
          provider="supergrok"
          connected={connected}
          panel={
            grok.pending ? (
              <SuperGrokDeviceCodePanel
                userCode={grok.pending.userCode}
                verificationUri={grok.pending.verificationUri}
              />
            ) : null
          }
        />
      </FieldStack>
    </ModelsFormPage>
  );
}
