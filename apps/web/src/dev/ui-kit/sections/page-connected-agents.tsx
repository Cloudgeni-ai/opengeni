import type {
  CheckMcpTrustedIssuerResponse,
  McpTrustedIssuer,
  McpTrustedIssuerEvent,
} from "@opengeni/contracts";
import { useMemo, useState } from "react";

import type { AutoConnectApi } from "@/components/organization-access/auto-connect";

import {
  ConnectedAgents,
  type ConnectedAgentsLocation,
} from "@/components/organization-access/connected-agents";
import { McpConsentPage } from "@/components/organization-access/mcp-consent-page";
import { OrganizationApiKeysSection } from "@/components/organization-api-keys-section";
import type { McpConnection, McpConnectionsApi } from "@/lib/mcp-connections";
import { allOrganizationPermissions, presetPermissions } from "@/lib/organization-access";

import { KitBlock, KitSection, PagePreview } from "../kit";
import { organization, workspaces } from "../fixtures";

// Relative to the real clock: RelativeTime counts from now.
const PREVIEW_NOW = Date.now();

const MCP_URL = "https://app.opengeni.ai/v1/mcp";

const accessWorkspaces = workspaces.map((workspace) => ({
  id: workspace.id,
  name: workspace.name,
  personal: workspace.kind === "personal",
}));
const shared = accessWorkspaces.filter((workspace) => !workspace.personal);

const ago = (minutes: number) => new Date(PREVIEW_NOW - minutes * 60_000).toISOString();
const ahead = (days: number) => new Date(PREVIEW_NOW + days * 86_400_000).toISOString();

const CONNECTIONS: McpConnection[] = [
  {
    id: "6f1d0c4a-1b2c-4d3e-8f9a-0b1c2d3e4f50",
    clientName: "Claude Code",
    clientHost: "localhost",
    actor: "user",
    connectedBy: { subjectId: "person-bendik", name: "Bendik Hansen" },
    policy: {
      preset: "full",
      permissions: presetPermissions("full"),
      workspaceScope: { kind: "all" },
    },
    createdAt: ago(60 * 24 * 3),
    lastUsedAt: ago(4),
    expiresAt: ahead(27),
    revokedAt: null,
  },
  {
    id: "7a2e1d5b-2c3d-4e4f-9a0b-1c2d3e4f5a61",
    clientName: "Cursor",
    clientHost: "cursor.com",
    actor: "user",
    connectedBy: { subjectId: "person-maria", name: "Maria Chen" },
    policy: {
      preset: "read_only",
      permissions: presetPermissions("read_only"),
      workspaceScope: { kind: "selected", workspaceIds: [shared[0]!.id, shared[1]!.id] },
    },
    createdAt: ago(60 * 24 * 12),
    lastUsedAt: ago(60 * 26),
    expiresAt: ahead(18),
    revokedAt: null,
  },
  {
    id: "8b3f2e6c-3d4e-4f5a-8b1c-2d3e4f5a6b72",
    clientName: "Release bot",
    clientHost: "ci.acme.dev",
    actor: "user",
    connectedBy: { subjectId: "person-jonas", name: "Jonas Berg" },
    policy: {
      preset: "custom",
      permissions: ["workspace:read", "sessions:read", "sessions:create", "scheduled_tasks:run"],
      workspaceScope: { kind: "selected", workspaceIds: [shared[1]!.id] },
    },
    createdAt: ago(60 * 24 * 40),
    lastUsedAt: ago(60 * 24 * 32),
    expiresAt: ago(60 * 24 * 2),
    revokedAt: null,
  },
];

const AUTO_CONNECTED: McpConnection = {
  id: "9c4a3f7d-4e5f-4a6b-9c2d-3e4f5a6b7c83",
  clientName: "Claude",
  clientHost: "claude.ai",
  actor: "user",
  connectedBy: { subjectId: "person-maria", name: "Maria Chen" },
  policy: {
    preset: "read_only",
    permissions: presetPermissions("read_only"),
    workspaceScope: { kind: "all" },
  },
  createdAt: ago(60 * 5),
  lastUsedAt: ago(2),
  expiresAt: ahead(29),
  revokedAt: null,
  autoConnect: { trustedIssuerId: "1d2e3f4a-5b6c-4d7e-8f9a-0b1c2d3e4f5a", issuerName: "Claude" },
};

const CLAUDE_ISSUER: McpTrustedIssuer = {
  id: "1d2e3f4a-5b6c-4d7e-8f9a-0b1c2d3e4f5a",
  organizationId: organization.id,
  name: "Claude",
  provider: "claude",
  issuer: "https://identity.anthropic.com/issuers/iss_01JD7Y3W9K2M4Q6R8T0V",
  jwksUri: null,
  allowedClientIds: null,
  access: {
    preset: "read_only",
    permissions: presetPermissions("read_only") as McpTrustedIssuer["access"]["permissions"],
    workspaceScope: { kind: "all" },
  },
  status: "active",
  connectedPeople: 14,
  lastConnectedAt: ago(2),
  lastRefusal: null,
  createdAt: ago(60 * 24 * 6),
  updatedAt: ago(60 * 24 * 6),
};

const OKTA_ISSUER: McpTrustedIssuer = {
  ...CLAUDE_ISSUER,
  id: "2e3f4a5b-6c7d-4e8f-9a0b-1c2d3e4f5a6b",
  name: "Okta",
  provider: "okta",
  issuer: "https://acme.okta.com",
  connectedPeople: 0,
  lastConnectedAt: null,
  lastRefusal: { reason: "no_matching_member", at: ago(12) },
  createdAt: ago(60 * 3),
  updatedAt: ago(60 * 3),
};

const NEW_ISSUER: McpTrustedIssuer = {
  ...CLAUDE_ISSUER,
  id: "3f4a5b6c-7d8e-4f9a-0b1c-2d3e4f5a6b7c",
  connectedPeople: 0,
  lastConnectedAt: null,
  createdAt: ago(1),
  updatedAt: ago(1),
};

const EVENTS: McpTrustedIssuerEvent[] = [
  {
    id: "a1000000-0000-4000-8000-000000000001",
    outcome: "connected",
    reason: null,
    person: { subjectId: "person-maria", name: "Maria Chen" },
    email: "maria@acme.dev",
    clientName: "Claude",
    at: ago(5 * 60),
  },
  {
    id: "a1000000-0000-4000-8000-000000000002",
    outcome: "refused",
    reason: "no_matching_member",
    person: null,
    email: "contractor@outside.example",
    clientName: "Claude",
    at: ago(60 * 26),
  },
  {
    id: "a1000000-0000-4000-8000-000000000003",
    outcome: "connected",
    reason: null,
    person: { subjectId: "person-jonas", name: "Jonas Berg" },
    email: "jonas@acme.dev",
    clientName: "Claude",
    at: ago(60 * 24 * 2),
  },
];

function fakeAutoConnect(initial: McpTrustedIssuer[]): AutoConnectApi {
  let rows = [...initial];
  return {
    list: async () => ({
      trustedIssuers: rows,
      mcpUrl: MCP_URL,
      audience: "https://app.opengeni.ai",
    }),
    check: async ({ issuer }): Promise<CheckMcpTrustedIssuerResponse> => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      return issuer.includes("anthropic.com") || issuer.includes("okta.com")
        ? {
            status: "ok",
            issuer,
            jwksUri: `${issuer}/jwks`,
            keyCount: 2,
            algorithms: ["ES256"],
          }
        : {
            status: "failed",
            issuer,
            message: "Opengeni couldn't find this issuer's signing keys. Check the URL.",
          };
    },
    create: async (request) => {
      const created: McpTrustedIssuer = {
        ...NEW_ISSUER,
        id: crypto.randomUUID(),
        name: request.name,
        provider: request.provider,
        issuer: request.issuer,
        access: request.access,
      };
      rows = [...rows, created];
      return created;
    },
    update: async (id, request) => {
      rows = rows.map((row) =>
        row.id === id
          ? {
              ...row,
              ...(request.access ? { access: request.access } : {}),
              ...(request.status ? { status: request.status } : {}),
              ...(request.allowedClientIds !== undefined
                ? { allowedClientIds: request.allowedClientIds }
                : {}),
              ...(request.jwksUri !== undefined ? { jwksUri: request.jwksUri } : {}),
              updatedAt: new Date().toISOString(),
            }
          : row,
      );
      return rows.find((row) => row.id === id)!;
    },
    remove: async (id) => {
      rows = rows.filter((row) => row.id !== id);
    },
    events: async (id) => ({ events: id === CLAUDE_ISSUER.id ? EVENTS : [] }),
  };
}

function fakeApi(initial: McpConnection[]): McpConnectionsApi {
  let rows = [...initial];
  return {
    list: async () => ({ connections: rows, canManageAll: true }),
    update: async (id, change) => {
      rows = rows.map((row) => (row.id === id ? { ...row, policy: change.policy } : row));
      return rows.find((row) => row.id === id)!;
    },
    disconnect: async (id) => {
      rows = rows.filter((row) => row.id !== id);
    },
  };
}

const LIST: ConnectedAgentsLocation = {};

function AgentsPreview({
  initial,
  issuers,
  start = LIST,
}: {
  initial: McpConnection[];
  /** Auto-connect issuers, for an owner's view; omit for a member's. */
  issuers?: McpTrustedIssuer[];
  start?: ConnectedAgentsLocation;
}) {
  const api = useMemo(() => fakeApi(initial), [initial]);
  const autoConnect = useMemo(() => (issuers ? fakeAutoConnect(issuers) : null), [issuers]);
  const [location, setLocation] = useState<ConnectedAgentsLocation>(start);
  return (
    <div className="mx-auto w-full max-w-[960px] px-6 py-8 max-sm:px-4">
      <ConnectedAgents
        organizationName={organization.name}
        mcpUrl={MCP_URL}
        api={api}
        currentSubjectId="person-bendik"
        workspaces={accessWorkspaces}
        location={location}
        onNavigate={setLocation}
        onCreateApiKey={() => setLocation({})}
        {...(autoConnect
          ? { autoConnect: { organizationId: organization.id, api: autoConnect } }
          : {})}
      />
    </div>
  );
}

const MEMBER_GRANTABLE = allOrganizationPermissions().filter(
  (permission) =>
    !permission.startsWith("account:") &&
    !permission.startsWith("billing:") &&
    !["workspace:create", "usage_allowances:manage", "api_keys:manage", "members:manage"].includes(
      permission,
    ),
);

export default function PageConnectedAgentsSection() {
  return (
    <KitSection sectionKey="page-connected-agents">
      <KitBlock
        title="Connected agents"
        description="Organization settings > Connected agents. How to add the MCP server to each client, then the agents: each row says whose agent it is, what it can do and where. A row opens the agent's page."
      >
        <PagePreview label="Connected agents" height={980}>
          <AgentsPreview initial={CONNECTIONS} />
        </PagePreview>
      </KitBlock>
      <KitBlock
        title="Auto-connect: off"
        description="Owners and admins see Auto-connect between setup and the list. Off, it's one line and one action."
      >
        <PagePreview label="Auto-connect off" height={1120}>
          <AgentsPreview initial={CONNECTIONS} issuers={[]} />
        </PagePreview>
      </KitBlock>
      <KitBlock
        title="Auto-connect: on"
        description="Each trusted issuer is a row: how many people it connected, what their agents can do and where. A refused or waiting issuer says so. Auto-connected agents say so in the list."
      >
        <PagePreview label="Auto-connect on" height={1280}>
          <AgentsPreview
            initial={[AUTO_CONNECTED, ...CONNECTIONS]}
            issuers={[CLAUDE_ISSUER, OKTA_ISSUER]}
          />
        </PagePreview>
      </KitBlock>
      <KitBlock
        title="Set up auto-connect"
        description="Pick where people come from. Claude shows the two values to paste into Claude's Managed authorization setup, then takes the Issuer URL Claude shows, checked as it's typed. Access defaults to Read only in every workspace."
      >
        <PagePreview label="Auto-connect setup page" height={1500}>
          <AgentsPreview initial={CONNECTIONS} issuers={[]} start={{ issuer: "new" }} />
        </PagePreview>
      </KitBlock>
      <KitBlock
        title="An issuer: working"
        description="Status first, then what every auto-connected agent can do (Save appears once changed), the setup values again, and recent attempts with plain reasons. Turn off and Remove are in the ⋯ menu."
      >
        <PagePreview label="Claude issuer" height={1700}>
          <AgentsPreview
            initial={[AUTO_CONNECTED, ...CONNECTIONS]}
            issuers={[CLAUDE_ISSUER, OKTA_ISSUER]}
            start={{ issuer: CLAUDE_ISSUER.id }}
          />
        </PagePreview>
      </KitBlock>
      <KitBlock
        title="An issuer: refused and waiting"
        description="The last refusal says what to fix. A new issuer waits for its first connection and says how to test it."
      >
        <PagePreview label="Okta issuer" height={1300}>
          <AgentsPreview
            initial={CONNECTIONS}
            issuers={[OKTA_ISSUER]}
            start={{ issuer: OKTA_ISSUER.id }}
          />
        </PagePreview>
        <PagePreview label="New Claude issuer" height={1300}>
          <AgentsPreview
            initial={CONNECTIONS}
            issuers={[NEW_ISSUER]}
            start={{ issuer: NEW_ISSUER.id }}
          />
        </PagePreview>
      </KitBlock>
      <KitBlock
        title="An auto-connected agent"
        description="Its access follows the issuer, so it reads as set for everyone; Change opens the issuer."
      >
        <PagePreview label="Auto-connected Claude" height={900}>
          <AgentsPreview
            initial={[AUTO_CONNECTED, ...CONNECTIONS]}
            issuers={[CLAUDE_ISSUER]}
            start={{ agent: AUTO_CONNECTED.id }}
          />
        </PagePreview>
      </KitBlock>
      <KitBlock title="Empty" description="Setup stays first; the empty list is one quiet line.">
        <PagePreview label="No connected agents" height={720}>
          <AgentsPreview initial={[]} />
        </PagePreview>
      </KitBlock>
      <KitBlock
        title="A connected agent"
        description="What it can do, editable in place; Save shows once something changed. Disconnect is in the ⋯ menu."
      >
        <PagePreview label="Claude Code" height={1100}>
          <AgentsPreview initial={CONNECTIONS} start={{ agent: CONNECTIONS[1]!.id }} />
        </PagePreview>
      </KitBlock>
      <KitBlock
        title="Create an organization API key"
        description="For servers and agents that can't sign in through a browser: the same Access and Available in, plus Developer setup."
      >
        <PagePreview label="Create API key" height={1250}>
          <div className="mx-auto w-full max-w-[960px] px-6 py-8 max-sm:px-4">
            <OrganizationApiKeysSection
              organizationId={organization.id}
              canManage
              view="new-key"
              onViewChange={() => {}}
              listApiKeys={async () => []}
              createApiKey={async () => {
                throw new Error("Preview only");
              }}
              deleteApiKey={async () => {
                throw new Error("Preview only");
              }}
              workspaces={accessWorkspaces.filter((workspace) => !workspace.personal)}
            />
          </div>
        </PagePreview>
      </KitBlock>
      <KitBlock
        title="Sign-in: choose its access"
        description="Opens in the browser when the agent signs in. It acts as the person; Read only in every workspace is the default. Permissions beyond their own access stay off."
      >
        <PagePreview label="Connect Claude Code" height={1300}>
          <McpConsentPage
            request={{
              client: { name: "Claude Code", host: "localhost" },
              person: { name: "Bendik Hansen" },
              defaultOrganizationId: organization.id,
              organizations: [
                {
                  id: organization.id,
                  name: organization.name,
                  workspaces: accessWorkspaces,
                  grantable: MEMBER_GRANTABLE,
                },
              ],
            }}
            onAnswer={async () => {}}
          />
        </PagePreview>
      </KitBlock>
    </KitSection>
  );
}
