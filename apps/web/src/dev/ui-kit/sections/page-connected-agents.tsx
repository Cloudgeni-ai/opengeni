import { useMemo, useState } from "react";

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
  start = LIST,
}: {
  initial: McpConnection[];
  start?: ConnectedAgentsLocation;
}) {
  const api = useMemo(() => fakeApi(initial), [initial]);
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
        description="Organization settings > Developer. Each row says whose agent it is, what it can do and where. A row opens the agent's page."
      >
        <PagePreview label="Connected agents" height={520}>
          <AgentsPreview initial={CONNECTIONS} />
        </PagePreview>
      </KitBlock>
      <KitBlock title="Empty" description="The empty list holds the one action.">
        <PagePreview label="No connected agents" height={360}>
          <AgentsPreview initial={[]} />
        </PagePreview>
      </KitBlock>
      <KitBlock
        title="Connect an agent"
        description="One server URL for the whole organization, and what to paste into each client. The access is chosen when the agent signs in."
      >
        <PagePreview label="Connect an agent" height={720}>
          <AgentsPreview initial={CONNECTIONS} start={{ view: "connect-agent" }} />
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
