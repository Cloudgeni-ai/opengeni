import { KeyRoundIcon, PlusIcon } from "lucide-react";
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
  CodexSettingRows,
  codexListedCount,
  codexSectionVisible,
  type CodexPlaces,
} from "@/components/models/codex-models";
import { CodexProviderSwitchRow } from "@/components/models/codex-provider-switch-row";
import { ProviderTile, useModelsNavigation } from "@/components/models/models-ui";
import { RowButton } from "@/components/ui/page-actions";
import {
  SuperGrokAccessPage,
  SuperGrokAccountPage,
  SuperGrokAccountRows,
  SuperGrokConnectPage,
  SuperGrokSettingRows,
  superGrokListedCount,
  superGrokSectionVisible,
  type SuperGrokPlaces,
} from "@/components/models/supergrok-models";
import { useSuperGrokSubscriptions } from "@/components/supergrok-connection";
import { DetailPage, DetailPageHeader } from "@/components/ui/detail-page";
import { EmptyState } from "@/components/ui/empty-state";
import { ListRow, RowList } from "@/components/ui/list-row";
import { Section, SectionStack } from "@/components/ui/section";
import { SettingRowGroup } from "@/components/ui/setting-row";
import { useAppContext } from "@/context";
import { accountKeyOf, type ModelsView } from "@/lib/models-route";
import { FLUSH_DETAIL_PAGE_CLASS } from "@/components/ui/flush-form-page";
import { useFocusOnNavigation } from "@/lib/use-focus-on-navigation";

/* ----------------------------------------------------------------------------
   Workspace Settings > Models: the defaults, one flat list of the accounts
   that pay (each opens its own page), then each provider's settings.
   Connect, Allowed models and "Models it can serve" are their own pages.
   All provider data lives here so moving between these pages never re-reads
   a provider or drops a sign-in that is still going.
   -------------------------------------------------------------------------- */

export function WorkspaceModelsPage({
  workspaceId,
  workspaceName,
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
  organizationName: string;
  /** Workspace admins: default model, Allowed models, custom models. */
  canManageSettings: boolean;
  /** Connect, change and disconnect accounts. */
  canManageConnections: boolean;
  /** Organization owners and admins: a link to shared accounts in organization settings. */
  canManageOrganizationModels: boolean;
  account: string | undefined;
  view: ModelsView | undefined;
  onConnectionChange: () => void;
}) {
  const client = useAppContext().client;
  const scope = useMemo(() => ({ kind: "workspace" as const, workspaceId }), [workspaceId]);
  const nav = useModelsNavigation(scope, { account, view });
  const organizationNav = useModelsNavigation(
    useMemo(() => ({ kind: "organization" as const, workspaceId }), [workspaceId]),
    {},
  );
  const [revision, setRevision] = useState(0);
  const connectionChanged = () => {
    setRevision((value) => value + 1);
    onConnectionChange();
  };

  const codex = useCodexSubscriptions({ client, workspaceId, canManage: canManageConnections });
  const grok = useSuperGrokSubscriptions({ client, workspaceId, canManage: canManageConnections });
  const vercel = useProviderConnection({
    client,
    config: PROVIDER_CONNECTION_CONFIGS.vercel,
    workspaceId,
    canManageConnection: canManageConnections,
    canManageCustomModels: canManageSettings,
    onConnectionChange: connectionChanged,
  });
  const openrouter = useProviderConnection({
    client,
    config: PROVIDER_CONNECTION_CONFIGS.openrouter,
    workspaceId,
    canManageConnection: canManageConnections,
    canManageCustomModels: canManageSettings,
    onConnectionChange: connectionChanged,
  });
  const gateways: Record<"vercel" | "openrouter", ProviderConnection> = { vercel, openrouter };

  const backToList = () => nav.openAccount(undefined);
  const codexPlaces: CodexPlaces = {
    workspaceName,
    organizationName,
    openAccount: (id) => nav.openAccount(`codex:${id}`),
    openConnect: () => nav.openView("connect:codex"),
    openAccess: (id) => nav.openView("model-access", `codex:${id}`),
    backToList,
    manageInOrganization: canManageOrganizationModels
      ? (id) => organizationNav.openAccount(`codex:${id}`)
      : undefined,
  };
  const grokPlaces: SuperGrokPlaces = {
    scopeName: workspaceName,
    organizationName,
    openAccount: (id) => nav.openAccount(`supergrok:${id}`),
    openConnect: () => nav.openView("connect:supergrok"),
    openAccess: (id) => nav.openView("model-access", `supergrok:${id}`),
    backToList,
  };

  const key = accountKeyOf(account);
  const pageKey = `${view ?? ""}|${account ?? ""}`;
  const root = useFocusOnNavigation(pageKey, {
    onList: pageKey === "|",
    rememberTitle: Boolean(account) && !view,
  });

  let page: ReactNode;
  if (view === "connect") {
    page = (
      <ConnectPickerPage
        codexAvailable={canManageConnections}
        grokAvailable={!grok.unavailable}
        gateways={gateways}
        scopeName={workspaceName}
        onClose={backToList}
        onPick={(provider) => nav.openView(`connect:${provider}`)}
        onOpenConnected={(provider) => nav.openAccount(`gateway:${provider}`)}
      />
    );
  } else if (view === "connect:codex") {
    page = <CodexConnectPage codex={codex} places={codexPlaces} onClose={backToList} />;
  } else if (view === "connect:supergrok") {
    page = <SuperGrokConnectPage grok={grok} places={grokPlaces} onClose={backToList} />;
  } else if (view === "connect:vercel" || view === "connect:openrouter") {
    const id = view === "connect:vercel" ? "vercel" : "openrouter";
    page = (
      <ProviderConnectPage
        state={gateways[id]}
        onClose={backToList}
        onConnected={() => nav.openAccount(`gateway:${id}`)}
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
    page =
      key.provider === "codex" ? (
        <CodexAccessPage codex={codex} accountId={key.id} onClose={back} />
      ) : key.provider === "supergrok" ? (
        <SuperGrokAccessPage grok={grok} accountId={key.id} client={client} onClose={back} />
      ) : (
        <ProviderAccessPage state={gateways[key.id as "vercel" | "openrouter"]} onClose={back} />
      );
  } else if (key?.provider === "codex") {
    page = <CodexAccountPage codex={codex} accountId={key.id} places={codexPlaces} />;
  } else if (key?.provider === "supergrok") {
    page = (
      <SuperGrokAccountPage grok={grok} accountId={key.id} places={grokPlaces} client={client} />
    );
  } else if (key?.provider === "gateway") {
    page = (
      <ProviderConnectionPage
        state={gateways[key.id]}
        scopeName={workspaceName}
        onBack={backToList}
        onConnect={() => nav.openView(`connect:${key.id}`)}
        onEditAccess={() => nav.openView("model-access", account)}
      />
    );
  } else {
    const listed = [
      codexListedCount(codex),
      superGrokListedCount(grok),
      ...(["openrouter", "vercel"] as const).map((id) => (providerListed(gateways[id]) ? 1 : 0)),
    ];
    const loadingAccounts =
      codex.loading ||
      (!grok.unavailable && grok.loading) ||
      (["openrouter", "vercel"] as const).some(
        (id) => !gateways[id].hidden && !gateways[id].settled,
      );
    page = (
      <ModelsList
        workspaceId={workspaceId}
        revision={revision}
        canManageSettings={canManageSettings}
        canManageConnections={canManageConnections}
        empty={!loadingAccounts && listed.every((count) => count === 0)}
        onEditAllowed={() => nav.openView("allowed-models")}
        onConnect={() => nav.openView("connect")}
        accounts={
          <RowList label="Accounts" columns={ACCOUNT_COLUMNS} flush>
            <CodexAccountRows codex={codex} places={codexPlaces} />
            <SuperGrokAccountRows grok={grok} places={grokPlaces} />
            {(["openrouter", "vercel"] as const)
              .filter((id) => providerListed(gateways[id]))
              .map((id) => (
                <ProviderConnectionRow
                  key={id}
                  state={gateways[id]}
                  onOpen={() => nav.openAccount(`gateway:${id}`)}
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
    );
  }

  return (
    <div ref={root} className="min-w-0">
      {page}
    </div>
  );
}

function ModelsList({
  workspaceId,
  revision,
  canManageSettings,
  canManageConnections,
  empty,
  onEditAllowed,
  onConnect,
  accounts,
  providerSections,
}: {
  workspaceId: string;
  revision: number;
  canManageSettings: boolean;
  canManageConnections: boolean;
  /** Nothing is connected (and nothing is still loading). */
  empty: boolean;
  onEditAllowed: () => void;
  onConnect: () => void;
  accounts: ReactNode;
  providerSections: ReactNode;
}) {
  const policy = useModelAccessPolicy(workspaceId);
  const firstRevision = useRef(revision);
  useEffect(() => {
    if (revision !== firstRevision.current) void policy.reload();
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- reload only when a connection changed
  }, [revision]);
  return (
    <SectionStack>
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
      <Section
        title="Accounts"
        description="Subscriptions and API keys that pay for models here."
        action={
          canManageConnections && !empty ? (
            <RowButton onClick={onConnect}>
              <PlusIcon aria-hidden="true" />
              Connect account
            </RowButton>
          ) : null
        }
      >
        {empty ? (
          <EmptyState
            variant="page"
            icon={<KeyRoundIcon />}
            title="No accounts connected"
            description={
              canManageConnections
                ? "Connect a subscription or an API key to pay for models here."
                : "Someone who can manage connections can add a subscription or an API key."
            }
            action={
              canManageConnections ? (
                <RowButton onClick={onConnect}>
                  <PlusIcon aria-hidden="true" />
                  Connect account
                </RowButton>
              ) : null
            }
            className="pt-8 pb-6"
          />
        ) : (
          accounts
        )}
      </Section>
      {providerSections}
    </SectionStack>
  );
}

type ConnectChoice = "codex" | "supergrok" | "vercel" | "openrouter";

/**
 * Connect account: every provider as a row (logo, name, how you pay). A row
 * opens that provider's own connect step; a provider that is already
 * connected opens its page instead.
 */
export function ConnectPickerPage({
  codexAvailable,
  grokAvailable,
  gateways,
  scopeName,
  onClose,
  onPick,
  onOpenConnected,
}: {
  codexAvailable: boolean;
  grokAvailable: boolean;
  gateways?: Record<"vercel" | "openrouter", ProviderConnection> | undefined;
  /** Where the account pays: the workspace's name, or the organization's shared workspaces. */
  scopeName: string;
  onClose: () => void;
  onPick: (provider: ConnectChoice) => void;
  /** Opens a provider that is already connected. */
  onOpenConnected?: ((provider: "vercel" | "openrouter") => void) | undefined;
}) {
  const choices: {
    id: ConnectChoice;
    title: string;
    summary: string;
    connected?: boolean;
  }[] = [
    ...(codexAvailable
      ? [{ id: "codex" as const, title: "Codex", summary: "Pay with your ChatGPT plan" }]
      : []),
    ...(grokAvailable
      ? [{ id: "supergrok" as const, title: "SuperGrok", summary: "Pay with your SuperGrok plan" }]
      : []),
    ...(gateways
      ? (["openrouter", "vercel"] as const)
          .filter((id) => gateways[id].canManageConnection)
          .map((id) => ({
            id,
            title: gateways[id].config.title,
            summary:
              id === "openrouter"
                ? "Pay per token through OpenRouter"
                : "Pay per token through Vercel",
            connected: gateways[id].connected,
          }))
      : []),
  ];
  return (
    <DetailPage back={{ label: "Models", onClick: onClose }} className={FLUSH_DETAIL_PAGE_CLASS}>
      <DetailPageHeader
        title="Connect account"
        meta={
          <p className="m-0 text-sm text-fg-muted">{`Choose what pays for models in ${scopeName}.`}</p>
        }
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
            {choices.map((choice) => (
              <ListRow
                key={choice.id}
                leading={<ProviderTile provider={choice.id} size="lg" />}
                title={choice.title}
                meta={[choice.connected ? "Connected" : choice.summary]}
                indicator="open"
                onOpen={() =>
                  choice.connected && (choice.id === "vercel" || choice.id === "openrouter")
                    ? onOpenConnected?.(choice.id)
                    : onPick(choice.id)
                }
              />
            ))}
          </RowList>
        )}
      </div>
    </DetailPage>
  );
}
