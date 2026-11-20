/**
 * The "Who should answer in #channel?" card for an installation with Slack
 * agents. Pure Block Kit, no I/O.
 *
 * Agents and workspaces are different kinds of answer: an agent is a named
 * assistant, a workspace is Opengeni itself working there. The card labels the
 * two groups so nobody has to guess which button is which.
 */
import { SlackBotOperationConflictError, type SlackMessageBlock } from "./slack-bot";

/** One stored option, as the card renders it. */
export type SlackRouteChoiceCardOption = {
  id: string;
  candidateLabel: string;
  candidateSlackAgentId: string | null;
};

export type SlackRouteChoiceCardInput = {
  /** The channel as Slack mrkdwn, for example `<#C123>`. */
  channel: string;
  /** In stored position order. */
  options: readonly SlackRouteChoiceCardOption[];
  /** Value of the "Not now" button. */
  cancelValue: string;
  /** The Opengeni workspace link for the footer, when known. */
  settingsUrl: string | null;
};

export const SLACK_ROUTE_SELECT_ACTION_ID = "opengeni.route.select";
export const SLACK_ROUTE_CANCEL_ACTION_ID = "opengeni.route.cancel";

export function slackRouteChoiceQuestion(channel: string): string {
  return `Who should answer in ${channel}?`;
}

function optionButton(option: SlackRouteChoiceCardOption, text: string) {
  return {
    type: "button" as const,
    action_id: SLACK_ROUTE_SELECT_ACTION_ID,
    value: option.id,
    text: { type: "plain_text" as const, text },
  };
}

function cancelButton(value: string) {
  return {
    type: "button" as const,
    action_id: SLACK_ROUTE_CANCEL_ACTION_ID,
    value,
    text: { type: "plain_text" as const, text: "Not now" },
  };
}

function footer(input: SlackRouteChoiceCardInput): SlackMessageBlock {
  return {
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: input.settingsUrl
          ? `Remembered for ${input.channel}. Change it in <${input.settingsUrl}|Opengeni> under Capabilities, then Slack.`
          : `Remembered for ${input.channel}. Change it in Opengeni under Capabilities, then Slack.`,
      },
    ],
  };
}

/**
 * The card: the question, then "Agents" and "Workspaces" each above its own
 * buttons, then "Not now" on its own below a divider, then where to change the answer. An
 * empty group is left out. Rendered only from the stored options, so a replay
 * posts the same bytes.
 */
export function slackRouteChoiceWithAgentsBlocks(
  input: SlackRouteChoiceCardInput,
): SlackMessageBlock[] {
  const groups = [
    {
      label: "Agents",
      blockId: "opengeni-route-choice-agents",
      options: input.options.filter((option) => option.candidateSlackAgentId !== null),
    },
    {
      label: "Workspaces",
      blockId: "opengeni-route-choice-workspaces",
      options: input.options.filter((option) => option.candidateSlackAgentId === null),
    },
  ];
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: slackRouteChoiceQuestion(input.channel) },
    },
    ...groups.flatMap((group): SlackMessageBlock[] =>
      group.options.length === 0
        ? []
        : [
            {
              type: "section",
              text: { type: "mrkdwn", text: `*${group.label}*` },
            },
            {
              type: "actions",
              block_id: group.blockId,
              elements: group.options.map((option) => optionButton(option, option.candidateLabel)),
            },
          ],
    ),
    { type: "divider" },
    {
      type: "actions",
      block_id: "opengeni-route-choice-cancel",
      elements: [cancelButton(input.cancelValue)],
    },
    footer(input),
  ];
}

/**
 * The previous flat card, kept for repair only. The post ledger binds a
 * prompt's operation id to a digest over the exact blocks, so a card an
 * earlier release already claimed (a pending prompt re-asked, or a retry
 * across the deploy) must be re-sent with the bytes it was bound to. New
 * prompts always use {@link slackRouteChoiceWithAgentsBlocks}.
 */
export function legacySlackRouteChoiceWithAgentsBlocks(
  input: SlackRouteChoiceCardInput & { boundLabel: (label: string) => string },
): SlackMessageBlock[] {
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: slackRouteChoiceQuestion(input.channel) },
    },
    {
      type: "actions",
      block_id: "opengeni-route-choice",
      elements: [
        ...input.options.map((option) =>
          optionButton(
            option,
            option.candidateSlackAgentId
              ? option.candidateLabel
              : input.boundLabel(`Opengeni in ${option.candidateLabel}`),
          ),
        ),
        cancelButton(input.cancelValue),
      ],
    },
    footer(input),
  ];
}

/**
 * Post the card. If the ledger refuses the bytes (it does so from its durable
 * claim, before any Slack write), the operation was bound by an earlier
 * release to the flat card, so retry once with that card under the same
 * operation id. Never mint a new id: that could put a second card up.
 */
export async function postSlackRouteChoiceWithAgentsCard(
  client: {
    postMessage(input: {
      operationId: string;
      userId: string;
      text: string;
      blocks: SlackMessageBlock[];
    }): Promise<unknown>;
  },
  input: SlackRouteChoiceCardInput & {
    operationId: string;
    userId: string;
    text: string;
    boundLabel: (label: string) => string;
  },
): Promise<void> {
  const post = (blocks: SlackMessageBlock[]) =>
    client.postMessage({
      operationId: input.operationId,
      userId: input.userId,
      text: input.text,
      blocks,
    });
  try {
    await post(slackRouteChoiceWithAgentsBlocks(input));
  } catch (error) {
    if (!(error instanceof SlackBotOperationConflictError)) throw error;
    await post(legacySlackRouteChoiceWithAgentsBlocks(input));
  }
}
