import { CORE_INTEGRATION_DEFINITIONS } from "@opengeni/capabilities";
import {
  assertOrganizationIntegrationAllowed,
  type IntegrationSource,
  type OrganizationIntegrationPolicy,
} from "@opengeni/contracts";

/** Admission for source discovery, before any credential-bearing network work.
 * Auto-detection may try only protocols the organization actually permits.
 */
export function integrationSourceForOrganizationPolicy(
  policy: OrganizationIntegrationPolicy,
  source: IntegrationSource,
): IntegrationSource {
  const snapshot = structuredClone(source);
  if (policy.mode === "unrestricted") return snapshot;
  if (snapshot.kind === "definition") {
    const definition = CORE_INTEGRATION_DEFINITIONS.find(
      (item) => item.id === snapshot.definitionId,
    );
    assertOrganizationIntegrationAllowed(policy, definition?.id ?? null);
    return snapshot;
  }
  if (snapshot.kind !== "auto") {
    assertOrganizationIntegrationAllowed(policy, `custom:${snapshot.kind}`);
    return snapshot;
  }
  const openapi = policy.allowedIntegrationKeys.includes("custom:openapi");
  const graphql = policy.allowedIntegrationKeys.includes("custom:graphql");
  if (openapi && graphql) return snapshot;
  if (openapi) return { ...snapshot, kind: "openapi" };
  if (graphql) return { kind: "graphql", endpoint: snapshot.url };
  assertOrganizationIntegrationAllowed(policy, null);
  return snapshot;
}

const dedicated = [
  { key: "gmail", label: "Gmail" },
  { key: "atlassian", label: "Atlassian (Jira and Confluence)" },
  { key: "slack-personal", label: "Slack personal accounts" },
  { key: "slack-bot", label: "Slack workspace bots" },
  { key: "github-personal", label: "GitHub personal accounts" },
  { key: "github-app", label: "GitHub App installations" },
  { key: "github-lens", label: "GitHub PR review" },
  { key: "fiken", label: "Fiken" },
  { key: "x", label: "X" },
  { key: "reddit", label: "Reddit" },
] as const;

/** Product identities owned by the server, independent of mutable workspace catalogs. */
export function organizationIntegrationCatalog(): {
  integrations: Array<{ key: string; label: string; kind: "curated" | "custom" }>;
} {
  return {
    integrations: [
      ...CORE_INTEGRATION_DEFINITIONS.map((definition) => ({
        key: definition.id,
        label: definition.name,
        kind: "curated" as const,
      })),
      ...dedicated.map((item) => ({ ...item, kind: "curated" as const })),
      { key: "custom:mcp", label: "Custom MCP servers", kind: "custom" },
      { key: "custom:openapi", label: "Custom OpenAPI services", kind: "custom" },
      { key: "custom:graphql", label: "Custom GraphQL services", kind: "custom" },
    ],
  };
}

/** Only use for a validated built-in Connect adapter, never caller-authored catalog metadata. */
export function integrationKeyForConnectProvider(providerId: string): string | null {
  if (CORE_INTEGRATION_DEFINITIONS.some((definition) => definition.id === providerId))
    return providerId;
  if (dedicated.some((item) => item.key === providerId)) return providerId;
  if (providerId === "fiken-token" || providerId === "fiken-oauth") return "fiken";
  if (providerId === "google-drive-knowledge" || providerId === "google-drive-publish")
    return "google-drive";
  if (["mcp-oauth", "mcp-headers", "mcp-bearer", "mcp-install"].includes(providerId))
    return "custom:mcp";
  if (providerId === "openapi") return "custom:openapi";
  if (providerId === "graphql") return "custom:graphql";
  // Unknown adapter identities do not inherit an allowed provider's authority.
  return null;
}
