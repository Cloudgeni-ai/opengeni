import type { AtlassianConnectionMetadata, ConnectionMetadata } from "@/types";

export const ATLASSIAN_APP_DESCRIPTION =
  "Search Jira and Confluence live, with optional knowledge synchronization.";

export function atlassianConnectionMetadata(
  value: Record<string, unknown>,
): AtlassianConnectionMetadata | null {
  if (
    value.credentialRole !== "atlassian_knowledge" ||
    typeof value.atlassianAccountId !== "string" ||
    !Array.isArray(value.sites)
  ) {
    return null;
  }
  return value as AtlassianConnectionMetadata;
}

export function preferredAtlassianConnection(
  connections: ConnectionMetadata[],
): ConnectionMetadata | null {
  return (
    connections
      .filter(
        (connection) =>
          connection.kind === "oauth2" &&
          connection.providerDomain.toLowerCase() === "api.atlassian.com" &&
          atlassianConnectionMetadata(connection.metadata) !== null,
      )
      .sort((left, right) => {
        const rank = (connection: ConnectionMetadata) =>
          connection.status === "active" ? 0 : connection.status === "revoked" ? 2 : 1;
        return rank(left) - rank(right) || Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
      })[0] ?? null
  );
}

export function atlassianStatus(connection: ConnectionMetadata | null, loaded: boolean) {
  if (!loaded) return "loading" as const;
  if (!connection || connection.status === "revoked") return "not_connected" as const;
  const metadata = atlassianConnectionMetadata(connection.metadata);
  if (!metadata) return "needs_attention" as const;
  if (metadata.lifecycle?.state === "paused") return "paused" as const;
  if (connection.status !== "active" || metadata.lifecycle?.state !== "active") {
    return "needs_attention" as const;
  }
  return "connected" as const;
}

export function localConnectedAtlassianPreview(
  search: string,
  workspaceId: string,
  enabled = import.meta.env.DEV,
): ConnectionMetadata | null {
  if (!enabled || new URLSearchParams(search).get("previewAtlassian") !== "connected") return null;
  const now = new Date().toISOString();
  return {
    id: "00000000-0000-4000-8000-000000000012",
    accountId: "00000000-0000-4000-8000-000000000001",
    workspaceId,
    subjectId: "preview-user",
    providerDomain: "api.atlassian.com",
    kind: "oauth2",
    status: "active",
    grantedScopes: ["offline_access", "read:jira-work", "read:confluence-content.all"],
    expiresAt: null,
    lastRefreshAt: now,
    lastUsedAt: now,
    lastError: null,
    version: 1,
    metadata: {
      credentialRole: "atlassian_knowledge",
      credentialLabel: "Atlassian read-only knowledge sync",
      atlassianAccountId: "preview-account",
      displayName: "Bendik Nyheim",
      email: "bendik@cloudgeni.ai",
      sites: [
        {
          cloudId: "preview-cloud",
          name: "OpenGeni Integration Lab",
          url: "https://opengeni-lab.atlassian.net",
          products: ["jira", "confluence"],
        },
      ],
      verifiedAt: now,
      accessMode: "readonly",
      lifecycle: { state: "active", recoverable: true, observedAt: now },
      selectedSources: [
        {
          id: "jira_project:preview-cloud:10000",
          cloudId: "preview-cloud",
          siteName: "OpenGeni Integration Lab",
          siteUrl: "https://opengeni-lab.atlassian.net",
          resourceId: "10000",
          key: "KAN",
          name: "OpenGeni Product Lab",
          kind: "jira_project",
          syncCadence: "hourly",
          syncEnabled: true,
          configGeneration: 1,
          readPolicy: "allow",
          selectedAt: now,
        },
        {
          id: "confluence_space:preview-cloud:20000",
          cloudId: "preview-cloud",
          siteName: "OpenGeni Integration Lab",
          siteUrl: "https://opengeni-lab.atlassian.net",
          resourceId: "20000",
          key: "SD",
          name: "Software development",
          kind: "confluence_space",
          syncCadence: "hourly",
          syncEnabled: true,
          configGeneration: 1,
          readPolicy: "allow",
          selectedAt: now,
        },
      ],
    },
    createdBySubjectId: "preview-user",
    updatedBySubjectId: "preview-user",
    createdAt: now,
    updatedAt: now,
  };
}
