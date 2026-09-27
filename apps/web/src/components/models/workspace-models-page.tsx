import { PlusIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import {
  PROVIDER_CONNECTION_CONFIGS,
  ProviderAccessPage,
  ProviderConnectPage,
  ProviderConnectionPage,
  ProviderConnectionRow,
  providerStatus,
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
  CodexConnectPage,
  CodexGroup,
  type CodexPlaces,
} from "@/components/models/codex-models";
import { CodexProviderSwitchRow } from "@/components/models/codex-provider-switch-row";
import {
  ModelsFormPage,
  ProviderGroupHeader,
  ProviderMark,
  RowButton,
  useModelsNavigation,
} from "@/components/models/models-ui";
import {
  SuperGrokAccessPage,
  SuperGrokAccountPage,
  SuperGrokConnectPage,
  SuperGrokGroup,
  type SuperGrokPlaces,
} from "@/components/models/supergrok-models";
import { useSuperGrokSubscriptions } from "@/components/supergrok-connection";
import { ChoiceCard, ChoiceCards } from "@/components/ui/choice-cards";
import { RowList } from "@/components/ui/list-row";
import { Section, SectionStack } from "@/components/ui/section";
import { SettingRowGroup } from "@/components/ui/setting-row";
import { useAppContext } from "@/context";
import { accountKeyOf, type ModelsView } from "@/lib/models-route";

/* ----------------------------------------------------------------------------
   Workspace Settings > Models: what pays for new work here and which models it
   may use. One list of accounts grouped by provider; each account opens its
   own page; Connect, Allowed models and "Models it can serve" are form pages.
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
  const root = useFocusOnNavigation(pageKey, account);

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
        workspaceName={workspaceName}
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
    page = (
      <ModelsList
        workspaceId={workspaceId}
        revision={revision}
        canManageSettings={canManageSettings}
        canManageConnections={canManageConnections}
        onEditAllowed={() => nav.openView("allowed-models")}
        onConnect={() => nav.openView("connect")}
      >
        <RowList label="Subscriptions" columns={ACCOUNT_COLUMNS}>
          <CodexGroup codex={codex} places={codexPlaces} first />
          <SuperGrokGroup grok={grok} places={grokPlaces} />
        </RowList>
        <ApiKeyRows
          gateways={gateways}
          onOpen={(id) => nav.openAccount(`gateway:${id}`)}
          onConnect={(id) => nav.openView(`connect:${id}`)}
        />
      </ModelsList>
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
  onEditAllowed,
  onConnect,
  children,
}: {
  workspaceId: string;
  revision: number;
  canManageSettings: boolean;
  canManageConnections: boolean;
  onEditAllowed: () => void;
  onConnect: () => void;
  children: ReactNode;
}) {
  const policy = useModelAccessPolicy(workspaceId);
  const firstRevision = useRef(revision);
  useEffect(() => {
    if (revision !== firstRevision.current) void policy.reload();
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- reload only when a connection changed
  }, [revision]);
  return (
    <SectionStack>
      <Section title="New work">
        <SettingRowGroup>
          <DefaultSessionModelPreferenceRow
            key={`default-model:${workspaceId}:${revision}`}
            workspaceId={workspaceId}
            canManage={canManageSettings}
          />
          <AllowedModelsRow state={policy} canManage={canManageSettings} onEdit={onEditAllowed} />
          <CodexProviderSwitchRow workspaceId={workspaceId} canManage={canManageSettings} />
        </SettingRowGroup>
      </Section>
      <Section
        title="Model accounts"
        description="Subscriptions and API keys that pay for model use."
        action={
          canManageConnections ? (
            <RowButton onClick={onConnect}>
              <PlusIcon aria-hidden="true" />
              Connect account
            </RowButton>
          ) : null
        }
      >
        {children}
      </Section>
    </SectionStack>
  );
}

function ApiKeyRows({
  gateways,
  onOpen,
  onConnect,
}: {
  gateways: Record<"vercel" | "openrouter", ProviderConnection>;
  onOpen: (id: "vercel" | "openrouter") => void;
  onConnect: (id: "vercel" | "openrouter") => void;
}) {
  // Connected providers first.
  const order = (["openrouter", "vercel"] as const)
    .filter((id) => !gateways[id].hidden)
    .sort(
      (a, b) =>
        Number(providerStatus(gateways[b]).status === "connected") -
        Number(providerStatus(gateways[a]).status === "connected"),
    );
  if (order.length === 0) return null;
  return (
    <RowList label="API keys" className="mt-2 border-t border-border">
      <ProviderGroupHeader title="API keys" subtitle="Pay the provider per token" />
      {order.map((id) => (
        <ProviderConnectionRow
          key={id}
          state={gateways[id]}
          onOpen={() => onOpen(id)}
          onConnect={() => onConnect(id)}
        />
      ))}
    </RowList>
  );
}

/** Connect a model account: pick the provider, then its own step. */
export function ConnectPickerPage({
  codexAvailable,
  grokAvailable,
  gateways,
  scopeName,
  onClose,
  onPick,
}: {
  codexAvailable: boolean;
  grokAvailable: boolean;
  gateways?: Record<"vercel" | "openrouter", ProviderConnection> | undefined;
  scopeName: string;
  onClose: () => void;
  onPick: (provider: "codex" | "supergrok" | "vercel" | "openrouter") => void;
}) {
  const [provider, setProvider] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <ModelsFormPage
      title="Connect a model account"
      description={`Pick what pays for new work in ${scopeName}.`}
      onClose={onClose}
      submitLabel="Continue"
      onSubmit={() => {
        if (!provider) {
          setError("Choose a provider to connect.");
          return false;
        }
        onPick(provider as "codex" | "supergrok" | "vercel" | "openrouter");
        return false;
      }}
    >
      <ChoiceCards
        aria-label="Provider"
        value={provider}
        onValueChange={(value) => {
          setProvider(value);
          setError(null);
        }}
        error={error}
      >
        {codexAvailable ? (
          <ChoiceCard
            value="codex"
            icon={<ProviderMark provider="codex" className="size-4" />}
            title="Codex"
            meta="ChatGPT plan"
            description="Pay with a ChatGPT Plus or Pro plan. You sign in with OpenAI; OpenGeni never sees your password."
          />
        ) : null}
        {grokAvailable ? (
          <ChoiceCard
            value="supergrok"
            icon={<ProviderMark provider="supergrok" className="size-4" />}
            title="SuperGrok"
            meta="xAI plan"
            description="Pay for Grok models with a SuperGrok plan. You sign in with xAI."
          />
        ) : null}
        {gateways
          ? (["vercel", "openrouter"] as const).map((id) => {
              const state = gateways[id];
              if (!state.canManageConnection) return null;
              return (
                <ChoiceCard
                  key={id}
                  value={id}
                  icon={<ProviderMark provider={id} className="size-4" />}
                  title={state.config.title}
                  meta="API key"
                  description={state.config.summary}
                  disabled={state.connected}
                  disabledReason={
                    state.connected
                      ? `Already connected. To change its key, open ${state.config.title} in Model accounts.`
                      : undefined
                  }
                />
              );
            })
          : null}
      </ChoiceCards>
    </ModelsFormPage>
  );
}

/**
 * After a navigation, focus lands on the new page's title so keyboard and
 * screen reader users start at the top of it; back on the list, focus returns
 * to the row that was opened.
 */
function useFocusOnNavigation(pageKey: string, account: string | undefined) {
  const ref = useRef<HTMLDivElement>(null);
  const first = useRef(true);
  const lastAccount = useRef<string | undefined>(account);
  const lastTitle = useRef<string | null>(null);
  useEffect(() => {
    const root = ref.current;
    const returnTo = lastTitle.current;
    const previousAccount = lastAccount.current;
    lastAccount.current = account;
    if (first.current) {
      first.current = false;
    } else if (root) {
      const onList = pageKey === "|";
      if (onList && previousAccount && returnTo) {
        const row = Array.from(root.querySelectorAll<HTMLElement>("[data-slot=list-row]")).find(
          (each) => each.textContent?.includes(returnTo),
        );
        row?.querySelector<HTMLElement>("[data-row-action]")?.focus();
      } else if (!onList) {
        const heading = root.querySelector<HTMLElement>("h1");
        if (heading && !heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
        heading?.focus({ preventScroll: true });
        root.scrollIntoView?.({ block: "start" });
      }
    }
    // Remember the title of an account page, to find its row again.
    const heading = account ? root?.querySelector<HTMLElement>("h1")?.textContent : null;
    lastTitle.current = heading ?? lastTitle.current;
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- only when the page changes
  }, [pageKey]);
  return ref;
}
