import {
  OpenGeniSlackBotInstallStart,
  OPENGENI_SLACK_BOT_REQUESTED_SCOPES,
} from "@opengeni/contracts";
import { ExternalActorContinuation } from "@opengeni/contracts/external-identities";
import {
  isOpenGeniSlackBotConnection,
  requireEnvironmentEncryption,
  type ApiRouteDeps,
} from "@opengeni/core";
import { encryptEnvironmentValue, getConnectionMetadata } from "@opengeni/db";
import { createSignedState } from "@opengeni/github";
import { HTTPException } from "hono/http-exception";
import {
  integrationBaseUrl,
  oauthStateTtlMs,
  requireIntegrationsStateSecret,
} from "./oauth-client";

export function requireOpenGeniSlackOAuthSettings(settings: ApiRouteDeps["settings"]) {
  const clientId = settings.slackClientId?.trim();
  const clientSecret = settings.slackClientSecret?.trim();
  if (!clientId || !clientSecret || !settings.slackSigningSecret?.trim())
    throw new HTTPException(503, {
      message:
        "OpenGeni Slack bot installation requires OPENGENI_SLACK_CLIENT_ID, OPENGENI_SLACK_CLIENT_SECRET, and OPENGENI_SLACK_SIGNING_SECRET",
    });
  return { clientId, clientSecret };
}

/** Only authenticated route admission may invoke this workspace-bot starter.
 * Hosted personal Slack MCP deliberately uses its own OAuth profile. */
export async function startSlackBotInstall(
  deps: ApiRouteDeps,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    requestUrl: string;
    connectionId?: string;
    connectAttemptId?: string;
    externalContinuation?: ExternalActorContinuation;
  },
) {
  const slack = requireOpenGeniSlackOAuthSettings(deps.settings);
  const key = requireEnvironmentEncryption(deps.settings);
  const existing = input.connectionId
    ? await getConnectionMetadata(deps.db, input.workspaceId, input.connectionId, input.subjectId)
    : null;
  if (input.connectionId && !existing)
    throw new HTTPException(404, { message: "connection not found" });
  if (existing && !isOpenGeniSlackBotConnection(existing))
    throw new HTTPException(422, {
      message: "connectionId is not an OpenGeni Slack bot connection",
    });
  const redirectUri = `${integrationBaseUrl(deps.settings.publicBaseUrl, input.requestUrl)}/v1/integrations/slack/callback`;
  const state = createSignedState(requireIntegrationsStateSecret(deps.settings), {
    kind: "slack_bot_install",
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    subjectId: input.subjectId,
    returnPath: `/workspaces/${input.workspaceId}/capabilities`,
    ...(input.connectAttemptId ? { connectAttemptId: input.connectAttemptId } : {}),
    ...(input.externalContinuation
      ? {
          encryptedExternalContinuation: encryptEnvironmentValue(
            key,
            JSON.stringify(ExternalActorContinuation.parse(input.externalContinuation)),
          ),
        }
      : {}),
    ...(existing ? { connectionId: existing.id, connectionVersion: existing.version } : {}),
  });
  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", slack.clientId);
  url.searchParams.set("scope", OPENGENI_SLACK_BOT_REQUESTED_SCOPES.join(","));
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  return OpenGeniSlackBotInstallStart.parse({
    authorizationUrl: url.toString(),
    expiresAt: new Date(Date.now() + oauthStateTtlMs).toISOString(),
  });
}
