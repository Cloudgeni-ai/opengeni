import { resolveWorkspaceSessionDefaults } from "@opengeni/contracts";
import type { OrganizationModelProviderKind, WorkspaceModelCatalogModel } from "@opengeni/sdk";
import { KeyRoundIcon, PlusIcon, UserIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import {
  PROVIDER_CONNECTION_CONFIGS,
  ProviderAccessPage,
  ProviderConnectPage,
  ProviderConnectionPage,
  ProviderConnectionRow,
  providerListed,
  useProviderConnection,
  type ProviderConnection,
} from "@/components/ai-gateway-connection";
import { useCodexSubscriptions } from "@/components/codex-connection";
import { useConnectionAccess } from "@/components/connection-access-settings";
import { DefaultSessionModelPreferenceRow } from "@/components/default-session-model";
import {
  AllowedModelsFormPage,
  AllowedModelsRow,
  useModelAccessPolicy,
} from "@/components/model-access-policy";
import {
  ACCOUNT_COLUMNS,
  CodexAccessPage,
  CodexAccountPage,
  CodexAccountRows,
  CodexConnectPage,
  CodexPoolNotice,
  CodexSettingRows,
  CodexUsage,
  codexListedCount,
  codexSectionVisible,
  type CodexPlaces,
  type OrganizationCodexPool,
} from "@/components/models/codex-models";
import { CodexProviderSwitchRow } from "@/components/models/codex-provider-switch-row";
import {
  ModelsFormPage,
  ProviderTile,
  modelsScopeLabels,
  useModelsNavigation,
  type ModelsScopeLabels,
} from "@/components/models/models-ui";
import { OpenGeniCreditsRow, useOpenGeniCredits } from "@/components/models/opengeni-credits-row";
import {
  OrgCodexAccessPage,
  OrgCodexAccountPage,
  OrgCodexConnectPage,
  reachesWorkspace,
  type OrgCodexPlaces,
} from "@/components/models/organization-codex-models";
import { ORGANIZATION_PROVIDER_META } from "@/components/models/provider-metadata";
import {
  SuperGrokAccessPage,
  SuperGrokAccountPage,
  SuperGrokAccountRows,
  SuperGrokConnectPage,
  SuperGrokSettingRows,
  superGrokListedCount,
  superGrokSectionVisible,
  type OrganizationSuperGrokPool,
  type SuperGrokPlaces,
} from "@/components/models/supergrok-models";
import { useOrganizationCodexSubscriptions } from "@/components/organization-codex-subscriptions";
import { useOrganizationProviderConnection } from "@/components/organization-model-provider-connection";
import { useSuperGrokSubscriptions } from "@/components/supergrok-connection";
import { DetailPage, DetailPageHeader } from "@/components/ui/detail-page";
import { EmptyState } from "@/components/ui/empty-state";
import { FLUSH_DETAIL_PAGE_CLASS } from "@/components/ui/flush-form-page";
import { ListRow, RowList } from "@/components/ui/list-row";
import { MetaChip } from "@/components/ui/meta-chip";
import { PageHeader } from "@/components/ui/page-header";
import { RowButton } from "@/components/ui/page-actions";
import { Section, SectionStack } from "@/components/ui/section";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SettingNavRow, SettingRow, SettingRowGroup } from "@/components/ui/setting-row";
import { useAppContext } from "@/context";
import {
  availabilityReasonLabel,
  billingClassForModel,
  payerSummaryForModel,
} from "@/lib/model-policy";
import {
  accountKey,
  accountKeyOf,
  connectStepOf,
  type GatewayId,
  type ModelsView,
} from "@/lib/models-route";
import { useFocusOnNavigation } from "@/lib/use-focus-on-navigation";
import { useWorkspaceModelCatalog } from "@/lib/use-workspace-model-catalog";

/* ----------------------------------------------------------------------------
   Settings > Models: the one page for what a workspace can use and who pays.
   One flat list of accounts, each tagged by who it is for ("Everyone in
   Acme", "This workspace only", "Only you"); then the workspace's own
   defaults and each provider's settings. Connect, Allowed models, each
   account and "Models it can serve" are their own pages.

   Organization owners and admins connect for everyone by default and manage
   the organization's accounts from here (Primary, Available in, Models it
   can serve); "Only this workspace" is the secondary choice. Everyone else
   sees the list read-only, with who can add to it.

   All provider data lives here so moving between these pages never re-reads
   a provider or drops a sign-in that is still going.
   -------------------------------------------------------------------------- */

const GATEWAYS = ["claude_subscription", "anthropic", "openrouter", "vercel"] as const;

/** The organization connection kind behind each API-key provider. */
const ORGANIZATION_KIND: Record<GatewayId, OrganizationModelProviderKind> = {
  vercel: "vercel_gateway",
  openrouter: "openrouter",
  anthropic: "anthropic",
  claude_subscription: "claude_subscription",
};

/** The catalog provider id of an organization key's models. */
const ORGANIZATION_CATALOG_PROVIDER: Record<GatewayId, string> = {
  vercel: "organization-gateway",
  openrouter: "organization-openrouter",
  anthropic: "organization-anthropic",
  claude_subscription: "organization-claude-subscription",
};

export function WorkspaceModelsPage({
  workspaceId,
  workspaceName,
  personal = false,
  organizationId,
  organizationName,
  canManageSettings,
  canManageConnections,
  canManageOrganizationModels,
  account,
  view,
  onConnectionChange,
}: {
  workspaceId: string;
  workspaceName: string;
  /** A Personal workspace: private to one person, and organization API keys don't reach it. */
  personal?: boolean;
  /** The organization that owns the workspace. */
  organizationId?: string | undefined;
  /** Its name, or "your organization" when it has none. */
  organizationName: string;
  /** Workspace admins: default model, Allowed models, custom models. */
  canManageSettings: boolean;
  /** Connect, change and disconnect this workspace's own accounts. */
  canManageConnections: boolean;
  /** Organization owners and admins: connect for everyone, and manage the organization's accounts. */
  canManageOrganizationModels: boolean;
  account: string | undefined;
  view: ModelsView | undefined;
  onConnectionChange: () => void;
}) {
  const { client, clientConfig } = useAppContext();
  const claudeEnabled = clientConfig.claudeSubscriptionEnabled === true;
  const scope = useMemo(() => ({ kind: "workspace" as const, workspaceId }), [workspaceId]);
  const nav = useModelsNavigation(scope, { account, view });
  const [revision, setRevision] = useState(0);
  const connectionChanged = () => {
    setRevision((value) => value + 1);
    onConnectionChange();
  };
  const labels = modelsScopeLabels(organizationName, personal);
  const organizationAdmin = canManageOrganizationModels && Boolean(organizationId);
  const here = useMemo(() => ({ id: workspaceId, personal }), [workspaceId, personal]);

  /* This workspace's view of every provider. */
  const codex = useCodexSubscriptions({ client, workspaceId, canManage: canManageConnections });
  const grok = useSuperGrokSubscriptions({ client, workspaceId, canManage: canManageConnections });
  const workspaceGateway = (id: GatewayId, enabled = true) => ({
    client,
    config: PROVIDER_CONNECTION_CONFIGS[id],
    workspaceId,
    canManageConnection: canManageConnections,
    canManageCustomModels: canManageSettings,
    onConnectionChange: connectionChanged,
    enabled,
  });
  const gateways: Record<GatewayId, ProviderConnection> = {
    vercel: useProviderConnection(workspaceGateway("vercel")),
    openrouter: useProviderConnection(workspaceGateway("openrouter")),
    anthropic: useProviderConnection(workspaceGateway("anthropic")),
    claude_subscription: useProviderConnection(
      workspaceGateway("claude_subscription", claudeEnabled),
    ),
  };

  /* The organization's own accounts: read only for people who manage them. */
  const orgId = organizationId ?? "";
  const orgCodex = useOrganizationCodexSubscriptions({
    client,
    organizationId: orgId,
    enabled: organizationAdmin,
  });
  const orgGrok = useSuperGrokSubscriptions({
    client,
    organizationId: orgId,
    canManage: true,
    enabled: organizationAdmin,
  });
  const organizationGateway = (id: GatewayId, enabled = true) => ({
    client,
    organizationId: orgId,
    providerKind: ORGANIZATION_KIND[id],
    enabled: organizationAdmin && enabled,
  });
  const orgGateways: Record<GatewayId, ProviderConnection> = {
    vercel: useOrganizationProviderConnection(organizationGateway("vercel")),
    openrouter: useOrganizationProviderConnection(organizationGateway("openrouter")),
    anthropic: useOrganizationProviderConnection(organizationGateway("anthropic")),
    claude_subscription: useOrganizationProviderConnection(
      organizationGateway("claude_subscription", claudeEnabled),
    ),
  };
  const catalog = useWorkspaceModelCatalog(workspaceId);
  const credits = useOpenGeniCredits(organizationId);

  const backToList = () => nav.openAccount(undefined);
  const codexPlaces: CodexPlaces = {
    workspaceName,
    organizationName,
    scope: labels,
    openAccount: (id) => nav.openAccount(accountKey("codex", id)),
    openConnect: () => nav.openView("connect:codex"),
    openAccess: (id) => nav.openView("model-access", accountKey("codex", id)),
    backToList,
  };
  const orgCodexPlaces: OrgCodexPlaces = {
    organizationName,
    scopeLabel: labels.organization,
    openAccount: (id) => nav.openAccount(accountKey("codex", id, true)),
    openConnect: () => nav.openView("connect-org:codex"),
    openAccess: (id) => nav.openView("model-access", accountKey("codex", id, true)),
    backToList,
  };
  const grokPlaces: SuperGrokPlaces = {
    scopeName: workspaceName,
    organizationName,
    scope: labels,
    openAccount: (id) => nav.openAccount(accountKey("supergrok", id)),
    openConnect: () => nav.openView("connect:supergrok"),
    openAccess: (id) => nav.openView("model-access", accountKey("supergrok", id)),
    backToList,
  };
  const orgGrokPlaces: SuperGrokPlaces = {
    scopeName: organizationName,
    organizationName,
    scope: labels,
    openAccount: (id) => nav.openAccount(accountKey("supergrok", id, true)),
    openConnect: () => nav.openView("connect-org:supergrok"),
    openAccess: (id) => nav.openView("model-access", accountKey("supergrok", id, true)),
    backToList,
  };
  const codexPool: OrganizationCodexPool | null = organizationAdmin
    ? { codex: orgCodex, workspace: here, openAccount: orgCodexPlaces.openAccount }
    : null;
  const grokPool: OrganizationSuperGrokPool | null =
    organizationAdmin && !orgGrok.unavailable
      ? { grok: orgGrok, workspace: here, openAccount: orgGrokPlaces.openAccount }
      : null;

  const key = accountKeyOf(account);
  const step = connectStepOf(view);
  const pageKey = `${view ?? ""}|${account ?? ""}`;
  const root = useFocusOnNavigation(pageKey, {
    onList: pageKey === "|",
    rememberTitle: Boolean(account) && !view,
  });

  // Connecting for everyone, and managing the organization's accounts, is
  // for its owners and admins; an organization URL opened by anyone else
  // shows the list instead.
  const organizationPage = Boolean(key?.organization || step?.organization);
  let page: ReactNode;
  if (organizationPage && !organizationAdmin) {
    page = (
      <DetailPage
        back={{ label: "Models", onClick: backToList }}
        className={FLUSH_DETAIL_PAGE_CLASS}
      >
        <DetailPageHeader title="Only organization owners and admins can open this" />
        <p className="mt-2 text-sm text-fg-muted">
          {`Ask an owner or admin of ${organizationName} to change the organization's accounts.`}
        </p>
      </DetailPage>
    );
  } else if (
    !claudeEnabled &&
    (step?.provider === "claude_subscription" ||
      (key?.provider === "gateway" && key.id === "claude_subscription"))
  ) {
    page = (
      <DetailPage
        back={{ label: "Models", onClick: backToList }}
        className={FLUSH_DETAIL_PAGE_CLASS}
      >
        <DetailPageHeader title="Claude subscriptions are not enabled" />
      </DetailPage>
    );
  } else if (view === "connect" || view === "connect-workspace") {
    // Owners and admins connect for everyone first; "Only this workspace" is
    // its own page. People who can only connect here get that page directly.
    const forEveryone = view === "connect" && organizationAdmin;
    page = forEveryone ? (
      <ConnectPickerPage
        target="organization"
        title="Connect account"
        subtitle={`Everyone in ${organizationName} can use what you connect here.`}
        codexAvailable
        grok={orgGrok.unavailable ? "not_enabled" : "available"}
        gateways={orgGateways}
        personal={personal}
        onClose={backToList}
        onPick={(provider) => nav.openView(`connect-org:${provider}`)}
        onOpenConnected={(provider) => nav.openAccount(accountKey("gateway", provider, true))}
        workspaceOnly={
          canManageConnections ? (
            <WorkspaceOnlyRow
              workspaceName={workspaceName}
              personal={personal}
              onOpen={() => nav.openView("connect-workspace")}
            />
          ) : null
        }
      />
    ) : (
      <ConnectPickerPage
        target="workspace"
        title={
          view === "connect-workspace"
            ? personal
              ? "Connect for your Personal workspace only"
              : `Connect for ${workspaceName} only`
            : "Connect account"
        }
        subtitle={workspaceOnlySubtitle({
          workspaceName,
          organizationName,
          personal,
          canConnectForEveryone: organizationAdmin,
        })}
        codexAvailable={canManageConnections}
        codexNote={
          codex.source?.organizationAvailable
            ? `Replaces ${possessive(organizationName)} Codex accounts in ${personal ? "this workspace" : workspaceName}`
            : undefined
        }
        grok={
          !canManageConnections
            ? "hidden"
            : grok.unavailable
              ? "not_enabled"
              : personal
                ? "not_in_personal"
                : "available"
        }
        gateways={gateways}
        personal={personal}
        backLabel={view === "connect-workspace" ? "Connect account" : "Models"}
        onClose={view === "connect-workspace" ? () => nav.openView("connect") : backToList}
        onPick={(provider) => nav.openView(`connect:${provider}`)}
        onOpenConnected={(provider) => nav.openAccount(accountKey("gateway", provider))}
      />
    );
  } else if (step?.organization) {
    const provider = step.provider;
    page =
      provider === "codex" ? (
        <OrgCodexConnectPage codex={orgCodex} places={orgCodexPlaces} onClose={backToList} />
      ) : provider === "supergrok" ? (
        <SuperGrokConnectPage
          grok={orgGrok}
          places={orgGrokPlaces}
          onClose={backToList}
          footerStart={`Everyone in ${organizationName} can use it. You can limit it on the account page.`}
        />
      ) : (
        <ProviderConnectPage
          key={`org:${provider}`}
          state={orgGateways[provider]}
          onClose={() =>
            orgGateways[provider].connected
              ? nav.openAccount(accountKey("gateway", provider, true))
              : backToList()
          }
          onConnected={() => nav.openAccount(accountKey("gateway", provider, true))}
          footerStart={
            personal
              ? `Everyone in ${organizationName} can use it in shared workspaces. Personal workspaces use their own keys.`
              : `Everyone in ${organizationName} can use it. You can limit it on the account page.`
          }
        />
      );
  } else if (step) {
    const provider = step.provider;
    page =
      provider === "codex" ? (
        <CodexConnectPage codex={codex} places={codexPlaces} onClose={backToList} />
      ) : provider === "supergrok" ? (
        <SuperGrokConnectPage grok={grok} places={grokPlaces} onClose={backToList} />
      ) : (
        <ProviderConnectPage
          key={provider}
          state={gateways[provider]}
          onClose={backToList}
          onConnected={() => nav.openAccount(accountKey("gateway", provider))}
        />
      );
  } else if (view === "allowed-models") {
    page = (
      <AllowedModelsFormPage
        key={`allowed:${revision}`}
        workspaceId={workspaceId}
        canManage={canManageSettings}
        onClose={backToList}
      />
    );
  } else if (view === "model-access" && key) {
    const back = () => nav.openAccount(account);
    if (key.organization) {
      page =
        key.provider === "codex" ? (
          <OrgCodexAccessPage codex={orgCodex} accountId={key.id} onClose={back} />
        ) : key.provider === "supergrok" ? (
          <SuperGrokAccessPage grok={orgGrok} accountId={key.id} client={client} onClose={back} />
        ) : (
          <ProviderAccessPage state={orgGateways[key.id as GatewayId]} onClose={back} />
        );
    } else {
      page =
        key.provider === "codex" ? (
          <CodexAccessPage codex={codex} accountId={key.id} onClose={back} />
        ) : key.provider === "supergrok" ? (
          <SuperGrokAccessPage grok={grok} accountId={key.id} client={client} onClose={back} />
        ) : (
          <ProviderAccessPage state={gateways[key.id as GatewayId]} onClose={back} />
        );
    }
  } else if (key?.provider === "codex" && key.organization) {
    // Usage shows while new work here uses the account.
    const inUse = codex.accounts.find(
      (candidate) => candidate.id === key.id && candidate.source === "organization",
    );
    page = (
      <OrgCodexAccountPage
        codex={orgCodex}
        accountId={key.id}
        places={orgCodexPlaces}
        usage={inUse ? <CodexUsage codex={codex} account={inUse} /> : undefined}
      />
    );
  } else if (key?.provider === "codex") {
    page = <CodexAccountPage codex={codex} accountId={key.id} places={codexPlaces} />;
  } else if (key?.provider === "supergrok") {
    page = key.organization ? (
      <SuperGrokAccountPage
        grok={orgGrok}
        accountId={key.id}
        places={orgGrokPlaces}
        client={client}
      />
    ) : (
      <SuperGrokAccountPage grok={grok} accountId={key.id} places={grokPlaces} client={client} />
    );
  } else if (key?.provider === "gateway") {
    page = key.organization ? (
      <ProviderConnectionPage
        state={orgGateways[key.id]}
        scopeName={labels.organization}
        onBack={backToList}
        onConnect={() => nav.openView(`connect-org:${key.id}`)}
        onEditAccess={() => nav.openView("model-access", account)}
      />
    ) : (
      <ProviderConnectionPage
        state={gateways[key.id]}
        scopeName={labels.workspace}
        onBack={backToList}
        onConnect={() => nav.openView(`connect:${key.id}`)}
        onEditAccess={() => nav.openView("model-access", account)}
      />
    );
  } else {
    const listedGateways = GATEWAYS.filter((id) => providerListed(gateways[id]));
    const listedOrgGateways = organizationAdmin
      ? GATEWAYS.filter((id) => providerListed(orgGateways[id]))
      : [];
    // People who can't read the organization's keys see the ones that reach
    // this workspace, from the models it can use.
    const readyOrgKeys = organizationAdmin
      ? []
      : GATEWAYS.filter(
          (id) =>
            (claudeEnabled || id !== "claude_subscription") && readyModels(catalog.models, id) > 0,
        );
    const listed = [
      // Credits pay for credit models, so the list is never "nothing pays" on such a deployment.
      credits.visible ? 1 : 0,
      codexListedCount(codex, codexPool),
      superGrokListedCount(grok, grokPool),
      listedGateways.length,
      listedOrgGateways.length,
      readyOrgKeys.length,
    ];
    const loadingAccounts =
      codex.loading ||
      (!grok.unavailable && grok.loading) ||
      (organizationAdmin && orgCodex.loading) ||
      (!organizationAdmin && catalog.loading) ||
      GATEWAYS.some((id) => !gateways[id].hidden && !gateways[id].settled);
    const canConnect = organizationAdmin || canManageConnections;
    page = (
      <ModelsList
        workspaceId={workspaceId}
        revision={revision}
        canManageSettings={canManageSettings}
        canConnect={canConnect}
        empty={!loadingAccounts && listed.every((count) => count === 0)}
        summary={
          <DefaultModelLine
            workspaceId={workspaceId}
            models={catalog.models}
            loading={catalog.loading}
            defaultModel={catalog.defaultSelection?.model ?? null}
            organizationName={organizationName}
            codexFromOrganization={codex.source?.effectiveSource === "organization"}
            grokFromOrganization={grok.inherited}
          />
        }
        whoCanConnect={
          canConnect ? null : (
            <WhoCanConnect organizationName={organizationName} personal={personal} />
          )
        }
        onEditAllowed={() => nav.openView("allowed-models")}
        onConnect={() => nav.openView("connect")}
        accountsNote={
          <CodexPoolNotice
            codex={codex}
            places={codexPlaces}
            organizationAccountCount={organizationAdmin ? orgCodex.accounts.length : undefined}
          />
        }
        accounts={
          <RowList label="Accounts" columns={ACCOUNT_COLUMNS} flush>
            <OpenGeniCreditsRow
              credits={credits}
              workspaceId={workspaceId}
              workspaceName={workspaceName}
              scope={labels.organization}
            />
            <CodexAccountRows codex={codex} places={codexPlaces} organization={codexPool} />
            <SuperGrokAccountRows grok={grok} places={grokPlaces} organization={grokPool} />
            {listedOrgGateways.map((id) => (
              <OrganizationGatewayRow
                key={`org:${id}`}
                state={orgGateways[id]}
                labels={labels}
                workspace={here}
                workspaceName={workspaceName}
                onOpen={() => nav.openAccount(accountKey("gateway", id, true))}
              />
            ))}
            {readyOrgKeys.map((id) => (
              <ListRow
                key={`org:${id}`}
                leading={<ProviderTile provider={id} size="lg" />}
                title={ORGANIZATION_PROVIDER_META[ORGANIZATION_KIND[id]].title}
                meta={[
                  labels.organization,
                  id === "claude_subscription" ? "Claude plan" : "API key",
                  modelCount(readyModels(catalog.models, id)),
                ]}
              />
            ))}
            {listedGateways.map((id) => (
              <ProviderConnectionRow
                key={id}
                state={gateways[id]}
                scope={labels.workspace}
                onOpen={() => nav.openAccount(accountKey("gateway", id))}
              />
            ))}
          </RowList>
        }
        providerSections={
          <>
            {codexSectionVisible(codex) || (organizationAdmin && orgCodex.accounts.length >= 2) ? (
              <Section title="Codex">
                <CodexSettingRows
                  codex={codex}
                  places={codexPlaces}
                  organizationSharing={
                    organizationAdmin && orgCodex.accounts.length >= 2 ? (
                      <SettingRow
                        label={`Sharing work between ${possessive(organizationName)} accounts`}
                        description={`Spread work sends new chats to the account with the most usage left, in every workspace that uses ${possessive(organizationName)} accounts. Primary only uses the primary account.`}
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
                    ) : null
                  }
                  providerSwitch={
                    <CodexProviderSwitchRow
                      workspaceId={workspaceId}
                      canManage={canManageSettings}
                    />
                  }
                />
              </Section>
            ) : null}
            {superGrokSectionVisible(grok) || (grokPool && superGrokSectionVisible(orgGrok)) ? (
              <Section title="SuperGrok">
                {superGrokSectionVisible(grok) ? <SuperGrokSettingRows grok={grok} /> : null}
                {grokPool && superGrokSectionVisible(orgGrok) ? (
                  <SuperGrokSettingRows
                    grok={orgGrok}
                    label={`Sharing work between ${possessive(organizationName)} accounts`}
                  />
                ) : null}
              </Section>
            ) : null}
          </>
        }
      />
    );
  }

  return (
    <div ref={root} className="min-w-0">
      {page}
    </div>
  );
}

function readyModels(models: readonly WorkspaceModelCatalogModel[], id: GatewayId): number {
  const provider = ORGANIZATION_CATALOG_PROVIDER[id];
  return models.filter(
    (model) =>
      (model.provider === provider || model.id.startsWith(`${provider}/`)) &&
      model.credentialReadiness.status === "ready",
  ).length;
}

function modelCount(count: number): string {
  return count === 1 ? "1 model" : `${count} models`;
}

/**
 * An organization API key on this workspace's list, for people who manage
 * it. "Not in use" when its "Available in" leaves this workspace out, or this
 * is a Personal workspace (organization keys serve shared workspaces only).
 */
function OrganizationGatewayRow({
  state,
  labels,
  workspace,
  workspaceName,
  onOpen,
}: {
  state: ProviderConnection;
  labels: ModelsScopeLabels;
  workspace: { id: string; personal: boolean };
  workspaceName: string;
  onOpen: () => void;
}) {
  const access = useConnectionAccess({ ...state.accessTarget, enabled: state.connected });
  const reaches = state.connected ? reachesWorkspace(access.data, workspace) : null;
  return (
    <ProviderConnectionRow
      state={state}
      scope={labels.organization}
      setAside={
        reaches === false
          ? workspace.personal
            ? "Shared workspaces only"
            : `Not available in ${workspaceName}`
          : null
      }
      onOpen={onOpen}
    />
  );
}

/** The one line under the title: what a new chat here starts with, and who pays. */
function DefaultModelLine({
  workspaceId,
  models,
  loading,
  defaultModel,
  organizationName,
  codexFromOrganization,
  grokFromOrganization,
}: {
  workspaceId: string;
  models: readonly WorkspaceModelCatalogModel[];
  loading: boolean;
  /** The server's default when the workspace has none saved. */
  defaultModel: string | null;
  organizationName: string;
  codexFromOrganization: boolean;
  grokFromOrganization: boolean;
}) {
  const context = useAppContext();
  const workspace = context.workspaces.find((candidate) => candidate.id === workspaceId);
  const configured = resolveWorkspaceSessionDefaults(workspace?.settings);
  const modelId = configured?.model ?? defaultModel ?? context.clientConfig.defaultModel;
  if (loading) {
    return (
      <span
        aria-hidden="true"
        data-slot="skeleton"
        className="inline-block h-4 w-full max-w-md animate-pulse rounded-md bg-surface-2 align-middle"
      />
    );
  }
  const model = models.find((candidate) => candidate.id === modelId);
  if (!model) return null;
  const runnable = model.credentialReadiness.status === "ready" && model.availability.selectable;
  const reason = availabilityReasonLabel(model.availability.reason);
  return (
    <span data-testid="models-default-line">
      New chats here start with <span className="font-medium text-fg">{model.label}</span>,{" "}
      {payerPhrase(model, { organizationName, codexFromOrganization, grokFromOrganization })}.
      {runnable ? null : (
        <span className="text-status-waiting">
          {` It can't run right now${reason ? ` (${reason.toLocaleLowerCase()})` : ""}.`}
        </span>
      )}
    </span>
  );
}

/** "Acme's", "Acme Robotics'". */
export function possessive(name: string): string {
  return /s$/i.test(name) ? `${name}'` : `${name}'s`;
}

/** "paid by Acme's Codex subscription": who pays for a model, in words. */
export function payerPhrase(
  model: WorkspaceModelCatalogModel,
  where: {
    organizationName: string;
    codexFromOrganization: boolean;
    grokFromOrganization: boolean;
  },
): string {
  const organization = possessive(where.organizationName);
  switch (billingClassForModel(model)) {
    case "codex_subscription":
      return `paid by ${where.codexFromOrganization ? organization : "this workspace's"} Codex subscription`;
    case "supergrok_subscription":
      return `paid by ${where.grokFromOrganization ? organization : "this workspace's"} SuperGrok subscription`;
    case "claude_subscription":
      return `paid by ${model.provider.startsWith("organization-") ? organization : "this workspace's"} Claude subscription`;
    case "opengeni_credits":
      return model.cost === "free"
        ? "free on this server"
        : `paid with ${organization} Opengeni credits`;
    case "byok":
      return `billed to this workspace's ${model.providerLabel} key`;
    case "organization_byok":
      return `billed to ${organization} ${model.providerLabel} key`;
    default:
      return `paid by ${payerSummaryForModel(model).toLocaleLowerCase()}`;
  }
}

function workspaceOnlySubtitle({
  workspaceName,
  organizationName,
  personal,
  canConnectForEveryone,
}: {
  workspaceName: string;
  organizationName: string;
  personal: boolean;
  canConnectForEveryone: boolean;
}): string {
  if (canConnectForEveryone) {
    return personal
      ? "Only you use what you connect here. Everyone else keeps what the organization shares."
      : `For a team that needs its own billing or keys. Everyone else in ${organizationName} keeps using what the organization shares.`;
  }
  return personal
    ? "Only you use what you connect here."
    : `Choose what pays for models in ${workspaceName}. Only owners and admins of ${organizationName} can connect for everyone.`;
}

/** The secondary choice on Connect account: connect for this workspace only. */
function WorkspaceOnlyRow({
  workspaceName,
  personal,
  onOpen,
}: {
  workspaceName: string;
  personal: boolean;
  onOpen: () => void;
}) {
  return (
    <Section title="Only this workspace" className="mt-8">
      <SettingRowGroup>
        <SettingNavRow
          label={
            personal
              ? "Connect for your Personal workspace only"
              : `Connect for ${workspaceName} only`
          }
          description={
            personal
              ? "Only you use it. API keys for your own chats go here. A Codex account connected here replaces the organization's in your Personal workspace."
              : "For separate billing or keys for one team. A Codex account connected here replaces the organization's Codex accounts in this workspace."
          }
          onOpen={onOpen}
        />
      </SettingRowGroup>
    </Section>
  );
}

/**
 * For people who can't add accounts: who can, in one calm line. In a DEV
 * build it also shows where "Connect just for me" will go, clearly marked as
 * a preview; it is never a working control.
 */
function WhoCanConnect({
  organizationName,
  personal,
}: {
  organizationName: string;
  personal: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-3 pt-2 pb-3">
      <p className="m-0 text-sm leading-5 text-fg-muted">
        {personal
          ? `Only owners and admins of ${organizationName} can add accounts for everyone.`
          : `Only owners and admins of ${organizationName}, and admins of this workspace, can add accounts. Ask one of them to connect a subscription or an API key.`}
      </p>
      {import.meta.env.DEV ? <ConnectJustForMePreview /> : null}
    </div>
  );
}

/** DEV only: where phase 2's "Connect just for me" goes. Not a working control. */
function ConnectJustForMePreview() {
  return (
    <div
      data-testid="connect-just-for-me-preview"
      className="flex min-w-0 items-center gap-3 border-t border-border pt-3"
    >
      <UserIcon aria-hidden="true" className="size-4 shrink-0 text-fg-muted" />
      <div className="min-w-0 flex-1">
        <p className="m-0 text-sm font-medium text-fg">Connect just for me</p>
        <p className="m-0 text-xs leading-4.5 text-fg-muted">
          Your own subscription or key, for work you start in any workspace.
        </p>
      </div>
      <MetaChip>Preview: coming soon</MetaChip>
    </div>
  );
}

function ModelsList({
  workspaceId,
  revision,
  canManageSettings,
  canConnect,
  empty,
  summary,
  whoCanConnect,
  onEditAllowed,
  onConnect,
  accountsNote,
  accounts,
  providerSections,
}: {
  workspaceId: string;
  revision: number;
  canManageSettings: boolean;
  /** Can add an account, for everyone or for this workspace. */
  canConnect: boolean;
  /** Nothing is connected (and nothing is still loading). */
  empty: boolean;
  /** The line that says what a new chat starts with and who pays. */
  summary: ReactNode;
  /** For people who can't add accounts: who can. */
  whoCanConnect: ReactNode;
  onEditAllowed: () => void;
  onConnect: () => void;
  /** The line above the list that says which Codex accounts new work uses. */
  accountsNote?: ReactNode;
  accounts: ReactNode;
  providerSections: ReactNode;
}) {
  const policy = useModelAccessPolicy(workspaceId);
  const firstRevision = useRef(revision);
  useEffect(() => {
    if (revision !== firstRevision.current) void policy.reload();
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- reload only when a connection changed
  }, [revision]);
  const connect = (
    <RowButton variant="default" onClick={onConnect}>
      <PlusIcon aria-hidden="true" />
      Connect account
    </RowButton>
  );
  return (
    <>
      <PageHeader title="Models" description={summary} />
      <SectionStack className="mt-8">
        <Section
          title="Accounts"
          description="Subscriptions, API keys and credits that pay for models here."
          action={canConnect && !empty ? connect : null}
        >
          {empty ? (
            <EmptyState
              variant="page"
              icon={<KeyRoundIcon />}
              title="No accounts connected"
              description={
                canConnect
                  ? "Connect a subscription or an API key to pay for models here."
                  : "Nothing pays for models here yet."
              }
              action={canConnect ? connect : null}
              className="pt-8 pb-6"
            />
          ) : (
            <>
              {accountsNote}
              {accounts}
            </>
          )}
          {whoCanConnect}
        </Section>
        <Section title="Defaults">
          <SettingRowGroup>
            <DefaultSessionModelPreferenceRow
              key={`default-model:${workspaceId}:${revision}`}
              workspaceId={workspaceId}
              canManage={canManageSettings}
            />
            <AllowedModelsRow state={policy} onEdit={onEditAllowed} />
          </SettingRowGroup>
        </Section>
        {providerSections}
      </SectionStack>
    </>
  );
}

type ConnectChoice =
  | "anthropic"
  | "claude_subscription"
  | "codex"
  | "supergrok"
  | "vercel"
  | "openrouter";

/**
 * Connect account: every provider as a row (logo, name, how you pay). A row
 * opens that provider's own connect step; a provider that is already
 * connected opens its page instead. A provider this server has turned off
 * stays in the list, disabled, so people know it exists.
 */
export function ConnectPickerPage({
  target,
  title,
  subtitle,
  codexAvailable,
  codexNote,
  grok,
  gateways,
  personal = false,
  backLabel = "Models",
  onClose,
  onPick,
  onOpenConnected,
  workspaceOnly,
}: {
  /** Who what's connected is for: everyone in the organization, or this workspace. */
  target: "organization" | "workspace";
  title: string;
  subtitle: string;
  codexAvailable: boolean;
  /** A second fact on the Codex row: what connecting it here changes. */
  codexNote?: string | undefined;
  /**
   * "not_enabled": this server has SuperGrok off. "not_in_personal": a Personal
   * workspace can't hold its own SuperGrok account (connect it for everyone
   * instead). "hidden": the viewer can't connect it.
   */
  grok: "available" | "not_enabled" | "not_in_personal" | "hidden";
  gateways?: Partial<Record<GatewayId, ProviderConnection>> | undefined;
  /** In a Personal workspace, organization keys serve shared workspaces only. */
  personal?: boolean;
  backLabel?: string;
  onClose: () => void;
  onPick: (provider: ConnectChoice) => void;
  /** Opens a provider that is already connected. */
  onOpenConnected?: ((provider: GatewayId) => void) | undefined;
  /** The secondary choice under the list: connect for this workspace only. */
  workspaceOnly?: ReactNode;
}) {
  const keysSkipPersonal = target === "organization" && personal;
  const choices: {
    id: ConnectChoice;
    title: string;
    summary: string;
    note?: string | undefined;
    connected?: boolean;
    unavailable?: string | undefined;
  }[] = [
    ...(codexAvailable
      ? [
          {
            id: "codex" as const,
            title: "Codex",
            summary: "Pay with your ChatGPT plan",
            note: codexNote,
          },
        ]
      : []),
    ...(grok !== "hidden"
      ? [
          {
            id: "supergrok" as const,
            title: "SuperGrok",
            summary: "Pay with your SuperGrok plan",
            unavailable:
              grok === "not_enabled"
                ? "Not enabled on this server"
                : grok === "not_in_personal"
                  ? "Connect it for everyone instead"
                  : undefined,
          },
        ]
      : []),
    ...(gateways
      ? GATEWAYS.filter((id) => gateways[id]?.canManageConnection && !gateways[id]?.hidden).map(
          (id) => ({
            id,
            title: gateways[id]!.config.title,
            summary:
              id === "anthropic" || id === "claude_subscription"
                ? gateways[id]!.config.summary
                : `Pay per token through ${gateways[id]!.config.title}`,
            note: keysSkipPersonal ? "Used in shared workspaces" : undefined,
            connected: gateways[id]!.connected,
          }),
        )
      : []),
  ];
  return (
    <DetailPage back={{ label: backLabel, onClick: onClose }} className={FLUSH_DETAIL_PAGE_CLASS}>
      <DetailPageHeader
        title={title}
        meta={<p className="m-0 text-sm text-fg-muted">{subtitle}</p>}
      />
      <div className="mt-6 min-w-0">
        {choices.length === 0 ? (
          <EmptyState
            variant="inline"
            title="Nothing to connect."
            description="Only people who can manage connections can add an account."
          />
        ) : (
          <RowList label="Providers" flush>
            {choices.map((choice) =>
              choice.unavailable ? (
                <ListRow
                  key={choice.id}
                  disabled
                  leading={<ProviderTile provider={choice.id} size="lg" />}
                  title={choice.title}
                  meta={[choice.summary]}
                  indicator={{ kind: "unavailable", label: choice.unavailable }}
                />
              ) : (
                <ListRow
                  key={choice.id}
                  leading={<ProviderTile provider={choice.id} size="lg" />}
                  title={choice.title}
                  meta={[choice.summary, choice.connected ? "Already connected" : choice.note]}
                  indicator="open"
                  onOpen={() =>
                    choice.connected &&
                    (choice.id === "vercel" ||
                      choice.id === "openrouter" ||
                      choice.id === "anthropic" ||
                      choice.id === "claude_subscription")
                      ? onOpenConnected?.(choice.id)
                      : onPick(choice.id)
                  }
                />
              ),
            )}
          </RowList>
        )}
        {workspaceOnly}
      </div>
    </DetailPage>
  );
}

// Kept for places that open a form page on the Models page outside this file.
export { ModelsFormPage };
