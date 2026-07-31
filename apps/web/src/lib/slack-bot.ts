import type { ConnectionMetadata } from "@/types";
import {
  OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
  OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
} from "@opengeni/contracts";
import { areOpenGeniSlackBotScopesAccepted } from "@opengeni/contracts/slack-bot-scopes";

export type OpenGeniSlackBotUiMetadata = {
  credentialRole: typeof OPENGENI_SLACK_BOT_CREDENTIAL_ROLE;
  credentialLabel: typeof OPENGENI_SLACK_BOT_CREDENTIAL_LABEL;
  slackTeamId: string;
  slackTeamName: string;
  botDisplayName: "OpenGeni";
};

export function openGeniSlackBotUiMetadata(
  connection: ConnectionMetadata,
): OpenGeniSlackBotUiMetadata | null {
  const metadata = connection.metadata;
  if (
    connection.verifiedInstallAt == null ||
    connection.verifiedInstallVersion !== connection.version ||
    connection.subjectId !== null ||
    connection.providerDomain !== "slack.com" ||
    connection.kind !== "app_install" ||
    !areOpenGeniSlackBotScopesAccepted(connection.grantedScopes) ||
    metadata.credentialRole !== OPENGENI_SLACK_BOT_CREDENTIAL_ROLE ||
    metadata.credentialLabel !== OPENGENI_SLACK_BOT_CREDENTIAL_LABEL ||
    typeof metadata.slackTeamId !== "string" ||
    typeof metadata.slackTeamName !== "string" ||
    metadata.botDisplayName !== "OpenGeni"
  ) {
    return null;
  }
  return metadata as OpenGeniSlackBotUiMetadata;
}

export function openGeniSlackBotConnections(
  connections: ConnectionMetadata[],
): ConnectionMetadata[] {
  return connections.filter((connection) => openGeniSlackBotUiMetadata(connection) !== null);
}

export function activeOpenGeniSlackBotConnections(
  connections: ConnectionMetadata[],
): ConnectionMetadata[] {
  return openGeniSlackBotConnections(connections).filter(
    (connection) => connection.status === "active",
  );
}

/** Prefer a usable install over a newer revoked row when choosing a reinstall target. */
export function preferredOpenGeniSlackBotConnection(
  connections: ConnectionMetadata[],
): ConnectionMetadata | null {
  const botConnections = openGeniSlackBotConnections(connections);
  return (
    botConnections.find((connection) => connection.status === "active") ?? botConnections[0] ?? null
  );
}

export function openGeniSlackBotConnectionLabel(connection: ConnectionMetadata): string | null {
  const metadata = openGeniSlackBotUiMetadata(connection);
  return metadata ? `${metadata.slackTeamName} · OpenGeni · ${connection.id}` : null;
}

/** Reinstall the exact selected principal unless the user explicitly asks for another install. */
export function openGeniSlackBotInstallInput(
  reinstallTarget: ConnectionMetadata | null,
  createNewConnection: boolean,
): { connectionId?: string } {
  return !createNewConnection && reinstallTarget ? { connectionId: reinstallTarget.id } : {};
}
