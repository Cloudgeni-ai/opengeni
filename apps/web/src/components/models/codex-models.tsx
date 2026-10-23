import type { CodexAccount } from "@opengeni/sdk";
import { ModelSettingsPlaceholder } from "@opengeni/react/app/components/models/model-settings-placeholder";
import {
  EnableAccountRow,
  SubscriptionAccountRow,
} from "@/components/models/subscription-account-ui";
import { CheckIcon, CopyIcon, PencilIcon, UnplugIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { useAppContext } from "@opengeni/react/app/app-context";
import {
  CodexDeviceCodePanel,
  CodexRedemptionDialog,
  ResetCreditInventory,
  codexAccountName,
  codexUsageReadings,
  hasResetInventory,
  planLabel,
  planReportsNoResets,
  useCodexSubscriptions,
  type CodexSubscriptions,
} from "@/components/codex-connection";
import {
  ConnectionAccessFormPage,
  ConnectionAccessRows,
  useConnectionAccess,
} from "@/components/connection-access-settings";
import {
  ModelsFormPage,
  ProviderTile,
  accountReachLabel,
  RenameAccountDialog,
  resetsLabel,
  type ModelsScopeLabels,
  useModelsListLabel,
} from "@opengeni/react/app/components/models/models-ui";
import type { OrganizationCodexSubscriptions } from "@/components/organization-codex-subscriptions";
import { MoreMenu, RowButton } from "@opengeni/react/ui/page-actions";
import { DeviceSignInStatus } from "@/components/subscription-device-code-panel";
import { Button } from "@opengeni/react/ui/button";
import { copyText } from "@opengeni/react/ui/copy-field";
import { DestructiveConfirm } from "@opengeni/react/app/components/ui/destructive-confirm";
import { DetailPage, DetailPageBody, DetailPageHeader } from "@opengeni/react/ui/detail-page";
import { DetailSection, DetailSkeleton } from "@opengeni/react/ui/detail-sheet";
import { DropdownMenuItem } from "@opengeni/react/ui/dropdown-menu";
import { EmptyState } from "@opengeni/react/ui/empty-state";
import { ErrorMessage } from "@opengeni/react/ui/error-message";
import { FieldStack } from "@opengeni/react/ui/field";
import { ListRow, ListRowSkeleton, RowList, type RowListColumn } from "@opengeni/react/ui/list-row";
import { AccountGroupRows, groupEntry } from "./account-fold";
import { Notice } from "@opengeni/react/ui/notice";
import { formatAbsoluteTime, RelativeTime } from "@opengeni/react/ui/relative-time";
import { SegmentedControl } from "@opengeni/react/ui/segmented-control";
import {
  SettingDangerRow,
  SettingNavRow,
  SettingRow,
  SettingRowGroup,
} from "@opengeni/react/ui/setting-row";
import { StatusBadge, type ProductStatus } from "@opengeni/react/ui/status-badge";
import { Switch } from "@opengeni/react/ui/switch";
import { UsageMeterGroup, UsageReadout, usageResets } from "@opengeni/react/ui/usage-meter";
import { CODEX_EXTRA_CREDITS_DESCRIPTION, CodexCreditBalance } from "./codex-account-usage";
import { FLUSH_DETAIL_PAGE_CLASS } from "@opengeni/react/ui/flush-form-page";

/* ----------------------------------------------------------------------------
   Codex on Settings > Models: the provider group (header with the pool-wide
   choices, one row per account), each account's own page, and the Connect
   page. All data and mutations come from useCodexSubscriptions.
   -------------------------------------------------------------------------- */

/** The one fact column account rows line up in: the usage readout, against the chevron. */
export const ACCOUNT_COLUMNS: RowListColumn[] = [
  { id: "usage", label: "Usage", width: 200, hideLabel: true, align: "end", leadsWhenFolded: true },
];

export interface CodexPlaces {
  personal?: boolean;
  /** The workspace's name, for sentences like "stops paying for new work in Local". */
  workspaceName: string;
  /** The organization's name, or "your organization" when it has none. */
  organizationName: string;
  /** Who each account is for: "Everyone in Acme", "This workspace only". */
  scope: ModelsScopeLabels;
  openAccount: (accountId: string) => void;
  openConnect: () => void;
  openAccess: (accountId: string) => void;
  sharePersonal?: ((accountId: string) => void) | undefined;
  backToList: () => void;
}

/**
 * The organization's own Codex accounts, for people who manage them: the rows
 * show every one of them, in use here or not, and open their organization page.
 */
export interface OrganizationCodexPool {
  codex: OrganizationCodexSubscriptions;
  workspace: { id: string; personal: boolean };
  /** A workspace's name in the organization, for an account's tag. */
  workspaceName: (workspaceId: string) => string | undefined;
  openAccount: (accountId: string) => void;
}

function needsReconnect(account: CodexAccount): boolean {
  return account.status !== "active";
}

function limitReached(account: CodexAccount, now: number): boolean {
  return Boolean(account.exhaustedUntil && new Date(account.exhaustedUntil).getTime() > now);
}

/** A state that needs attention, in the one status language. A healthy account has none. */
function attentionStatus(account: CodexAccount, now: number): ProductStatus | null {
  if (needsReconnect(account)) return "needs_reconnect";
  if (!account.allocatorEnabled) return "disabled";
  if (limitReached(account, now)) return "out_of_usage";
  return null;
}

/** This account belongs to this workspace, and the viewer may change it. */
function editable(codex: CodexSubscriptions, account: CodexAccount): boolean {
  return codex.canManage && codex.workspaceManaged && account.source !== "organization";
}

/* ----------------------------------------------------------------------------
   On the Models list: the account rows (in the one Accounts list) and the
   Codex section's setting rows.
   -------------------------------------------------------------------------- */

/** How many rows Codex adds to the Accounts list once loaded. */
export function codexListedCount(codex: CodexSubscriptions): number {
  if (codex.loading) return 0;
  if (codex.loadError || codex.sourceDisabled) return 1;
  return codex.accounts.length + (codex.pending ? 1 : 0);
}

/**
 * Codex's rows in the Accounts list: every account that reaches this
 * workspace, its own and the organization's, each once. For people who manage
 * the organization's accounts, an organization account's tag says who else it
 * reaches, and the row opens its organization page.
 */
export function CodexAccountRows({
  codex,
  places,
  organization = null,
}: {
  codex: CodexSubscriptions;
  places: CodexPlaces;
  organization?: OrganizationCodexPool | null;
}) {
  if (codex.loading) return <ListRowSkeleton count={1} />;
  if (codex.loadError) {
    return (
      <li className="col-span-full list-none px-3 py-3">
        <ErrorMessage
          variant="inline"
          title="Couldn't load Codex accounts."
          action={<RowButton onClick={() => void codex.refreshAccounts()}>Try again</RowButton>}
        >
          {codex.loadError}
        </ErrorMessage>
      </li>
    );
  }
  if (codex.sourceDisabled) {
    return (
      <ListRow
        leading={<ProviderTile provider="codex" size="lg" />}
        title="Codex"
        meta={["Off in this workspace", "Accounts stay connected"]}
      />
    );
  }
  const organizationAccounts =
    organization && !organization.codex.loading && !organization.codex.loadError
      ? new Map(organization.codex.accounts.map((account) => [account.id, account]))
      : null;
  // Every account here, in use first; ones turned off fold away once there
  // are several, as on the organization's list.
  const entries = codex.accounts.map((account) => {
    const shared = account.source === "organization";
    const listed = organizationAccounts?.get(account.id);
    // Until the organization's list says who else an account reaches, its
    // tag waits in place rather than changing under the reader.
    const scopeLabel =
      !shared || !organization ? undefined : listed?.reach ? (
        accountReachLabel(places.scope, listed.reach, organization.workspaceName)
      ) : organization.codex.loading ? (
        <ModelSettingsPlaceholder />
      ) : undefined;
    return groupEntry(
      account.id,
      account,
      <CodexRow
        codex={codex}
        account={account}
        places={places}
        scopeLabel={scopeLabel}
        onOpen={() =>
          shared && organization && listed
            ? organization.openAccount(account.id)
            : places.openAccount(account.id)
        }
      />,
    );
  });
  return (
    <>
      <AccountGroupRows title="Codex" entries={entries} />
      {codex.pending ? (
        <ListRow
          leading={<ProviderTile provider="codex" size="lg" />}
          title="Signing in to ChatGPT…"
          meta={["Finish signing in to add the account"]}
          indicator="open"
          onOpen={places.openConnect}
        />
      ) : null}
    </>
  );
}

/** Codex shows its own section once there is something to set. */
export function codexSectionVisible(codex: CodexSubscriptions): boolean {
  if (codex.loading || codex.loadError) return false;
  return (
    codex.sourceDisabled ||
    codex.accounts.length > 0 ||
    Boolean(codex.source?.organizationAvailable)
  );
}

/**
 * The Codex section: how several accounts share work, keeping chats portable,
 * and Turn off Codex last. Which pool new work uses is not a setting here; the
 * line above the Accounts list says it.
 */
export function CodexSettingRows({
  codex,
  places,
  providerSwitch,
  organizationSharing = null,
  onConnectForWorkspace,
  showRotation = true,
}: {
  codex: CodexSubscriptions;
  places: CodexPlaces;
  /** The "Keep Codex chats portable" row. */
  providerSwitch: ReactNode;
  /** How the organization's accounts share work, for the people who manage them. */
  organizationSharing?: ReactNode;
  /** Opens Connect Codex for an account owned by this workspace (Codex Apps needs one). */
  onConnectForWorkspace?: (() => void) | undefined;
  /** The shared account-rules section owns rotation after core settings load. */
  showRotation?: boolean;
}) {
  const [turningOff, setTurningOff] = useState(false);
  const { accounts } = codex;
  if (codex.sourceDisabled) {
    return (
      <SettingRowGroup>
        <SettingRow
          label="Codex is off in this workspace"
          description="New chats and schedules here can't use Codex models. Accounts stay connected."
          control={
            codex.canManage ? (
              <RowButton
                disabled={codex.busy}
                onClick={() =>
                  void codex.setSourceMode("automatic", `Codex is on in ${places.workspaceName}`)
                }
              >
                Turn on Codex
              </RowButton>
            ) : null
          }
        />
      </SettingRowGroup>
    );
  }
  // Only the pool in use matters, and only this workspace's own pool is set here.
  const showPick =
    showRotation && codex.canManage && codex.workspaceManaged && accounts.length >= 2;
  return (
    <>
      <SettingRowGroup>
        {organizationSharing}
        {showPick ? (
          <SettingRow
            label="Spreading work across this workspace's accounts"
            description="Spread work starts new chats evenly across accounts that can serve them. Primary first starts new chats on the primary account and uses another account when it can't serve them."
            controlWidth="auto"
            control={
              <SegmentedControl<"spread" | "primary">
                size="sm"
                pending={codex.working === "rotation"}
                disabled={codex.busy && codex.working !== "rotation"}
                value={codex.rotationEnabled ? "spread" : "primary"}
                onValueChange={(value) =>
                  void codex.setRotation({ rotationEnabled: value === "spread" })
                }
                options={[
                  { value: "spread", label: "Spread work" },
                  { value: "primary", label: "Primary first" },
                ]}
              />
            }
          />
        ) : null}
        <CodexAppsRow codex={codex} places={places} onConnectForWorkspace={onConnectForWorkspace} />
        {providerSwitch}
        {codex.canManage ? (
          <SettingDangerRow
            label="Turn off Codex"
            description="New chats and schedules here stop using Codex models. Accounts stay connected."
            disabled={codex.busy}
            onClick={() => setTurningOff(true)}
          />
        ) : null}
      </SettingRowGroup>
      <DestructiveConfirm
        open={turningOff}
        onOpenChange={setTurningOff}
        title={`Turn off Codex in ${places.workspaceName}?`}
        consequences={[
          "New chats and schedules here can't use Codex models.",
          "Work already running finishes first.",
          "Accounts stay connected. Turn Codex back on any time.",
        ]}
        confirmLabel="Turn off Codex"
        pendingLabel="Turning off…"
        onConfirm={async () => {
          const done = await codex.setSourceMode(
            "disabled",
            `Codex is off in ${places.workspaceName}`,
          );
          if (!done) throw new Error("Couldn't turn off Codex. Nothing was changed.");
        }}
      />
    </>
  );
}

/**
 * Codex Apps: agents use the ChatGPT apps of one account, which must be owned
 * by this workspace (an organization account can't be designated). The row
 * says which account does it, or how to turn it on: from one of this
 * workspace's accounts, or by connecting one for this workspace.
 */
function CodexAppsRow({
  codex,
  places,
  onConnectForWorkspace,
}: {
  codex: CodexSubscriptions;
  places: CodexPlaces;
  onConnectForWorkspace?: (() => void) | undefined;
}) {
  const apps = codex.data?.apps;
  if (!apps?.available || !codex.canManage) return null;
  const own = codex.accounts.filter((account) => account.source !== "organization");
  const designated = apps.credentialId
    ? (own.find((account) => account.id === apps.credentialId) ?? null)
    : null;
  const description =
    "Let agents use the ChatGPT apps connected to one account. It must be an account owned by this workspace.";
  if (designated) {
    return (
      <SettingNavRow
        label="Codex Apps"
        description={description}
        value={codexAccountName(designated)}
        onOpen={() => places.openAccount(designated.id)}
      />
    );
  }
  if (apps.credentialId) {
    return <SettingRow label="Codex Apps" description={`${description} On.`} />;
  }
  if (own.length > 0) {
    const only = own.length === 1 ? own[0]! : null;
    return only ? (
      <SettingNavRow
        label="Codex Apps"
        description={`${description} Turn it on from ${codexAccountName(only)}.`}
        value="Off"
        onOpen={() => places.openAccount(only.id)}
      />
    ) : (
      <SettingRow
        label="Codex Apps"
        description={`${description} Turn it on from one of this workspace's accounts above.`}
      />
    );
  }
  return (
    <SettingRow
      label="Codex Apps"
      description="Let agents use the ChatGPT apps connected to an account. Codex Apps need a ChatGPT account owned by this workspace."
      control={
        onConnectForWorkspace ? (
          <RowButton onClick={onConnectForWorkspace}>Connect for this workspace</RowButton>
        ) : null
      }
    />
  );
}

function CodexRow({
  codex,
  account,
  places,
  scopeLabel,
  onOpen,
}: {
  codex: CodexSubscriptions;
  account: CodexAccount;
  places: CodexPlaces;
  /** Overrides the tag, for an organization account whose "Available in" is known. */
  scopeLabel?: ReactNode;
  onOpen: () => void;
}) {
  const live = codex.usageMap[account.id];
  const readings = codexUsageReadings(live?.usage, codex.now);
  const weekly = readings[0]!;
  const status = attentionStatus(account, codex.now);
  const primary = codex.accounts.length > 1 && account.id === codex.activeAccountId;
  const resets = codex.overviewMap[account.id]?.resetCredits.availableCount;
  const loadingUsage = codex.refreshingUsage && !live;
  const organizationAccount = account.source === "organization";
  useConnectionAccess({
    client: codex.client,
    workspaceId: codex.workspaceId,
    kind: "codex",
    connectionId: account.id,
    enabled: !organizationAccount && !places.personal && codex.canManage,
  });
  return (
    <SubscriptionAccountRow
      provider="codex"
      title={codexAccountName(account)}
      email={account.email}
      primary={primary}
      meta={[
        scopeLabel ?? (organizationAccount ? places.scope.organization : places.scope.workspace),
        planLabel(account.plan, "ChatGPT"),
        account.appsDesignated ? "Codex Apps" : null,
        // An organization account's resets are redeemed on its page in Organization settings.
        resetsLabel(resets ?? account.resetCreditAvailableCount),
      ]}
      cells={{
        usage:
          status === "needs_reconnect" ? null : status === "disabled" ? (
            <StatusBadge status="disabled" variant="dot" />
          ) : status === "out_of_usage" ? (
            <span className="text-xs font-medium text-danger">Out of usage</span>
          ) : (
            <UsageReadout
              percent={loadingUsage ? null : weekly.percent}
              loading={loadingUsage}
              window="this week"
              resets={usageResets(readings, weekly.label)}
              fallback={
                live?.status === "error" || (!live && codex.usageError)
                  ? "Usage unavailable"
                  : "No usage yet"
              }
            />
          ),
      }}
      indicator={needsReconnect(account) ? { kind: "attention", label: "Needs reconnect" } : "open"}
      onOpen={onOpen}
    />
  );
}

/* ----------------------------------------------------------------------------
   The account page.
   -------------------------------------------------------------------------- */

export function CodexAccountPage({
  codex,
  accountId,
  places,
}: {
  codex: CodexSubscriptions;
  accountId: string;
  places: CodexPlaces;
}) {
  const listLabel = useModelsListLabel();
  const account = codex.accounts.find((candidate) => candidate.id === accountId) ?? null;
  const back = { label: listLabel, onClick: places.backToList };
  if (codex.loading) {
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
          description={
            codex.loadError
              ? "Couldn't load Codex accounts. Go back and try again."
              : "It may have been disconnected, or new work here uses another source now."
          }
          action={<RowButton onClick={places.backToList}>Back to Models</RowButton>}
        />
      </DetailPage>
    );
  }
  return <CodexAccountDetail codex={codex} account={account} places={places} />;
}

function CodexAccountDetail({
  codex,
  account,
  places,
}: {
  codex: CodexSubscriptions;
  account: CodexAccount;
  places: CodexPlaces;
}) {
  const listLabel = useModelsListLabel();
  const [renaming, setRenaming] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const name = codexAccountName(account);
  const canEdit = editable(codex, account);
  const organizationAccount = account.source === "organization";
  const status = attentionStatus(account, codex.now);
  const access = useConnectionAccess({
    client: codex.client,
    workspaceId: codex.workspaceId,
    kind: "codex",
    connectionId: account.id,
    enabled: !organizationAccount && !places.personal,
  });
  const overview = codex.overviewMap[account.id];
  const attempts = codex.redemptionAttempts(account.id);
  const others = codex.accounts.filter(
    (candidate) =>
      candidate.id !== account.id && candidate.allocatorEnabled && !needsReconnect(candidate),
  );
  const resetCount = overview?.resetCredits.availableCount ?? 0;

  const chatgptAccountId = account.chatgptAccountId;
  // ⋯ holds Rename, the ChatGPT account ID (the one technical fact) and Disconnect.
  const menuItems = [
    canEdit ? (
      <DropdownMenuItem key="rename" onSelect={() => setRenaming(true)}>
        <PencilIcon />
        Rename
      </DropdownMenuItem>
    ) : null,
    chatgptAccountId ? (
      <DropdownMenuItem
        key="copy-id"
        onSelect={() =>
          void copyText(chatgptAccountId).then((copied) =>
            copied
              ? toast.success("ChatGPT account ID copied")
              : toast.error("Couldn't copy the account ID", { description: chatgptAccountId }),
          )
        }
      >
        <CopyIcon />
        Copy account ID
      </DropdownMenuItem>
    ) : null,
    canEdit ? (
      <DropdownMenuItem
        key="disconnect"
        variant="destructive"
        onSelect={() => setDisconnecting(true)}
      >
        <UnplugIcon />
        Disconnect
      </DropdownMenuItem>
    ) : null,
  ].filter(Boolean);
  const actions =
    menuItems.length > 0 ? (
      <MoreMenu label={`More actions for ${name}`}>{menuItems}</MoreMenu>
    ) : null;

  return (
    <DetailPage
      back={{ label: listLabel, onClick: places.backToList }}
      className={FLUSH_DETAIL_PAGE_CLASS}
    >
      <DetailPageHeader
        leading={<ProviderTile provider="codex" />}
        title={name}
        chips={status ? <StatusBadge status={status} variant="outline" /> : null}
        meta={[
          planLabel(account.plan, "ChatGPT"),
          // A custom name hides the sign-in, so the email stays findable.
          account.email && account.email !== name ? account.email : null,
          organizationAccount ? places.scope.organization : places.scope.workspace,
        ]}
        actions={actions}
      />
      <DetailPageBody>
        {organizationAccount ? (
          <ManagedNote>{`Managed by the owners and admins of ${places.organizationName}.`}</ManagedNote>
        ) : !organizationAccount && !codex.canManage ? (
          <ManagedNote>Only people who can manage connections can change this account.</ManagedNote>
        ) : null}
        {needsReconnect(account) ? (
          <DetailSection>
            <Notice
              tone="waiting"
              title="Sign in to ChatGPT again"
              action={
                canEdit ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="default"
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
        {account.planExcludedModels?.length ? (
          <DetailSection>
            <Notice tone="waiting" title="Not included in this plan">
              {`${account.planExcludedModels.map((entry) => entry.label).join(", ")} ${
                account.planExcludedModels.length === 1 ? "isn't" : "aren't"
              } included in this account's current plan, so Opengeni skips this account for ${
                account.planExcludedModels.length === 1 ? "that model" : "those models"
              } until ${formatAbsoluteTime(
                new Date(
                  Math.min(
                    ...account.planExcludedModels.map((entry) =>
                      new Date(entry.retryAfter).getTime(),
                    ),
                  ),
                ),
                { now: codex.now },
              )}, or sooner once a plan change is seen. Check usage after upgrading.`}
            </Notice>
          </DetailSection>
        ) : null}
        <DetailSection title="Usage">
          <CodexUsage codex={codex} account={account} />
        </DetailSection>
        {canEdit ? (
          <DetailSection title="Settings">
            <SettingRowGroup className="-my-3">
              <EnableAccountRow
                name={name}
                checked={account.allocatorEnabled}
                pending={codex.working === `allocator:${account.id}`}
                disabled={codex.busy}
                onCheckedChange={(next) => void codex.setAllocator(account, next)}
              />
              <SettingRow
                label="Use extra credits"
                description={CODEX_EXTRA_CREDITS_DESCRIPTION}
                control={
                  <Switch
                    aria-label={`Use extra credits on ${name}`}
                    checked={account.extraCreditsEnabled ?? false}
                    pending={codex.working === `extra-credits:${account.id}`}
                    disabled={codex.busy}
                    onCheckedChange={(next) => void codex.setExtraCredits(account, next)}
                  />
                }
              />
              {codex.accounts.length > 1 ? (
                <SettingRow
                  label="Primary account"
                  description="New chats start here when work isn’t spread across accounts."
                  control={
                    account.id === codex.activeAccountId ? (
                      <span className="inline-flex h-8 items-center gap-1.5 text-sm font-medium text-fg-muted">
                        <CheckIcon aria-hidden="true" className="size-4 text-status-idle" />
                        Primary
                      </span>
                    ) : (
                      <RowButton
                        disabled={codex.busy || needsReconnect(account)}
                        onClick={() => void codex.activate(account)}
                      >
                        Make primary
                      </RowButton>
                    )
                  }
                />
              ) : null}
              {codex.data?.apps?.available ? (
                <SettingRow
                  label="Codex Apps"
                  description="Let agents use the ChatGPT apps connected to this account. Only one account per workspace, separate from which account pays."
                  control={
                    <Switch
                      aria-label={`Use ${name} for Codex Apps`}
                      checked={account.appsDesignated}
                      pending={codex.working === `apps:${account.id}`}
                      disabled={
                        codex.busy ||
                        (account.appsDesignated
                          ? !codex.data.apps.canDisable
                          : !account.canEnableApps)
                      }
                      disabledReason={
                        account.appsDesignated
                          ? codex.data.apps.canDisable
                            ? undefined
                            : "Only people who can manage connections, signed in here, can turn this off."
                          : account.canEnableApps
                            ? undefined
                            : "Only the person who connected this account can turn this on."
                      }
                      onCheckedChange={(next) => void codex.setAppsCredential(account, next)}
                    />
                  }
                />
              ) : null}
              {!places.personal ? (
                <ConnectionAccessRows
                  access={access}
                  organization={false}
                  canManage={codex.canManage}
                  onEdit={() => places.openAccess(account.id)}
                />
              ) : null}
              {places.sharePersonal ? (
                <SettingRow
                  label="Share with your organization"
                  description="Choose which workspaces can use this account."
                  control={
                    <RowButton
                      disabled={codex.busy}
                      onClick={() => places.sharePersonal?.(account.id)}
                    >
                      Share account
                    </RowButton>
                  }
                />
              ) : null}
            </SettingRowGroup>
          </DetailSection>
        ) : null}
        {!organizationAccount && !planReportsNoResets(overview, attempts) ? (
          <DetailSection
            title={resetCount > 0 ? `Usage limit resets (${resetCount})` : "Usage limit resets"}
          >
            {!overview ? (
              <SettingRow
                label={
                  codex.usageError ? (
                    "Couldn't check usage limit resets."
                  ) : (
                    <ModelSettingsPlaceholder />
                  )
                }
                control={
                  codex.usageError ? (
                    <RowButton
                      variant="ghost"
                      onClick={() => void codex.refreshAccountUsage(account.id)}
                    >
                      Try again
                    </RowButton>
                  ) : null
                }
              />
            ) : !hasResetInventory(overview, attempts) ? (
              <SettingRow label="No usage limit resets available" />
            ) : (
              <ResetCreditInventory
                overview={overview}
                busy={codex.busy || codex.preparingReset != null}
                recoveryAttempts={attempts}
                onRedeem={(credit, recovery) =>
                  void codex.beginRedemption(account.id, credit, recovery)
                }
                onReconnectSameAccount={places.openConnect}
              />
            )}
          </DetailSection>
        ) : null}
      </DetailPageBody>
      <CodexRedemptionDialog codex={codex} />
      <RenameAccountDialog
        open={renaming}
        onOpenChange={setRenaming}
        name={name}
        label={account.label}
        provider="ChatGPT"
        onSave={(label) => codex.rename(account, label)}
      />
      <DestructiveConfirm
        open={disconnecting}
        onOpenChange={setDisconnecting}
        title={`Disconnect ${name}?`}
        consequences={[
          `${name} stops paying for new work in ${places.workspaceName}.`,
          others.length > 0
            ? `New work moves to ${others.map(codexAccountName).join(" and ")}.`
            : "New Codex work waits until you connect another account.",
          "Work already running finishes first.",
          ...(resetCount > 0
            ? [
                `Its ${resetCount} usage limit ${resetCount === 1 ? "reset" : "resets"} can't be redeemed after this.`,
              ]
            : []),
        ]}
        confirmLabel="Disconnect"
        pendingLabel="Disconnecting…"
        onConfirm={async () => {
          await codex.disconnect(account);
          places.backToList();
        }}
      />
    </DetailPage>
  );
}

export function CodexUsage({
  codex,
  account,
}: {
  codex: CodexSubscriptions;
  account: CodexAccount;
}) {
  const live = codex.usageMap[account.id];
  const credits = live?.usage?.credits;
  const overview = codex.overviewMap[account.id];
  const readings = codexUsageReadings(live?.usage, codex.now);
  const fetchedAt = overview?.usage.fetchedAt ?? live?.usage?.fetchedAt ?? null;
  const provenance = overview
    ? `${overview.usage.source === "provider" ? "Reported by ChatGPT" : "Saved by Opengeni"}${overview.usage.stale ? ", may be out of date" : ""}`
    : undefined;
  const error =
    !codex.refreshingUsage && (live?.status === "error" || (!live && codex.usageError))
      ? "Couldn't check usage. Try again in a moment."
      : !codex.refreshingUsage && live && readings.every((reading) => reading.percent === null)
        ? "ChatGPT hasn't reported usage for this account yet."
        : undefined;
  return (
    <>
      <UsageMeterGroup
        windows={readings}
        loading={codex.refreshingUsage && !live}
        checked={
          fetchedAt ? (
            <span title={provenance}>
              <RelativeTime date={fetchedAt} prefix="Checked" now={codex.now} />
              {overview?.usage.stale ? " · may be out of date" : null}
            </span>
          ) : codex.refreshingUsage ? (
            "Checking…"
          ) : (
            "Not checked yet"
          )
        }
        error={error}
        refreshing={codex.refreshingRow === account.id}
        refreshDisabledReason={
          needsReconnect(account) ? "Sign in to ChatGPT again to check usage." : undefined
        }
        onRefresh={codex.canManage ? () => void codex.refreshAccountUsage(account.id) : undefined}
      />
      <CodexCreditBalance credits={credits} loading={codex.refreshingUsage && !live} />
    </>
  );
}

/** The one muted sentence on a read-only account: who can change it. */
function ManagedNote({ children }: { children: ReactNode }) {
  return <p className="m-0 pt-2 pb-6 text-sm leading-5 text-fg-muted">{children}</p>;
}

/** "Models <name> can serve", from the account page. */
export function CodexAccessPage({
  codex,
  accountId,
  onClose,
}: {
  codex: CodexSubscriptions;
  accountId: string;
  onClose: () => void;
}) {
  const account = codex.accounts.find((candidate) => candidate.id === accountId);
  const access = useConnectionAccess({
    client: codex.client,
    workspaceId: codex.workspaceId,
    kind: "codex",
    connectionId: accountId,
  });
  return (
    <ConnectionAccessFormPage
      access={access}
      organization={false}
      canManage={Boolean(account && editable(codex, account))}
      name={account ? codexAccountName(account) : "this account"}
      onClose={onClose}
    />
  );
}

/* ----------------------------------------------------------------------------
   Connect.
   -------------------------------------------------------------------------- */

export function CodexConnectPage({
  codex,
  places,
  onClose,
  footerStart,
  fields,
  blockedReason,
}: {
  codex: CodexSubscriptions;
  places: CodexPlaces;
  onClose: () => void;
  footerStart?: ReactNode;
  /** Fields above the sign-in, such as which workspaces can use the account. */
  fields?: ReactNode;
  /** Why the sign-in can't start yet (a choice above is incomplete). */
  blockedReason?: string | null;
}) {
  const [connected, setConnected] = useState(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const signingIn = Boolean(codex.pending);

  return (
    <ModelsFormPage
      title="Connect Codex"
      description="Sign in with the ChatGPT account whose plan should pay for new work."
      onClose={onClose}
      submitLabel="Sign in with ChatGPT"
      pendingLabel="Opening ChatGPT…"
      // While the code waits, the step holds its own actions.
      footer={signingIn || connected ? false : undefined}
      submitDisabled={!codex.canManage || codex.busy || connected || Boolean(blockedReason)}
      disabledReason={
        codex.canManage
          ? (blockedReason ?? undefined)
          : "Only people who can manage connections can add an account."
      }
      footerStart={footerStart}
      onSubmit={async () => {
        if (signingIn) return false;
        await codex.connect({
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
        {fields}
        <DeviceSignInStatus
          provider="codex"
          connected={connected}
          panel={
            codex.pending ? (
              <CodexDeviceCodePanel
                userCode={codex.pending.userCode}
                verificationUri={codex.pending.verificationUri}
              />
            ) : null
          }
        />
      </FieldStack>
    </ModelsFormPage>
  );
}

/* ----------------------------------------------------------------------------
   Standalone: pick the Codex Apps account without leaving a conversation.
   -------------------------------------------------------------------------- */

export function CodexSubscriptionsCard({
  workspaceId,
  canManage,
}: {
  workspaceId: string;
  canManage: boolean;
}) {
  const client = useAppContext().client;
  const codex = useCodexSubscriptions({ client, workspaceId, canManage });
  const apps = codex.data?.apps;
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="min-w-0">
        <h3 className="text-sm leading-5 font-semibold text-fg">Codex Apps</h3>
        <p className="mt-1 text-xs leading-4.5 text-fg-muted">
          Choose the ChatGPT account whose apps agents can use in this workspace.
        </p>
      </div>
      {codex.loading ? (
        <RowList label="Codex accounts">
          <ListRowSkeleton count={1} />
        </RowList>
      ) : codex.loadError ? (
        <ErrorMessage
          title="Couldn't load Codex accounts."
          action={
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void codex.refreshAccounts()}
            >
              Try again
            </Button>
          }
        >
          {codex.loadError}
        </ErrorMessage>
      ) : codex.accounts.length > 0 ? (
        <RowList label="Codex accounts">
          {codex.accounts.map((account) => (
            <ListRow
              key={account.id}
              leading={<ProviderTile provider="codex" />}
              title={codexAccountName(account)}
              meta={[planLabel(account.plan, "ChatGPT")]}
              control={
                apps?.available ? (
                  <Switch
                    aria-label={`Use ${codexAccountName(account)} for Codex Apps`}
                    checked={account.appsDesignated}
                    pending={codex.working === `apps:${account.id}`}
                    disabled={
                      codex.busy ||
                      (account.appsDesignated ? !apps.canDisable : !account.canEnableApps)
                    }
                    disabledReason={
                      account.appsDesignated || account.canEnableApps
                        ? undefined
                        : "Only the person who connected this account can turn this on."
                    }
                    onCheckedChange={(next) => void codex.setAppsCredential(account, next)}
                  />
                ) : null
              }
            />
          ))}
        </RowList>
      ) : null}
      {codex.pending ? (
        <CodexDeviceCodePanel
          userCode={codex.pending.userCode}
          verificationUri={codex.pending.verificationUri}
        />
      ) : canManage && codex.workspaceManaged && !codex.loading && !codex.loadError ? (
        <div>
          <RowButton
            variant="default"
            data-analytics-action="connect_codex"
            disabled={codex.busy}
            onClick={() => void codex.connect()}
          >
            Connect {codex.accounts.length === 0 ? "a ChatGPT account" : "another ChatGPT account"}
          </RowButton>
        </div>
      ) : null}
    </div>
  );
}
