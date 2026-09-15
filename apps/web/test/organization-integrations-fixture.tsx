import { createRoot } from "react-dom/client";
import { OrganizationIntegrationsSection } from "../src/components/organization-integrations-section";
import "../src/styles.css";

const integrations = [
  { key: "slack", label: "Slack", kind: "curated" },
  {
    key: "example-long-stable-key-that-wraps-without-horizontal-overflow-in-small-settings-panels",
    label: "Example integration with a long descriptive name",
    kind: "curated",
  },
  { key: "custom:mcp", label: "Custom MCP", kind: "custom" },
  { key: "custom:openapi", label: "Custom OpenAPI", kind: "custom" },
  { key: "custom:graphql", label: "Custom GraphQL", kind: "custom" },
];
const client = {
  requestJson: async (method: string, path: string, body?: Record<string, unknown>) => {
    if (method === "PUT") return { ...body, revision: 2 };
    return path.endsWith("catalog")
      ? { integrations }
      : { mode: "restricted", allowedIntegrationKeys: [], revision: 1 };
  },
} as Parameters<typeof OrganizationIntegrationsSection>[0]["client"];

createRoot(document.getElementById("root")!).render(
  <main className="mx-auto max-w-5xl px-4 py-5 sm:px-8 lg:px-12 lg:py-10">
    <header className="mb-6 border-b border-border pb-5">
      <h1 className="text-2xl font-semibold">Integrations</h1>
    </header>
    <OrganizationIntegrationsSection
      client={client}
      identity={{
        principalGeneration: 1,
        subjectId: "test-admin",
        organizationId: "test-org",
        workspaceId: "test-workspace",
      }}
      actorRole="owner"
      managedSession
    />
  </main>,
);
