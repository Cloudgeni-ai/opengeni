import {
  OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
  OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
  OPENGENI_SLACK_BOT_SESSION_METADATA_KEY,
  OpenGeniSlackBotConnectionMetadata,
  SCHEDULED_SLACK_BOT_POSTING_TOOLS,
  areOpenGeniSlackBotScopesAccepted,
  type AccessGrant,
  type ConnectionMetadata,
  type FirstPartyMcpToolName,
  type OpenGeniSlackBotConnectionMetadata as OpenGeniSlackBotMetadata,
  type ScheduledTask,
  type ScheduledTaskAgentConfig,
  type Session,
} from "@opengeni/contracts";
import {
  getConnectionMetadata,
  type ConnectionMetadataWithVerification,
  type Database,
} from "@opengeni/db";
import { HTTPException } from "hono/http-exception";
import { requirePermission, type AccessGrantAuthorization } from "../access";
import { grantHasAgentAttemptAuthority } from "../session-authorization";

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
  return (
    connection.verifiedInstallAt != null &&
    connection.verifiedInstallVersion === connection.version &&
    connection.subjectId === null &&
    connection.providerDomain === "slack.com" &&
    connection.kind === "app_install" &&
    areOpenGeniSlackBotScopesAccepted(connection.grantedScopes) &&
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

/**
 * Proves, with the bot's own token, that it may post in the chosen channel:
 * the bot is a member and the channel is active and not shared with another
 * organization. Supplied only by the HTTP routes a person uses to edit tasks.
 */
export type ScheduledTaskSlackChannelVerifier = (input: {
  connectionId: string;
  channelId: string;
}) => Promise<void>;

/**
 * Whether this request is a signed-in person acting for themselves: never an
 * agent attempt, a service, an API key, or a request carrying service
 * provenance. The same rule gates Agent learning settings.
 */
export function isAuthenticatedPersonAuthorization(
  authorization: AccessGrantAuthorization | undefined,
): boolean {
  if (!authorization) return false;
  const { grant } = authorization;
  return (
    grant.principalKind === "human_session" &&
    authorization.contextIntegrity &&
    authorization.authenticatedSubjectId === grant.subjectId &&
    !grant.serviceInitiator &&
    !grant.serviceInitiatorContext &&
    grant.metadata?.attemptId === undefined &&
    grant.metadata?.turnId === undefined &&
    grant.metadata?.executionGeneration === undefined &&
    !grantHasAgentAttemptAuthority(grant)
  );
}

/**
 * A scheduled task may post as the OpenGeni workspace bot only to the one
 * Slack channel a person chose on the task. Choosing or changing that channel
 * therefore needs a signed-in person with `connections:write`, and the bot's
 * membership is verified at that moment. Keeping or clearing the existing
 * channel needs neither, so an agent editing other task fields cannot redirect
 * posts but also does not have to re-prove the person's choice. Clearing is the
 * safe direction and is never refused, even for a task that continues one chat.
 */
export async function validateScheduledTaskSlackChannel(input: {
  grant: AccessGrant;
  authorization?: AccessGrantAuthorization | undefined;
  previous: Pick<ScheduledTaskAgentConfig, "slackBotConnectionId" | "slackBotChannelId"> | null;
  next: Pick<ScheduledTaskAgentConfig, "slackBotConnectionId" | "slackBotChannelId">;
  runMode: ScheduledTask["runMode"];
  /**
   * Null unless the task already created the reusable chat its runs continue.
   * Otherwise reports whether that chat was created with the posting tools,
   * which are fixed at creation.
   */
  reusableSessionCanPost: (() => Promise<boolean>) | null;
  verifySlackChannel?: ScheduledTaskSlackChannelVerifier | undefined;
}): Promise<void> {
  const previousChannel = input.previous?.slackBotChannelId ?? null;
  const nextChannel = input.next.slackBotChannelId ?? null;
  // Clearing takes effect at once: the tools re-read the task and refuse.
  if (!nextChannel) return;
  if (!input.next.slackBotConnectionId) {
    throw new HTTPException(422, {
      message: "slackBotChannelId requires slackBotConnectionId",
    });
  }
  if (input.runMode === "existing_session") {
    throw new HTTPException(422, {
      message: "Slack channel posting needs a task that starts its own chats",
    });
  }
  if (
    previousChannel === nextChannel &&
    (input.previous?.slackBotConnectionId ?? null) === input.next.slackBotConnectionId
  ) {
    return;
  }
  if (!isAuthenticatedPersonAuthorization(input.authorization)) {
    throw new HTTPException(403, {
      message: "Only a person can choose the Slack channel a scheduled task posts to",
    });
  }
  requirePermission(input.grant, "connections:write");
  // A chat created without the posting tools keeps that tool set, so choosing
  // a channel for it would silently post nothing.
  if (input.reusableSessionCanPost && !(await input.reusableSessionCanPost())) {
    throw new HTTPException(409, {
      message:
        "this task continues a chat that was created without Slack posting; recreate the task to post from it",
    });
  }
  if (!input.verifySlackChannel) {
    throw new HTTPException(422, {
      message: "Choose the Slack channel in the schedule editor",
    });
  }
  await input.verifySlackChannel({
    connectionId: input.next.slackBotConnectionId,
    channelId: nextChannel,
  });
}

/**
 * Add the bot posting tools to a generated scheduled run when, and only when,
 * a person chose the task's Slack channel. The deployment ceiling still
 * applies: an operator who disallowed these tools keeps them off.
 */
export function withScheduledSlackBotPostingTools(
  tools: readonly FirstPartyMcpToolName[],
  agentConfig: Pick<ScheduledTaskAgentConfig, "slackBotConnectionId" | "slackBotChannelId">,
  allowedTools: readonly FirstPartyMcpToolName[],
): FirstPartyMcpToolName[] {
  if (!agentConfig.slackBotConnectionId || !agentConfig.slackBotChannelId) return [...tools];
  const allowed = new Set(allowedTools);
  const next = [...tools];
  for (const tool of SCHEDULED_SLACK_BOT_POSTING_TOOLS) {
    if (allowed.has(tool) && !next.includes(tool)) next.push(tool);
  }
  return next;
}
