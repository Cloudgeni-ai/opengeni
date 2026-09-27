import type { SuperGrokAccount } from "@opengeni/sdk";
import {
  BuildingIcon,
  CheckIcon,
  CircleCheckIcon,
  FolderIcon,
  LoaderCircleIcon,
  LockIcon,
  PencilIcon,
  UnplugIcon,
  UserIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import {
  ConnectionAccessFormPage,
  ConnectionAccessRows,
  useConnectionAccess,
} from "@/components/connection-access-settings";
import { ModelsFormPage, ProviderTile, RenameAccountDialog } from "@/components/models/models-ui";
import { MoreMenu, RowButton } from "@/components/ui/page-actions";
import {
  SuperGrokDeviceCodePanel,
  superGrokAccountName,
  type SuperGrokSubscriptions,
} from "@/components/supergrok-connection";
import { Button } from "@/components/ui/button";
import { ChoiceCard, ChoiceCards } from "@/components/ui/choice-cards";
import { DestructiveConfirm } from "@/components/ui/destructive-confirm";
import {
  DetailAside,
  DetailAsideItem,
  DetailPage,
  DetailPageBody,
  DetailPageHeader,
} from "@/components/ui/detail-page";
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
  openAccount: (accountId: string) => void;
  openConnect: () => void;
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

/** How many rows SuperGrok adds to the Accounts list once loaded. */
export function superGrokListedCount(grok: SuperGrokSubscriptions): number {
  if (grok.unavailable || grok.loading) return 0;
  if (grok.loadError || grok.pending) return 1;
  return grok.accounts.length;
}

/** SuperGrok's rows in the Accounts list. Nothing when the deployment has it off. */
export function SuperGrokAccountRows({
  grok,
  places,
}: {
  grok: SuperGrokSubscriptions;
  places: SuperGrokPlaces;
}) {
  if (grok.unavailable) return null;
  if (grok.loading) return <ListRowSkeleton count={1} />;
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
  return (
    <>
      {grok.accounts.map((account) => (
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
          onOpen={places.openConnect}
        />
      ) : null}
    </>
  );
}

/** "When several accounts are connected", once there are two SuperGrok accounts. */
export function superGrokSectionVisible(grok: SuperGrokSubscriptions): boolean {
  return !grok.unavailable && !grok.loading && grok.canManageAccounts && grok.accounts.length >= 2;
}

export function SuperGrokSettingRows({ grok }: { grok: SuperGrokSubscriptions }) {
  return (
    <SettingRowGroup>
      <SettingRow
        label="When several accounts are connected"
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
  onOpen,
}: {
  grok: SuperGrokSubscriptions;
  account: SuperGrokAccount;
  places: SuperGrokPlaces;
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
      meta={[
        planOf(account),
        grok.inherited ? `Shared by ${places.organizationName}` : null,
        account.scope === "user" ? "Only you" : null,
      ]}
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
  const scopeLabel = grok.inherited
    ? places.organizationName
    : account.scope === "user"
      ? "Only you"
      : organization
        ? "Organization account"
        : "Workspace account";
  return (
    <DetailPage
      back={{ label: "Models", onClick: places.backToList }}
      className={FLUSH_DETAIL_PAGE_CLASS}
    >
      <DetailPageHeader
        leading={<ProviderTile provider="supergrok" />}
        title={name}
        chips={
          <>
            <StatusBadge status={status} variant="outline" />
            {grok.inherited ? <MetaChip variant="outline">Organization</MetaChip> : null}
          </>
        }
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
      <DetailPageBody
        aside={
          <DetailAside label={`About ${name}`}>
            <DetailAsideItem
              label="Belongs to"
              icon={
                account.scope === "user" ? (
                  <UserIcon />
                ) : grok.inherited || organization ? (
                  <BuildingIcon />
                ) : (
                  <FolderIcon />
                )
              }
            >
              {account.scope === "user"
                ? "Only you"
                : grok.inherited
                  ? places.organizationName
                  : places.scopeName}
            </DetailAsideItem>
            <DetailAsideItem label="Plan">{planOf(account)}</DetailAsideItem>
          </DetailAside>
        }
      >
        {grok.inherited ? (
          <ManagedNote>
            {`Shared by ${places.organizationName}. Only organization owners and admins can change it.`}
          </ManagedNote>
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
                    variant="outline"
                    onClick={places.openConnect}
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
  return (
    <p className="flex items-start gap-2 pt-2 pb-6 text-xs leading-4.5 text-fg-muted">
      <LockIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-fg-subtle" />
      <span className="min-w-0">{children}</span>
    </p>
  );
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
}: {
  grok: SuperGrokSubscriptions;
  places: SuperGrokPlaces;
  onClose: () => void;
  footerStart?: ReactNode;
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
      submitLabel={signingIn ? "Open xAI again" : "Sign in with xAI"}
      pendingLabel="Opening xAI…"
      submitDisabled={!grok.canManage || grok.busy || connected}
      disabledReason={
        grok.canManage ? undefined : "Only people who can manage connections can add an account."
      }
      footerStart={footerStart}
      onSubmit={async () => {
        if (signingIn && grok.pending) {
          window.open(grok.pending.verificationUri, "_blank", "noopener,noreferrer");
          return false;
        }
        await grok.connect(scope, {
          onConnected: (accountId) => {
            if (!active.current) return;
            setConnected(true);
            if (accountId) places.openAccount(accountId);
            else places.backToList();
          },
        });
        return false;
      }}
    >
      <FieldStack>
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
        {grok.pending ? (
          <SuperGrokDeviceCodePanel
            userCode={grok.pending.userCode}
            verificationUri={grok.pending.verificationUri}
          />
        ) : (
          <p className="text-sm text-fg-muted">
            xAI opens in a new tab and asks for a code, which shows here. OpenGeni never sees your
            password.
          </p>
        )}
        {signingIn || connected ? (
          <p
            role="status"
            className="flex min-w-0 items-center gap-2 rounded-[10px] bg-surface-2 px-3 py-2.5 text-sm text-fg-muted"
          >
            {connected ? (
              <>
                <CircleCheckIcon aria-hidden="true" className="size-4 shrink-0 text-status-idle" />
                Connected
              </>
            ) : (
              <>
                <LoaderCircleIcon
                  aria-hidden="true"
                  className="size-4 shrink-0 text-fg-subtle motion-safe:animate-spin"
                />
                Waiting for you to sign in…
              </>
            )}
          </p>
        ) : null}
      </FieldStack>
    </ModelsFormPage>
  );
}
