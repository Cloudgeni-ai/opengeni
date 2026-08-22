import { formatTimestamp } from "@/lib/format";
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
  botId: string;
  botUserId: string;
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
    typeof metadata.botId !== "string" ||
    typeof metadata.botUserId !== "string" ||
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

/**
 * Name for one bot install: the Slack workspace it posts into. The connection
 * uuid used to be appended here to keep two installs apart, but a uuid names
 * nothing a reader recognizes. Disambiguation belongs to
 * `openGeniSlackBotConnectionOptions`, which can see the whole candidate list
 * and add only as much as it takes.
 */
export function openGeniSlackBotConnectionLabel(connection: ConnectionMetadata): string | null {
  const metadata = openGeniSlackBotUiMetadata(connection);
  return metadata ? `${metadata.slackTeamName} · OpenGeni` : null;
}

export type OpenGeniSlackBotConnectionOption = {
  connection: ConnectionMetadata;
  /**
   * Never a uuid. Distinct within the supplied list in every case a human can
   * actually act on: the ladder adds the Slack team id, then the install time.
   * Two installs of the same Slack workspace within the same second still
   * collide, which no non-uuid discriminator can separate.
   */
  label: string;
};

function tally<T>(rows: readonly T[], key: (row: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const value = key(row);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

/**
 * Picker rows for a set of bot installs, named by the Slack workspace each one
 * posts into. A discriminator is added only to the rows that would otherwise
 * read identically, and only the smallest one that separates them: the Slack
 * team id when two same-named Slack workspaces collide, and the install time
 * when one Slack workspace was installed more than once. Both are stable facts
 * a person can match against Slack itself, which a connection uuid is not.
 *
 * Rows that are not OpenGeni bot installs are dropped rather than labeled: this
 * renders a picker, and an unlabelable option is not a choice.
 */
export function openGeniSlackBotConnectionOptions(
  connections: ConnectionMetadata[],
): OpenGeniSlackBotConnectionOption[] {
  const rows = connections.flatMap((connection) => {
    const metadata = openGeniSlackBotUiMetadata(connection);
    return metadata ? [{ connection, metadata }] : [];
  });
  const named = (row: (typeof rows)[number]) => `${row.metadata.slackTeamName} · OpenGeni`;
  const withTeamId = (row: (typeof rows)[number]) => `${named(row)} · ${row.metadata.slackTeamId}`;
  const byName = tally(rows, named);
  const byTeamId = tally(rows, withTeamId);
  return rows.map((row) => {
    if ((byName.get(named(row)) ?? 0) < 2) {
      return { connection: row.connection, label: named(row) };
    }
    if ((byTeamId.get(withTeamId(row)) ?? 0) < 2) {
      return { connection: row.connection, label: withTeamId(row) };
    }
    return {
      connection: row.connection,
      label: `${withTeamId(row)} · installed ${formatTimestamp(row.connection.createdAt)}`,
    };
  });
}

/** Reinstall the exact selected principal unless the user explicitly asks for another install. */
export function openGeniSlackBotInstallInput(
  reinstallTarget: ConnectionMetadata | null,
  createNewConnection: boolean,
): { connectionId?: string } {
  return !createNewConnection && reinstallTarget ? { connectionId: reinstallTarget.id } : {};
}
