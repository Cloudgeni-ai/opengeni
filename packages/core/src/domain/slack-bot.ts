import {
  OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
  OPENGENI_SLACK_BOT_REQUIRED_SCOPES,
  OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
  OPENGENI_SLACK_BOT_SESSION_METADATA_KEY,
  OpenGeniSlackBotConnectionMetadata,
  type AccessGrant,
  type ConnectionMetadata,
  type OpenGeniSlackBotConnectionMetadata as OpenGeniSlackBotMetadata,
  type Session,
} from "@opengeni/contracts";
import {
  getConnectionMetadata,
  type ConnectionMetadataWithVerification,
  type Database,
} from "@opengeni/db";
import { HTTPException } from "hono/http-exception";
import { requirePermission } from "../access";

export function openGeniSlackBotMetadata(
  metadata: Record<string, unknown>,
): OpenGeniSlackBotMetadata | null {
  const parsed = OpenGeniSlackBotConnectionMetadata.safeParse(metadata);
  return parsed.success ? parsed.data : null;
}

export function isOpenGeniSlackBotConnection(
  connection: ConnectionMetadata &
    Partial<
      Pick<ConnectionMetadataWithVerification, "verifiedInstallAt" | "verifiedInstallVersion">
    >,
): boolean {
  const granted = new Set(connection.grantedScopes);
  return (
    connection.verifiedInstallAt != null &&
    connection.verifiedInstallVersion === connection.version &&
    connection.subjectId === null &&
    connection.providerDomain === "slack.com" &&
    connection.kind === "app_install" &&
    granted.size === OPENGENI_SLACK_BOT_REQUIRED_SCOPES.length &&
    OPENGENI_SLACK_BOT_REQUIRED_SCOPES.every((scope) => granted.has(scope)) &&
    openGeniSlackBotMetadata(connection.metadata)?.credentialRole ===
      OPENGENI_SLACK_BOT_CREDENTIAL_ROLE
  );
}

export function hasReservedOpenGeniSlackBotMetadata(
  metadata: Record<string, unknown> | null | undefined,
): boolean {
  return (
    metadata?.credentialRole === OPENGENI_SLACK_BOT_CREDENTIAL_ROLE ||
    metadata?.credentialLabel === OPENGENI_SLACK_BOT_CREDENTIAL_LABEL
  );
}

export function hasReservedOpenGeniSlackBotSessionMetadata(
  metadata: Record<string, unknown> | null | undefined,
): boolean {
  return Boolean(
    metadata &&
    Object.prototype.hasOwnProperty.call(metadata, OPENGENI_SLACK_BOT_SESSION_METADATA_KEY),
  );
}

/**
 * Internal, pre-authorized lookup used by the scheduler and Slack tool adapter.
 * Public callers must perform their permission check before calling this helper.
 */
export async function requireOpenGeniSlackBotConnection(
  db: Database,
  workspaceId: string,
  connectionId: string,
): Promise<ConnectionMetadata> {
  const connection = await getConnectionMetadata(db, workspaceId, connectionId, null);
  if (!connection || !isOpenGeniSlackBotConnection(connection)) {
    throw new HTTPException(422, {
      message: "slackBotConnectionId must reference an OpenGeni Slack bot connection",
    });
  }
  if (connection.status !== "active") {
    throw new HTTPException(422, {
      message: `OpenGeni Slack bot connection is not active (${connection.status})`,
    });
  }
  return connection;
}

export async function validateOpenGeniSlackBotConnectionSelection(
  db: Database,
  grant: AccessGrant,
  workspaceId: string,
  connectionId: string,
): Promise<ConnectionMetadata> {
  requirePermission(grant, "connections:read");
  return await requireOpenGeniSlackBotConnection(db, workspaceId, connectionId);
}

export function scheduledSlackBotConnectionId(
  metadata: Record<string, unknown> | null | undefined,
): string | null {
  const value = metadata?.[OPENGENI_SLACK_BOT_SESSION_METADATA_KEY];
  return typeof value === "string" && zUuid(value) ? value : null;
}

/**
 * The scheduler writes the connection pointer together with immutable creator
 * provenance. Requiring both prevents ordinary session metadata from becoming
 * an authorization mechanism for a workspace-shared bot credential.
 */
export function isTrustedScheduledSlackBotSession(
  session: Pick<Session, "createdBy" | "createdByContext" | "metadata">,
): boolean {
  const scheduledTaskId = session.metadata.scheduledTaskId;
  const scheduledTaskRunId = session.metadata.scheduledTaskRunId;
  return (
    session.createdBy?.kind === "service" &&
    session.createdBy.subjectId === "scheduler" &&
    typeof scheduledTaskId === "string" &&
    zUuid(scheduledTaskId) &&
    typeof scheduledTaskRunId === "string" &&
    zUuid(scheduledTaskRunId) &&
    session.createdByContext.scheduledTaskId === scheduledTaskId &&
    session.createdByContext.scheduledTaskRunId === scheduledTaskRunId &&
    scheduledSlackBotConnectionId(session.metadata) !== null
  );
}

function zUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
