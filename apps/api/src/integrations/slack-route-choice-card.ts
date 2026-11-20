/**
 * The "Who should answer in #channel?" card for an installation with Slack
 * agents. Pure Block Kit, no I/O.
 *
 * Agents and workspaces are different kinds of answer: an agent is a named
 * assistant, a workspace is Opengeni itself working there. The card labels the
 * two groups so nobody has to guess which button is which, and shows each
 * agent with its avatar and description.
 */
import { escapeSlackMrkdwn } from "./slack-app-home";
import { SlackBotOperationConflictError, type SlackMessageBlock } from "./slack-bot";

/** What the card shows about an agent beyond its name. */
export type SlackRouteChoiceAgentDetails = {
  /** A public picture of the agent's avatar, or null to show none. */
  iconUrl: string | null;
  description: string;
};

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
  /** Avatar and description by Slack agent id; an agent without them shows its name only. */
  agentDetails?: ReadonlyMap<string, SlackRouteChoiceAgentDetails>;
};

/** A description longer than this is cut, so a row stays one or two lines. */
const AGENT_DESCRIPTION_MAX_CHARS = 120;

function shortDescription(text: string): string {
  const chars = [...text.replace(/\s+/gu, " ").trim()];
  return chars.length <= AGENT_DESCRIPTION_MAX_CHARS
    ? chars.join("")
    : `${chars.slice(0, AGENT_DESCRIPTION_MAX_CHARS - 1).join("")}…`;
}

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
 * One agent: its avatar, name and description on a quiet line, then its button.
 * Without details it is just a button with its name.
 */
function agentRows(
  option: SlackRouteChoiceCardOption,
  details: SlackRouteChoiceAgentDetails | undefined,
): SlackMessageBlock[] {
  const description = details ? shortDescription(details.description) : "";
  if (!details || (!details.iconUrl && !description)) {
    return [
      {
        type: "actions",
        block_id: `opengeni-route-choice-${option.id}`,
        elements: [optionButton(option, option.candidateLabel)],
      },
    ];
  }
  const name = `*${escapeSlackMrkdwn(option.candidateLabel)}*`;
  return [
    {
      type: "context",
      elements: [
        ...(details.iconUrl
          ? [
              {
                type: "image" as const,
                image_url: details.iconUrl,
                alt_text: option.candidateLabel,
              },
            ]
          : []),
        {
          type: "mrkdwn" as const,
          text: description ? `${name}  ${escapeSlackMrkdwn(description)}` : name,
        },
      ],
    },
    {
      type: "actions",
      block_id: `opengeni-route-choice-${option.id}`,
      elements: [optionButton(option, "Choose")],
    },
  ];
}

/**
 * The card: the question, then "Agents" and "Workspaces" each above its own
 * options, then "Not now" on its own below a divider, then where to change the
 * answer. An empty group is left out. Options come from the stored snapshot,
 * so a replay posts the same bytes unless an agent's avatar or description
 * changed in between.
 */
export function slackRouteChoiceWithAgentsBlocks(
  input: SlackRouteChoiceCardInput,
): SlackMessageBlock[] {
  const agents = input.options.filter((option) => option.candidateSlackAgentId !== null);
  const workspaces = input.options.filter((option) => option.candidateSlackAgentId === null);
  const label = (text: string): SlackMessageBlock => ({
    type: "section",
    text: { type: "mrkdwn", text: `*${text}*` },
  });
  return [
    { type: "section", text: { type: "mrkdwn", text: slackRouteChoiceQuestion(input.channel) } },
    ...(agents.length > 0
      ? [
          label("Agents"),
          ...agents.flatMap((option) =>
            agentRows(option, input.agentDetails?.get(option.candidateSlackAgentId!)),
          ),
        ]
      : []),
    ...(workspaces.length > 0
      ? [
          label("Workspaces"),
          {
            type: "actions" as const,
            block_id: "opengeni-route-choice-workspaces",
            elements: workspaces.map((option) => optionButton(option, option.candidateLabel)),
          },
        ]
      : []),
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
 * Post the card. The post ledger binds the prompt's operation id to a digest
 * of the exact blocks and refuses other bytes from its durable claim, before
 * any Slack write. A refusal means the operation was bound earlier: if that
 * card is already up there is nothing to post; otherwise an earlier release
 * bound it to the flat card, so retry once with that card under the same
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
    /** Whether the operation's card was already posted. */
    alreadyPosted: () => Promise<boolean>;
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
    if (await input.alreadyPosted()) return;
    await post(legacySlackRouteChoiceWithAgentsBlocks(input));
  }
}
