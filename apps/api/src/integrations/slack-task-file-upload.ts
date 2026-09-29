import { createHash } from "node:crypto";
import {
  hasOpenGeniSlackFileUploadScope,
  OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
  OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
  type AccessGrant,
} from "@opengeni/contracts";
import {
  fileOwnerContextForAgent,
  hasPermission,
  requireOpenGeniSlackBotConnection,
  requirePermission,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  checkpointSlackFileUpload,
  claimSlackFileUpload,
  getSlackBotUserLink,
  getSlackInteractionForSession,
  recordAuditEvent,
  releaseSlackFileUploadClaim,
  renewSlackFileUploadClaim,
  requireFileForSubject,
  resolveSlackInstallationRoute,
  resolveSlackTargetAuthority,
  withSessionRlsActorContext,
  type SlackInteraction,
} from "@opengeni/db";
import { HTTPException } from "hono/http-exception";
import { createOpenGeniSlackBotInteractionClient } from "./slack-bot";
import { runSlackFileUpload, SlackFileUploadClaimLostError } from "./slack-file-upload-flow";

export const SLACK_TASK_FILE_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
const CLAIM_LEASE_MS = 60_000;

/** The source and destination are canonical authorities, never a URL or channel supplied by the model. */
export async function uploadSlackTaskFile(
  deps: ApiRouteDeps,
  input: {
    grant: AccessGrant;
    sessionId: string;
    fileId: string;
    operationId: string;
    authorize: () => Promise<void>;
  },
) {
  await input.authorize();
  const { grant } = input;
  requirePermission(grant, "connections:read");
  const actor = await fileOwnerContextForAgent(deps, grant, "files:read");
  const scope = { accountId: grant.accountId, workspaceId: grant.workspaceId };
  const resolveTarget = async () => {
    const interaction = await getSlackInteractionForSession(deps.db, {
      ...scope,
      sessionId: input.sessionId,
    });
    if (
      !interaction?.initiatingSlackUserId ||
      !interaction.slackThreadTs ||
      !/^\d{1,20}\.\d{1,12}$/.test(interaction.slackThreadTs)
    ) {
      throw new HTTPException(422, {
        message: "File delivery requires this session's existing Slack task thread",
      });
    }
    if (
      interaction.visibility === "private" &&
      actor.initiatingHumanSubjectId !== interaction.owningSubjectId
    ) {
      throw new HTTPException(403, {
        message: "Private Slack file delivery requires the task owner's current attempt",
      });
    }
    assertSlackTaskUploadTarget(interaction);
    const home = await resolveSlackInstallationRoute(deps.db, interaction.slackTeamId);
    if (
      !home ||
      home.accountId !== grant.accountId ||
      home.connectionId !== interaction.connectionId
    ) {
      throw new HTTPException(403, { message: "Slack task installation authority changed" });
    }
    const link = await getSlackBotUserLink(
      deps.db,
      home.workspaceId,
      interaction.connectionId,
      interaction.initiatingSlackUserId,
    );
    if (!link || link.subjectId !== interaction.owningSubjectId) {
      throw new HTTPException(403, { message: "Slack task requester is no longer linked" });
    }
    const requester = await resolveSlackTargetAuthority(deps.db, {
      subjectId: link.subjectId,
      targetAccountId: grant.accountId,
      targetWorkspaceId: grant.workspaceId,
    });
    if (!requester || !slackTaskRequesterCanReceiveFile(requester.permissions)) {
      throw new HTTPException(403, {
        message: "Slack task requester no longer has file delivery access",
      });
    }
    return { interaction, home };
  };

  return withSessionRlsActorContext(actor, async () => {
    const target = await resolveTarget();
    const file = await requireFileForSubject(deps.db, {
      ...scope,
      subjectId: grant.subjectId,
      fileId: input.fileId,
    });
    if (file.workspaceId !== grant.workspaceId) {
      throw new HTTPException(422, {
        message: "Select a retained file from this Slack task's workspace",
      });
    }
    assertSlackTaskUploadFile(file, target.interaction.visibility);
    const connection = await requireOpenGeniSlackBotConnection(
      deps.db,
      target.home.workspaceId,
      target.interaction.connectionId,
    );
    if (!hasOpenGeniSlackFileUploadScope(connection.grantedScopes)) {
      throw new HTTPException(422, {
        message:
          "A Slack administrator must apply the OpenGeni bot manifest and reinstall the bot to grant files:write. A personal Slack connection is not needed.",
      });
    }
    if (!deps.objectStorage)
      throw new HTTPException(503, { message: "Retained file storage is unavailable" });
    let stored;
    try {
      stored = await deps.objectStorage.getObjectBytes(file.objectKey);
    } catch {
      throw new HTTPException(503, { message: "Retained file content is unavailable" });
    }
    if (
      !stored ||
      stored.bytes.byteLength !== file.sizeBytes ||
      createHash("sha256").update(stored.bytes).digest("hex") !== file.sha256
    ) {
      throw new HTTPException(409, {
        message: "Retained file content does not match its immutable identity",
      });
    }
    const filename = file.safeFilename.slice(0, 200);
    if (!filename || /[\r\n\0]/.test(filename))
      throw new HTTPException(422, { message: "Invalid retained filename" });
    const binding = {
      ...scope,
      sessionId: input.sessionId,
      interactionId: target.interaction.id,
      connectionId: target.interaction.connectionId,
      fileId: input.fileId,
      subjectId: actor.initiatingHumanSubjectId ?? grant.subjectId,
      operationId: input.operationId,
      requestDigest: createHash("sha256")
        .update(
          JSON.stringify({
            fileId: file.id,
            sha256: file.sha256,
            sizeBytes: file.sizeBytes,
            contentType: file.contentType,
            filename,
            channelId: target.interaction.slackChannelId,
            threadTimestamp: target.interaction.slackThreadTs,
            connectionId: target.interaction.connectionId,
            slackTeamId: target.interaction.slackTeamId,
          }),
        )
        .digest("hex"),
    };
    const claimHolderId = crypto.randomUUID();
    const claim = await claimSlackFileUpload(deps.db, {
      ...binding,
      claimHolderId,
      leaseMs: CLAIM_LEASE_MS,
    });
    if (claim.status === "conflict")
      throw new HTTPException(409, {
        message: "operationId is already bound to a different Slack file delivery",
      });
    if (claim.status === "busy")
      throw new HTTPException(409, {
        message: "Slack file delivery is already in progress; retry with the same operationId",
      });
    const claimScope = {
      ...scope,
      sessionId: input.sessionId,
      operationId: input.operationId,
      claimHolderId,
    };
    const authorizeProviderRequest = async () => {
      await input.authorize();
      await fileOwnerContextForAgent(deps, grant, "files:read");
      const currentTarget = await resolveTarget();
      if (
        currentTarget.interaction.id !== target.interaction.id ||
        currentTarget.interaction.connectionId !== target.interaction.connectionId ||
        currentTarget.interaction.slackChannelId !== target.interaction.slackChannelId ||
        currentTarget.interaction.slackThreadTs !== target.interaction.slackThreadTs ||
        currentTarget.interaction.visibility !== target.interaction.visibility ||
        currentTarget.home.workspaceId !== target.home.workspaceId
      )
        throw new HTTPException(403, { message: "Slack file delivery target changed" });
      const currentFile = await requireFileForSubject(deps.db, {
        ...scope,
        subjectId: grant.subjectId,
        fileId: file.id,
      });
      assertSlackTaskUploadFile(currentFile, currentTarget.interaction.visibility);
      if (
        currentFile.sha256 !== file.sha256 ||
        currentFile.sizeBytes !== file.sizeBytes ||
        currentFile.objectKey !== file.objectKey
      ) {
        throw new HTTPException(409, { message: "Slack file delivery source changed" });
      }
      if (!(await renewSlackFileUploadClaim(deps.db, { ...claimScope, leaseMs: CLAIM_LEASE_MS })))
        throw new SlackFileUploadClaimLostError();
    };
    try {
      const client = await createOpenGeniSlackBotInteractionClient(
        { ...deps, authorizeProviderRequest },
        {
          accountId: target.home.accountId,
          workspaceId: target.home.workspaceId,
          connectionId: target.interaction.connectionId,
          subjectId: grant.subjectId,
          sessionId: input.sessionId,
        },
      );
      const result = await runSlackFileUpload({
        state: claim.operation,
        provider: client,
        checkpoint: (update) => checkpointSlackFileUpload(deps.db, { ...claimScope, ...update }),
        channelId: target.interaction.slackChannelId,
        threadTimestamp: target.interaction.slackThreadTs!,
        ...(target.interaction.visibility === "private"
          ? { privateRecipientSlackUserId: target.interaction.initiatingSlackUserId! }
          : {}),
        filename,
        bytes: stored.bytes,
      });
      await recordAuditEvent(deps.db, {
        ...scope,
        subjectId: grant.subjectId,
        action: "slack.file.upload",
        targetType: "workspace_file",
        targetId: file.id,
        metadata: {
          operationId: input.operationId,
          sessionId: input.sessionId,
          interactionId: target.interaction.id,
          slackFileId: result.slackFileId,
          replayed: result.replayed,
        },
      });
      return {
        status: "uploaded" as const,
        fileId: file.id,
        ...result,
        channelId: target.interaction.slackChannelId,
        threadTimestamp: target.interaction.slackThreadTs,
        receipt: {
          credentialRole: OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
          credentialLabel: OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
          connectionId: target.interaction.connectionId,
          slackTeamId: target.interaction.slackTeamId,
          operation: "file.upload",
          operationId: input.operationId,
        },
      };
    } finally {
      if (claim.status === "claimed") await releaseSlackFileUploadClaim(deps.db, claimScope);
    }
  });
}

export function slackTaskRequesterCanReceiveFile(permissions: AccessGrant["permissions"]): boolean {
  return hasPermission(permissions, "files:read") && hasPermission(permissions, "sessions:read");
}

/** Private shortcuts bind a runnable session before its bot-DM route commits. */
export function assertSlackTaskUploadTarget(
  interaction: Pick<
    SlackInteraction,
    "visibility" | "slackChannelId" | "slackThreadTs" | "routeKey" | "ackSlackMessageTs"
  >,
): void {
  if (
    interaction.visibility === "private" &&
    (!interaction.slackChannelId.startsWith("D") ||
      interaction.routeKey !== `${interaction.slackChannelId}:${interaction.slackThreadTs}` ||
      (interaction.ackSlackMessageTs !== null &&
        interaction.ackSlackMessageTs !== interaction.slackThreadTs))
  ) {
    throw new HTTPException(409, {
      message: "Private Slack file delivery must wait for this task's committed bot-DM thread",
    });
  }
}

export function assertSlackTaskUploadFile(
  file: { status: string; scope?: string | undefined; sizeBytes: number; sha256: string | null },
  visibility: string,
): void {
  if (file.status !== "ready" || !file.sha256 || !/^[a-f0-9]{64}$/.test(file.sha256)) {
    throw new HTTPException(422, {
      message: "Publish a ready, immutable file before uploading it to Slack",
    });
  }
  if (file.scope === "personal" && visibility !== "private") {
    throw new HTTPException(403, {
      message: "Personal files cannot be uploaded to a shared Slack task thread",
    });
  }
  if (file.sizeBytes < 1 || file.sizeBytes > SLACK_TASK_FILE_UPLOAD_MAX_BYTES) {
    throw new HTTPException(413, {
      message: "Slack task file delivery supports nonempty files up to 25 MiB",
    });
  }
}
