import type { CodexAccount } from "@opengeni/sdk";
import { SubscriptionAccountRow } from "./subscription-account-ui";
import { BuildingIcon, CheckIcon, CopyIcon, PencilIcon, UnplugIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

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
  NOT_IN_USE,
  ProviderTile,
  organizationReachLabel,
  RenameAccountDialog,
  resetsLabel,
  type ModelsScopeLabels,
  useModelsListLabel,
} from "@/components/models/models-ui";
import { reachesWorkspace } from "@/components/models/organization-codex-models";
import type { OrganizationCodexSubscriptions } from "@/components/organization-codex-subscriptions";
import { MoreMenu, RowButton } from "@/components/ui/page-actions";
import { DeviceSignInStatus } from "@/components/subscription-device-code-panel";
import { Button } from "@/components/ui/button";
import { ChoiceCard, ChoiceCards } from "@/components/ui/choice-cards";
import { copyText } from "@/components/ui/copy-field";
import { DestructiveConfirm } from "@/components/ui/destructive-confirm";
import { DetailPage, DetailPageBody, DetailPageHeader } from "@/components/ui/detail-page";
import { DetailSection, DetailSkeleton } from "@/components/ui/detail-sheet";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorMessage } from "@/components/ui/error-message";
import { FieldStack } from "@/components/ui/field";
import { ListRow, ListRowSkeleton, RowList, type RowListColumn } from "@/components/ui/list-row";
import { MetaChip } from "@/components/ui/meta-chip";
import { Notice } from "@/components/ui/notice";
import { formatAbsoluteTime, RelativeTime } from "@/components/ui/relative-time";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  SettingDangerRow,
  SettingNavRow,
  SettingRow,
  SettingRowGroup,
} from "@/components/ui/setting-row";
import { StatusBadge, type ProductStatus } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { UsageMeterGroup, UsageReadout } from "@/components/ui/usage-meter";
import { FLUSH_DETAIL_PAGE_CLASS } from "@/components/ui/flush-form-page";

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
  /** The organization's name, or "your organization" when it has none. */
  organizationName: string;
  /** Who each account is for: "Everyone in Acme", "This workspace only". */
  scope: ModelsScopeLabels;
  openAccount: (accountId: string) => void;
  openConnect: () => void;
  openAccess: (accountId: string) => void;
  backToList: () => void;
}

/**
 * The organization's own Codex accounts, for people who manage them: the rows
 * show every one of them, in use here or not, and open their organization page.
 */
export interface OrganizationCodexPool {
  codex: OrganizationCodexSubscriptions;
  workspace: { id: string; personal: boolean };
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
  if (!account.allocatorEnabled) return "paused";
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

/**
 * Which pool new work uses, and which accounts are set aside. A workspace
 * uses exactly one Codex pool, its own accounts or the organization's, never
 * both (docs/codex-subscription-rotation.md).
 */
function poolState(codex: CodexSubscriptions) {
  const source = codex.source;
  const inUse = source?.effectiveSource ?? "workspace";
  return {
    inUse,
    mode: source?.mode ?? "automatic",
    /** The organization shares accounts that new work here doesn't use. */
    organizationSetAside: inUse === "workspace" && Boolean(source?.organizationAvailable),
    /** This workspace has accounts that new work here doesn't use. */
    workspaceSetAside: inUse === "organization" && Boolean(source?.workspaceAvailable),
  };
}

/** How many rows Codex adds to the Accounts list once loaded. */
export function codexListedCount(
  codex: CodexSubscriptions,
  organization: OrganizationCodexPool | null = null,
): number {
  if (codex.loading) return 0;
  if (codex.loadError || codex.sourceDisabled) return 1;
  const pool = poolState(codex);
  const own = codex.accounts.filter((account) => account.source !== "organization").length;
  const shared = organization
    ? organization.codex.accounts.length
    : codex.accounts.length - own + (pool.organizationSetAside ? 1 : 0);
  return own + shared + (codex.pending ? 1 : 0) + (pool.workspaceSetAside ? 1 : 0);
}

/** The ⋯ item that keeps new work on the organization's accounts, when it would change something. */
function alwaysOrganizationItem(codex: CodexSubscriptions, places: CodexPlaces): ReactNode {
  const mode = codex.source?.mode;
  if (!codex.canManage || (mode !== "automatic" && mode !== "workspace")) return null;
  return (
    <DropdownMenuItem
      disabled={codex.busy}
      onSelect={() =>
        void codex.setSourceMode(
          "organization",
          `New work in ${places.workspaceName} now uses the organization's Codex accounts`,
        )
      }
    >
      <BuildingIcon />
      Always use the organization's accounts
    </DropdownMenuItem>
  );
}

/**
 * Codex's rows in the Accounts list: the accounts new work uses, then the
 * other pool's accounts, muted with "Not in use". People who manage the
 * organization's accounts see each of them, in use here or not; everyone else
 * sees the organization's accounts only while new work here uses them, and one
 * summary row while they are set aside.
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
  if (codex.loading || organization?.codex.loading) return <ListRowSkeleton count={1} />;
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
  const pool = poolState(codex);
  const alwaysOrganization = alwaysOrganizationItem(codex, places);
  const own = codex.accounts.filter((account) => account.source !== "organization");
  const sharedInUse = codex.accounts.filter((account) => account.source === "organization");
  const ownRows = own.map((account) => (
    <CodexRow
      key={account.id}
      codex={codex}
      account={account}
      places={places}
      onOpen={() => places.openAccount(account.id)}
    />
  ));
  const pendingRow = codex.pending ? (
    <ListRow
      leading={<ProviderTile provider="codex" size="lg" />}
      title="Signing in to ChatGPT…"
      meta={["Finish signing in to add the account"]}
      indicator="open"
      onOpen={places.openConnect}
    />
  ) : null;
  const workspaceSetAsideRow = pool.workspaceSetAside ? (
    <ListRow
      disabled
      leading={<ProviderTile provider="codex" size="lg" />}
      title="This workspace's Codex accounts"
      meta={[places.scope.workspace, "Set aside while the organization's are used"]}
      cells={{ usage: NOT_IN_USE }}
    />
  ) : null;

  if (codex.sourceDisabled) {
    return (
      <ListRow
        leading={<ProviderTile provider="codex" size="lg" />}
        title="Codex"
        meta={["Off in this workspace", "Accounts stay connected"]}
      />
    );
  }

  if (organization) {
    if (organization.codex.loadError) {
      return (
        <>
          {ownRows}
          <li className="col-span-full list-none px-3 py-3">
            <ErrorMessage
              variant="inline"
              title="Couldn't load the organization's Codex accounts."
              action={
                <RowButton onClick={() => void organization.codex.refresh()}>Try again</RowButton>
              }
            >
              {organization.codex.loadError}
            </ErrorMessage>
          </li>
        </>
      );
    }
    return (
      <>
        {organization.codex.accounts.map((account) => {
          const live = sharedInUse.find((candidate) => candidate.id === account.id);
          return live ? (
            <SharedCodexInUseRow
              key={account.id}
              codex={codex}
              account={live}
              places={places}
              organization={organization}
            />
          ) : (
            <SharedCodexSetAsideRow
              key={account.id}
              account={account}
              organization={organization}
              places={places}
              ownInUse={pool.organizationSetAside}
              menu={pool.organizationSetAside ? alwaysOrganization : null}
            />
          );
        })}
        {ownRows}
        {pendingRow}
        {workspaceSetAsideRow}
      </>
    );
  }

  return (
    <>
      {sharedInUse.map((account) => (
        <CodexRow
          key={account.id}
          codex={codex}
          account={account}
          places={places}
          onOpen={() => places.openAccount(account.id)}
        />
      ))}
      {ownRows}
      {pendingRow}
      {pool.organizationSetAside ? (
        <ListRow
          disabled
          leading={<ProviderTile provider="codex" size="lg" />}
          title="Shared Codex accounts"
          meta={[places.scope.organization, "Set aside while this workspace has its own"]}
          cells={{ usage: NOT_IN_USE }}
          menu={alwaysOrganization}
          menuLabel="More actions for the organization's Codex accounts"
        />
      ) : null}
      {workspaceSetAsideRow}
    </>
  );
}

/** An organization account new work here uses, tagged with where it's available. */
function SharedCodexInUseRow({
  codex,
  account,
  places,
  organization,
}: {
  codex: CodexSubscriptions;
  account: CodexAccount;
  places: CodexPlaces;
  organization: OrganizationCodexPool;
}) {
  const access = useConnectionAccess({
    client: organization.codex.client,
    organizationId: organization.codex.organizationId,
    kind: "codex",
    connectionId: account.id,
  });
  return (
    <CodexRow
      codex={codex}
      account={account}
      places={places}
      scopeLabel={organizationReachLabel(places.scope, access.data)}
      onOpen={() => organization.openAccount(account.id)}
    />
  );
}

/**
 * An organization account new work here doesn't use, with the plain reason:
 * this workspace has its own accounts, or the account isn't available here.
 */
function SharedCodexSetAsideRow({
  account,
  organization,
  places,
  ownInUse,
  menu,
}: {
  account: CodexAccount;
  organization: OrganizationCodexPool;
  places: CodexPlaces;
  /** This workspace's own accounts are in use, which sets the organization's aside. */
  ownInUse: boolean;
  menu: ReactNode;
}) {
  const access = useConnectionAccess({
    client: organization.codex.client,
    organizationId: organization.codex.organizationId,
    kind: "codex",
    connectionId: account.id,
  });
  const reaches = ownInUse ? true : reachesWorkspace(access.data, organization.workspace);
  const reason = ownInUse
    ? "Set aside while this workspace has its own"
    : reaches === false
      ? `Not available in ${places.workspaceName}`
      : null;
  return (
    <ListRow
      leading={<ProviderTile provider="codex" size="lg" />}
      title={codexAccountName(account)}
      meta={[
        organizationReachLabel(places.scope, access.data),
        planLabel(account.plan, "ChatGPT"),
        reason,
      ]}
      cells={{ usage: NOT_IN_USE }}
      menu={menu}
      indicator={
        account.status !== "active" ? { kind: "attention", label: "Needs reconnect" } : "open"
      }
      onOpen={() => organization.openAccount(account.id)}
    />
  );
}

/**
 * The one line above the Accounts list that says which Codex accounts new
 * work uses. It replaces a source control: the pool is picked automatically,
 * and an explicit choice saved earlier shows here with the way back.
 */
export function CodexPoolNotice({
  codex,
  places,
  organizationAccountCount,
}: {
  codex: CodexSubscriptions;
  places: CodexPlaces;
  /** How many accounts the organization shares, when known. */
  organizationAccountCount?: number | undefined;
}) {
  const source = codex.source;
  if (codex.loading || codex.loadError || !source || source.effectiveSource === "disabled") {
    return null;
  }
  const explicit = source.mode !== "automatic";
  if (!explicit && !source.organizationAvailable) return null;
  const copy = codexPoolCopy({
    mode: source.mode,
    inUse: source.effectiveSource,
    organizationAvailable: source.organizationAvailable,
    workspaceCount: source.effectiveSource === "workspace" ? codex.accounts.length : 0,
    organizationCount:
      source.effectiveSource === "organization" ? codex.accounts.length : organizationAccountCount,
    canConnect: codex.canManage,
  });
  return (
    <Notice
      tone={copy.blocked ? "waiting" : "muted"}
      actionLayout="responsive"
      className="mb-2"
      action={
        explicit && codex.canManage ? (
          <RowButton
            disabled={codex.busy}
            onClick={() =>
              void codex.setSourceMode(
                "automatic",
                `New work in ${places.workspaceName} picks Codex accounts automatically`,
              )
            }
          >
            Use automatically
          </RowButton>
        ) : undefined
      }
    >
      {copy.text}
    </Notice>
  );
}

/** The pool line's words, for every source mode. Exported for tests and the kit. */
export function codexPoolCopy({
  mode,
  inUse,
  organizationAvailable,
  workspaceCount,
  organizationCount,
  canConnect,
}: {
  mode: "automatic" | "workspace" | "organization" | "disabled";
  inUse: "workspace" | "organization";
  organizationAvailable: boolean;
  workspaceCount: number;
  organizationCount?: number | undefined;
  canConnect: boolean;
}): { text: string; blocked: boolean } {
  const orgOne = organizationCount === 1;
  const orgAccounts = `the organization's ${orgOne ? "account" : "accounts"}`;
  if (inUse === "organization") {
    const used = `New work uses the organization's Codex ${orgOne ? "account" : "accounts"}`;
    if (mode === "organization") {
      return { text: `${used}, even when accounts are connected here.`, blocked: false };
    }
    return {
      text: canConnect ? `${used}. Connect an account here to use your own instead.` : `${used}.`,
      blocked: false,
    };
  }
  if (workspaceCount === 0) {
    return {
      text: "New Codex work can't start. This workspace is set to use only its own accounts, and none are connected.",
      blocked: true,
    };
  }
  const here = `this workspace's Codex ${workspaceCount === 1 ? "account" : "accounts"}`;
  if (mode === "workspace") {
    return {
      text: organizationAvailable
        ? `New work uses ${here}. ${capitalize(orgAccounts)} ${orgOne ? "is" : "are"} never used here, even if none are connected.`
        : `New work uses only ${here}, never the organization's.`,
      blocked: false,
    };
  }
  return {
    text: `New work uses ${here}. ${capitalize(orgAccounts)} ${orgOne ? "is" : "are"} set aside while ${
      workspaceCount === 1 ? "it's" : "these are"
    } connected.`,
    blocked: false,
  };
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
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
}: {
  codex: CodexSubscriptions;
  places: CodexPlaces;
  /** The "Keep Codex chats portable" row. */
  providerSwitch: ReactNode;
  /** How the organization's accounts share work, for the people who manage them. */
  organizationSharing?: ReactNode;
  /** Opens Connect Codex for an account owned by this workspace (Codex Apps needs one). */
  onConnectForWorkspace?: (() => void) | undefined;
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
  const showPick = codex.canManage && codex.workspaceManaged && accounts.length >= 2;
  return (
    <>
      <SettingRowGroup>
        {organizationSharing}
        {showPick ? (
          <SettingRow
            label="Sharing work between this workspace's accounts"
            description="Spread work sends each new chat to the account with the most usage left. Primary only uses the primary account and waits when it runs out."
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
  scopeLabel?: string | undefined;
  onOpen: () => void;
}) {
  const live = codex.usageMap[account.id];
  const weekly = codexUsageReadings(live?.usage, codex.now)[0]!;
  const status = attentionStatus(account, codex.now);
  const primary = codex.accounts.length > 1 && account.id === codex.activeAccountId;
  const resets = codex.overviewMap[account.id]?.resetCredits.availableCount;
  const loadingUsage = codex.refreshingUsage && !live;
  const organizationAccount = account.source === "organization";
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
        // Resets can only be redeemed on the account's own page, which org accounts don't have here.
        organizationAccount ? null : resetsLabel(resets),
      ]}
      cells={{
        usage:
          status === "needs_reconnect" ? null : status === "paused" ? (
            <StatusBadge status="paused" variant="dot" />
          ) : status === "out_of_usage" ? (
            <span className="text-xs font-medium text-danger">Out of usage</span>
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
      menu={organizationAccount ? alwaysOrganizationItem(codex, places) : undefined}
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
    enabled: !organizationAccount,
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
              <SettingRow
                label="Available for new chats"
                description="Turn off to stop sending new chats and schedules to this account. Work already running continues."
                control={
                  <Switch
                    aria-label={`${name} is available for new chats`}
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
              <ConnectionAccessRows
                access={access}
                organization={false}
                canManage={codex.canManage}
                onEdit={() => places.openAccess(account.id)}
              />
            </SettingRowGroup>
          </DetailSection>
        ) : null}
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

export function CodexUsage({
  codex,
  account,
}: {
  codex: CodexSubscriptions;
  account: CodexAccount;
}) {
  const live = codex.usageMap[account.id];
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
        {fields}
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
