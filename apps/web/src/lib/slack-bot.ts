import type { ConnectionMetadata } from "@/types";
import {
  OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
  OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
  OPENGENI_SLACK_BOT_REQUIRED_SCOPES,
} from "@opengeni/contracts";

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
  const grantedScopes = new Set(connection.grantedScopes);
  if (
    connection.verifiedInstallAt == null ||
    connection.verifiedInstallVersion !== connection.version ||
    connection.subjectId !== null ||
    connection.providerDomain !== "slack.com" ||
    connection.kind !== "app_install" ||
    grantedScopes.size !== OPENGENI_SLACK_BOT_REQUIRED_SCOPES.length ||
    !OPENGENI_SLACK_BOT_REQUIRED_SCOPES.every((scope) => grantedScopes.has(scope)) ||
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

/** A different immutable bot principal must mint a new row, never overwrite the old one. */
export function openGeniSlackBotConnectInput(
  token: string,
  reinstallTarget: ConnectionMetadata | null,
  createNewConnection: boolean,
): { token: string; connectionId?: string } {
  return {
    token,
    ...(!createNewConnection && reinstallTarget ? { connectionId: reinstallTarget.id } : {}),
  };
}

export function isDifferentSlackBotPrincipalError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes(
      "a different Slack bot requires a new connection and explicit scheduled-task rebinding",
    )
  );
}
