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

export function activeOpenGeniSlackBotConnections(
  connections: ConnectionMetadata[],
): ConnectionMetadata[] {
  return connections.filter(
    (connection) =>
      connection.status === "active" && openGeniSlackBotUiMetadata(connection) !== null,
  );
}
