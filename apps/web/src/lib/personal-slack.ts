import {
  OPENGENI_PERSONAL_SLACK_MCP_URL,
  selectCanonicalPersonalSlackConnection,
} from "@opengeni/contracts";

import type { CapabilityCatalogItem, ConnectionMetadata } from "@/types";

const PERSONAL_SLACK_PROVIDER_DOMAIN = "slack.com";

export type PersonalSlackAccountState =
  | { state: "unverified" }
  | { state: "not_connected" }
  | {
      state: "connected";
      connection: ConnectionMetadata;
      accessTokenRefreshDue: boolean;
    }
  | {
      state: "reconnect_required";
      connection: ConnectionMetadata;
      reason: "expired" | "provider_rejected" | "error";
    }
  | { state: "disconnected"; connection: ConnectionMetadata };

/**
 * The curated personal Slack capability. Exact hosted-resource matching keeps
 * this user-account surface separate from the workspace bot and from arbitrary
 * Slack-shaped MCP endpoints.
 */
export function personalSlackCapability(
  items: CapabilityCatalogItem[],
): CapabilityCatalogItem | null {
  return (
    items.find(
      (item) =>
        item.kind === "mcp" &&
        item.authKind === "oauth2" &&
        normalizedProviderDomain(item.providerDomain ?? "") === PERSONAL_SLACK_PROVIDER_DOMAIN &&
        (item.mcpUrl ?? item.endpointUrl) === OPENGENI_PERSONAL_SLACK_MCP_URL,
    ) ?? null
  );
}

/**
 * Subject-owned personal Slack rows visible to the current caller. The API
 * already applies exact-subject filtering; the client additionally rejects
 * workspace-shared rows and non-official resources before rendering them here.
 */
export function personalSlackConnections(connections: ConnectionMetadata[]): ConnectionMetadata[] {
  return connections.filter(
    (connection) =>
      connection.subjectId !== null &&
      connection.kind === "oauth2" &&
      normalizedProviderDomain(connection.providerDomain) === PERSONAL_SLACK_PROVIDER_DOMAIN &&
      connection.metadata.mcpUrl === OPENGENI_PERSONAL_SLACK_MCP_URL,
  );
}

/** Prefer a usable row, then the newest actionable/revoked row for reconnect. */
export function preferredPersonalSlackConnection(
  connections: ConnectionMetadata[],
): ConnectionMetadata | null {
  return selectCanonicalPersonalSlackConnection(personalSlackConnections(connections));
}

/**
 * Truthful personal-account status. An expired access token on an active row is
 * refresh-due, not automatically broken: the broker refreshes it on use. Only a
 * persisted needs_reauth/error status asks the user to reconnect.
 */
export function personalSlackAccountState(
  connection: ConnectionMetadata | null,
  loaded: boolean,
  now: Date = new Date(),
): PersonalSlackAccountState {
  if (!loaded) return { state: "unverified" };
  if (!connection) return { state: "not_connected" };

  const expired = connectionExpiresAtOrBefore(connection, now);
  switch (connection.status) {
    case "active":
      return { state: "connected", connection, accessTokenRefreshDue: expired };
    case "needs_reauth":
      return {
        state: "reconnect_required",
        connection,
        reason: expired ? "expired" : "provider_rejected",
      };
    case "error":
      return { state: "reconnect_required", connection, reason: "error" };
    case "revoked":
      return { state: "disconnected", connection };
  }
}

export function personalSlackOAuthTarget(item: CapabilityCatalogItem | null): {
  providerDomain: "slack.com";
  mcpUrl: typeof OPENGENI_PERSONAL_SLACK_MCP_URL;
  ownership: "personal";
} | null {
  if (!item || personalSlackCapability([item]) === null) return null;
  return {
    providerDomain: PERSONAL_SLACK_PROVIDER_DOMAIN,
    mcpUrl: OPENGENI_PERSONAL_SLACK_MCP_URL,
    ownership: "personal",
  };
}

function connectionExpiresAtOrBefore(connection: ConnectionMetadata, now: Date): boolean {
  if (!connection.expiresAt) return false;
  const expiresAt = Date.parse(connection.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= now.getTime();
}

function normalizedProviderDomain(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^www\./, "");
}
