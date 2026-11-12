import { OPENGENI_PERSONAL_SLACK_MCP_URL } from "@opengeni/contracts";
import {
  OFFICIAL_DRIVE_MCP_URL,
  OFFICIAL_GMAIL_MCP_URL,
  OFFICIAL_GOOGLE_CALENDAR_MCP_URL,
} from "./oauth-profiles";

/** Reviewed MCP servers with their own organization integration key. */
const DEDICATED_MCP_HOSTS = new Map<string, string>([
  [new URL(OFFICIAL_GMAIL_MCP_URL).hostname, "gmail"],
  [new URL(OFFICIAL_DRIVE_MCP_URL).hostname, "google-drive"],
  [new URL(OFFICIAL_GOOGLE_CALENDAR_MCP_URL).hostname, "google-calendar"],
  [new URL(OPENGENI_PERSONAL_SLACK_MCP_URL).hostname, "slack-personal"],
]);

function mcpServerIntegrationKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password)
    return null;
  return DEDICATED_MCP_HOSTS.get(url.hostname) ?? "custom:mcp";
}

/**
 * The organization integration a credential stored through the generic
 * connections API is for, read from the connection's own data. An OAuth
 * credential with an MCP server URL (`metadata.mcpUrl`) and no other
 * credential role is that MCP server's credential: a reviewed server's own key
 * (Gmail, Google Drive, Google Calendar, Slack), otherwise `custom:mcp`. These
 * are the keys the native MCP sign-in uses. A `metadata.resource` must name the
 * same kind of server. Anything else is unclassified (null), which a
 * restricted policy refuses.
 */
export function storedConnectionIntegrationKey(connection: {
  kind: string;
  metadata: Record<string, unknown>;
}): string | null {
  if (connection.kind !== "oauth2" || connection.metadata.credentialRole !== undefined) return null;
  const key = mcpServerIntegrationKey(connection.metadata.mcpUrl);
  if (key === null) return null;
  if (
    connection.metadata.resource !== undefined &&
    mcpServerIntegrationKey(connection.metadata.resource) !== key
  )
    return null;
  return key;
}
