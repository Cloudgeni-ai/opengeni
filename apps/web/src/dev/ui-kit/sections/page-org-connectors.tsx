import type {
  ApiIntegrationPreview,
  CreateOrganizationConnectorRequest,
  OrganizationConnector,
} from "@opengeni/contracts";
import type { CapabilityCatalogItem } from "@opengeni/react/app/types";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { useMemo, useState } from "react";

import { OrganizationConnectors } from "@/components/organization-connectors";
import type { ConnectorLocation } from "@/lib/organization-route";

import { KitBlock, KitSection, PagePreview } from "../kit";
import { organization, workspaces } from "../fixtures";

/* ----------------------------------------------------------------------------
   Organization settings > Integrations > Connectors, rendered for real against
   an in-memory organization: the list, adding one, a connector's page, its
   Available in and replacing its key. Every control works; nothing is saved.
   -------------------------------------------------------------------------- */

const shared = workspaces.filter((workspace) => workspace.kind === "shared");
const HERE = shared[0]!.id;

function connector(overrides: Partial<OrganizationConnector>): OrganizationConnector {
  return {
    id: "4f1d0c4a-1b2c-4d3e-8f9a-0b1c2d3e4f50",
    organizationId: organization.id,
    kind: "mcp",
    capabilityId: "registry:linear",
    name: "Linear",
    description: null,
    endpointUrl: "https://mcp.linear.app/mcp",
    source: "catalog",
    login: "each_person",
    headerNames: [],
    allowedTools: null,
    availability: { allowedWorkspaceIds: null, allowPersonalWorkspaces: true },
    status: "active",
    available: true,
    apiIntegration: null,
    generation: 1,
    createdAt: "2026-10-30T09:00:00Z",
    updatedAt: "2026-10-30T09:00:00Z",
    ...overrides,
  };
}

const CONNECTORS: OrganizationConnector[] = [
  connector({}),
  connector({
    id: "5a2e1d5b-2c3d-4e4f-9a0b-1c2d3e4f5a61",
    capabilityId: "mcp:docs-search",
    name: "Docs search",
    endpointUrl: "https://docs.acme.dev/mcp",
    source: "custom",
    login: "organization_key",
    headerNames: ["Authorization"],
    availability: {
      allowedWorkspaceIds: shared.slice(0, 2).map((workspace) => workspace.id),
      allowPersonalWorkspaces: false,
    },
  }),
  connector({
    id: "6b3f2e6c-3d4e-4f5a-8b1c-2d3e4f5a6b72",
    capabilityId: "registry:sentry",
    name: "Sentry",
    endpointUrl: "https://mcp.sentry.dev/mcp",
    status: "disabled",
    availability: { allowedWorkspaceIds: [HERE], allowPersonalWorkspaces: false },
  }),
  connector({
    id: "7c4a3f7d-4e5f-4a6b-9c2d-3e4f5a6b7c83",
    capabilityId: "registry:legacy-wiki",
    name: "Legacy wiki",
    endpointUrl: "https://wiki.example.com/mcp",
    login: "none",
    available: false,
  }),
  connector({
    id: "8d5b4a8e-5f6a-4b7c-8d3e-4f5a6b7c8d94",
    kind: "api",
    capabilityId: "api:openapi:billing",
    name: "Billing API",
    endpointUrl: "https://billing.acme.dev/v1/",
    source: "custom",
    login: "organization_key",
    headerNames: ["X-Api-Key"],
    availability: { allowedWorkspaceIds: [HERE], allowPersonalWorkspaces: false },
    apiIntegration: {
      definitionId: "billing",
      protocol: "openapi",
      providerDomain: "billing.acme.dev",
      auth: {
        kind: "api_key",
        providerDomain: "billing.acme.dev",
        carrier: "header",
        name: "X-Api-Key",
      },
      revisionId: "openapi:4c1d8e2f9a7b",
      contentSha256: "4c1d8e2f9a7b".padEnd(64, "0"),
      tools: [
        { id: "list_invoices", name: "List invoices", safety: "read" },
        { id: "get_invoice", name: "Get an invoice", safety: "read" },
        { id: "refund_invoice", name: "Refund an invoice", safety: "destructive" },
      ],
    },
  }),
];

const API = CONNECTORS[4]!;

/** What checking a custom API finds, for the Add connector preview. */
function previewFor(url: string): ApiIntegrationPreview {
  const host = new URL(url).host;
  return {
    source: { kind: "auto", url },
    definitionId: host,
    definitionProvenance: "workspace",
    protocol: "openapi",
    capabilityId: `api:openapi:${host}`,
    pluginKey: `integration/openapi/${host}`,
    serverId: "api_openapi_inventory",
    name: "Inventory API",
    description: "Stock levels and warehouse moves.",
    provider: null,
    providerDomain: host,
    baseUrl: `https://${host}/v2/`,
    sourceUrl: url,
    revisionId: "openapi:9e8d7c6b5a4f",
    contentSha256: "9e8d7c6b5a4f".padEnd(64, "0"),
    auth: { kind: "http", providerDomain: host, scheme: "bearer" },
    connectionId: null,
    connectionOwnership: null,
    tools: Array.from({ length: 14 }, (_, index) => ({
      id: `tool_${index}`,
      operationKey: `op_${index}`,
      name: `Tool ${index}`,
      description: "",
      safety: "read" as const,
      approvalMode: "never" as const,
      deprecated: false,
    })),
    warnings: [],
  };
}

function catalogItem(id: string, name: string, description: string, authKind: string) {
  return {
    id,
    kind: "mcp",
    source: "registry",
    name,
    description,
    endpointUrl: `https://mcp.${name.toLowerCase()}.com/mcp`,
    mcpUrl: `https://mcp.${name.toLowerCase()}.com/mcp`,
    providerDomain: `mcp.${name.toLowerCase()}.com`,
    surfaceType: null,
    authKind,
    logoAssetPath: null,
    enabled: false,
    actions: ["connect"],
    metadata: {},
  } as unknown as CapabilityCatalogItem;
}

const CATALOG: CapabilityCatalogItem[] = [
  catalogItem("registry:linear", "Linear", "Issues, projects and cycles.", "oauth2"),
  catalogItem("registry:notion", "Notion", "Search and edit pages and databases.", "oauth2"),
  catalogItem("registry:sentry", "Sentry", "Errors, issues and releases.", "oauth2"),
  catalogItem("registry:context7", "Context7", "Current library documentation.", "none"),
  catalogItem("registry:exa", "Exa", "Web search for agents.", "api_key"),
];

/** Just what the page calls, kept in memory. */
function fakeClient(initial: OrganizationConnector[]): OpenGeniBrowserClient {
  let rows = [...initial];
  const client = {
    listOrganizationConnectors: async () => rows,
    previewOrganizationApiIntegration: async (
      _organizationId: string,
      request: { source: { kind: string; url?: string } },
    ) => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      return previewFor(request.source.url ?? "https://api.example.com/openapi.json");
    },
    createOrganizationConnector: async (
      _organizationId: string,
      request: CreateOrganizationConnectorRequest,
    ) => {
      if (request.apiIntegration) {
        const source = request.apiIntegration.source as { url?: string };
        const preview = previewFor(source.url ?? "https://api.example.com/openapi.json");
        const created = connector({
          id: crypto.randomUUID(),
          kind: "api",
          capabilityId: preview.capabilityId,
          name: preview.name,
          endpointUrl: preview.baseUrl,
          source: "custom",
          login: request.login,
          headerNames: (request.apiKey ?? []).map((placement) => placement.name),
          availability: request.availability,
          apiIntegration: {
            definitionId: preview.definitionId,
            protocol: preview.protocol,
            providerDomain: preview.providerDomain,
            auth: preview.auth,
            revisionId: preview.revisionId,
            contentSha256: preview.contentSha256,
            tools: preview.tools.map(({ id, name, safety }) => ({ id, name, safety })),
          },
        });
        rows = [...rows, created];
        return created;
      }
      const item = CATALOG.find((each) => each.id === request.capabilityId);
      const created = connector({
        id: crypto.randomUUID(),
        capabilityId: request.capabilityId ?? `mcp:${crypto.randomUUID()}`,
        name: item?.name ?? request.custom?.name ?? "Connector",
        endpointUrl: item?.mcpUrl ?? request.custom?.endpointUrl ?? "",
        source: item ? "catalog" : "custom",
        login: request.login,
        headerNames: Object.keys(request.headers ?? {}),
        availability: request.availability,
      });
      rows = [...rows, created];
      return created;
    },
    updateOrganizationConnector: async (
      _organizationId: string,
      id: string,
      request: Partial<OrganizationConnector> & {
        headers?: Record<string, string>;
        apiKey?: unknown;
      },
    ) => {
      const current = rows.find((row) => row.id === id)!;
      const { headers, apiKey: _apiKey, ...change } = request;
      const updated: OrganizationConnector = {
        ...current,
        ...change,
        headerNames: headers ? Object.keys(headers) : current.headerNames,
        generation: current.generation + 1,
      };
      rows = rows.map((row) => (row.id === id ? updated : row));
      return updated;
    },
    deleteOrganizationConnector: async (_organizationId: string, id: string) => {
      rows = rows.filter((row) => row.id !== id);
    },
    listCapabilities: async () => ({ items: CATALOG }),
    catalogAssetUrl: () => null,
    getOrganizationAdministrationOverview: async () => ({
      workspaces: shared.map(({ id, name }) => ({ id, name })),
    }),
  };
  return client as unknown as OpenGeniBrowserClient;
}

const LIST: ConnectorLocation = { kind: "list" };

function ConnectorsPreview({
  initial,
  start = LIST,
}: {
  initial: OrganizationConnector[];
  start?: ConnectorLocation;
}) {
  const client = useMemo(() => fakeClient(initial), [initial]);
  const [location, setLocation] = useState<ConnectorLocation>(start);
  return (
    <div className="mx-auto w-full max-w-[960px] px-6 py-8 max-sm:px-4">
      <OrganizationConnectors
        client={client}
        organizationId={organization.id}
        organizationName={organization.name}
        workspaceId={HERE}
        location={location}
        onNavigate={setLocation}
      />
    </div>
  );
}

export default function PageOrgConnectorsSection() {
  return (
    <KitSection sectionKey="page-org-connectors">
      <KitBlock
        title="Connectors"
        description="Organization settings > Integrations. Each row says how people sign in and where it works; Off and Unavailable say why a workspace doesn't get it. A row opens the connector's page."
      >
        <PagePreview label="Organization connectors" height={560}>
          <ConnectorsPreview initial={CONNECTORS} />
        </PagePreview>
      </KitBlock>
      <KitBlock title="Empty" description="One line on what adding a connector does.">
        <PagePreview label="No organization connectors" height={420}>
          <ConnectorsPreview initial={[]} />
        </PagePreview>
      </KitBlock>
      <KitBlock
        title="Add a connector"
        description="From the catalog or a custom server address, then how people sign in and where it works."
      >
        <PagePreview label="Add a connector" height={1200}>
          <ConnectorsPreview initial={CONNECTORS} start={{ kind: "new" }} />
        </PagePreview>
      </KitBlock>
      <KitBlock
        title="A connector"
        description="Turned on, Available in, how people sign in and what each workspace can still do. Remove is in the ⋯ menu."
      >
        <PagePreview label="Docs search" height={900}>
          <ConnectorsPreview
            initial={CONNECTORS}
            start={{ kind: "connector", connectorId: CONNECTORS[1]!.id, view: "page" }}
          />
        </PagePreview>
      </KitBlock>
      <KitBlock
        title="An API"
        description="An OpenAPI or GraphQL API added once for the organization: its protocol, where its key goes and its tools."
      >
        <PagePreview label="Billing API" height={900}>
          <ConnectorsPreview
            initial={CONNECTORS}
            start={{ kind: "connector", connectorId: API.id, view: "page" }}
          />
        </PagePreview>
      </KitBlock>
      <KitBlock title="Available in" description="The same control as vaults and model keys.">
        <PagePreview label="Available in" height={900}>
          <ConnectorsPreview
            initial={CONNECTORS}
            start={{ kind: "connector", connectorId: CONNECTORS[0]!.id, view: "available-in" }}
          />
        </PagePreview>
      </KitBlock>
      <KitBlock
        title="Replace key"
        description="The stored value is never shown; a new one replaces it."
      >
        <PagePreview label="Replace key" height={640}>
          <ConnectorsPreview
            initial={CONNECTORS}
            start={{ kind: "connector", connectorId: CONNECTORS[1]!.id, view: "replace-key" }}
          />
        </PagePreview>
      </KitBlock>
      <KitBlock
        title="Replace an API key"
        description="The field follows where the API expects its key."
      >
        <PagePreview label="Replace an API key" height={640}>
          <ConnectorsPreview
            initial={CONNECTORS}
            start={{ kind: "connector", connectorId: API.id, view: "replace-key" }}
          />
        </PagePreview>
      </KitBlock>
    </KitSection>
  );
}
