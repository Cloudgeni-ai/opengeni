import type {
  CodexAccount,
  ConnectionMetadata,
  SuperGrokAccount,
  WorkspaceModelCatalogModel,
} from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { KeyRoundIcon, LockIcon, PlusIcon } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import {
  PROVIDER_CONNECTION_CONFIGS,
  ProviderConnectionRow,
  isProviderConnection,
  providerListed,
  type ProviderConnection,
} from "@/components/ai-gateway-connection";
import { codexAccountName, codexUsageReadings, planLabel } from "@/components/codex-connection";
import { useConnectionAccess } from "@/components/connection-access-settings";
import { allowedModelsSummary, modelAccessPolicyDraft } from "@/components/model-access-policy";
import { ACCOUNT_COLUMNS } from "@/components/models/codex-models";
import {
  NOT_IN_USE,
  ProviderTile,
  organizationReachLabel,
  payerShortLabel,
  type ModelsScopeLabels,
} from "@/components/models/models-ui";
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
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorMessage } from "@/components/ui/error-message";
import { ListRow, ListRowSkeleton, RowList } from "@/components/ui/list-row";
import { LogoTile } from "@/components/ui/logo-tile";
import { MetaChip } from "@/components/ui/meta-chip";
import { RowButton } from "@/components/ui/page-actions";
import { Section, SectionStack } from "@/components/ui/section";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SettingRow, SettingRowGroup } from "@/components/ui/setting-row";
import { StatusBadge } from "@/components/ui/status-badge";
import { UsageReadout } from "@/components/ui/usage-meter";
import { billingClassForModel } from "@/lib/model-policy";
import { accountKey, type GatewayId } from "@/lib/models-route";

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

export const GATEWAYS = ["claude_subscription", "anthropic", "openrouter", "vercel"] as const;

/** The catalog provider id of an organization key's models. */
const ORGANIZATION_CATALOG_PROVIDER: Record<GatewayId, string> = {
  vercel: "organization-gateway",
  openrouter: "organization-openrouter",
  anthropic: "organization-anthropic",
  claude_subscription: "organization-claude-subscription",
};

const ORGANIZATION_KIND = {
  vercel: "vercel_gateway",
  openrouter: "openrouter",
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
  keysOwn: GatewayId[];
  keysShared: { id: GatewayId; models: number }[];
  /** "GPT-6 Astra · Codex", or null when it can't be read. */
  defaultModel: string | null;
  /** "All models", "3 models", or null when it can't be read. */
  allowed: string | null;
}

async function readWorkspaceModels(
  client: OpenGeniBrowserClient,
  workspace: ModelsWorkspace,
  claudeEnabled: boolean,
): Promise<WorkspaceModelsSnapshot> {
  const [codex, grok, connections, catalog, policy] = await Promise.allSettled([
    client.listCodexAccounts(workspace.id),
    client.listSuperGrokAccounts(workspace.id),
    client.listConnections(workspace.id),
    client.getWorkspaceModelCatalog(workspace.id),
    client.getWorkspaceModelAccessPolicy(workspace.id),
  ]);
  const codexAccounts = codex.status === "fulfilled" ? codex.value.accounts : [];
  const grokData = grok.status === "fulfilled" ? grok.value : null;
  const grokInherited = grokData?.source === "organization";
  const models = catalog.status === "fulfilled" ? catalog.value.models : [];
  const own = (connections.status === "fulfilled" ? connections.value : []) as ConnectionMetadata[];
  const gateways = GATEWAYS.filter((id) => claudeEnabled || id !== "claude_subscription");
  const defaultId =
    workspace.savedDefaultModel ??
    (catalog.status === "fulfilled" ? (catalog.value.defaultSelection?.model ?? null) : null);
  const defaultModel = defaultId ? models.find((model) => model.id === defaultId) : undefined;
  return {
    codexOwn: codexAccounts.filter((account) => account.source !== "organization"),
    codexShared: codexAccounts.filter((account) => account.source === "organization"),
    codexOff: codex.status === "fulfilled" && codex.value.source?.effectiveSource === "disabled",
    grokOwn: grokInherited ? [] : (grokData?.accounts ?? []),
    grokShared: grokInherited ? (grokData?.accounts ?? []) : [],
    keysOwn: gateways.filter((id) =>
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
  };
}

/** Reads each workspace once, through that workspace, and keeps the results by id. */
function useWorkspaceSnapshots(
  client: OpenGeniBrowserClient,
  workspaces: readonly ModelsWorkspace[],
  claudeEnabled: boolean,
): Record<string, WorkspaceModelsSnapshot | "loading" | "error"> {
  const [snapshots, setSnapshots] = useState<
    Record<string, WorkspaceModelsSnapshot | "loading" | "error">
  >({});
  const readable = useMemo(
    () => workspaces.filter((workspace) => workspace.canManage),
    [workspaces],
  );
  const key = readable.map((workspace) => `${workspace.id}:${workspace.savedDefaultModel}`).join();
  useEffect(() => {
    let live = true;
    setSnapshots(
      Object.fromEntries(readable.map((workspace) => [workspace.id, "loading" as const])),
    );
    for (const workspace of readable) {
      readWorkspaceModels(client, workspace, claudeEnabled)
        .then((snapshot) => {
          if (live) setSnapshots((current) => ({ ...current, [workspace.id]: snapshot }));
        })
        .catch(() => {
          if (live) setSnapshots((current) => ({ ...current, [workspace.id]: "error" }));
        });
    }
    return () => {
      live = false;
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- re-read when the set of workspaces changes
  }, [client, key, claudeEnabled]);
  return snapshots;
}

export function OrganizationModelsList({
  client,
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
  orgGateways,
  liveCodexUsage,
  onOpenAccount,
  onOpenWorkspace,
  onConnect,
}: {
  client: OpenGeniBrowserClient;
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
  orgGateways: Record<GatewayId, ProviderConnection>;
  /** Weekly usage by account, as the settings workspace reads the accounts it uses. */
  liveCodexUsage: Readonly<Record<string, ReactNode>>;
  /** Opens an organization account (`org:...`). */
  onOpenAccount: (account: string) => void;
  /** Opens a workspace's model page, or an account it owns. */
  onOpenWorkspace: (workspaceId: string, account?: string) => void;
  onConnect: () => void;
}) {
  const snapshots = useWorkspaceSnapshots(client, workspaces, claudeEnabled);
  const ready = workspaces
    .map((workspace) => ({ workspace, snapshot: snapshots[workspace.id] }))
    .filter(
      (entry): entry is { workspace: ModelsWorkspace; snapshot: WorkspaceModelsSnapshot } =>
        typeof entry.snapshot === "object",
    );
  const loadingWorkspaces = Object.values(snapshots).some((value) => value === "loading");

  /* Each workspace's own accounts, tagged with the workspace. */
  const ownRows = ready.flatMap(({ workspace, snapshot }) => {
    const tag = workspace.personal ? "Personal workspace only" : `${workspace.name} only`;
    return [
      ...snapshot.codexOwn.map((account) => (
        <ListRow
          key={`${workspace.id}:codex:${account.id}`}
          leading={<ProviderTile provider="codex" size="lg" />}
          title={codexAccountName(account)}
          meta={[
            tag,
            planLabel(account.plan, "ChatGPT"),
            account.appsDesignated ? "Codex Apps" : null,
          ]}
          cells={snapshot.codexOff ? { usage: NOT_IN_USE } : { usage: cachedCodexUsage(account) }}
          indicator={
            account.status !== "active" ? { kind: "attention", label: "Needs reconnect" } : "open"
          }
          onOpen={() => onOpenWorkspace(workspace.id, accountKey("codex", account.id))}
        />
      )),
      ...snapshot.grokOwn.map((account) => (
        <ListRow
          key={`${workspace.id}:supergrok:${account.id}`}
          leading={<ProviderTile provider="supergrok" size="lg" />}
          title={superGrokAccountName(account)}
          meta={[account.scope === "user" ? `${tag} · only you` : tag, superGrokPlan(account)]}
          indicator={
            account.status !== "active" ? { kind: "attention", label: "Needs reconnect" } : "open"
          }
          onOpen={() => onOpenWorkspace(workspace.id, accountKey("supergrok", account.id))}
        />
      )),
      ...snapshot.keysOwn.map((id) => (
        <ListRow
          key={`${workspace.id}:gateway:${id}`}
          leading={<ProviderTile provider={id} size="lg" />}
          title={PROVIDER_CONNECTION_CONFIGS[id].title}
          meta={[tag, id === "claude_subscription" ? "Claude plan" : "API key"]}
          indicator="open"
          onOpen={() => onOpenWorkspace(workspace.id, accountKey("gateway", id))}
        />
      )),
    ];
  });

  /* What the organization shares, as the workspaces of a workspace admin use it. */
  const sharedRows = administrator ? [] : sharedAccountRows(ready, labels);

  const orgRows = administrator ? (
    <>
      <OrganizationCodexRows
        codex={orgCodex}
        labels={labels}
        liveUsage={liveCodexUsage}
        onOpen={(id) => onOpenAccount(accountKey("codex", id, true))}
        onConnect={() => onConnect()}
      />
      {orgGrok.unavailable ? null : (
        <OrganizationSuperGrokRows
          grok={orgGrok}
          labels={labels}
          onOpen={(id) => onOpenAccount(accountKey("supergrok", id, true))}
        />
      )}
      {GATEWAYS.filter((id) => providerListed(orgGateways[id])).map((id) => (
        <OrganizationKeyRow
          key={`org:${id}`}
          state={orgGateways[id]}
          labels={labels}
          onOpen={() => onOpenAccount(accountKey("gateway", id, true))}
        />
      ))}
    </>
  ) : null;

  const loadingAccounts =
    loadingWorkspaces ||
    (administrator &&
      (orgCodex.loading ||
        (!orgGrok.unavailable && orgGrok.loading) ||
        GATEWAYS.some((id) => !orgGateways[id].hidden && !orgGateways[id].settled)));
  const organizationCount = administrator
    ? orgCodex.accounts.length +
      (orgCodex.pending || orgCodex.loadError ? 1 : 0) +
      (orgGrok.unavailable ? 0 : orgGrok.accounts.length + (orgGrok.loadError ? 1 : 0)) +
      GATEWAYS.filter((id) => providerListed(orgGateways[id])).length
    : sharedRows.length;
  const empty =
    !loadingAccounts && !credits.visible && organizationCount === 0 && ownRows.length === 0;
  const connect = (
    <RowButton variant="default" onClick={onConnect}>
      <PlusIcon aria-hidden="true" />
      Connect account
    </RowButton>
  );
  const shared = workspaces.filter((workspace) => !workspace.personal);
  const personal = workspaces.filter((workspace) => workspace.personal);

  return (
    <SectionStack>
      <Section
        title="Accounts"
        description={
          administrator
            ? "Subscriptions, API keys and credits that pay for models. Each account is available in all workspaces or the ones you choose."
            : workspaces.some((workspace) => !workspace.personal)
              ? "Subscriptions, API keys and credits that pay for models in your workspaces."
              : "Subscriptions, API keys and credits that pay for models in your Personal workspace."
        }
        action={administrator && !empty ? connect : null}
      >
        {empty ? (
          <EmptyState
            variant="page"
            icon={<KeyRoundIcon />}
            title="No accounts connected"
            description={
              administrator
                ? "Connect a subscription or an API key, then choose which workspaces use it."
                : "Nothing pays for models in your workspaces yet."
            }
            action={administrator ? connect : null}
            className="pt-8 pb-6"
          />
        ) : (
          <RowList label="Accounts" columns={ACCOUNT_COLUMNS} flush>
            <OpenGeniCreditsRow
              credits={credits}
              workspaceId={anchorWorkspaceId}
              workspaceName={creditsReturnLabel}
              scope={labels.everyone}
            />
            {orgRows}
            {sharedRows}
            {ownRows}
            {loadingWorkspaces ? <ListRowSkeleton count={1} /> : null}
          </RowList>
        )}
        {administrator ? null : (
          <p className="m-0 pt-2 pb-3 text-sm leading-5 text-fg-muted">
            Only organization owners and admins can add accounts.
          </p>
        )}
      </Section>

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

      {administrator && orgCodex.accounts.length >= 2 ? (
        <Section title="Codex">
          <SettingRowGroup>
            <SettingRow
              label="Sharing work between accounts"
              description={`Spread work sends new chats to the account with the most usage left, in every workspace that uses ${possessive(organizationName)} Codex accounts. Primary only uses the primary account.`}
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
                    { value: "primary", label: "Primary only" },
                  ]}
                />
              }
            />
          </SettingRowGroup>
        </Section>
      ) : null}
      {administrator && superGrokSectionVisible(orgGrok) ? (
        <Section title="SuperGrok">
          <SuperGrokSettingRows grok={orgGrok} label="Sharing work between accounts" />
        </Section>
      ) : null}
    </SectionStack>
  );
}

/** "Acme's", "Acme Robotics'". */
export function possessive(name: string): string {
  return /s$/i.test(name) ? `${name}'` : `${name}'s`;
}

/** Cached weekly usage an account carries, for a row with no live reading. */
function cachedCodexUsage(account: CodexAccount): ReactNode {
  const weekly = codexUsageReadings(
    { weekly: account.weekly ?? null, fiveHour: account.fiveHour ?? null },
    Date.now(),
  )[0]!;
  if (weekly.percent === null) return null;
  return (
    <UsageReadout percent={weekly.percent} window="this week" resetsLabel={weekly.resetsLabel} />
  );
}

/**
 * For a workspace admin who can't read the organization's accounts: the ones
 * their workspaces use, once each, naming those workspaces. Read-only.
 */
function sharedAccountRows(
  ready: { workspace: ModelsWorkspace; snapshot: WorkspaceModelsSnapshot }[],
  labels: ModelsScopeLabels,
): ReactNode[] {
  const codex = new Map<string, { account: CodexAccount; where: string[] }>();
  const grok = new Map<string, { account: SuperGrokAccount; where: string[] }>();
  const keys = new Map<GatewayId, { models: number; where: string[] }>();
  for (const { workspace, snapshot } of ready) {
    const where = workspace.personal ? "your Personal workspace" : workspace.name;
    for (const account of snapshot.codexShared) {
      const entry = codex.get(account.id) ?? { account, where: [] };
      entry.where.push(where);
      codex.set(account.id, entry);
    }
    for (const account of snapshot.grokShared) {
      const entry = grok.get(account.id) ?? { account, where: [] };
      entry.where.push(where);
      grok.set(account.id, entry);
    }
    for (const key of snapshot.keysShared) {
      const entry = keys.get(key.id) ?? { models: key.models, where: [] };
      entry.where.push(where);
      keys.set(key.id, entry);
    }
  }
  const usedIn = (where: string[]) => `Used in ${where.join(", ")}`;
  return [
    ...[...codex.values()].map(({ account, where }) => (
      <ListRow
        key={`shared:codex:${account.id}`}
        leading={<ProviderTile provider="codex" size="lg" />}
        title={codexAccountName(account)}
        meta={[labels.organization, usedIn(where), planLabel(account.plan, "ChatGPT")]}
        cells={{ usage: cachedCodexUsage(account) }}
      />
    )),
    ...[...grok.values()].map(({ account, where }) => (
      <ListRow
        key={`shared:supergrok:${account.id}`}
        leading={<ProviderTile provider="supergrok" size="lg" />}
        title={superGrokAccountName(account)}
        meta={[labels.organization, usedIn(where), superGrokPlan(account)]}
      />
    )),
    ...[...keys.entries()].map(([id, { models, where }]) => (
      <ListRow
        key={`shared:gateway:${id}`}
        leading={<ProviderTile provider={id} size="lg" />}
        title={ORGANIZATION_PROVIDER_META[ORGANIZATION_KIND[id]].title}
        meta={[labels.organization, usedIn(where), models === 1 ? "1 model" : `${models} models`]}
      />
    )),
  ];
}

function OrganizationCodexRows({
  codex,
  labels,
  liveUsage,
  onOpen,
  onConnect,
}: {
  codex: OrganizationCodexSubscriptions;
  labels: ModelsScopeLabels;
  liveUsage: Readonly<Record<string, ReactNode>>;
  onOpen: (accountId: string) => void;
  onConnect: () => void;
}) {
  if (codex.loading) return <ListRowSkeleton count={1} />;
  if (codex.loadError) {
    return (
      <li className="col-span-full list-none px-3 py-3">
        <ErrorMessage
          variant="inline"
          title="Couldn't load the organization's Codex accounts."
          action={<RowButton onClick={() => void codex.refresh()}>Try again</RowButton>}
        >
          {codex.loadError}
        </ErrorMessage>
      </li>
    );
  }
  return (
    <>
      {codex.accounts.map((account) => (
        <OrganizationCodexRow
          key={account.id}
          codex={codex}
          account={account}
          labels={labels}
          usage={liveUsage[account.id] ?? cachedCodexUsage(account)}
          onOpen={() => onOpen(account.id)}
        />
      ))}
      {codex.pending ? (
        <ListRow
          leading={<ProviderTile provider="codex" size="lg" />}
          title="Signing in to ChatGPT…"
          meta={["Finish signing in to add the account"]}
          indicator="open"
          onOpen={onConnect}
        />
      ) : null}
    </>
  );
}

function OrganizationCodexRow({
  codex,
  account,
  labels,
  usage,
  onOpen,
}: {
  codex: OrganizationCodexSubscriptions;
  account: CodexAccount;
  labels: ModelsScopeLabels;
  usage: ReactNode;
  onOpen: () => void;
}) {
  const access = useConnectionAccess({
    client: codex.client,
    organizationId: codex.organizationId,
    kind: "codex",
    connectionId: account.id,
  });
  const primary = codex.accounts.length > 1 && account.id === codex.activeAccountId;
  const reconnect = account.status !== "active";
  return (
    <ListRow
      leading={<ProviderTile provider="codex" size="lg" />}
      title={codexAccountName(account)}
      titleAddon={primary ? <MetaChip variant="outline">Primary</MetaChip> : null}
      meta={[organizationReachLabel(labels, access.data), planLabel(account.plan, "ChatGPT")]}
      cells={{
        usage: reconnect ? null : !account.allocatorEnabled ? (
          <StatusBadge status="paused" variant="dot" />
        ) : (
          usage
        ),
      }}
      indicator={reconnect ? { kind: "attention", label: "Needs reconnect" } : "open"}
      onOpen={onOpen}
    />
  );
}

function OrganizationSuperGrokRows({
  grok,
  labels,
  onOpen,
}: {
  grok: SuperGrokSubscriptions;
  labels: ModelsScopeLabels;
  onOpen: (accountId: string) => void;
}) {
  const places = useMemo<SuperGrokPlaces>(
    () => ({
      scopeName: labels.everyone,
      organizationName: labels.organization,
      scope: labels,
      openAccount: onOpen,
      openConnect: () => undefined,
      openAccess: () => undefined,
      backToList: () => undefined,
    }),
    [labels, onOpen],
  );
  if (grok.loading) return <ListRowSkeleton count={1} />;
  if (grok.loadError) {
    return (
      <li className="col-span-full list-none px-3 py-3">
        <ErrorMessage
          variant="inline"
          title="Couldn't load the organization's SuperGrok accounts."
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
        <OrganizationSuperGrokRow
          key={account.id}
          grok={grok}
          account={account}
          places={places}
          onOpen={() => onOpen(account.id)}
        />
      ))}
    </>
  );
}

function OrganizationSuperGrokRow({
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
  const access = useConnectionAccess({
    client: grok.client,
    organizationId: grok.organizationId,
    kind: "supergrok",
    connectionId: account.id,
  });
  return (
    <SuperGrokRow
      grok={grok}
      account={account}
      places={places}
      scopeLabel={organizationReachLabel(places.scope, access.data)}
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

/** One workspace: its default model and Allowed models, opening its model page. */
function WorkspaceRow({
  workspace,
  snapshot,
  onOpen,
}: {
  workspace: ModelsWorkspace;
  snapshot: WorkspaceModelsSnapshot | "loading" | "error" | undefined;
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
      : typeof snapshot === "object"
        ? [snapshot.defaultModel, snapshot.allowed]
        : [];
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
