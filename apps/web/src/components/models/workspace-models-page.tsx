import type { OrganizationModelProviderKind, WorkspaceModelCatalogModel } from "@opengeni/sdk";
import { KeyRoundIcon, PlusIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

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
import { codexUsageReadings, useCodexSubscriptions } from "@/components/codex-connection";
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
  ConnectAudienceFields,
  EVERYONE,
  applyConnectAudience,
  audienceBlockedReason,
  useOrganizationWorkspaces,
  type ConnectAudience,
} from "@/components/models/connect-audience";
import {
  ModelsFormPage,
  ModelsListLabelProvider,
  ProviderTile,
  modelsScopeLabels,
  organizationReachLabel,
  useModelsNavigation,
  type ModelsScopeLabels,
} from "@/components/models/models-ui";
import {
  GATEWAYS,
  OrganizationModelsList,
  possessive,
  readyOrganizationKeyModels,
  type ModelsWorkspace,
} from "@/components/models/organization-models-list";
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
import { RowButton } from "@/components/ui/page-actions";
import { Section, SectionStack } from "@/components/ui/section";
import { SettingRowGroup } from "@/components/ui/setting-row";
import { UsageReadout } from "@/components/ui/usage-meter";
import { useAppContext } from "@/context";
import { billingClassForModel, payerSummaryForModel } from "@/lib/model-policy";
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
   Organization settings > Models: every model setting in one place. This
   component owns the provider data and routes between the page's views:

   - the organization's list (organization-models-list.tsx): accounts,
     workspaces, organization-wide provider settings;
   - one workspace's model page (`?workspace=`): its Default model, Allowed
     models, the accounts it uses and its Codex and SuperGrok settings;
   - an account's page, Connect account and each form, opened from either.

   It is rendered for one workspace: the one whose page is open, or the one
   the settings URL goes through. Organization owners and admins connect
   organization accounts and choose which workspaces use them; accounts owned
   by one workspace stay where they are genuinely needed (Codex Apps, usage
   limit resets, a key in a Personal workspace, workspace admins who can't
   connect for everyone). All provider data lives here so moving between
   these pages never re-reads a provider or drops a sign-in that is still going.
   -------------------------------------------------------------------------- */

/** The organization connection kind behind each API-key provider. */
const ORGANIZATION_KIND: Record<GatewayId, OrganizationModelProviderKind> = {
  vercel: "vercel_gateway",
  openrouter: "openrouter",
  anthropic: "anthropic",
  claude_subscription: "claude_subscription",
};

export function WorkspaceModelsPage({
  anchorWorkspaceId,
  workspacePage,
  workspaces,
  workspacesError = false,
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
  /** The workspace the settings URL goes through (`/workspaces/<id>/organization`). */
  anchorWorkspaceId: string;
  /** `?workspace=` names this workspace: its model page, or a page opened from it. */
  workspacePage: boolean;
  /** The workspaces on the organization's list. */
  workspaces: readonly ModelsWorkspace[];
  /** The organization's workspace list couldn't be read. */
  workspacesError?: boolean;
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
  const scope = useMemo(
    () => ({ anchorWorkspaceId, workspaceId: workspacePage ? workspaceId : undefined }),
    [anchorWorkspaceId, workspaceId, workspacePage],
  );
  const nav = useModelsNavigation(scope, { account, view });
  const [revision, setRevision] = useState(0);
  const connectionChanged = () => {
    setRevision((value) => value + 1);
    onConnectionChange();
  };
  const labels = modelsScopeLabels(organizationName, personal, workspaceName);
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
    scope: labels,
    openAccount: (id) => nav.openAccount(accountKey("codex", id, true)),
    openConnect: (id) =>
      nav.openView("connect-org:codex", id ? accountKey("codex", id, true) : undefined),
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
    openConnect: (id) =>
      nav.openView("connect-org:supergrok", id ? accountKey("supergrok", id, true) : undefined),
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
  // Which workspaces can use what is being connected, per provider, kept
  // while moving between the connect pages.
  const [audiences, setAudiences] = useState<Partial<Record<string, ConnectAudience>>>({});
  const orgWorkspaces = useOrganizationWorkspaces(
    client,
    orgId,
    organizationAdmin && Boolean(step),
  );
  // Connect account opened from a workspace's page starts from that workspace.
  const connectHere = workspacePage ? { id: workspaceId, name: workspaceName, personal } : null;
  const pageKey = `${view ?? ""}|${account ?? ""}`;
  const root = useFocusOnNavigation(pageKey, {
    onList: pageKey === "|",
    rememberTitle: Boolean(account) && !view,
  });

  // Connecting for everyone, and managing the organization's accounts, is
  // for its owners and admins; an organization URL opened by anyone else
  // shows the list instead.
  const organizationPage = Boolean(key?.organization || step?.organization);
  // A connected organization key is replaced on its own step, not connected anew.
  const orgStepReplaces = (provider: string) =>
    (GATEWAYS as readonly string[]).includes(provider) &&
    orgGateways[provider as GatewayId].connected;
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
    // Owners and admins connect for the organization and choose the
    // workspaces on the next step. People who can only connect for this
    // workspace get that, with who can connect for everyone.
    page = organizationAdmin ? (
      <ConnectPickerPage
        target="organization"
        title="Connect account"
        subtitle={`Connect it once for ${organizationName}, then choose which workspaces can use it.`}
        codexAvailable
        grok={orgGrok.unavailable ? "not_enabled" : "available"}
        gateways={orgGateways}
        personal={workspacePage && personal}
        onClose={backToList}
        onPick={(provider) => nav.openView(`connect-org:${provider}`)}
        onOpenConnected={(provider) => nav.openAccount(accountKey("gateway", provider, true))}
      />
    ) : (
      <ConnectPickerPage
        target="workspace"
        title="Connect account"
        subtitle={workspaceOnlySubtitle({ workspaceName, organizationName, personal })}
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
        onClose={backToList}
        onPick={(provider) => nav.openView(`connect:${provider}`)}
        onOpenConnected={(provider) => nav.openAccount(accountKey("gateway", provider))}
      />
    );
  } else if (
    step?.organization &&
    organizationAdmin &&
    !account &&
    !orgStepReplaces(step.provider)
  ) {
    // A new organization account: choose which workspaces can use it, then
    // sign in or paste the key.
    const provider = step.provider;
    const accessKind =
      provider === "codex" || provider === "supergrok" ? provider : ORGANIZATION_KIND[provider];
    const audience: ConnectAudience = audiences[provider] ?? EVERYONE;
    const signingIn =
      provider === "codex"
        ? Boolean(orgCodex.pending || codex.pending)
        : provider === "supergrok"
          ? Boolean(orgGrok.pending || grok.pending)
          : false;
    const fields = (
      <>
        <ConnectAudienceFields
          kind={accessKind}
          organizationName={organizationName}
          here={connectHere}
          workspaces={orgWorkspaces.workspaces}
          value={audience}
          onChange={(next) => setAudiences((current) => ({ ...current, [provider]: next }))}
          disabled={signingIn}
        />
        {workspacePage &&
        personal &&
        canManageConnections &&
        (GATEWAYS as readonly string[]).includes(provider) ? (
          // An organization key can't reach a Personal workspace, so a key for
          // your own chats here is connected for this workspace instead.
          <p className="m-0 text-sm leading-5 text-fg-muted">
            To use a key in your Personal workspace,{" "}
            <button
              type="button"
              className="font-medium text-fg underline underline-offset-2 pointer-coarse:py-2"
              onClick={() => nav.openView(`connect:${provider}`)}
            >
              connect it for your Personal workspace
            </button>{" "}
            instead.
          </p>
        ) : null}
      </>
    );
    const blockedReason = audienceBlockedReason(audience);
    const limitAfterConnect = async (connectionId: string | null, isNew: boolean) => {
      if (!connectionId || !isNew) return;
      const applied = await applyConnectAudience(
        client,
        { organizationId: orgId, kind: accessKind, connectionId },
        audience,
      );
      if (!applied) {
        toast.error("Connected, but it couldn't be limited to those workspaces", {
          description: "Every workspace can use it until you change Available in on its page.",
        });
      }
    };
    if (provider === "codex") {
      const existing = new Set(orgCodex.accounts.map((each) => each.id));
      page = (
        <OrgCodexConnectPage
          codex={orgCodex}
          places={orgCodexPlaces}
          onClose={backToList}
          fields={fields}
          blockedReason={blockedReason}
          onAccountConnected={(id) => limitAfterConnect(id, !existing.has(id ?? ""))}
        />
      );
    } else if (provider === "supergrok") {
      const existing = new Set(orgGrok.accounts.map((each) => each.id));
      page = (
        <SuperGrokConnectPage
          grok={orgGrok}
          places={orgGrokPlaces}
          onClose={backToList}
          fields={fields}
          blockedReason={blockedReason}
          onAccountConnected={(id) => limitAfterConnect(id, !existing.has(id ?? ""))}
        />
      );
    } else {
      page = (
        <ProviderConnectPage
          key={`org:${provider}`}
          state={orgGateways[provider]}
          onClose={backToList}
          onConnected={() => nav.openAccount(accountKey("gateway", provider, true))}
          fields={fields}
          blockedReason={blockedReason}
          afterSave={() => limitAfterConnect("current", true)}
          footerStart={false}
        />
      );
    }
  } else if (step?.organization) {
    // Signing an organization account in again, or replacing its key.
    const provider = step.provider;
    const back = account ? () => nav.openAccount(account) : backToList;
    page =
      provider === "codex" ? (
        <OrgCodexConnectPage codex={orgCodex} places={orgCodexPlaces} onClose={back} />
      ) : provider === "supergrok" ? (
        <SuperGrokConnectPage grok={orgGrok} places={orgGrokPlaces} onClose={back} />
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
        />
      );
  } else if (step) {
    // An account owned by this workspace. Owners and admins reach it only
    // where one is needed (Codex Apps, usage limit resets, a key in a Personal
    // workspace, a team with its own key), so the page says what it is.
    const provider = step.provider;
    const note = organizationAdmin ? (
      <p className="m-0 text-sm leading-5 text-fg-muted">
        {workspaceOwnedNote(provider, { workspaceName, personal })}
      </p>
    ) : undefined;
    page =
      provider === "codex" ? (
        <CodexConnectPage codex={codex} places={codexPlaces} onClose={backToList} fields={note} />
      ) : provider === "supergrok" ? (
        <SuperGrokConnectPage grok={grok} places={grokPlaces} onClose={backToList} fields={note} />
      ) : (
        <ProviderConnectPage
          key={provider}
          state={gateways[provider]}
          onClose={backToList}
          onConnected={() => nav.openAccount(accountKey("gateway", provider))}
          fields={note}
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
        resets={
          (codex.overviewMap[key.id]?.resetCredits.availableCount ?? 0) > 0 ? (
            <OrganizationResetsNote
              count={codex.overviewMap[key.id]?.resetCredits.availableCount ?? null}
              workspaceName={personal ? "your Personal workspace" : workspaceName}
              onConnect={canManageConnections ? () => nav.openView("connect:codex") : undefined}
            />
          ) : undefined
        }
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
      <OrganizationGatewayPage
        state={orgGateways[key.id]}
        labels={labels}
        footnote={
          canManageConnections ? (
            <WorkspaceKeyFootnote
              title={orgGateways[key.id].config.title}
              workspaceName={workspaceName}
              personal={personal}
              onConnect={() => nav.openView(`connect:${key.id}`)}
            />
          ) : null
        }
        onBack={backToList}
        onConnect={() => nav.openView(`connect-org:${key.id}`, account)}
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
  } else if (!workspacePage) {
    page = (
      <OrganizationModelsList
        client={client}
        organizationName={organizationName}
        administrator={organizationAdmin}
        claudeEnabled={claudeEnabled}
        labels={labels}
        workspaces={workspaces}
        workspacesError={workspacesError}
        credits={credits}
        creditsReturnLabel={organizationName}
        anchorWorkspaceId={anchorWorkspaceId}
        orgCodex={orgCodex}
        orgGrok={orgGrok}
        orgGateways={orgGateways}
        liveCodexUsage={Object.fromEntries(
          codex.accounts
            .filter((candidate) => candidate.source === "organization")
            .map((candidate) => [candidate.id, codexUsageReadout(codex, candidate.id)]),
        )}
        onOpenAccount={(target) => nav.openAccount(target)}
        onOpenWorkspace={(id, target) => nav.openWorkspace(id, target)}
        onConnect={() => nav.openView("connect")}
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
            (claudeEnabled || id !== "claude_subscription") &&
            readyOrganizationKeyModels(catalog.models, id) > 0,
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
      <DetailPage
        back={{ label: "Models", onClick: () => nav.openWorkspace(undefined) }}
        className={FLUSH_DETAIL_PAGE_CLASS}
      >
        <DetailPageHeader
          title={personal ? "Your Personal workspace" : workspaceName}
          meta={personal ? ["Only you"] : undefined}
        />
        <div className="mt-8 min-w-0">
          <ModelsList
            workspaceId={workspaceId}
            revision={revision}
            canManageSettings={canManageSettings}
            canConnect={canConnect}
            empty={!loadingAccounts && listed.every((count) => count === 0)}
            describePayer={(model) =>
              payerPhrase(model, {
                organizationName,
                codexFromOrganization: codex.source?.effectiveSource === "organization",
                grokFromOrganization: grok.inherited,
              })
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
                  workspaceId={anchorWorkspaceId}
                  workspaceName={workspaceName}
                  scope={labels.everyone}
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
                      modelCount(readyOrganizationKeyModels(catalog.models, id)),
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
                {codexSectionVisible(codex) ? (
                  <Section title="Codex">
                    <CodexSettingRows
                      codex={codex}
                      places={codexPlaces}
                      onConnectForWorkspace={
                        canManageConnections ? () => nav.openView("connect:codex") : undefined
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
                {superGrokSectionVisible(grok) ? (
                  <Section title="SuperGrok">
                    <SuperGrokSettingRows grok={grok} />
                  </Section>
                ) : null}
              </>
            }
          />
        </div>
      </DetailPage>
    );
  }

  return (
    <ModelsListLabelProvider
      value={workspacePage ? (personal ? "Your Personal workspace" : workspaceName) : "Models"}
    >
      <div ref={root} className="min-w-0">
        {page}
      </div>
    </ModelsListLabelProvider>
  );
}

/** A Codex account's weekly usage, as a workspace that uses it reads it. */
function codexUsageReadout(
  codex: ReturnType<typeof useCodexSubscriptions>,
  accountId: string,
): ReactNode {
  const live = codex.usageMap[accountId];
  if (!live?.usage) return null;
  const weekly = codexUsageReadings(live.usage, codex.now)[0]!;
  return weekly.percent === null ? null : (
    <UsageReadout percent={weekly.percent} window="this week" resetsLabel={weekly.resetsLabel} />
  );
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
      scope={organizationReachLabel(labels, access.data)}
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

/** An organization key's page, tagged with where it's available. */
function OrganizationGatewayPage({
  state,
  labels,
  footnote,
  onBack,
  onConnect,
  onEditAccess,
}: {
  state: ProviderConnection;
  labels: ModelsScopeLabels;
  footnote?: ReactNode;
  onBack: () => void;
  onConnect: () => void;
  onEditAccess: () => void;
}) {
  const access = useConnectionAccess({ ...state.accessTarget, enabled: state.connected });
  return (
    <ProviderConnectionPage
      state={state}
      scopeName={organizationReachLabel(labels, access.data)}
      onBack={onBack}
      onConnect={onConnect}
      onEditAccess={onEditAccess}
      footnote={state.connected ? footnote : null}
    />
  );
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
}: {
  workspaceName: string;
  organizationName: string;
  personal: boolean;
}): string {
  return personal
    ? `Only you use what you connect here. Owners and admins of ${organizationName} connect accounts for everyone.`
    : `Choose what pays for models in ${workspaceName}. Only owners and admins of ${organizationName} can connect for everyone.`;
}

/** What an account owned by this workspace is, on its connect step, for owners and admins. */
function workspaceOwnedNote(
  provider: string,
  where: { workspaceName: string; personal: boolean },
): string {
  const here = where.personal ? "your Personal workspace" : where.workspaceName;
  if (provider === "codex") {
    return `This account will belong to ${here} only. Use it for Codex Apps or to redeem usage limit resets. To share an account with other workspaces, connect it from Connect account.`;
  }
  if (where.personal && provider !== "supergrok") {
    return "This key will belong to your Personal workspace, so only you use it. Organization API keys can't be used in Personal workspaces.";
  }
  return `This ${provider === "supergrok" ? "account" : "key"} will belong to ${here} only, for a team that pays with its own. To share one with other workspaces, connect it from Connect account.`;
}

/**
 * On an organization Codex account's page: its usage limit resets, which
 * only an account owned by a workspace can redeem.
 */
function OrganizationResetsNote({
  count,
  workspaceName,
  onConnect,
}: {
  count: number | null;
  workspaceName: string;
  onConnect?: (() => void) | undefined;
}) {
  if (!count || count <= 0) return null;
  return (
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
      <p className="m-0 min-w-0 flex-1 basis-64 text-sm leading-5 text-fg-muted">
        {`${count === 1 ? "1 usage limit reset is" : `${count} usage limit resets are`} waiting on this ChatGPT account. Resets can only be redeemed from an account owned by a workspace: connect the same ChatGPT account for ${workspaceName} to redeem them.`}
      </p>
      {onConnect ? <RowButton onClick={onConnect}>Connect for this workspace</RowButton> : null}
    </div>
  );
}

/** On an organization key's page: when a key owned by this workspace is the right tool. */
function WorkspaceKeyFootnote({
  title,
  workspaceName,
  personal,
  onConnect,
}: {
  title: string;
  workspaceName: string;
  personal: boolean;
  onConnect: () => void;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
      <p className="m-0 min-w-0 flex-1 basis-64 text-sm leading-5 text-fg-muted">
        {personal
          ? `Organization API keys can't be used in Personal workspaces. To use ${title} in yours, connect a key for it.`
          : `A team that pays with its own ${title} key can connect one just for ${workspaceName}.`}
      </p>
      <RowButton onClick={onConnect}>
        {personal ? "Connect for your Personal workspace" : `Connect a key for ${workspaceName}`}
      </RowButton>
    </div>
  );
}

/** For people who can't add accounts: who can, in one calm line. */
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
    </div>
  );
}

function ModelsList({
  workspaceId,
  revision,
  canManageSettings,
  canConnect,
  empty,
  describePayer,
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
  /** Who pays for the default model, for its row: "paid with Acme's Opengeni credits". */
  describePayer: (model: WorkspaceModelCatalogModel) => string;
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
  // Defaults first: what a new chat here starts with, and who pays for it.
  return (
    <SectionStack>
      <Section title="Defaults">
        <SettingRowGroup>
          <DefaultSessionModelPreferenceRow
            key={`default-model:${workspaceId}:${revision}`}
            workspaceId={workspaceId}
            canManage={canManageSettings}
            describePayer={describePayer}
          />
          <AllowedModelsRow state={policy} onEdit={onEditAllowed} />
        </SettingRowGroup>
      </Section>
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
      {providerSections}
    </SectionStack>
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
   * workspace can't hold its own SuperGrok account (an owner or admin can
   * connect one for Personal workspaces). "hidden": the viewer can't connect it.
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
                  ? "Only owners and admins can add it for Personal workspaces"
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
            note: keysSkipPersonal ? "Not used in Personal workspaces" : undefined,
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
      </div>
    </DetailPage>
  );
}

// Kept for places that open a form page on the Models page outside this file.
export { ModelsFormPage };
