import type {
  ApiIntegrationAuthPreview,
  ApiIntegrationPreview,
  CreateOrganizationConnectorRequest,
  IntegrationSourceInput,
  OrganizationApiKeyPlacement,
  OrganizationConnector,
  OrganizationConnectorAvailability,
  OrganizationConnectorLogin,
  PreviewOrganizationApiIntegrationRequest,
  UpdateOrganizationConnectorRequest,
} from "@opengeni/contracts";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { PlugIcon, TrashIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import {
  ApiKeyFields,
  apiKeyDestination,
  apiKeyPlacements,
  EMPTY_API_KEY,
  type ApiKeyValues,
} from "@/components/capabilities/api-key-fields";
import {
  customApiAuthenticationMayBeRequired,
  normalizeCustomApiUrl,
} from "@/components/capabilities/custom-api-flow";
import { useOrganizationWorkspaces } from "@/components/models/connect-audience";
import type { ConnectorLocation } from "@/lib/organization-route";
import {
  WorkspaceReachFields,
  workspaceReachIsEmpty,
  workspaceReachSummary,
  type WorkspaceReach,
} from "@opengeni/react/app/components/workspace-reach";
import { capabilityLogoSource } from "@opengeni/react/app/components/capabilities/capability-logo-source";
import { DestructiveConfirm } from "@opengeni/react/app/components/ui/destructive-confirm";
import type { CapabilityCatalogItem } from "@opengeni/react/app/types";
import { userErrorText } from "@opengeni/react/ui/api-error";
import { errorMessage } from "@opengeni/contracts/values";
import { Button } from "@opengeni/react/ui/button";
import { ChoiceCard, ChoiceCards } from "@opengeni/react/ui/choice-cards";
import { DetailPage, DetailPageBody, DetailPageHeader } from "@opengeni/react/ui/detail-page";
import { DetailSection, DetailSkeleton } from "@opengeni/react/ui/detail-sheet";
import { DropdownMenuItem } from "@opengeni/react/ui/dropdown-menu";
import { EmptyState } from "@opengeni/react/ui/empty-state";
import { ErrorMessage } from "@opengeni/react/ui/error-message";
import { Field, FieldStack, TextInput } from "@opengeni/react/ui/field";
import { FLUSH_DETAIL_PAGE_CLASS, FlushFormPage } from "@opengeni/react/ui/flush-form-page";
import { ListRow, ListRowSkeleton, RowList } from "@opengeni/react/ui/list-row";
import { LogoTile } from "@opengeni/react/ui/logo-tile";
import { Notice } from "@opengeni/react/ui/notice";
import { MoreMenu, RowButton } from "@opengeni/react/ui/page-actions";
import { Section } from "@opengeni/react/ui/section";
import { SettingRow, SettingRowGroup } from "@opengeni/react/ui/setting-row";
import { StatusBadge } from "@opengeni/react/ui/status-badge";
import { Switch } from "@opengeni/react/ui/switch";
import { Toolbar, ToolbarSearch } from "@opengeni/react/ui/toolbar";

/* ----------------------------------------------------------------------------
   Organization connectors (Organization settings > Integrations). An owner or
   admin adds a connector (an MCP server, or an OpenAPI or GraphQL API) once
   and chooses which workspaces get it, instead of every workspace setting it
   up:

     Connectors                                         [Add connector]
     [logo] Linear       Each person signs in · All workspaces + Personal
     [logo] Docs search  Organization key · 2 workspaces              Off

   A connector's page says how people sign in and where it works, turns it
   off everywhere at once, replaces its organization key and removes it. A
   workspace can still turn it off for itself, and its own setup of the same
   connector wins there; both happen on that workspace's Connectors page (an
   API shows under its Custom APIs).
   -------------------------------------------------------------------------- */

type Client = OpenGeniBrowserClient;

export const CONNECTOR_LOGIN_LABEL: Record<OrganizationConnectorLogin, string> = {
  each_person: "Each person signs in",
  organization_key: "Organization key",
  none: "No sign-in",
};

const MANAGED_BY = "Organization owners and admins manage it.";
const EMPTY_REACH = "Pick at least one workspace, or choose All workspaces.";

function reachOf(availability: OrganizationConnectorAvailability): WorkspaceReach {
  return {
    workspaceIds: availability.allowedWorkspaceIds,
    personalWorkspaces: availability.allowPersonalWorkspaces,
  };
}

function availabilityOf(reach: WorkspaceReach): OrganizationConnectorAvailability {
  return {
    allowedWorkspaceIds: reach.workspaceIds === null ? null : [...reach.workspaceIds],
    allowPersonalWorkspaces: reach.personalWorkspaces,
  };
}

/** "All workspaces + Personal", "2 workspaces", "Personal workspaces only". */
export function connectorReachSummary(availability: OrganizationConnectorAvailability): string {
  return workspaceReachSummary(reachOf(availability), {
    owner: "organization",
    personalWorkspaces: "choice",
  });
}

function reachIsEmpty(reach: WorkspaceReach): boolean {
  return workspaceReachIsEmpty(reach, { owner: "organization", personalWorkspaces: "choice" });
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function protocolLabel(protocol: "openapi" | "graphql"): string {
  return protocol === "graphql" ? "GraphQL" : "OpenAPI";
}

/** "OpenAPI · 12 tools · api.example.com" */
export function apiPreviewSummary(preview: ApiIntegrationPreview): string {
  const tools = preview.tools.filter((tool) => !tool.deprecated).length;
  return `${protocolLabel(preview.protocol)} · ${tools} ${tools === 1 ? "tool" : "tools"} · ${hostOf(preview.baseUrl)}`;
}

/** The organization's connectors, read once and kept current by this page's own changes. */
function useOrganizationConnectors(client: Client, organizationId: string) {
  const [connectors, setConnectors] = useState<OrganizationConnector[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setError(null);
    client
      .listOrganizationConnectors(organizationId)
      .then((value) => {
        if (live) setConnectors(value);
      })
      .catch((caught: unknown) => {
        if (live) setError(caught);
      });
    return () => {
      live = false;
    };
  }, [client, organizationId, attempt]);
  const reload = useCallback(() => setAttempt((value) => value + 1), []);
  const accept = useCallback((connector: OrganizationConnector) => {
    setConnectors((current) => {
      const rest = (current ?? []).filter((each) => each.id !== connector.id);
      return [...rest, connector].sort((a, b) => a.name.localeCompare(b.name));
    });
  }, []);
  const drop = useCallback((connectorId: string) => {
    setConnectors((current) => current?.filter((each) => each.id !== connectorId) ?? null);
  }, []);
  return { connectors, error, reload, accept, drop };
}

/**
 * The catalog connectors an organization can add, read from the workspace the
 * settings were opened from. It also gives listed connectors their logos.
 */
function useConnectorCatalog(client: Client, workspaceId: string) {
  const [items, setItems] = useState<CapabilityCatalogItem[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setError(null);
    client
      .listCapabilities(workspaceId)
      .then((response) => {
        if (live) setItems(addableCatalogItems(response.items));
      })
      .catch((caught: unknown) => {
        if (live) setError(caught);
      });
    return () => {
      live = false;
    };
  }, [client, workspaceId, attempt]);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  const logo = useCallback(
    (item: CapabilityCatalogItem | undefined) =>
      item ? capabilityLogoSource(item, (path) => client.catalogAssetUrl(path)) : null,
    [client],
  );
  return { items, error, retry, logo };
}

type Catalog = ReturnType<typeof useConnectorCatalog>;

export function OrganizationConnectors({
  client,
  organizationId,
  organizationName,
  workspaceId,
  location,
  onNavigate,
}: {
  client: Client;
  organizationId: string;
  organizationName: string;
  /** The workspace the settings were opened from; its catalog lists the connectors to add. */
  workspaceId: string;
  location: ConnectorLocation;
  onNavigate: (next: ConnectorLocation) => void;
}) {
  const state = useOrganizationConnectors(client, organizationId);
  const catalog = useConnectorCatalog(client, workspaceId);
  const workspaces = useOrganizationWorkspaces(client, organizationId, location.kind !== "list");
  const toList = () => onNavigate({ kind: "list" });
  const logoFor = (connector: OrganizationConnector) =>
    connector.source === "catalog"
      ? catalog.logo(catalog.items?.find((item) => item.id === connector.capabilityId))
      : null;

  if (location.kind === "list")
    return (
      <ConnectorList
        connectors={state.connectors}
        error={state.error}
        logoFor={logoFor}
        onRetry={state.reload}
        onAdd={() => onNavigate({ kind: "new" })}
        onOpen={(connectorId) => onNavigate({ kind: "connector", connectorId, view: "page" })}
      />
    );

  if (location.kind === "new")
    return (
      <NewConnectorPage
        catalog={catalog}
        organizationName={organizationName}
        existing={state.connectors}
        workspaces={workspaces}
        onClose={toList}
        onPreviewApi={(request) =>
          client.previewOrganizationApiIntegration(organizationId, request)
        }
        onCreate={async (request) => {
          const created = await client.createOrganizationConnector(organizationId, request);
          state.accept(created);
          onNavigate({ kind: "connector", connectorId: created.id, view: "page" });
        }}
      />
    );

  const back = { label: "Integrations", onClick: toList };
  const connector = state.connectors?.find((each) => each.id === location.connectorId) ?? null;
  if (!connector) {
    return (
      <DetailPage back={back} className={FLUSH_DETAIL_PAGE_CLASS}>
        {state.error ? (
          <ErrorMessage
            variant="block"
            title="Couldn't load this connector"
            announce
            action={<RowButton onClick={state.reload}>Try again</RowButton>}
          >
            {userErrorText(state.error)}
          </ErrorMessage>
        ) : state.connectors === null ? (
          <DetailSkeleton />
        ) : (
          <EmptyState
            variant="page"
            icon={<PlugIcon />}
            title="This connector isn't in your organization"
            description="It may have been removed."
            action={<RowButton onClick={toList}>Back to Integrations</RowButton>}
          />
        )}
      </DetailPage>
    );
  }

  const update = async (
    request: Omit<UpdateOrganizationConnectorRequest, "expectedGeneration">,
  ) => {
    const updated = await client.updateOrganizationConnector(organizationId, connector.id, {
      ...request,
      expectedGeneration: connector.generation,
    });
    state.accept(updated);
  };
  const toPage = () => onNavigate({ kind: "connector", connectorId: connector.id, view: "page" });

  if (location.view === "available-in")
    return (
      <ConnectorAvailabilityPage
        connector={connector}
        organizationName={organizationName}
        workspaces={workspaces}
        onClose={toPage}
        onSave={async (availability) => {
          await update({ availability });
          toPage();
        }}
      />
    );

  if (
    location.view === "replace-key" &&
    connector.login === "organization_key" &&
    connector.apiIntegration
  )
    return (
      <ReplaceApiKeyPage
        connector={connector}
        auth={connector.apiIntegration.auth}
        onClose={toPage}
        onSave={async (apiKey) => {
          await update({ apiKey });
          toPage();
        }}
      />
    );

  if (location.view === "replace-key" && connector.login === "organization_key")
    return (
      <ReplaceKeyPage
        connector={connector}
        onClose={toPage}
        onSave={async (headers) => {
          await update({ headers });
          toPage();
        }}
      />
    );

  return (
    <ConnectorPage
      connector={connector}
      logo={logoFor(connector)}
      organizationName={organizationName}
      onBack={toList}
      onEditAvailability={() =>
        onNavigate({ kind: "connector", connectorId: connector.id, view: "available-in" })
      }
      onReplaceKey={() =>
        onNavigate({ kind: "connector", connectorId: connector.id, view: "replace-key" })
      }
      onSetStatus={(status) => update({ status })}
      onRemove={async () => {
        await client.deleteOrganizationConnector(organizationId, connector.id);
        state.drop(connector.id);
        toList();
      }}
    />
  );
}

function ConnectorList({
  connectors,
  error,
  logoFor,
  onRetry,
  onAdd,
  onOpen,
}: {
  connectors: OrganizationConnector[] | null;
  error: unknown;
  logoFor: (connector: OrganizationConnector) => string | null;
  onRetry: () => void;
  onAdd: () => void;
  onOpen: (connectorId: string) => void;
}) {
  return (
    <Section
      title="Connectors"
      description="Add a connector once and choose which workspaces get it. A workspace can still turn it off for itself."
      action={
        <Button type="button" size="sm" onClick={onAdd} className="pointer-coarse:h-11">
          Add connector
        </Button>
      }
    >
      {error && connectors === null ? (
        <ErrorMessage
          variant="inline"
          title="Couldn't load connectors."
          announce
          action={<RowButton onClick={onRetry}>Try again</RowButton>}
        />
      ) : connectors === null ? (
        <div role="status" aria-label="Loading connectors…">
          <RowList label="Connectors" busy flush>
            <ListRowSkeleton count={2} />
          </RowList>
        </div>
      ) : connectors.length === 0 ? (
        <EmptyState
          variant="inline"
          title="No organization connectors yet."
          description="Until you add one, each workspace sets up its own."
        />
      ) : (
        <RowList label="Connectors" flush>
          {connectors.map((connector) => (
            <ListRow
              key={connector.id}
              leading={<LogoTile name={connector.name} src={logoFor(connector)} />}
              title={connector.name}
              description={[
                ...(connector.apiIntegration
                  ? [protocolLabel(connector.apiIntegration.protocol)]
                  : []),
                CONNECTOR_LOGIN_LABEL[connector.login],
                connectorReachSummary(connector.availability),
              ].join(" · ")}
              status={
                !connector.available ? (
                  <StatusBadge status="unavailable" variant="outline" />
                ) : connector.status === "disabled" ? (
                  <StatusBadge status="off" variant="outline" />
                ) : undefined
              }
              indicator="open"
              onOpen={() => onOpen(connector.id)}
            />
          ))}
        </RowList>
      )}
    </Section>
  );
}

/** Which sign-in modes a catalog connector can use, and the one to start with. */
export function catalogLoginChoices(item: Pick<CapabilityCatalogItem, "authKind" | "name">): {
  allowed: Record<OrganizationConnectorLogin, string | null>;
  initial: OrganizationConnectorLogin | null;
} {
  const noOwnSignIn = `${item.name} has no sign-in of its own.`;
  switch (item.authKind) {
    case "oauth2":
      return {
        allowed: {
          each_person: null,
          organization_key: null,
          none: `${item.name} needs people to sign in.`,
        },
        initial: "each_person",
      };
    case "api_key":
      return {
        allowed: {
          each_person: noOwnSignIn,
          organization_key: null,
          none: `${item.name} needs a key.`,
        },
        initial: "organization_key",
      };
    case "none":
      return {
        allowed: { each_person: noOwnSignIn, organization_key: null, none: null },
        initial: "none",
      };
    default:
      return { allowed: { each_person: null, organization_key: null, none: null }, initial: null };
  }
}

/**
 * Which sign-in modes an API integration can use, from how the API itself
 * authenticates, and the one to start with. The server checks the same.
 */
export function apiLoginChoices(preview: Pick<ApiIntegrationPreview, "name" | "auth">): {
  allowed: Record<OrganizationConnectorLogin, string | null>;
  initial: OrganizationConnectorLogin;
} {
  switch (preview.auth.kind) {
    case "none":
      return {
        allowed: {
          each_person: `${preview.name} has no sign-in of its own.`,
          organization_key: `${preview.name} needs no key.`,
          none: null,
        },
        initial: "none",
      };
    case "oauth2":
      return {
        allowed: {
          each_person: null,
          organization_key: `${preview.name} signs in with OAuth, so each person connects their own account.`,
          none: `${preview.name} needs people to sign in.`,
        },
        initial: "each_person",
      };
    default:
      return {
        allowed: {
          each_person: null,
          organization_key: null,
          none: `${preview.name} needs a key.`,
        },
        initial: "organization_key",
      };
  }
}

/** Catalog connectors an organization can add: shared remote MCP servers, not a workspace's own. */
export function addableCatalogItems(
  items: readonly CapabilityCatalogItem[],
): CapabilityCatalogItem[] {
  return items
    .filter(
      (item) =>
        item.kind === "mcp" &&
        !item.workspaceId &&
        item.source !== "built_in" &&
        item.source !== "configured" &&
        Boolean(item.endpointUrl) &&
        (item.surfaceType ?? "mcp") === "mcp" &&
        !(
          item.metadata.organizationConnector &&
          typeof item.metadata.organizationConnector === "object" &&
          (item.metadata.organizationConnector as { source?: unknown }).source === "custom"
        ),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}

type Header = { name: string; value: string };

function headerIssue(header: Header): string | undefined {
  if (!header.name.trim()) return "Give the header a name, such as Authorization.";
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(header.name.trim()))
    return "A header name has only letters, digits and dashes.";
  if (!header.value.trim()) return "Paste the key.";
  return undefined;
}

function HeaderFields({
  header,
  onChange,
  error,
}: {
  header: Header;
  onChange: (next: Header) => void;
  error?: string | undefined;
}) {
  return (
    <>
      <Field label="Header" hint="Sent to the server with every request.">
        <TextInput
          value={header.name}
          onChange={(event) => onChange({ ...header, name: event.target.value })}
          placeholder="Authorization"
          mono
          suppressAutofill
        />
      </Field>
      <Field label="Value" error={error} hint="Stored encrypted. Nobody can read it back.">
        <TextInput
          type="password"
          value={header.value}
          onChange={(event) => onChange({ ...header, value: event.target.value })}
          placeholder="Bearer …"
          autoComplete="off"
          suppressAutofill
        />
      </Field>
    </>
  );
}

type Workspaces = ReturnType<typeof useOrganizationWorkspaces>;

function ReachFields({
  organizationName,
  value,
  onChange,
  workspaces,
  error,
  labelHidden = false,
}: {
  organizationName: string;
  value: WorkspaceReach;
  onChange: (next: WorkspaceReach) => void;
  workspaces: Workspaces;
  error?: string | undefined;
  labelHidden?: boolean;
}) {
  const sorted = useMemo(
    () =>
      workspaces.workspaces
        ? [...workspaces.workspaces].sort((a, b) => a.name.localeCompare(b.name))
        : null,
    [workspaces.workspaces],
  );
  return (
    <WorkspaceReachFields
      owner={{ kind: "organization", name: organizationName }}
      organizationName={organizationName}
      managedBy={MANAGED_BY}
      labelHidden={labelHidden}
      value={value}
      onChange={onChange}
      workspaces={sorted}
      workspacesError={workspaces.error}
      onRetryWorkspaces={workspaces.retry}
      personalWorkspaces="choice"
      error={error}
    />
  );
}

function NewConnectorPage({
  catalog: catalogState,
  organizationName,
  existing,
  workspaces,
  onClose,
  onPreviewApi,
  onCreate,
}: {
  catalog: Catalog;
  organizationName: string;
  existing: OrganizationConnector[] | null;
  workspaces: Workspaces;
  onClose: () => void;
  onPreviewApi: (
    request: PreviewOrganizationApiIntegrationRequest,
  ) => Promise<ApiIntegrationPreview>;
  onCreate: (request: CreateOrganizationConnectorRequest) => Promise<void>;
}) {
  const [source, setSource] = useState<"catalog" | "custom" | "api">("catalog");
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [endpointUrl, setEndpointUrl] = useState("");
  const [login, setLogin] = useState<OrganizationConnectorLogin | null>(null);
  const [header, setHeader] = useState<Header>({ name: "Authorization", value: "" });
  const [apiUrl, setApiUrl] = useState("");
  const [checked, setChecked] = useState<{
    source: IntegrationSourceInput;
    preview: ApiIntegrationPreview;
  } | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  // Null until an API turns out to need a key just to read it.
  const [readKey, setReadKey] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState<ApiKeyValues>(EMPTY_API_KEY);
  const [reach, setReach] = useState<WorkspaceReach>({
    workspaceIds: null,
    personalWorkspaces: true,
  });
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});
  const [formError, setFormError] = useState<ReactNode>(null);
  const catalog = catalogState.items;
  const added = useMemo(
    () => new Set((existing ?? []).map((connector) => connector.capabilityId)),
    [existing],
  );
  const item = source === "catalog" ? (catalog?.find((each) => each.id === picked) ?? null) : null;
  const choices =
    source === "catalog" && item
      ? catalogLoginChoices(item)
      : source === "api" && checked
        ? apiLoginChoices(checked.preview)
        : { allowed: { each_person: null, organization_key: null, none: null }, initial: null };
  const query = search.trim().toLowerCase();
  const shown = (catalog ?? []).filter((each) =>
    `${each.name} ${each.description ?? ""}`.toLowerCase().includes(query),
  );
  const clear = (key: string) =>
    setErrors((current) => {
      const { [key]: _removed, ...rest } = current;
      return rest;
    });

  const pick = (next: CapabilityCatalogItem) => {
    setPicked(next.id);
    setLogin(catalogLoginChoices(next).initial);
    clear("connector");
    clear("login");
  };

  const checkApi = async () => {
    let requested: IntegrationSourceInput;
    try {
      requested = { kind: "auto", url: normalizeCustomApiUrl(apiUrl) };
    } catch (caught) {
      setErrors((current) => ({ ...current, api: errorMessage(caught) }));
      return;
    }
    setChecking(true);
    setCheckError(null);
    clear("api");
    try {
      const preview = await onPreviewApi({
        source: requested,
        ...(readKey?.trim()
          ? {
              apiKey: [
                {
                  carrier: "header",
                  name: "Authorization",
                  prefix: "Bearer ",
                  value: readKey.trim(),
                },
              ],
            }
          : {}),
      });
      setChecked({ source: requested, preview });
      setLogin(apiLoginChoices(preview).initial);
      setApiKey(EMPTY_API_KEY);
      clear("login");
    } catch (caught) {
      setCheckError(userErrorText(caught));
      if (readKey === null && customApiAuthenticationMayBeRequired(requested, caught))
        setReadKey("");
    } finally {
      setChecking(false);
    }
  };

  return (
    <FlushFormPage
      backLabel="Integrations"
      onClose={onClose}
      title="Add connector"
      description={`Workspaces in ${organizationName} that it reaches get it ready to use. A workspace's own setup of the same connector still wins there.`}
      submitLabel="Add connector"
      pendingLabel="Adding…"
      error={formError}
      onSubmit={async (event) => {
        event.preventDefault();
        setFormError(null);
        const next: Partial<Record<string, string>> = {};
        if (source === "catalog" && !item) next.connector = "Choose a connector.";
        if (source === "api" && !checked) next.api = "Check the API first.";
        if (source === "custom") {
          if (!name.trim()) next.name = "Give the server a name.";
          if (!/^https:\/\/\S+$/u.test(endpointUrl.trim()))
            next.endpointUrl = "Enter the server's https:// address.";
        }
        if (source === "api" && !checked) {
          // How people sign in is chosen once the API is checked.
        } else if (!login) next.login = "Choose how people sign in.";
        else if (choices.allowed[login]) next.login = choices.allowed[login] ?? undefined;
        const keyed =
          login === "organization_key" && source === "api" && checked
            ? apiKeyPlacements(checked.preview.auth, apiKey)
            : null;
        const keyIssue = keyed
          ? "issue" in keyed
            ? keyed.issue
            : undefined
          : login === "organization_key" && source !== "api"
            ? headerIssue(header)
            : undefined;
        if (keyIssue) next.header = keyIssue;
        if (reachIsEmpty(reach)) next.reach = EMPTY_REACH;
        setErrors(next);
        if (Object.keys(next).length > 0 || !login) return false;
        try {
          await onCreate({
            ...(source === "catalog" && item
              ? { capabilityId: item.id }
              : source === "api" && checked
                ? {
                    apiIntegration: {
                      source: checked.source,
                      expectedRevisionId: checked.preview.revisionId,
                      expectedContentSha256: checked.preview.contentSha256,
                    },
                  }
                : { custom: { name: name.trim(), endpointUrl: endpointUrl.trim() } }),
            login,
            ...(keyed && "placements" in keyed
              ? { apiKey: keyed.placements }
              : login === "organization_key"
                ? { headers: { [header.name.trim()]: header.value.trim() } }
                : {}),
            availability: availabilityOf(reach),
          });
          return true;
        } catch (caught) {
          setFormError(userErrorText(caught));
          return false;
        }
      }}
    >
      <FieldStack>
        <ChoiceCards
          label="Connector"
          value={source}
          onValueChange={(value) => {
            const next = value as "catalog" | "custom" | "api";
            setSource(next);
            setLogin(
              next === "catalog" && item
                ? catalogLoginChoices(item).initial
                : next === "api" && checked
                  ? apiLoginChoices(checked.preview).initial
                  : null,
            );
            setErrors({});
          }}
        >
          <ChoiceCard
            value="catalog"
            title="From the catalog"
            description="A reviewed connector, such as Linear or Notion."
          />
          <ChoiceCard
            value="custom"
            title="Custom server"
            description="Any remote MCP server, by its address."
          />
          <ChoiceCard
            value="api"
            title="Custom API"
            description="Any OpenAPI or GraphQL API, by its address."
          />
        </ChoiceCards>
        {source === "catalog" && item ? (
          <div className="flex min-w-0 flex-col gap-2">
            <span className="text-sm leading-5 font-medium text-fg">Chosen connector</span>
            <RowList label="Chosen connector" flush>
              <ListRow
                leading={<LogoTile name={item.name} src={catalogState.logo(item)} />}
                title={item.name}
                description={item.description ?? undefined}
                control={
                  <RowButton
                    onClick={() => {
                      setPicked(null);
                      setLogin(null);
                    }}
                  >
                    Change
                  </RowButton>
                }
              />
            </RowList>
          </div>
        ) : source === "catalog" ? (
          <div className="flex min-w-0 flex-col gap-3">
            <Toolbar>
              <ToolbarSearch
                value={search}
                onValueChange={setSearch}
                placeholder="Search connectors"
                aria-label="Search connectors"
              />
            </Toolbar>
            {catalogState.error && catalog === null ? (
              <ErrorMessage
                variant="inline"
                title="Couldn't load the catalog."
                announce
                action={<RowButton onClick={catalogState.retry}>Try again</RowButton>}
              />
            ) : catalog === null ? (
              <div role="status" aria-label="Loading connectors…">
                <RowList label="Catalog connectors" busy flush>
                  <ListRowSkeleton count={4} />
                </RowList>
              </div>
            ) : shown.length === 0 ? (
              <EmptyState
                variant="inline"
                title={
                  catalog.length === 0
                    ? "The catalog has no connectors to add."
                    : `No connector matches "${search.trim()}".`
                }
              />
            ) : (
              // No inner scroll box: picking one collapses the list to a single row.
              <RowList label="Catalog connectors" flush>
                {shown.map((each) => {
                  const already = added.has(each.id);
                  return (
                    <ListRow
                      key={each.id}
                      leading={<LogoTile name={each.name} src={catalogState.logo(each)} />}
                      title={each.name}
                      description={each.description ?? undefined}
                      indicator={already ? "added" : "add"}
                      disabled={already}
                      disabledReason={already ? "Already added for your organization." : undefined}
                      onOpen={() => pick(each)}
                    />
                  );
                })}
              </RowList>
            )}
            {errors.connector ? (
              <p role="alert" className="m-0 text-sm leading-5 text-danger">
                {errors.connector}
              </p>
            ) : null}
          </div>
        ) : source === "api" ? (
          <ApiSourceFields
            url={apiUrl}
            onUrlChange={(next) => {
              setApiUrl(next);
              setCheckError(null);
              clear("api");
            }}
            checked={checked?.preview ?? null}
            checking={checking}
            checkError={checkError}
            readKey={readKey}
            onReadKeyChange={setReadKey}
            onCheck={() => void checkApi()}
            onChange={() => {
              setChecked(null);
              setLogin(null);
            }}
            error={errors.api}
          />
        ) : (
          <>
            <Field label="Name" error={errors.name}>
              <TextInput
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  clear("name");
                }}
                maxLength={120}
                placeholder="Team docs"
                suppressAutofill
              />
            </Field>
            <Field
              label="Server address"
              hint="A remote MCP server over streamable HTTP."
              error={errors.endpointUrl}
            >
              <TextInput
                value={endpointUrl}
                onChange={(event) => {
                  setEndpointUrl(event.target.value);
                  clear("endpointUrl");
                }}
                placeholder="https://example.com/mcp"
                inputMode="url"
                mono
                suppressAutofill
              />
            </Field>
          </>
        )}
        {source === "api" && !checked ? null : (
          <ChoiceCards
            label="How people sign in"
            value={login ?? ""}
            onValueChange={(value) => {
              setLogin(value as OrganizationConnectorLogin);
              clear("login");
            }}
            error={errors.login}
          >
            <ChoiceCard
              value="each_person"
              title="Each person signs in"
              description={
                source === "api"
                  ? "Everyone adds their own key or account. Nothing is shared."
                  : "Everyone connects their own account. Nothing is shared."
              }
              disabled={Boolean(choices.allowed.each_person)}
              disabledReason={choices.allowed.each_person ?? undefined}
            />
            <ChoiceCard
              value="organization_key"
              title="Organization key"
              description="One key for everyone. Every chat in the workspaces it reaches uses it."
              disabled={Boolean(choices.allowed.organization_key)}
              disabledReason={choices.allowed.organization_key ?? undefined}
            />
            <ChoiceCard
              value="none"
              title="No sign-in"
              description={
                source === "api"
                  ? "For an API that needs no account or key."
                  : "For a server that needs no account or key."
              }
              disabled={Boolean(choices.allowed.none)}
              disabledReason={choices.allowed.none ?? undefined}
            />
          </ChoiceCards>
        )}
        {login === "organization_key" && source === "api" && checked ? (
          <ApiKeyFields
            auth={checked.preview.auth}
            values={apiKey}
            onChange={(next) => {
              setApiKey(next);
              clear("header");
            }}
            error={errors.header}
          />
        ) : login === "organization_key" ? (
          <HeaderFields
            header={header}
            onChange={(next) => {
              setHeader(next);
              clear("header");
            }}
            error={errors.header}
          />
        ) : null}
        <ReachFields
          organizationName={organizationName}
          value={reach}
          onChange={(next) => {
            setReach(next);
            clear("reach");
          }}
          workspaces={workspaces}
          error={errors.reach}
        />
      </FieldStack>
    </FlushFormPage>
  );
}

function ConnectorPage({
  connector,
  logo,
  organizationName,
  onBack,
  onEditAvailability,
  onReplaceKey,
  onSetStatus,
  onRemove,
}: {
  connector: OrganizationConnector;
  logo: string | null;
  organizationName: string;
  onBack: () => void;
  onEditAvailability: () => void;
  onReplaceKey: () => void;
  onSetStatus: (status: OrganizationConnector["status"]) => Promise<void>;
  onRemove: () => Promise<void>;
}) {
  const [removing, setRemoving] = useState(false);
  const [statusPending, setStatusPending] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const on = connector.status === "active";
  const api = connector.apiIntegration;
  const signIn =
    connector.login === "each_person"
      ? api
        ? "Each person adds their own key or account, under a workspace's Custom APIs."
        : "Each person connects their own account from a workspace's Connectors page."
      : connector.login === "organization_key"
        ? api
          ? `The organization's key. ${apiKeyDestination(api.auth)}`
          : `The organization's key, sent as ${connector.headerNames.join(", ") || "a header"}.`
        : "Needs no account or key.";
  return (
    <DetailPage
      back={{ label: "Integrations", onClick: onBack }}
      className={FLUSH_DETAIL_PAGE_CLASS}
    >
      <DetailPageHeader
        leading={<LogoTile name={connector.name} src={logo} />}
        title={connector.name}
        chips={
          !connector.available ? (
            <StatusBadge status="unavailable" variant="outline" />
          ) : !on ? (
            <StatusBadge status="off" variant="outline" />
          ) : null
        }
        meta={[
          connector.source === "catalog"
            ? "From the catalog"
            : api
              ? "Custom API"
              : "Custom server",
          ...(api ? [protocolLabel(api.protocol)] : []),
          hostOf(connector.endpointUrl),
          `Belongs to ${organizationName}`,
        ]}
        actions={
          <MoreMenu label={`More actions for ${connector.name}`}>
            <DropdownMenuItem variant="destructive" onSelect={() => setRemoving(true)}>
              <TrashIcon />
              Remove connector
            </DropdownMenuItem>
          </MoreMenu>
        }
      />
      <DetailPageBody>
        {!connector.available ? (
          <DetailSection>
            <Notice tone="waiting" title="This connector left the catalog">
              No workspace gets it until it returns. Remove it if you no longer need it.
            </Notice>
          </DetailSection>
        ) : null}
        <DetailSection title="Settings">
          <SettingRowGroup className="-my-3">
            <SettingRow
              label="Turned on"
              description={
                on
                  ? "Workspaces it reaches can use it."
                  : "No workspace gets it until you turn it back on. Where it works is kept."
              }
              control={
                <Switch
                  checked={on}
                  disabled={statusPending}
                  aria-label={`${connector.name} turned on`}
                  onCheckedChange={(next) => {
                    setStatusPending(true);
                    setStatusError(null);
                    onSetStatus(next ? "active" : "disabled")
                      .catch((caught: unknown) => setStatusError(userErrorText(caught)))
                      .finally(() => setStatusPending(false));
                  }}
                />
              }
            />
            {statusError ? (
              <ErrorMessage variant="inline" title="Couldn't change it." announce>
                {statusError}
              </ErrorMessage>
            ) : null}
            <SettingRow
              label="Available in"
              description={connectorReachSummary(connector.availability)}
              control={<RowButton onClick={onEditAvailability}>Change</RowButton>}
            />
            <SettingRow
              label={CONNECTOR_LOGIN_LABEL[connector.login]}
              description={signIn}
              control={
                connector.login === "organization_key" ? (
                  <RowButton onClick={onReplaceKey}>Replace key</RowButton>
                ) : undefined
              }
            />
            {connector.allowedTools || api ? (
              <SettingRow label="Tools" description={connectorToolsSummary(connector)} />
            ) : null}
          </SettingRowGroup>
        </DetailSection>
        <DetailSection title="In each workspace">
          <p className="m-0 max-w-prose text-sm leading-5 text-fg-muted">
            {api
              ? "It shows under each workspace's Custom APIs as added by your organization. A workspace admin can turn it off there, and a workspace that sets up the same API itself uses its own setup instead. To change how people sign in, remove it and add it again."
              : "It shows on each workspace's Connectors page as added by your organization. A workspace admin can turn it off there, and a workspace that sets up the same connector itself uses its own setup instead. To change how people sign in, remove the connector and add it again."}
          </p>
        </DetailSection>
      </DetailPageBody>
      <DestructiveConfirm
        open={removing}
        onOpenChange={setRemoving}
        title={`Remove ${connector.name}?`}
        consequences={[
          "Every workspace stops getting it at once.",
          ...(connector.login === "each_person"
            ? [
                api
                  ? "People's own keys and accounts stay, and work again if it's added back."
                  : "People's own sign-ins stay, and work again if it's added back.",
              ]
            : connector.login === "organization_key"
              ? ["The stored organization key is deleted."]
              : []),
          "Workspaces that set it up themselves keep their own setup.",
        ]}
        confirmLabel="Remove connector"
        pendingLabel="Removing…"
        onConfirm={async () => {
          try {
            await onRemove();
          } catch (caught) {
            throw new Error(userErrorText(caught), { cause: caught });
          }
        }}
      />
    </DetailPage>
  );
}

function ConnectorAvailabilityPage({
  connector,
  organizationName,
  workspaces,
  onClose,
  onSave,
}: {
  connector: OrganizationConnector;
  organizationName: string;
  workspaces: Workspaces;
  onClose: () => void;
  onSave: (availability: OrganizationConnectorAvailability) => Promise<void>;
}) {
  const initial = reachOf(connector.availability);
  const [reach, setReach] = useState<WorkspaceReach>(initial);
  const [error, setError] = useState<string | undefined>();
  const [formError, setFormError] = useState<ReactNode>(null);
  const changed = JSON.stringify(availabilityOf(reach)) !== JSON.stringify(availabilityOf(initial));
  return (
    <FlushFormPage
      backLabel={connector.name}
      onClose={onClose}
      title="Available in"
      description={`Which workspaces in ${organizationName} get ${connector.name}.`}
      submitLabel="Save"
      pendingLabel="Saving…"
      submitDisabled={!changed}
      error={formError}
      onSubmit={async (event) => {
        event.preventDefault();
        setFormError(null);
        if (reachIsEmpty(reach)) {
          setError(EMPTY_REACH);
          return false;
        }
        try {
          await onSave(availabilityOf(reach));
          return true;
        } catch (caught) {
          setFormError(userErrorText(caught));
          return false;
        }
      }}
    >
      <ReachFields
        organizationName={organizationName}
        value={reach}
        onChange={(next) => {
          setReach(next);
          setError(undefined);
        }}
        workspaces={workspaces}
        error={error}
        labelHidden
      />
    </FlushFormPage>
  );
}

function ReplaceKeyPage({
  connector,
  onClose,
  onSave,
}: {
  connector: OrganizationConnector;
  onClose: () => void;
  onSave: (headers: Record<string, string>) => Promise<void>;
}) {
  const [header, setHeader] = useState<Header>({
    name: connector.headerNames[0] ?? "Authorization",
    value: "",
  });
  const [error, setError] = useState<string | undefined>();
  const [formError, setFormError] = useState<ReactNode>(null);
  return (
    <FlushFormPage
      backLabel={connector.name}
      onClose={onClose}
      title="Replace key"
      description={`The new key replaces every stored header for ${connector.name}. The server is checked with it before it's saved.`}
      submitLabel="Replace key"
      pendingLabel="Checking…"
      error={formError}
      onSubmit={async (event) => {
        event.preventDefault();
        setFormError(null);
        const issue = headerIssue(header);
        setError(issue);
        if (issue) return false;
        try {
          await onSave({ [header.name.trim()]: header.value.trim() });
          return true;
        } catch (caught) {
          setFormError(userErrorText(caught));
          return false;
        }
      }}
    >
      <FieldStack>
        <HeaderFields
          header={header}
          onChange={(next) => {
            setHeader(next);
            setError(undefined);
          }}
          error={error}
        />
      </FieldStack>
    </FlushFormPage>
  );
}

/** "Only list_entries.", "All 12 tools." */
export function connectorToolsSummary(
  connector: Pick<OrganizationConnector, "allowedTools" | "apiIntegration">,
): string {
  if (connector.allowedTools)
    return connector.allowedTools.length === 0
      ? "No tools are on."
      : `Only ${connector.allowedTools.join(", ")}.`;
  const tools = connector.apiIntegration?.tools ?? [];
  if (tools.length === 1) return `Its one tool, ${tools[0]!.name}.`;
  return `All ${tools.length} tools.`;
}

/** The address of an API to add, then what reading it found. */
function ApiSourceFields({
  url,
  onUrlChange,
  checked,
  checking,
  checkError,
  readKey,
  onReadKeyChange,
  onCheck,
  onChange,
  error,
}: {
  url: string;
  onUrlChange: (next: string) => void;
  checked: ApiIntegrationPreview | null;
  checking: boolean;
  checkError: string | null;
  /** Null until the API turns out to need a key just to read it. */
  readKey: string | null;
  onReadKeyChange: (next: string) => void;
  onCheck: () => void;
  onChange: () => void;
  error?: string | undefined;
}) {
  if (checked)
    return (
      <div className="flex min-w-0 flex-col gap-2">
        <span className="text-sm leading-5 font-medium text-fg">API</span>
        <RowList label="Checked API" flush>
          <ListRow
            leading={<LogoTile name={checked.name} src={null} />}
            title={checked.name}
            description={apiPreviewSummary(checked)}
            control={<RowButton onClick={onChange}>Change</RowButton>}
          />
        </RowList>
        {checked.warnings.length > 0 ? (
          <Notice tone="waiting" title="Worth knowing before you add it">
            {checked.warnings.join(" ")}
          </Notice>
        ) : null}
      </div>
    );
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <Field
        label="API address"
        hint="An OpenAPI document or GraphQL endpoint. It's read to list its tools before anything is added."
        error={error}
      >
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
          <TextInput
            value={url}
            onChange={(event) => onUrlChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                if (!checking) onCheck();
              }
            }}
            placeholder="https://api.example.com/openapi.json"
            inputMode="url"
            mono
            suppressAutofill
            className="min-w-0 sm:flex-1"
          />
          <Button
            type="button"
            variant="outline"
            onClick={onCheck}
            disabled={checking || !url.trim()}
            className="shrink-0 pointer-coarse:h-11"
          >
            {checking ? "Checking…" : "Check API"}
          </Button>
        </div>
      </Field>
      {checkError ? (
        <ErrorMessage variant="inline" title="Couldn't read this API." announce>
          {checkError}
        </ErrorMessage>
      ) : null}
      {readKey !== null ? (
        <Field
          label="Key to read it"
          optional
          hint="Some APIs need a key even to say what they do. It's used only to read it now and isn't stored."
        >
          <TextInput
            type="password"
            value={readKey}
            onChange={(event) => onReadKeyChange(event.target.value)}
            placeholder="Bearer token"
            autoComplete="off"
            suppressAutofill
          />
        </Field>
      ) : null}
    </div>
  );
}

function ReplaceApiKeyPage({
  connector,
  auth,
  onClose,
  onSave,
}: {
  connector: OrganizationConnector;
  auth: ApiIntegrationAuthPreview;
  onClose: () => void;
  onSave: (apiKey: OrganizationApiKeyPlacement[]) => Promise<void>;
}) {
  const [values, setValues] = useState<ApiKeyValues>(EMPTY_API_KEY);
  const [error, setError] = useState<string | undefined>();
  const [formError, setFormError] = useState<ReactNode>(null);
  return (
    <FlushFormPage
      backLabel={connector.name}
      onClose={onClose}
      title="Replace key"
      description={`The new key replaces the stored one for ${connector.name}. Every workspace it reaches uses it from the next request.`}
      submitLabel="Replace key"
      pendingLabel="Replacing…"
      error={formError}
      onSubmit={async (event) => {
        event.preventDefault();
        setFormError(null);
        const keyed = apiKeyPlacements(auth, values);
        if ("issue" in keyed) {
          setError(keyed.issue);
          return false;
        }
        try {
          await onSave(keyed.placements);
          return true;
        } catch (caught) {
          setFormError(userErrorText(caught));
          return false;
        }
      }}
    >
      <FieldStack>
        <ApiKeyFields
          auth={auth}
          values={values}
          onChange={(next) => {
            setValues(next);
            setError(undefined);
          }}
          error={error}
        />
      </FieldStack>
    </FlushFormPage>
  );
}
