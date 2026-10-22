import { possessive } from "./possessive";
import { OrganizationElevenLabsVoiceConnection } from "./elevenlabs-voice-connection";
import { OrganizationRealtimeVoiceSettingsRows } from "./realtime-voice-settings";
import {
  AccountGroupHeading,
  SubscriptionAccountRow,
} from "@/components/models/subscription-account-ui";
import { ProviderGroupHeading, useSubscriptionUsagePool } from "./subscription-usage-pool";
import { splitSubscriptionPool, subscriptionAccountName } from "./use-subscription-account-pool";
import type { ClaudeSubscriptions } from "./use-claude-subscriptions";
import {
  ClaudeRow,
  ClaudeSettingRows,
  claudePlan,
  claudeUsageCell,
  ClaudeAccountUsageReadout,
  type ClaudePlaces,
} from "./claude-subscription-models";
import type {
  CodexAccount,
  ConnectionMetadata,
  SubscriptionUsagePool,
  SuperGrokAccount,
  ClaudeSubscriptionAccount,
  WorkspaceModelCatalogModel,
} from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { KeyRoundIcon, LockIcon, PlusIcon } from "lucide-react";
import { Fragment, useMemo, useState, type ReactNode } from "react";
import { useOrganizationCodexUsage } from "@/components/models/use-organization-codex-overview";

import {
  PROVIDER_CONNECTION_CONFIGS,
  ProviderConnectionRow,
  isProviderConnection,
  providerListed,
  type ProviderConnection,
} from "@/components/ai-gateway-connection";
import { codexAccountName, codexUsageReadings, planLabel } from "@/components/codex-connection";
import { useConnectionAccess } from "@/components/connection-access-settings";
import {
  AllowedModelsRow,
  allowedModelsSummary,
  modelAccessPolicyDraft,
  useModelAccessPolicy,
} from "@/components/model-access-policy";
import { DefaultSessionModelPreferenceRow } from "@/components/default-session-model";
import { compactionSummary } from "@/components/models/model-compaction-page";
import {
  OrganizationAccountRulesSection,
  accountRuleChanges,
  type ModelAccountSettingsOverviewState,
} from "@/components/models/model-account-settings";
import type { OrganizationModelDefaultsState } from "@/components/models/use-organization-model-defaults";
import { ACCOUNT_COLUMNS } from "@/components/models/codex-models";
import {
  NOT_IN_USE,
  ProviderTile,
  accountReachLabel,
  organizationReachLabel,
  payerShortLabel,
  resetsLabel,
  type AccountReach,
  type ModelsScopeLabels,
} from "@opengeni/react/app/components/models/models-ui";
import { OpenGeniCreditsRow, type OpenGeniCredits } from "@/components/models/opengeni-credits-row";
import { ORGANIZATION_PROVIDER_META } from "@/components/models/provider-metadata";
import {
  SuperGrokRow,
  SuperGrokSettingRows,
  planOf as superGrokPlan,
  superGrokSectionVisible,
  type SuperGrokPlaces,
} from "@/components/models/supergrok-models";
import type { OrganizationCodexSubscriptions } from "@/components/organization-codex-subscriptions";
import {
  superGrokAccountName,
  type SuperGrokSubscriptions,
} from "@/components/supergrok-connection";
import { EmptyState } from "@opengeni/react/ui/empty-state";
import { ErrorMessage } from "@opengeni/react/ui/error-message";
import { ListRow, ListRowSkeleton, RowList } from "@opengeni/react/ui/list-row";
import { LogoTile } from "@opengeni/react/ui/logo-tile";
import { MetaChip } from "@opengeni/react/ui/meta-chip";
import { RowButton } from "@opengeni/react/ui/page-actions";
import { Section, SectionStack } from "@opengeni/react/ui/section";
import { SegmentedControl } from "@opengeni/react/ui/segmented-control";
import { SettingNavRow, SettingRow, SettingRowGroup } from "@opengeni/react/ui/setting-row";
import { StatusBadge } from "@opengeni/react/ui/status-badge";
import { UsageReadout, usageResets } from "@opengeni/react/ui/usage-meter";
import { billingClassForModel } from "@opengeni/react/app/lib/model-policy";
import {
  accountKey,
  type GatewayId,
  type WorkspaceGatewayId,
} from "@opengeni/react/app/lib/models-route";
import { MODEL_SETTINGS_STALE_TIME_MS, useSharedQuery } from "@opengeni/react/app/lib/shared-query";

/* ----------------------------------------------------------------------------
   Organization settings > Models, the list: every account that pays for
   models (the organization's, tagged by where they're available, and each
   workspace's own, tagged with its workspace), then every workspace with its
   default model and Allowed models, then the organization-wide provider
   settings. A workspace row opens that workspace's model page.

   Owners and admins see and manage everything. A workspace admin who isn't
   one sees only the workspaces they administer, and the accounts those
   workspaces use, read-only: only owners and admins add accounts.
   -------------------------------------------------------------------------- */

export const GATEWAYS: readonly GatewayId[] = [
  "anthropic",
  "azure_openai",
  "openai",
  "openrouter",
  "opper",
  "vercel",
];

/** The catalog provider id of an organization key's models. */
const ORGANIZATION_CATALOG_PROVIDER: Record<GatewayId, string> = {
  vercel: "organization-gateway",
  openrouter: "organization-openrouter",
  opper: "organization-opper",
  openai: "organization-openai",
  azure_openai: "organization-azure-openai",
  anthropic: "organization-anthropic",
  claude_subscription: "organization-claude-subscription",
};

const ORGANIZATION_KIND = {
  vercel: "vercel_gateway",
  openrouter: "openrouter",
  opper: "opper",
  openai: "openai",
  azure_openai: "azure_openai",
  anthropic: "anthropic",
  claude_subscription: "claude_subscription",
} as const;

/** How many models an organization key serves in a workspace's catalog. */
export function readyOrganizationKeyModels(
  models: readonly WorkspaceModelCatalogModel[],
  id: GatewayId,
): number {
  const provider = ORGANIZATION_CATALOG_PROVIDER[id];
  return models.filter(
    (model) =>
      (model.provider === provider || model.id.startsWith(`${provider}/`)) &&
      model.credentialReadiness.status === "ready",
  ).length;
}

/** A workspace on the Workspaces list. */
export interface ModelsWorkspace {
  id: string;
  name: string;
  personal: boolean;
  /** The viewer can change its default model and Allowed models. */
  canManage: boolean;
  /** Its saved default model, if any (from the workspace's settings). */
  savedDefaultModel: string | null;
}

/** What one workspace uses, read through that workspace (its own reads). */
export interface WorkspaceModelsSnapshot {
  codexOwn: CodexAccount[];
  codexShared: CodexAccount[];
  codexOff: boolean;
  grokOwn: SuperGrokAccount[];
  grokShared: SuperGrokAccount[];
  claudeOwn: ClaudeSubscriptionAccount[];
  claudeShared: ClaudeSubscriptionAccount[];
  keysOwn: WorkspaceGatewayId[];
  keysShared: { id: GatewayId; models: number }[];
  /** "GPT-6 Astra · Codex", or null when it can't be read. */
  defaultModel: string | null;
  /** "All models", "3 models", or null when it can't be read. */
  allowed: string | null;
  /** It has its own default model, Allowed models or a compaction limit. */
  changesDefaults: boolean;
  /** What it sets itself instead of following the organization; account rules in words. */
  own: { defaultModel: boolean; allowed: boolean; compaction: boolean; accountRules: string[] };
}

async function readWorkspaceModels(
  client: OpenGeniBrowserClient,
  workspace: ModelsWorkspace,
  claudeEnabled: boolean,
  /**
   * Read its subscription accounts. An organization admin's list already has
   * every shared account, so only their Personal workspace's are read.
   */
  accounts: boolean,
): Promise<WorkspaceModelsSnapshot> {
  const [codex, grok, connections, catalog, policy, claude, rules] = await Promise.allSettled([
    accounts ? client.listCodexAccounts(workspace.id) : Promise.resolve(null),
    accounts ? client.listSuperGrokAccounts(workspace.id) : Promise.resolve(null),
    client.listConnections(workspace.id),
    client.getWorkspaceModelCatalog(workspace.id),
    client.getWorkspaceModelAccessPolicy(workspace.id),
    accounts && claudeEnabled
      ? client.listClaudeSubscriptionAccounts(workspace.id)
      : Promise.resolve(null),
    // A Personal workspace has no account rules of its own.
    workspace.personal
      ? Promise.resolve(null)
      : client.getWorkspaceModelAccountSettings(workspace.id),
  ]);
  const codexAccounts = codex.status === "fulfilled" ? (codex.value?.accounts ?? []) : [];
  const grokData = grok.status === "fulfilled" ? grok.value : null;
  const claudeData = claude.status === "fulfilled" ? claude.value : null;
  // Who owns each account is its own scope: a workspace with an account of its
  // own also lists the organization's that serve it (scope `organization`).
  const grokPool = splitSubscriptionPool({
    accounts: grokData?.accounts ?? [],
    inherited: grokData?.source === "organization",
  });
  const claudePool = splitSubscriptionPool({
    accounts: claudeData?.accounts ?? [],
    inherited: claudeData?.source === "organization",
  });
  const models = catalog.status === "fulfilled" ? catalog.value.models : [];
  const own = (connections.status === "fulfilled" ? connections.value : []) as ConnectionMetadata[];
  const gateways = GATEWAYS.filter((id) => claudeEnabled || id !== "claude_subscription");
  const defaultId =
    workspace.savedDefaultModel ??
    (catalog.status === "fulfilled" ? (catalog.value.defaultSelection?.model ?? null) : null);
  const defaultModel = defaultId ? models.find((model) => model.id === defaultId) : undefined;
  const sets = {
    defaultModel: Boolean(workspace.savedDefaultModel),
    allowed: policy.status === "fulfilled" && policy.value.source === "workspace",
    compaction: models.some((model) => (model.compactionPolicy?.overrideTokens ?? null) !== null),
    accountRules:
      rules.status === "fulfilled" && rules.value !== null ? accountRuleChanges(rules.value) : [],
  };
  return {
    codexOwn: codexAccounts.filter((account) => account.source !== "organization"),
    codexShared: codexAccounts.filter((account) => account.source === "organization"),
    codexOff: codex.status === "fulfilled" && codex.value?.source?.effectiveSource === "disabled",
    grokOwn: grokPool.own,
    grokShared: grokPool.shared,
    claudeOwn: claudePool.own,
    claudeShared: claudePool.shared,
    keysOwn: gateways.filter(
      (id): id is WorkspaceGatewayId =>
        id !== "openai" &&
        id !== "azure_openai" &&
        own.some(
          (connection) =>
            connection.status === "active" &&
            isProviderConnection(connection, PROVIDER_CONNECTION_CONFIGS[id]),
        ),
    ),
    keysShared: gateways
      .map((id) => ({ id, models: readyOrganizationKeyModels(models, id) }))
      .filter((key) => key.models > 0),
    defaultModel: defaultModel
      ? `${defaultModel.label} · ${payerShortLabel({
          billingClass: billingClassForModel(defaultModel),
          providerLabel: defaultModel.providerLabel,
        })}`
      : null,
    allowed:
      policy.status === "fulfilled"
        ? allowedModelsSummary({
            saved: modelAccessPolicyDraft(policy.value, models),
            models,
          })
        : null,
    changesDefaults: sets.defaultModel || sets.allowed || sets.compaction,
    own: sets,
  };
}

/** Reads each workspace once, through that workspace, and keeps the results by id. */
function useWorkspaceSnapshots(
  client: OpenGeniBrowserClient,
  workspaces: readonly ModelsWorkspace[],
  claudeEnabled: boolean,
  /** Changes when the organization's defaults change, so what workspaces follow is re-read. */
  defaultsRevision: string,
  administrator: boolean,
): Record<string, WorkspaceModelsSnapshot | "loading" | "error"> {
  const readable = useMemo(
    () => workspaces.filter((workspace) => workspace.canManage),
    [workspaces],
  );
  const key = readable.map((workspace) => `${workspace.id}:${workspace.savedDefaultModel}`).join();
  const query = useSharedQuery(
    client,
    ["model-settings", "workspace-snapshots", key, claudeEnabled, defaultsRevision, administrator],
    async () =>
      Object.fromEntries(
        await Promise.all(
          readable.map(
            async (workspace) =>
              [
                workspace.id,
                await readWorkspaceModels(
                  client,
                  workspace,
                  claudeEnabled,
                  !administrator || workspace.personal,
                ),
              ] as const,
          ),
        ),
      ),
    { enabled: readable.length > 0, staleTimeMs: MODEL_SETTINGS_STALE_TIME_MS },
  );
  return (
    query.data ??
    Object.fromEntries(
      readable.map((workspace) => [workspace.id, query.error ? "error" : "loading"]),
    )
  );
}

export function OrganizationModelsList({
  client,
  organizationId,
  organizationDefaults,
  accountRules,
  modelLabel,
  onEditAllowed,
  onEditCompaction,
  onEditAccountRuleLocks,
  organizationName,
  administrator,
  claudeEnabled,
  labels,
  workspaces,
  workspacesError,
  credits,
  creditsReturnLabel,
  anchorWorkspaceId,
  orgCodex,
  orgGrok,
  orgClaude,
  orgGateways,
  liveCodexUsage,
  onOpenAccount,
  onOpenWorkspace,
  onConnect,
}: {
  client: OpenGeniBrowserClient;
  organizationId?: string | undefined;
  /** The defaults every workspace follows; owners and admins only, otherwise null. */
  organizationDefaults: OrganizationModelDefaultsState | null;
  /** The organization's account rules and every workspace's; owners and admins only, otherwise null. */
  accountRules?: ModelAccountSettingsOverviewState | null;
  /** A model's name, for the fallback order. */
  modelLabel?: (id: string) => string;
  onEditAllowed: () => void;
  onEditCompaction: () => void;
  /** Opens "What workspaces can change". */
  onEditAccountRuleLocks?: () => void;
  organizationName: string;
  /** An organization owner or admin: manages accounts and every workspace. */
  administrator: boolean;
  claudeEnabled: boolean;
  labels: ModelsScopeLabels;
  /** The workspaces this person can see here, shared ones first. */
  workspaces: readonly ModelsWorkspace[];
  /** The organization's workspace list couldn't be read. */
  workspacesError: boolean;
  credits: OpenGeniCredits;
  creditsReturnLabel: string;
  anchorWorkspaceId: string;
  orgCodex: OrganizationCodexSubscriptions;
  orgGrok: SuperGrokSubscriptions;
  orgClaude: ClaudeSubscriptions;
  orgGateways: Record<GatewayId, ProviderConnection>;
  /** Weekly usage by account, as the settings workspace reads the accounts it uses. */
  liveCodexUsage: Readonly<Record<string, ReactNode>>;
  /** Opens an organization account (`org:...`). */
  onOpenAccount: (account: string) => void;
  /** Opens a workspace's model page, or an account it owns. */
  onOpenWorkspace: (workspaceId: string, account?: string) => void;
  onConnect: () => void;
}) {
  const snapshots = useWorkspaceSnapshots(
    client,
    workspaces,
    claudeEnabled,
    organizationDefaults?.defaults?.updatedAt ?? "",
    administrator,
  );
  const ready = workspaces
    .map((workspace) => ({ workspace, snapshot: snapshots[workspace.id] }))
    .filter(
      (entry): entry is { workspace: ModelsWorkspace; snapshot: WorkspaceModelsSnapshot } =>
        typeof entry.snapshot === "object",
    );
  const loadingWorkspaces = Object.values(snapshots).some((value) => value === "loading");
  const workspaceName = (id: string) => workspaces.find((workspace) => workspace.id === id)?.name;
  const codexPool = useSubscriptionUsagePool(
    client,
    "organization",
    administrator ? organizationId : undefined,
    "codex",
  );
  const claudePool = useSubscriptionUsagePool(
    client,
    "organization",
    administrator && claudeEnabled ? organizationId : undefined,
    "claude",
  );
  const [showOff, setShowOff] = useState<Partial<Record<AccountGroupId, boolean>>>({});

  /* Every account once, grouped by provider. For owners and admins, the
     organization's list has every shared account, each tagged with whose it
     is: the organization's (with who it reaches) or a workspace's own, which
     opens on that workspace's page. Their own personal accounts come from
     their Personal workspace. Everyone else sees what their workspaces use. */
  const groups: Record<AccountGroupId, GroupEntry[]> = { codex: [], claude: [], supergrok: [] };
  const keyRows: ReactNode[] = [];
  const organizationIds = new Set(
    administrator
      ? [
          ...orgCodex.accounts,
          ...(claudeEnabled ? orgClaude.accounts : []),
          ...(orgGrok.unavailable ? [] : orgGrok.accounts),
        ].map((account) => account.id)
      : [],
  );
  const reachLabel = (reach: AccountReach | undefined) =>
    reach ? accountReachLabel(labels, reach, workspaceName) : undefined;
  /* A workspace's own account is only read live in that workspace: the
     organization route never touches its credential. A viewer in that
     workspace sees its live reading there; anyone else its last stored one. */
  const ownerWorkspace = (reach: AccountReach | undefined) =>
    reach?.ownerWorkspaceId
      ? (workspaces.find((workspace) => workspace.id === reach.ownerWorkspaceId) ?? null)
      : undefined;
  const openShared = (
    provider: "codex" | "claude" | "supergrok",
    id: string,
    reach: AccountReach | undefined,
  ) =>
    reach?.ownerWorkspaceId
      ? onOpenWorkspace(reach.ownerWorkspaceId, accountKey(provider, id))
      : onOpenAccount(accountKey(provider, id, true));
  if (administrator) {
    for (const account of orgCodex.accounts)
      groups.codex.push(
        groupEntry(
          `org:codex:${account.id}`,
          account,
          <OrganizationCodexRow
            codex={orgCodex}
            account={account}
            scopeLabel={reachLabel(account.reach)}
            usage={liveCodexUsage[account.id] ?? cachedCodexUsage(account)}
            workspaceOwned={Boolean(account.reach?.ownerWorkspaceId)}
            onOpen={() => openShared("codex", account.id, account.reach)}
          />,
        ),
      );
    const claudePlaces: ClaudePlaces = {
      scopeName: organizationName,
      organizationName,
      scope: labels,
      openAccount: (id) => onOpenAccount(accountKey("claude", id, true)),
      openConnect: () => onConnect(),
      openAccess: (id) => onOpenAccount(accountKey("claude", id, true)),
      backToList: onConnect,
    };
    if (claudeEnabled)
      for (const account of orgClaude.accounts) {
        const owner = ownerWorkspace(account.reach);
        groups.claude.push(
          groupEntry(
            `org:claude:${account.id}`,
            account,
            <ClaudeRow
              claude={orgClaude}
              account={account}
              places={claudePlaces}
              {...(account.reach ? { scopeLabel: reachLabel(account.reach) } : {})}
              {...(owner === undefined
                ? {}
                : {
                    usage: owner ? (
                      <ClaudeAccountUsageReadout
                        client={client}
                        scope="workspace"
                        scopeId={owner.id}
                        account={account}
                        canManage={false}
                      />
                    ) : (
                      claudeUsageCell(account)
                    ),
                  })}
              onOpen={() => openShared("claude", account.id, account.reach)}
            />,
          ),
        );
      }
    const grokPlaces: SuperGrokPlaces = {
      scopeName: labels.everyone,
      organizationName: labels.organization,
      scope: labels,
      openAccount: (id) => onOpenAccount(accountKey("supergrok", id, true)),
      openConnect: () => undefined,
      openAccess: () => undefined,
      backToList: () => undefined,
    };
    if (!orgGrok.unavailable)
      for (const account of orgGrok.accounts)
        groups.supergrok.push(
          groupEntry(
            `org:supergrok:${account.id}`,
            account,
            <SuperGrokRow
              grok={orgGrok}
              account={account}
              places={grokPlaces}
              scopeLabel={reachLabel(account.reach)}
              onOpen={() => openShared("supergrok", account.id, account.reach)}
            />,
          ),
        );
  }

  /* What only a workspace's own reads show: a person's own accounts, a
     workspace's API keys, and for a workspace admin who isn't an organization
     admin, their workspaces' own accounts. */
  for (const { workspace, snapshot } of ready) {
    const tag = workspace.personal ? "Your Personal workspace" : `Belongs to ${workspace.name}`;
    const yours = workspace.personal ? labels.user : `Only you, in ${workspace.name}`;
    for (const account of snapshot.codexOwn) {
      if (organizationIds.has(account.id)) continue;
      groups.codex.push(
        groupEntry(
          `${workspace.id}:codex:${account.id}`,
          account,
          <ListRow
            leading={<ProviderTile provider="codex" size="lg" />}
            title={codexAccountName(account)}
            meta={[
              workspace.personal ? labels.user : tag,
              planLabel(account.plan, "ChatGPT"),
              account.appsDesignated ? "Codex Apps" : null,
            ]}
            cells={snapshot.codexOff ? { usage: NOT_IN_USE } : { usage: cachedCodexUsage(account) }}
            indicator={
              account.status !== "active" ? { kind: "attention", label: "Needs reconnect" } : "open"
            }
            onOpen={() => onOpenWorkspace(workspace.id, accountKey("codex", account.id))}
          />,
          snapshot.codexOff,
        ),
      );
    }
    for (const account of snapshot.grokOwn) {
      if (organizationIds.has(account.id)) continue;
      groups.supergrok.push(
        groupEntry(
          `${workspace.id}:supergrok:${account.id}`,
          account,
          <ListRow
            leading={<ProviderTile provider="supergrok" size="lg" />}
            title={superGrokAccountName(account)}
            meta={[account.scope === "user" ? yours : tag, superGrokPlan(account)]}
            indicator={
              account.status !== "active" ? { kind: "attention", label: "Needs reconnect" } : "open"
            }
            onOpen={() => onOpenWorkspace(workspace.id, accountKey("supergrok", account.id))}
          />,
        ),
      );
    }
    for (const account of snapshot.claudeOwn) {
      if (organizationIds.has(account.id)) continue;
      groups.claude.push(
        groupEntry(
          `${workspace.id}:claude:${account.id}`,
          account,
          <SubscriptionAccountRow
            provider="claude_subscription"
            title={subscriptionAccountName(account)}
            email={account.email}
            primary={account.active}
            meta={[account.scope === "user" ? yours : tag, claudePlan(account)]}
            cells={{
              usage: (
                <ClaudeAccountUsageReadout
                  client={client}
                  scope="workspace"
                  scopeId={workspace.id}
                  account={account}
                  canManage={workspace.canManage && account.scope !== "organization"}
                />
              ),
            }}
            indicator={
              account.status !== "active" ? { kind: "attention", label: "Needs reconnect" } : "open"
            }
            onOpen={() => onOpenWorkspace(workspace.id, accountKey("claude", account.id))}
          />,
        ),
      );
    }
    for (const id of snapshot.keysOwn)
      keyRows.push(
        <ListRow
          key={`${workspace.id}:gateway:${id}`}
          leading={<ProviderTile provider={id} size="lg" />}
          title={PROVIDER_CONNECTION_CONFIGS[id].title}
          meta={[tag, id === "claude_subscription" ? "Claude plan" : "API key"]}
          indicator="open"
          onOpen={() => onOpenWorkspace(workspace.id, accountKey("gateway", id))}
        />,
      );
  }
  if (!administrator) {
    const sharedRows = sharedAccountRows(ready, labels);
    groups.codex.unshift(...sharedRows.codex);
    groups.claude.unshift(...sharedRows.claude);
    groups.supergrok.unshift(...sharedRows.supergrok);
    keyRows.unshift(...sharedRows.keys);
  }

  const orgKeyIds = administrator ? GATEWAYS.filter((id) => providerListed(orgGateways[id])) : [];
  const loadingAccounts =
    loadingWorkspaces ||
    (administrator &&
      (orgCodex.loading ||
        (!orgGrok.unavailable && orgGrok.loading) ||
        (claudeEnabled && orgClaude.loading) ||
        GATEWAYS.some((id) => !orgGateways[id].hidden && !orgGateways[id].settled)));
  const visible: Record<AccountGroupId, boolean> = {
    codex:
      groups.codex.length > 0 ||
      (administrator && (orgCodex.loading || Boolean(orgCodex.loadError || orgCodex.pending))),
    claude:
      claudeEnabled &&
      (groups.claude.length > 0 ||
        (administrator && (orgClaude.loading || Boolean(orgClaude.loadError)))),
    supergrok:
      groups.supergrok.length > 0 ||
      (administrator && !orgGrok.unavailable && (orgGrok.loading || Boolean(orgGrok.loadError))),
  };
  const empty =
    !loadingAccounts &&
    !credits.visible &&
    !visible.codex &&
    !visible.claude &&
    !visible.supergrok &&
    orgKeyIds.length === 0 &&
    keyRows.length === 0;
  const connect = (
    <RowButton variant="default" onClick={onConnect}>
      <PlusIcon aria-hidden="true" />
      Connect provider
    </RowButton>
  );
  const shared = workspaces.filter((workspace) => !workspace.personal);
  const personal = workspaces.filter((workspace) => workspace.personal);
  /* On the Defaults scope an admin sees only the workspaces that change
     something; every other workspace uses the defaults above. */
  const withOwnSettings = [...shared, ...personal].filter((workspace) => {
    const snapshot = snapshots[workspace.id];
    return (
      workspace.canManage &&
      (snapshot === "error" ||
        (typeof snapshot === "object" &&
          (snapshot.changesDefaults || snapshot.own.accountRules.length > 0)))
    );
  });

  const group = (
    id: AccountGroupId,
    title: string,
    loading: boolean,
    loadError: string | null,
    retry: () => void,
    pool?: { pool: SubscriptionUsagePool | null; loading: boolean },
    after?: ReactNode,
  ) =>
    visible[id] ? (
      <Fragment key={id}>
        <ProviderGroupHeading
          title={title}
          facts={loading ? null : groupFacts(groups[id])}
          pool={pool}
        />
        {loading ? <ListRowSkeleton count={2} /> : null}
        {loadError ? (
          <li className="col-span-full list-none px-3 py-3">
            <ErrorMessage
              variant="inline"
              title={`Couldn't load the organization's ${title} accounts.`}
              action={<RowButton onClick={retry}>Try again</RowButton>}
            >
              {loadError}
            </ErrorMessage>
          </li>
        ) : null}
        <AccountGroupRows
          title={title}
          entries={groups[id]}
          showOff={Boolean(showOff[id])}
          onShowOff={(value) => setShowOff((current) => ({ ...current, [id]: value }))}
        />
        {after}
      </Fragment>
    ) : null;

  const accountCountsKnown =
    administrator &&
    !orgCodex.loading &&
    !(claudeEnabled && orgClaude.loading) &&
    !(!orgGrok.unavailable && orgGrok.loading);
  const accountCounts = accountCountsKnown
    ? {
        codex: orgCodex.accounts.length,
        claude: claudeEnabled ? orgClaude.accounts.length : 0,
        xai: orgGrok.unavailable ? 0 : orgGrok.accounts.length,
      }
    : undefined;

  return (
    <SectionStack>
      <Section
        title="Model providers"
        description={
          <>
            {administrator
              ? "Subscriptions, API keys and credits that run models. Open one to see its usage, choose who can use it, or reconnect it."
              : workspaces.some((workspace) => !workspace.personal)
                ? "Subscriptions, API keys and credits that run models in your workspaces."
                : "Subscriptions, API keys and credits that run models in your Personal workspace."}
          </>
        }
        action={administrator && !empty ? connect : null}
      >
        {empty ? (
          <EmptyState
            variant="page"
            icon={<KeyRoundIcon />}
            title="No model providers connected"
            description={
              administrator
                ? "Connect a subscription or an API key, then choose who can use it."
                : "Nothing pays for models in your workspaces yet."
            }
            action={administrator ? connect : null}
            className="pt-8 pb-6"
          />
        ) : (
          <RowList label="Model providers" columns={ACCOUNT_COLUMNS} flush>
            {group(
              "codex",
              "Codex",
              administrator && orgCodex.loading,
              administrator ? orgCodex.loadError : null,
              () => void orgCodex.refresh(),
              administrator ? codexPool : undefined,
              administrator && orgCodex.pending ? (
                <ListRow
                  leading={<ProviderTile provider="codex" size="lg" />}
                  title="Signing in to ChatGPT…"
                  meta={["Finish signing in to add the account"]}
                  indicator="open"
                  onOpen={onConnect}
                />
              ) : null,
            )}
            {group(
              "claude",
              "Claude",
              administrator && orgClaude.loading,
              administrator ? orgClaude.loadError : null,
              () => void orgClaude.refresh(),
              administrator ? claudePool : undefined,
            )}
            {group(
              "supergrok",
              "SuperGrok",
              administrator && !orgGrok.unavailable && orgGrok.loading,
              administrator && !orgGrok.unavailable ? orgGrok.loadError : null,
              () => void orgGrok.refresh(),
            )}
            {credits.visible || keyRows.length > 0 || orgKeyIds.length > 0 ? (
              <AccountGroupHeading>Pay as you go</AccountGroupHeading>
            ) : null}
            <OpenGeniCreditsRow
              credits={credits}
              workspaceId={anchorWorkspaceId}
              workspaceName={creditsReturnLabel}
              scope={labels.everyone}
            />
            {orgKeyIds.map((id) => (
              <OrganizationKeyRow
                key={`org:${id}`}
                state={orgGateways[id]}
                labels={labels}
                onOpen={() => onOpenAccount(accountKey("gateway", id, true))}
              />
            ))}
            {keyRows}
          </RowList>
        )}
        {administrator ? null : (
          <p className="m-0 pt-2 pb-3 text-sm leading-5 text-fg-muted">
            To connect your own subscription, pick one of your workspaces above. Only organization
            owners and admins connect providers for everyone.
          </p>
        )}
      </Section>

      {organizationDefaults ? (
        <OrganizationDefaultsSection
          organizationName={organizationName}
          anchorWorkspaceId={anchorWorkspaceId}
          defaults={organizationDefaults}
          onEditAllowed={onEditAllowed}
          onEditCompaction={onEditCompaction}
        />
      ) : null}

      {organizationDefaults && organizationId ? (
        <Section
          title="Voice"
          description="Connect ElevenLabs once for every workspace, and choose how each voice model sounds and listens. A workspace can choose its own."
        >
          <OrganizationElevenLabsVoiceConnection
            organizationId={organizationId}
            organizationName={organizationName}
          />
          <OrganizationRealtimeVoiceSettingsRows
            anchorWorkspaceId={anchorWorkspaceId}
            defaults={organizationDefaults}
          />
        </Section>
      ) : null}

      {accountRules ? (
        <OrganizationAccountRulesSection
          organizationName={organizationName}
          state={accountRules}
          accountCounts={accountCounts}
          modelLabel={modelLabel}
          onEditLocks={onEditAccountRuleLocks ?? (() => undefined)}
        />
      ) : null}

      {organizationDefaults ? (
        <Section
          title="Workspaces with their own settings"
          description={
            withOwnSettings.length === 0 && !loadingWorkspaces
              ? "Every workspace uses the defaults."
              : "These workspaces change something for themselves. Everything else they use from the defaults."
          }
        >
          {withOwnSettings.length > 0 || loadingWorkspaces ? (
            <RowList label="Workspaces with their own settings" flush>
              {withOwnSettings.map((workspace) => (
                <WorkspaceRow
                  key={workspace.id}
                  workspace={workspace}
                  snapshot={snapshots[workspace.id]}
                  follows
                  onOpen={() => onOpenWorkspace(workspace.id)}
                />
              ))}
              {loadingWorkspaces ? <ListRowSkeleton count={1} /> : null}
            </RowList>
          ) : null}
          {workspacesError ? (
            <p className="m-0 pt-2 pb-3 text-sm leading-5 text-fg-muted">
              Couldn't load every workspace in the organization, so only the ones you're in are
              checked. Reload the page to try again.
            </p>
          ) : null}
        </Section>
      ) : (
        <Section
          title="Workspaces"
          description="Each workspace's default model and the models people can pick there."
        >
          <RowList label="Workspaces" flush>
            {[...shared, ...personal].map((workspace) => (
              <WorkspaceRow
                key={workspace.id}
                workspace={workspace}
                snapshot={snapshots[workspace.id]}
                follows={false}
                onOpen={() => onOpenWorkspace(workspace.id)}
              />
            ))}
          </RowList>
          {workspacesError ? (
            <p className="m-0 pt-2 pb-3 text-sm leading-5 text-fg-muted">
              Couldn't load every workspace in the organization, so only the ones you're in are
              listed. Reload the page to try again.
            </p>
          ) : null}
        </Section>
      )}

      {!accountRules && administrator && orgCodex.accounts.length >= 2 ? (
        <Section title="Codex">
          <SettingRowGroup>
            <SettingRow
              label="Sharing work between accounts"
              description={`Spread work shares new chats evenly across accounts that can serve them, in every workspace that uses ${possessive(organizationName)} Codex accounts. Primary first starts new chats on the primary account and uses another account when it can't serve them.`}
              controlWidth="auto"
              control={
                <SegmentedControl<"spread" | "primary">
                  size="sm"
                  pending={orgCodex.working === "rotation"}
                  disabled={orgCodex.busy && orgCodex.working !== "rotation"}
                  value={orgCodex.rotationEnabled ? "spread" : "primary"}
                  onValueChange={(value) => void orgCodex.setRotation(value === "spread")}
                  options={[
                    { value: "spread", label: "Spread work" },
                    { value: "primary", label: "Primary first" },
                  ]}
                />
              }
            />
          </SettingRowGroup>
        </Section>
      ) : null}
      {!accountRules && administrator && claudeEnabled && orgClaude.accounts.length > 1 ? (
        <Section title="Claude">
          <ClaudeSettingRows claude={orgClaude} />
        </Section>
      ) : null}
      {!accountRules && administrator && superGrokSectionVisible(orgGrok) ? (
        <Section title="SuperGrok">
          <SuperGrokSettingRows grok={orgGrok} label="Sharing work between accounts" />
        </Section>
      ) : null}
    </SectionStack>
  );
}

/**
 * What every workspace starts with: the default model, Allowed models and
 * compaction limits. A workspace follows each until its admins change it.
 */
export function OrganizationDefaultsSection({
  organizationName,
  anchorWorkspaceId,
  defaults,
  onEditAllowed,
  onEditCompaction,
}: {
  organizationName: string;
  /** Whose catalog lists the models to choose from. */
  anchorWorkspaceId: string;
  defaults: OrganizationModelDefaultsState;
  onEditAllowed: () => void;
  onEditCompaction: () => void;
}) {
  const policy = useModelAccessPolicy({
    kind: "organization",
    workspaceId: anchorWorkspaceId,
    defaults,
  });
  return (
    <Section
      title="New chats"
      description="What new chats start with and which models people can pick."
    >
      {defaults.error ? (
        <ErrorMessage
          title={`Couldn't load ${possessive(organizationName)} defaults.`}
          action={<RowButton onClick={() => void defaults.reload()}>Try again</RowButton>}
        >
          Nothing was changed.
        </ErrorMessage>
      ) : (
        <SettingRowGroup>
          <DefaultSessionModelPreferenceRow
            workspaceId={anchorWorkspaceId}
            canManage
            organizationName={organizationName}
            organizationDefaults={defaults}
          />
          <AllowedModelsRow state={policy} onEdit={onEditAllowed} />
          <SettingNavRow
            label="Context & compaction"
            description="When to summarize long conversations, by model."
            value={compactionSummary(policy.models, {
              organizationLimits: defaults.defaults?.modelCompactionThresholds ?? {},
            })}
            onOpen={onEditCompaction}
          />
        </SettingRowGroup>
      )}
    </Section>
  );
}

export { possessive };

/** Cached weekly usage an account carries, for a row with no live reading. */
function cachedCodexUsage(account: CodexAccount): ReactNode {
  const readings = codexUsageReadings(
    { weekly: account.weekly ?? null, fiveHour: account.fiveHour ?? null },
    Date.now(),
  );
  const weekly = readings[0]!;
  if (weekly.percent === null) return null;
  return (
    <UsageReadout
      percent={weekly.percent}
      window="this week"
      resets={usageResets(readings, weekly.label)}
    />
  );
}

type AccountGroupId = "codex" | "claude" | "supergrok";

/** One account row in a provider group, with what the group's heading counts. */
interface GroupEntry {
  key: string;
  node: ReactNode;
  /** Turned on and working. */
  on: boolean;
  /** Signed out or failing: needs reconnecting. */
  attention: boolean;
}

function groupEntry(
  key: string,
  account: { allocatorEnabled?: boolean; status: string },
  node: ReactNode,
  /** Not in use where it's listed, whatever the account says. */
  off = false,
): GroupEntry {
  const attention = account.status !== "active";
  return { key, node, on: !off && !attention && account.allocatorEnabled !== false, attention };
}

/** "12 accounts", "9 on", "1 needs reconnecting". */
function groupFacts(entries: readonly GroupEntry[]): (string | null)[] {
  const on = entries.filter((entry) => entry.on).length;
  const attention = entries.filter((entry) => entry.attention).length;
  return [
    entries.length === 1 ? "1 account" : `${entries.length} accounts`,
    entries.length > 1 && on !== entries.length ? `${on} on` : null,
    attention === 0
      ? null
      : attention === 1
        ? "1 needs reconnecting"
        : `${attention} need reconnecting`,
  ];
}

/** A group shows its accounts in use first; ones turned off fold away once there are several. */
const FOLD_OFF_AFTER = 4;

function AccountGroupRows({
  title,
  entries,
  showOff,
  onShowOff,
}: {
  title: string;
  entries: readonly GroupEntry[];
  showOff: boolean;
  onShowOff: (value: boolean) => void;
}) {
  const first = entries.filter((entry) => entry.on || entry.attention);
  const off = entries.filter((entry) => !entry.on && !entry.attention);
  const fold = entries.length > FOLD_OFF_AFTER && off.length > 0;
  const shown = fold && !showOff ? first : [...first, ...off];
  return (
    <>
      {shown.map((entry) => (
        <Fragment key={entry.key}>{entry.node}</Fragment>
      ))}
      {fold ? (
        <li className="col-span-full list-none px-3 py-2">
          <RowButton
            aria-expanded={showOff}
            aria-label={`${showOff ? "Hide" : "Show"} ${off.length} ${title} ${off.length === 1 ? "account" : "accounts"} turned off`}
            onClick={() => onShowOff(!showOff)}
          >
            {showOff ? "Hide turned off" : `Show ${off.length} turned off`}
          </RowButton>
        </li>
      ) : null}
    </>
  );
}

/**
 * For a workspace admin who can't read the organization's accounts: the ones
 * their workspaces use, once each, naming those workspaces. Read-only.
 */
function sharedAccountRows(
  ready: { workspace: ModelsWorkspace; snapshot: WorkspaceModelsSnapshot }[],
  labels: ModelsScopeLabels,
): Record<AccountGroupId, GroupEntry[]> & { keys: ReactNode[] } {
  const codex = new Map<string, { account: CodexAccount; where: string[] }>();
  const grok = new Map<string, { account: SuperGrokAccount; where: string[] }>();
  const claude = new Map<string, { account: ClaudeSubscriptionAccount; where: string[] }>();
  const keys = new Map<GatewayId, { models: number; where: string[] }>();
  const add = <T,>(
    map: Map<string, { account: T; where: string[] }>,
    id: string,
    account: T,
    where: string,
  ) => {
    const entry = map.get(id) ?? { account, where: [] };
    entry.where.push(where);
    map.set(id, entry);
  };
  for (const { workspace, snapshot } of ready) {
    const where = workspace.personal ? "your Personal workspace" : workspace.name;
    for (const account of snapshot.codexShared) add(codex, account.id, account, where);
    for (const account of snapshot.grokShared) add(grok, account.id, account, where);
    for (const account of snapshot.claudeShared) add(claude, account.id, account, where);
    for (const key of snapshot.keysShared) {
      const entry = keys.get(key.id) ?? { models: key.models, where: [] };
      entry.where.push(where);
      keys.set(key.id, entry);
    }
  }
  const usedIn = (where: string[]) => `Used in ${where.join(", ")}`;
  return {
    codex: [...codex.values()].map(({ account, where }) =>
      groupEntry(
        `shared:codex:${account.id}`,
        account,
        <ListRow
          leading={<ProviderTile provider="codex" size="lg" />}
          title={codexAccountName(account)}
          meta={[labels.organization, usedIn(where), planLabel(account.plan, "ChatGPT")]}
          cells={{ usage: cachedCodexUsage(account) }}
        />,
      ),
    ),
    supergrok: [...grok.values()].map(({ account, where }) =>
      groupEntry(
        `shared:supergrok:${account.id}`,
        account,
        <ListRow
          leading={<ProviderTile provider="supergrok" size="lg" />}
          title={superGrokAccountName(account)}
          meta={[labels.organization, usedIn(where), superGrokPlan(account)]}
        />,
      ),
    ),
    claude: [...claude.values()].map(({ account, where }) =>
      groupEntry(
        `shared:claude:${account.id}`,
        account,
        <SubscriptionAccountRow
          provider="claude_subscription"
          title={subscriptionAccountName(account)}
          email={account.email}
          meta={[labels.organization, usedIn(where), claudePlan(account)]}
          cells={{ usage: claudeUsageCell(account) }}
        />,
      ),
    ),
    keys: [...keys.entries()].map(([id, { models, where }]) => (
      <ListRow
        key={`shared:gateway:${id}`}
        leading={<ProviderTile provider={id} size="lg" />}
        title={ORGANIZATION_PROVIDER_META[ORGANIZATION_KIND[id]].title}
        meta={[labels.organization, usedIn(where), models === 1 ? "1 model" : `${models} models`]}
      />
    )),
  };
}

function OrganizationCodexRow({
  codex,
  account,
  scopeLabel,
  usage,
  workspaceOwned,
  onOpen,
}: {
  codex: OrganizationCodexSubscriptions;
  account: CodexAccount;
  /** Whose it is and who it reaches; empty while that is still loading. */
  scopeLabel: string | undefined;
  usage: ReactNode;
  /** A workspace's own account: never read live on the organization route. */
  workspaceOwned: boolean;
  onOpen: () => void;
}) {
  const live = useOrganizationCodexUsage(
    codex.client,
    codex.organizationId,
    account,
    !workspaceOwned,
  );
  const readings = codexUsageReadings(live.data?.usage, Date.now());
  const primary = codex.accounts.length > 1 && account.id === codex.activeAccountId;
  const reconnect = account.status !== "active";
  return (
    <ListRow
      leading={<ProviderTile provider="codex" size="lg" />}
      title={codexAccountName(account)}
      titleAddon={primary ? <MetaChip variant="outline">Primary</MetaChip> : null}
      meta={[
        scopeLabel ?? null,
        planLabel(account.plan, "ChatGPT"),
        resetsLabel(live.resetCredits?.availableCount ?? account.resetCreditAvailableCount),
      ]}
      cells={{
        usage: reconnect ? null : !account.allocatorEnabled ? (
          <StatusBadge status="disabled" variant="dot" />
        ) : workspaceOwned ? (
          usage
        ) : live.loading ? (
          <UsageReadout percent={null} window="this week" loading />
        ) : live.error || live.data?.status === "error" ? (
          <span className="text-xs text-fg-muted">Usage unavailable</span>
        ) : live.data ? (
          <UsageReadout
            percent={readings[0]!.percent}
            window="this week"
            resets={usageResets(readings, readings[0]!.label)}
          />
        ) : (
          usage
        ),
      }}
      indicator={reconnect ? { kind: "attention", label: "Needs reconnect" } : "open"}
      onOpen={onOpen}
    />
  );
}

function OrganizationKeyRow({
  state,
  labels,
  onOpen,
}: {
  state: ProviderConnection;
  labels: ModelsScopeLabels;
  onOpen: () => void;
}) {
  const access = useConnectionAccess({ ...state.accessTarget, enabled: state.connected });
  return (
    <ProviderConnectionRow
      state={state}
      scope={organizationReachLabel(labels, access.data)}
      onOpen={onOpen}
    />
  );
}

/**
 * One workspace, opening its model page. For an organization admin it says
 * only what the workspace sets itself; otherwise its default model and
 * Allowed models.
 */
function WorkspaceRow({
  workspace,
  snapshot,
  follows,
  onOpen,
}: {
  workspace: ModelsWorkspace;
  snapshot: WorkspaceModelsSnapshot | "loading" | "error" | undefined;
  /** The page shows the defaults above, so the row says only what the workspace changes. */
  follows: boolean;
  onOpen: () => void;
}) {
  const title = workspace.personal ? "Your Personal workspace" : workspace.name;
  const leading = workspace.personal ? (
    <LogoTile icon={<LockIcon />} />
  ) : (
    <LogoTile name={workspace.name} />
  );
  if (!workspace.canManage) {
    return (
      <ListRow
        disabled
        leading={leading}
        title={title}
        meta={[]}
        disabledReason="Only its workspace admins can change its models."
      />
    );
  }
  const facts =
    snapshot === "error"
      ? ["Couldn't load its models"]
      : typeof snapshot !== "object"
        ? []
        : follows
          ? workspaceDifferences(snapshot)
          : [snapshot.defaultModel, snapshot.allowed];
  return (
    <ListRow
      leading={leading}
      title={title}
      meta={[...(workspace.personal ? ["Only you"] : []), ...facts]}
      indicator="open"
      onOpen={onOpen}
    />
  );
}

/**
 * "Default: GPT-6 Astra · Codex", "3 models allowed", what it changed in its
 * sharing rules ("Claude sharing: Off"), or "Uses the defaults".
 */
function workspaceDifferences(snapshot: WorkspaceModelsSnapshot) {
  const facts = [
    snapshot.own.defaultModel && snapshot.defaultModel ? `Default: ${snapshot.defaultModel}` : null,
    snapshot.own.allowed && snapshot.allowed ? `${snapshot.allowed} allowed` : null,
    snapshot.own.compaction ? "Own compaction limits" : null,
  ].filter((fact): fact is string => fact !== null);
  const rules = snapshot.own.accountRules;
  // Two changes read at a glance; more would crowd the row, so they're counted.
  facts.push(...(rules.length > 2 ? [`${rules.length} sharing rules changed`] : rules));
  return facts.length > 0 ? facts : ["Uses the defaults"];
}
