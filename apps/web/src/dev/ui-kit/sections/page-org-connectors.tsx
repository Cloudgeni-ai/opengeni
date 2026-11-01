import type { OrganizationConnector } from "@opengeni/contracts";
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
];

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
    createOrganizationConnector: async (
      _organizationId: string,
      request: {
        capabilityId?: string;
        custom?: { name: string; endpointUrl: string };
        login: OrganizationConnector["login"];
        headers?: Record<string, string>;
        availability: OrganizationConnector["availability"];
      },
    ) => {
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
      request: Partial<OrganizationConnector> & { headers?: Record<string, string> },
    ) => {
      const current = rows.find((row) => row.id === id)!;
      const { headers, ...change } = request;
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
    </KitSection>
  );
}
