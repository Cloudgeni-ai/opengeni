/**
 * The Ask form's Slack round trips: opening it (bare slash command, message
 * shortcut, App Home's Ask button) and taking its submission.
 *
 * Opening happens inside Slack's three-second trigger window, so it does only
 * the reads it needs and never retries; every caller has a plain fallback.
 *
 * A submission is validated, rechecked (the agent still exists, the person can
 * still use it, the stored shortcut message is theirs), acknowledged at once,
 * and queued in the ordinary inbox: like a slash command (or the shortcut it
 * came from) addressed to the chosen agent through `target_slack_agent_id`.
 * The inbox processing then checks access again, exactly as for any request.
 *
 * Nothing here runs without workspace routing and at least one agent in the
 * installation, so an installation without agents is unchanged.
 */
import {
  deleteSlackAskForm,
  enqueueSlackInteractionInbox,
  getSlackAskForm,
  getSlackBotUserLink,
  insertSlackAskForm,
  resolveSlackInstallationRoute,
  type SlackAgentRecord,
  type SlackInstallationRoute,
} from "@opengeni/db";
import type { ApiRouteDeps } from "@opengeni/core";
import { errorMessage } from "@opengeni/contracts/values";

import type { LoadedSlackAgents } from "./slack-agents";
import {
  buildSlackAskFormView,
  parseSlackAskSubmission,
  slackAskShortcutText,
  SLACK_ASK_AGENT_BLOCK_ID,
  SLACK_ASK_REQUEST_BLOCK_ID,
  type SlackAskMetadata,
} from "./slack-ask-form";
import { createOpenGeniSlackBotInteractionClient, SlackBotProviderError } from "./slack-bot";

const SLACK_ASK_BOT_SUBJECT_ID = "service:slack-interaction";
/** Inbox text is bounded at 12,000 bytes. */
const SLACK_INBOX_TEXT_MAX_BYTES = 12_000;

/** What the Ask form borrows from the interaction pipeline. */
export type SlackAskHelpers = {
  usableAgents: (
    installation: Pick<SlackInstallationRoute, "accountId" | "workspaceId" | "connectionId">,
    subjectId: string,
  ) => Promise<{ agents: SlackAgentRecord[]; loaded: LoadedSlackAgents }>;
  linkUrl: (identity: {
    workspaceId: string;
    connectionId: string;
    slackTeamId: string;
    slackUserId: string;
  }) => string;
  /** A Slack failure that retrying will not fix. */
  permanentDeliveryError: (error: unknown) => boolean;
};

export type SlackViewSubmissionResponse =
  | { response_action: "clear" }
  | { response_action: "errors"; errors: Record<string, string> };

function fieldError(blockId: string, message: string): SlackViewSubmissionResponse {
  return { response_action: "errors", errors: { [blockId]: message } };
}

/**
 * The agents to offer this person, or null when the form does not apply: no
 * workspace routing, no agents in the installation, or an unlinked person
 * (who gets today's link prompt instead).
 */
async function askFormAgents(
  deps: ApiRouteDeps,
  installation: SlackInstallationRoute,
  slackUserId: string,
  helpers: SlackAskHelpers,
): Promise<SlackAgentRecord[] | null> {
  if (!deps.settings.slackWorkspaceRoutingEnabled) return null;
  const link = await getSlackBotUserLink(
    deps.db,
    installation.workspaceId,
    installation.connectionId,
    slackUserId,
  );
  if (!link) return null;
  const { agents, loaded } = await helpers.usableAgents(installation, link.subjectId);
  return loaded.records.length > 0 ? agents : null;
}

async function openView(
  deps: ApiRouteDeps,
  installation: SlackInstallationRoute,
  triggerId: string,
  view: Record<string, unknown>,
): Promise<boolean> {
  try {
    const client = await createOpenGeniSlackBotInteractionClient(deps, {
      accountId: installation.accountId,
      workspaceId: installation.workspaceId,
      connectionId: installation.connectionId,
      subjectId: SLACK_ASK_BOT_SUBJECT_ID,
    });
    await client.openView({ triggerId, view });
    return true;
  } catch (error) {
    console.error("[slack-ask] opening the Ask form failed", {
      workspaceId: installation.workspaceId,
      error: errorMessage(error),
    });
    return false;
  }
}

function metadataFor(
  installation: SlackInstallationRoute,
  slackTeamId: string,
  fields: Pick<SlackAskMetadata, "src" | "ch" | "f">,
): SlackAskMetadata {
  return { v: 1, c: installation.connectionId, t: slackTeamId, ...fields };
}

function formAgents(agents: readonly SlackAgentRecord[]) {
  return agents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    description: agent.description,
  }));
}

/** A bare slash command. False means: answer with the info card as before. */
export async function openSlackAskFormForCommand(
  deps: ApiRouteDeps,
  installation: SlackInstallationRoute,
  input: { triggerId: string; slackTeamId: string; slackUserId: string; slackChannelId: string },
  helpers: SlackAskHelpers,
): Promise<boolean> {
  const agents = await askFormAgents(deps, installation, input.slackUserId, helpers);
  if (!agents) return false;
  return await openView(
    deps,
    installation,
    input.triggerId,
    buildSlackAskFormView({
      agents: formAgents(agents),
      metadata: metadataFor(installation, input.slackTeamId, {
        src: "command",
        ch: input.slackChannelId,
        f: null,
      }),
    }),
  );
}

/**
 * The message shortcut in an installation with agents. False means: queue the
 * shortcut exactly as before.
 */
export async function openSlackAskFormForShortcut(
  deps: ApiRouteDeps,
  installation: SlackInstallationRoute,
  input: {
    triggerId: string;
    providerEventId: string;
    slackTeamId: string;
    slackUserId: string;
    slackChannelId: string;
    slackMessageTs: string;
    slackThreadTs: string | null;
    text: string;
  },
  helpers: SlackAskHelpers,
): Promise<boolean> {
  // Any failure here only means no form: the shortcut is then queued right
  // away, exactly as it was before agents existed.
  let agents: Awaited<ReturnType<typeof askFormAgents>>;
  try {
    agents = await askFormAgents(deps, installation, input.slackUserId, helpers);
  } catch {
    return false;
  }
  if (!agents) return false;
  const home = { accountId: installation.accountId, workspaceId: installation.workspaceId };
  const form = await insertSlackAskForm(deps.db, home, {
    connectionId: installation.connectionId,
    slackTeamId: input.slackTeamId,
    slackUserId: input.slackUserId,
    slackChannelId: input.slackChannelId,
    slackMessageTs: input.slackMessageTs,
    slackThreadTs: input.slackThreadTs,
    providerEventId: input.providerEventId,
    messageText: input.text,
  });
  const opened = await openView(
    deps,
    installation,
    input.triggerId,
    buildSlackAskFormView({
      agents: formAgents(agents),
      metadata: metadataFor(installation, input.slackTeamId, {
        src: "shortcut",
        ch: null,
        f: form.id,
      }),
      messageText: input.text,
    }),
  );
  if (!opened) await deleteSlackAskForm(deps.db, home, { formId: form.id });
  return opened;
}

/** App Home's Ask button: the form with that agent chosen. */
export async function openSlackAskFormFromHome(
  deps: ApiRouteDeps,
  input: { triggerId: string; slackTeamId: string; slackUserId: string; agentId: string },
  helpers: SlackAskHelpers,
): Promise<void> {
  const installation = await resolveSlackInstallationRoute(deps.db, input.slackTeamId);
  if (!installation) return;
  const agents = await askFormAgents(deps, installation, input.slackUserId, helpers);
  if (!agents) return;
  await openView(
    deps,
    installation,
    input.triggerId,
    buildSlackAskFormView({
      agents: formAgents(agents),
      metadata: metadataFor(installation, input.slackTeamId, { src: "home", ch: null, f: null }),
      preselectedAgentId: input.agentId,
    }),
  );
}

function boundedInboxText(text: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= SLACK_INBOX_TEXT_MAX_BYTES) return text;
  let bounded = [...text].slice(0, 11_000).join("");
  while (encoder.encode(bounded).length > SLACK_INBOX_TEXT_MAX_BYTES) {
    bounded = bounded.slice(0, -100);
  }
  return bounded;
}

/**
 * Take a submitted Ask form. Returns Slack's answer to the submission:
 * `clear` once the request is queued, or an error on the field to fix. Null
 * when the payload is not an Ask form.
 */
export async function handleSlackAskSubmission(
  deps: ApiRouteDeps,
  payload: unknown,
  helpers: SlackAskHelpers,
): Promise<SlackViewSubmissionResponse | null> {
  const submission = parseSlackAskSubmission(payload);
  if (!submission) return null;
  const { metadata } = submission;
  const unavailable = fieldError(
    SLACK_ASK_REQUEST_BLOCK_ID,
    "Opengeni is no longer available here. Close this and try again.",
  );
  if (metadata.t !== submission.slackTeamId || !deps.settings.slackWorkspaceRoutingEnabled) {
    return unavailable;
  }
  const installation = await resolveSlackInstallationRoute(deps.db, submission.slackTeamId);
  if (!installation || installation.connectionId !== metadata.c) return unavailable;
  const home = { accountId: installation.accountId, workspaceId: installation.workspaceId };
  const link = await getSlackBotUserLink(
    deps.db,
    installation.workspaceId,
    installation.connectionId,
    submission.slackUserId,
  );
  if (!link) {
    return fieldError(
      SLACK_ASK_REQUEST_BLOCK_ID,
      `Link your Slack identity to Opengeni first: ${helpers.linkUrl({
        workspaceId: installation.workspaceId,
        connectionId: installation.connectionId,
        slackTeamId: submission.slackTeamId,
        slackUserId: submission.slackUserId,
      })}`,
    );
  }

  // The agent is read again now: it may have been deleted, or the person may
  // have lost access to its workspace, since the form opened.
  if (submission.agentId) {
    const { agents, loaded } = await helpers.usableAgents(installation, link.subjectId);
    if (!agents.some((agent) => agent.id === submission.agentId)) {
      const agent = loaded.records.find((candidate) => candidate.id === submission.agentId);
      return fieldError(
        SLACK_ASK_AGENT_BLOCK_ID,
        agent
          ? `${agent.name} works in a workspace you don't have access to. Choose another.`
          : "This agent no longer exists. Choose another.",
      );
    }
  }

  if (metadata.src === "shortcut") {
    const form = metadata.f ? await getSlackAskForm(deps.db, home, { formId: metadata.f }) : null;
    if (
      !form ||
      form.connectionId !== installation.connectionId ||
      form.slackTeamId !== submission.slackTeamId ||
      form.slackUserId !== submission.slackUserId
    ) {
      return fieldError(
        SLACK_ASK_REQUEST_BLOCK_ID,
        "This form expired. Close it and use the shortcut again.",
      );
    }
    // The same inbox row the shortcut queues without the form, with the
    // chosen agent: the shortcut pipeline continues from here unchanged.
    await enqueueSlackInteractionInbox(deps.db, {
      ...home,
      connectionId: installation.connectionId,
      providerEventId: form.providerEventId,
      providerMessageId: form.providerEventId,
      slackTeamId: form.slackTeamId,
      slackUserId: form.slackUserId,
      slackChannelId: form.slackChannelId,
      slackMessageTs: form.slackMessageTs,
      slackThreadTs: form.slackThreadTs,
      triggerKind: "message_shortcut",
      text: boundedInboxText(slackAskShortcutText(form.messageText, submission.request)),
      hasFiles: false,
      targetSlackAgentId: submission.agentId,
    });
    await deleteSlackAskForm(deps.db, home, { formId: form.id });
    return { response_action: "clear" };
  }

  if (submission.request.length === 0) {
    return fieldError(SLACK_ASK_REQUEST_BLOCK_ID, "Write a request.");
  }
  const client = await createOpenGeniSlackBotInteractionClient(deps, {
    ...home,
    connectionId: installation.connectionId,
    subjectId: SLACK_ASK_BOT_SUBJECT_ID,
  });
  let channelId = metadata.ch;
  try {
    if (metadata.src === "home" || !channelId) {
      // From App Home the answer goes to the person's messages with Opengeni.
      channelId = (await client.openDirectMessage(submission.slackUserId)).channelId;
    } else {
      await client.verifyChannelAccess(channelId);
    }
  } catch (error) {
    if (error instanceof SlackBotProviderError && error.code === "not_in_channel") {
      return fieldError(
        SLACK_ASK_REQUEST_BLOCK_ID,
        "Opengeni is not a member of this channel. Add @Opengeni, then try again.",
      );
    }
    // As for a slash command, a transient membership check falls through to
    // the inbox, whose retries cover it. Without a channel there is nowhere
    // to answer, so that one asks the person to try again.
    if (
      !channelId ||
      !(error instanceof SlackBotProviderError) ||
      helpers.permanentDeliveryError(error)
    ) {
      return fieldError(SLACK_ASK_REQUEST_BLOCK_ID, "Slack didn't answer. Try again.");
    }
  }
  // One request per form: the view id is the delivery identity, like a slash
  // command's trigger id.
  const providerEventId = `ask:${submission.viewId}`;
  await enqueueSlackInteractionInbox(deps.db, {
    ...home,
    connectionId: installation.connectionId,
    providerEventId,
    providerMessageId: providerEventId,
    slackTeamId: submission.slackTeamId,
    slackUserId: submission.slackUserId,
    slackChannelId: channelId,
    slackMessageTs: submission.viewId,
    slackThreadTs: null,
    triggerKind: "slash_command",
    text: boundedInboxText(submission.request),
    hasFiles: false,
    targetSlackAgentId: submission.agentId,
  });
  return { response_action: "clear" };
}
