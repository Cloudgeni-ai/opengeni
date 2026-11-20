/**
 * The "Who should answer in #channel?" card for an installation with Slack
 * agents, and how it is posted.
 *
 * Agents and workspaces are different kinds of answer: an agent is a named
 * assistant, a workspace is Opengeni itself working there. The card offers
 * them in one menu with an Agents group and a Workspaces group, so nobody has
 * to guess which is which, and "Not now" beside it.
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
  /** An agent's avatar emoji by Slack agent id, shown before its name. */
  agentEmoji?: ReadonlyMap<string, string>;
};

const SELECT_ACTION_ID = "opengeni.route.select";
const CANCEL_ACTION_ID = "opengeni.route.cancel";
/** Slack's limit on a menu option's text, in characters. */
const OPTION_TEXT_MAX_CHARS = 75;

export function slackRouteChoiceQuestion(channel: string): string {
  return `Who should answer in ${channel}?`;
}

function optionButton(option: SlackRouteChoiceCardOption, text: string) {
  return {
    type: "button" as const,
    action_id: SELECT_ACTION_ID,
    value: option.id,
    text: { type: "plain_text" as const, text },
  };
}

function cancelButton(value: string) {
  return {
    type: "button" as const,
    action_id: CANCEL_ACTION_ID,
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

/** A menu option's text: the name, after the agent's emoji when it still fits. */
function optionText(label: string, emoji: string | undefined): string {
  const withEmoji = emoji ? `${emoji} ${label}` : label;
  if ([...withEmoji].length <= OPTION_TEXT_MAX_CHARS) return withEmoji;
  const chars = [...label];
  return chars.length <= OPTION_TEXT_MAX_CHARS
    ? label
    : `${chars.slice(0, OPTION_TEXT_MAX_CHARS - 1).join("")}…`;
}

/**
 * The card: the question, then one menu (Agents, then Workspaces; an empty
 * group is left out) with "Not now" beside it, then where to change the
 * answer. Picking an option sends its stored option id, exactly as the old
 * buttons did. Options come from the stored snapshot, so a replay posts the
 * same bytes unless an agent's emoji changed in between.
 */
export function slackRouteChoiceWithAgentsBlocks(
  input: SlackRouteChoiceCardInput,
): SlackMessageBlock[] {
  const group = (label: string, options: readonly SlackRouteChoiceCardOption[]) =>
    options.length === 0
      ? []
      : [
          {
            label: { type: "plain_text" as const, text: label },
            options: options.map((option) => ({
              text: {
                type: "plain_text" as const,
                text: optionText(
                  option.candidateLabel,
                  option.candidateSlackAgentId
                    ? input.agentEmoji?.get(option.candidateSlackAgentId)
                    : undefined,
                ),
                emoji: true,
              },
              value: option.id,
            })),
          },
        ];
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: slackRouteChoiceQuestion(input.channel) },
    },
    {
      type: "actions",
      block_id: "opengeni-route-choice",
      elements: [
        {
          type: "static_select",
          action_id: SELECT_ACTION_ID,
          placeholder: { type: "plain_text", text: "Choose who answers" },
          option_groups: [
            ...group(
              "Agents",
              input.options.filter((option) => option.candidateSlackAgentId !== null),
            ),
            ...group(
              "Workspaces",
              input.options.filter((option) => option.candidateSlackAgentId === null),
            ),
          ],
        },
        cancelButton(input.cancelValue),
      ],
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
