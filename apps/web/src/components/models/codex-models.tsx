import type { CodexAccount } from "@opengeni/sdk";
import {
  ArrowUpRightIcon,
  BuildingIcon,
  CheckIcon,
  CircleCheckIcon,
  FolderIcon,
  LoaderCircleIcon,
  LockIcon,
  PencilIcon,
  UnplugIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { useAppContext } from "@/context";
import {
  CodexDeviceCodePanel,
  CodexRedemptionDialog,
  ResetCreditInventory,
  codexAccountName,
  codexUsageReadings,
  hasResetInventory,
  planLabel,
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
  MoreMenu,
  ProviderTile,
  RenameAccountDialog,
  RowButton,
  resetsLabel,
} from "@/components/models/models-ui";
import { Button } from "@/components/ui/button";
import { ChoiceCard, ChoiceCards } from "@/components/ui/choice-cards";
import { CopyField } from "@/components/ui/copy-field";
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
import { ListRow, ListRowSkeleton, RowList, type RowListColumn } from "@/components/ui/list-row";
import { MetaChip } from "@/components/ui/meta-chip";
import { Notice } from "@/components/ui/notice";
import { RelativeTime } from "@/components/ui/relative-time";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SettingDangerRow, SettingRow, SettingRowGroup } from "@/components/ui/setting-row";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { UsageMeterGroup, UsageReadout } from "@/components/ui/usage-meter";

/* ----------------------------------------------------------------------------
   Codex on Settings > Models: the provider group (header with the pool-wide
   choices, one row per account), each account's own page, and the Connect
   page. All data and mutations come from useCodexSubscriptions.
   -------------------------------------------------------------------------- */

/** The one fact column account rows line up in: the usage readout, against the chevron. */
export const ACCOUNT_COLUMNS: RowListColumn[] = [
  { id: "usage", label: "Usage", width: 200, hideLabel: true, align: "end" },
];

export interface CodexPlaces {
  /** The workspace's name, for sentences like "stops paying for new work in Local". */
  workspaceName: string;
  /** The organization's name, for "subscriptions from Acme". */
  organizationName: string;
  openAccount: (accountId: string) => void;
  openConnect: () => void;
  openAccess: (accountId: string) => void;
  backToList: () => void;
  /** Present for organization admins: opens the account in organization settings. */
  manageInOrganization?: ((accountId: string) => void) | undefined;
}

function needsReconnect(account: CodexAccount): boolean {
  return account.status !== "active";
}

function limitReached(account: CodexAccount, now: number): boolean {
  return Boolean(account.exhaustedUntil && new Date(account.exhaustedUntil).getTime() > now);
}

/** The account's state in the one status language. */
function accountStatus(
  account: CodexAccount,
  now: number,
): { status: "connected" | "paused" | "needs_reconnect"; label?: string; tone?: "neutral" } {
  if (needsReconnect(account)) return { status: "needs_reconnect" };
  if (!account.allocatorEnabled) return { status: "paused" };
  if (limitReached(account, now))
    return { status: "connected", label: "Limit reached", tone: "neutral" };
  return { status: "connected" };
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
  if (codex.loadError || codex.sourceDisabled || codex.pending) return 1;
  return codex.accounts.length;
}

/** Codex's rows in the Accounts list: one per account, or its error or sign-in row. */
export function CodexAccountRows({
  codex,
  places,
}: {
  codex: CodexSubscriptions;
  places: CodexPlaces;
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
  return (
    <>
      {codex.accounts.map((account) => (
        <CodexRow
          key={account.id}
          codex={codex}
          account={account}
          places={places}
          onOpen={() => places.openAccount(account.id)}
        />
      ))}
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
 * The Codex section: where subscriptions come from, how several accounts
 * share work, whether Codex chats may switch providers, and Turn off.
 * Each row has one control.
 */
export function CodexSettingRows({
  codex,
  places,
  providerSwitch,
}: {
  codex: CodexSubscriptions;
  places: CodexPlaces;
  /** The "Allow switching to other providers" row. */
  providerSwitch: ReactNode;
}) {
  const [turningOff, setTurningOff] = useState(false);
  const { source, accounts } = codex;
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
  const showSource = codex.canManage && Boolean(source?.organizationAvailable);
  const showPick = codex.canManage && codex.workspaceManaged && accounts.length >= 2;
  return (
    <>
      <SettingRowGroup>
        {showSource && source ? (
          <SettingRow
            label="Subscriptions from"
            description={`${places.organizationName} shares its Codex accounts with this workspace. New work uses theirs or the ones connected here, never both.`}
            controlWidth="auto"
            control={
              <SegmentedControl<"organization" | "workspace">
                size="sm"
                pending={codex.working === "source"}
                disabled={codex.busy && codex.working !== "source"}
                value={source.effectiveSource === "organization" ? "organization" : "workspace"}
                onValueChange={(value) =>
                  void codex.setSourceMode(
                    value,
                    value === "organization"
                      ? `New work in ${places.workspaceName} now uses subscriptions from ${places.organizationName}`
                      : `New work in ${places.workspaceName} now uses this workspace's accounts`,
                  )
                }
                options={[
                  { value: "organization", label: "Organization" },
                  { value: "workspace", label: "This workspace" },
                ]}
              />
            }
          />
        ) : !codex.canManage && source?.effectiveSource === "organization" ? (
          <SettingRow
            label="Subscriptions from"
            description={`New work here uses the Codex accounts ${places.organizationName} shares.`}
            control={<span className="text-sm text-fg-muted">{places.organizationName}</span>}
          />
        ) : null}
        {showPick ? (
          <SettingRow
            label="When several accounts are connected"
            description="Spread work sends new work to the account with the most room left. Primary only waits for the primary account."
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
                  { value: "primary", label: "Primary only" },
                ]}
              />
            }
          />
        ) : null}
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

function CodexRow({
  codex,
  account,
  places,
  onOpen,
}: {
  codex: CodexSubscriptions;
  account: CodexAccount;
  places: CodexPlaces;
  onOpen: () => void;
}) {
  const live = codex.usageMap[account.id];
  const weekly = codexUsageReadings(live?.usage, codex.now)[0]!;
  const status = accountStatus(account, codex.now);
  const primary = codex.accounts.length > 1 && account.id === codex.activeAccountId;
  const resets = codex.overviewMap[account.id]?.resetCredits.availableCount;
  const loadingUsage = codex.refreshingUsage && !live;
  const organizationAccount = account.source === "organization";
  return (
    <ListRow
      leading={<ProviderTile provider="codex" size="lg" />}
      title={codexAccountName(account)}
      titleAddon={primary ? <MetaChip variant="outline">Primary</MetaChip> : null}
      meta={[
        planLabel(account.plan, "ChatGPT"),
        organizationAccount ? `Shared by ${places.organizationName}` : null,
        account.appsDesignated ? "Codex Apps" : null,
        // Resets can only be redeemed on the account's own page, which org accounts don't have here.
        organizationAccount ? null : resetsLabel(resets),
      ]}
      cells={{
        usage: needsReconnect(account) ? null : status.status === "paused" ? (
          <StatusBadge status="paused" variant="dot" />
        ) : status.label === "Limit reached" ? (
          <span className="text-xs font-medium text-danger">Limit reached</span>
        ) : (
          <UsageReadout
            percent={loadingUsage ? null : weekly.percent}
            loading={loadingUsage}
            window="this week"
            resetsLabel={weekly.resetsLabel}
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
  const account = codex.accounts.find((candidate) => candidate.id === accountId) ?? null;
  const back = { label: "Models", onClick: places.backToList };
  if (codex.loading) {
    return (
      <DetailPage back={back} className={PAGE_CLASS}>
        <DetailSkeleton />
      </DetailPage>
    );
  }
  if (!account) {
    return (
      <DetailPage back={back} className={PAGE_CLASS}>
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

export const PAGE_CLASS = "max-w-none px-0 pt-0 pb-0 max-sm:px-0";

function CodexAccountDetail({
  codex,
  account,
  places,
}: {
  codex: CodexSubscriptions;
  account: CodexAccount;
  places: CodexPlaces;
}) {
  const [renaming, setRenaming] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const name = codexAccountName(account);
  const canEdit = editable(codex, account);
  const organizationAccount = account.source === "organization";
  const status = accountStatus(account, codex.now);
  const access = useConnectionAccess({
    client: codex.client,
    workspaceId: codex.workspaceId,
    kind: "codex",
    connectionId: account.id,
    enabled: !organizationAccount,
  });
  const overview = codex.overviewMap[account.id];
  const attempts = codex.redemptionAttempts(account.id);
  const others = codex.accounts.filter(
    (candidate) =>
      candidate.id !== account.id && candidate.allocatorEnabled && !needsReconnect(candidate),
  );
  const resetCount = overview?.resetCredits.availableCount ?? 0;

  const actions = organizationAccount ? (
    places.manageInOrganization ? (
      <RowButton onClick={() => places.manageInOrganization?.(account.id)}>
        Manage in organization settings
        <ArrowUpRightIcon aria-hidden="true" />
      </RowButton>
    ) : null
  ) : canEdit ? (
    <MoreMenu label={`More actions for ${name}`}>
      <DropdownMenuItem variant="destructive" onSelect={() => setDisconnecting(true)}>
        <UnplugIcon />
        Disconnect
      </DropdownMenuItem>
    </MoreMenu>
  ) : null;

  return (
    <DetailPage back={{ label: "Models", onClick: places.backToList }} className={PAGE_CLASS}>
      <DetailPageHeader
        leading={<ProviderTile provider="codex" />}
        title={name}
        chips={
          <>
            <StatusBadge status={status.status} tone={status.tone} variant="outline">
              {status.label}
            </StatusBadge>
            {organizationAccount ? <MetaChip variant="outline">Organization</MetaChip> : null}
          </>
        }
        meta={[
          planLabel(account.plan, "ChatGPT"),
          account.email && account.email !== name ? account.email : null,
          organizationAccount ? places.organizationName : "Workspace account",
        ]}
        actions={actions}
      />
      <DetailPageBody
        aside={
          <DetailAside label={`About ${name}`}>
            <DetailAsideItem
              label="Belongs to"
              icon={organizationAccount ? <BuildingIcon /> : <FolderIcon />}
            >
              {organizationAccount ? places.organizationName : places.workspaceName}
            </DetailAsideItem>
            <DetailAsideItem label="Plan">{planLabel(account.plan, "ChatGPT")}</DetailAsideItem>
            {account.chatgptAccountId ? (
              <DetailAsideItem label="ChatGPT account ID">
                <CopyField
                  value={account.chatgptAccountId}
                  label="ChatGPT account ID"
                  truncate="middle"
                />
              </DetailAsideItem>
            ) : null}
          </DetailAside>
        }
      >
        {organizationAccount ? (
          <ManagedNote>
            {`Shared by ${places.organizationName}. `}
            {places.manageInOrganization
              ? "Change it in organization settings."
              : "Only organization owners and admins can change it."}
          </ManagedNote>
        ) : !codex.canManage ? (
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
        <DetailSection title="Usage">
          <CodexUsage codex={codex} account={account} />
        </DetailSection>
        {canEdit ? (
          <DetailSection title="Settings">
            <SettingRowGroup className="-my-3">
              <SettingRow
                label="Use for new work"
                description="When off, this account isn't picked for new chats, schedules or chats pinned to it. Work already running continues."
                control={
                  <Switch
                    aria-label={`Use ${name} for new work`}
                    checked={account.allocatorEnabled}
                    pending={codex.working === `allocator:${account.id}`}
                    disabled={codex.busy}
                    onCheckedChange={(next) => void codex.setAllocator(account, next)}
                  />
                }
              />
              {codex.accounts.length > 1 ? (
                <SettingRow
                  label="Primary account"
                  description={
                    account.id === codex.activeAccountId
                      ? "New work starts here. With Primary only, it's the only account used."
                      : "Make this the account new work starts with."
                  }
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
              <SettingRow
                label="Name"
                description={account.label ? name : `${name} (from the ChatGPT sign-in)`}
                control={
                  <RowButton aria-label={`Rename ${name}`} onClick={() => setRenaming(true)}>
                    <PencilIcon aria-hidden="true" />
                    Rename
                  </RowButton>
                }
              />
              <ConnectionAccessRows
                access={access}
                organization={false}
                canManage={codex.canManage}
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
              {codex.accounts.length > 1 ? (
                <DetailFact label="Primary">
                  {account.id === codex.activeAccountId ? "Yes" : "No"}
                </DetailFact>
              ) : null}
              {codex.data?.apps?.available ? (
                <DetailFact label="Codex Apps">{account.appsDesignated ? "On" : "Off"}</DetailFact>
              ) : null}
            </DetailFacts>
          </DetailSection>
        )}
        {!organizationAccount && hasResetInventory(overview, attempts) ? (
          <DetailSection
            title={resetCount > 0 ? `Usage limit resets (${resetCount})` : "Usage limit resets"}
          >
            <ResetCreditInventory
              overview={overview}
              busy={codex.busy || codex.preparingReset != null}
              recoveryAttempts={attempts}
              onRedeem={(credit, recovery) =>
                void codex.beginRedemption(account.id, credit, recovery)
              }
              onReconnectSameAccount={places.openConnect}
            />
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

function CodexUsage({ codex, account }: { codex: CodexSubscriptions; account: CodexAccount }) {
  const live = codex.usageMap[account.id];
  const overview = codex.overviewMap[account.id];
  const readings = codexUsageReadings(live?.usage, codex.now);
  const fetchedAt = overview?.usage.fetchedAt ?? live?.usage?.fetchedAt ?? null;
  const provenance = overview
    ? `${overview.usage.source === "provider" ? "Reported by ChatGPT" : "Saved by OpenGeni"}${overview.usage.stale ? ", may be out of date" : ""}`
    : undefined;
  const error =
    !codex.refreshingUsage && (live?.status === "error" || (!live && codex.usageError))
      ? "Couldn't check usage. Try again in a moment."
      : !codex.refreshingUsage && live && readings.every((reading) => reading.percent === null)
        ? "ChatGPT hasn't reported usage for this account yet."
        : undefined;
  return (
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
  );
}

/** The one-line "who manages this" note on a read-only account. */
function ManagedNote({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 pt-2 pb-6 text-xs leading-4.5 text-fg-muted">
      <LockIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-fg-subtle" />
      <span className="min-w-0">{children}</span>
    </p>
  );
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

function Step({ number, title, children }: { number: number; title: string; children: ReactNode }) {
  return (
    <li className="flex min-w-0 gap-3">
      <span
        aria-hidden="true"
        className="grid size-6 shrink-0 place-items-center rounded-full border border-border bg-surface-2 text-xs font-medium text-fg-muted"
      >
        {number}
      </span>
      <div className="min-w-0 flex-1 pt-0.5">
        <p className="text-sm font-medium text-fg">{title}</p>
        {children}
      </div>
    </li>
  );
}

export function CodexConnectPage({
  codex,
  places,
  onClose,
  footerStart,
}: {
  codex: CodexSubscriptions;
  places: CodexPlaces;
  onClose: () => void;
  footerStart?: ReactNode;
}) {
  const source = codex.source;
  // Connecting while the organization's pool is in use asks which to use.
  const askSource = source?.effectiveSource === "organization";
  const [useFor, setUseFor] = useState<"workspace" | "organization" | "">("");
  const [useError, setUseError] = useState<string | null>(null);
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
      submitLabel={signingIn ? "Open ChatGPT again" : "Sign in with ChatGPT"}
      pendingLabel="Opening ChatGPT…"
      submitDisabled={!codex.canManage || codex.busy || connected}
      disabledReason={
        codex.canManage ? undefined : "Only people who can manage connections can add an account."
      }
      footerStart={footerStart}
      onSubmit={async () => {
        if (signingIn && codex.pending) {
          window.open(codex.pending.verificationUri, "_blank", "noopener,noreferrer");
          return false;
        }
        if (askSource && !useFor) {
          setUseError("Choose which subscriptions new work should use.");
          return false;
        }
        await codex.connect({
          useFor: useFor || undefined,
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
        {askSource ? (
          <ChoiceCards
            label="Use this account instead of the organization's subscriptions?"
            description={`New work in ${places.workspaceName} uses one or the other, never both.`}
            value={useFor}
            disabled={signingIn}
            onValueChange={(value) => {
              setUseFor(value as "workspace" | "organization");
              setUseError(null);
            }}
            error={useError}
          >
            <ChoiceCard
              value="workspace"
              title="Use this account"
              description={`New work here switches to this workspace's accounts and stops using subscriptions from ${places.organizationName}.`}
            />
            <ChoiceCard
              value="organization"
              title="Keep the organization's subscriptions"
              description="This account stays connected but isn't used until you switch."
            />
          </ChoiceCards>
        ) : null}
        <ol className="m-0 flex min-w-0 list-none flex-col gap-5 p-0">
          <Step number={1} title="Sign in with ChatGPT">
            <p className="mt-0.5 text-xs leading-4.5 text-fg-muted">
              ChatGPT opens in a new tab. OpenGeni never sees your password.
            </p>
          </Step>
          <Step number={2} title="Enter the code when ChatGPT asks for it">
            {codex.pending ? (
              <div className="mt-2">
                <CodexDeviceCodePanel
                  userCode={codex.pending.userCode}
                  verificationUri={codex.pending.verificationUri}
                />
              </div>
            ) : (
              <p className="mt-0.5 text-xs leading-4.5 text-fg-muted">
                The code shows here once you start.
              </p>
            )}
          </Step>
        </ol>
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
                <span className="min-w-0">
                  Waiting for you to sign in. You can leave this page; it keeps going for 15
                  minutes.
                </span>
              </>
            )}
          </p>
        ) : null}
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
