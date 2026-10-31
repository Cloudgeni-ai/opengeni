/**
 * The Ask form: a Slack modal to ask Opengeni or one of its agents.
 *
 * Pure Block Kit and payload parsing, no I/O. Opened by a bare slash command,
 * the message shortcut (when the installation has agents) and the Ask button
 * in App Home. What the form needs to know about where it was opened travels
 * in `private_metadata`, which Slack keeps server-side and returns only on a
 * signed submission; it is still validated like any other input.
 */
import { z } from "zod";

import { escapeSlackMrkdwn } from "./slack-app-home";

export const SLACK_ASK_CALLBACK_ID = "opengeni.ask";
export const SLACK_ASK_AGENT_BLOCK_ID = "opengeni_ask_agent";
export const SLACK_ASK_AGENT_ACTION_ID = "agent";
export const SLACK_ASK_REQUEST_BLOCK_ID = "opengeni_ask_request";
export const SLACK_ASK_REQUEST_ACTION_ID = "request";
/** The picker value for ordinary routing, as if no agent was named. */
export const SLACK_ASK_OPENGENI_VALUE = "opengeni";
/** Slack's limit on a plain-text input. */
export const SLACK_ASK_REQUEST_MAX_CHARS = 3_000;
/** A static select lists at most 100 options; one is Opengeni. */
const SLACK_ASK_AGENT_OPTIONS_MAX = 99;
const SLACK_ASK_MESSAGE_PREVIEW_CHARS = 1_500;

export type SlackAskSource = "command" | "home" | "shortcut";

/** What the form remembers about where it was opened. */
export const SlackAskMetadata = z
  .object({
    v: z.literal(1),
    src: z.enum(["command", "home", "shortcut"]),
    /** The installation's connection and Slack team. */
    c: z.string().uuid(),
    t: z.string().min(1).max(64),
    /** The channel the command came from; none from App Home or a shortcut. */
    ch: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,64}$/u)
      .nullable(),
    /** The shortcut's stored message. */
    f: z.string().uuid().nullable(),
  })
  .strict();
export type SlackAskMetadata = z.infer<typeof SlackAskMetadata>;

export type SlackAskFormAgent = { id: string; name: string; description: string };

function plain(text: string) {
  return { type: "plain_text" as const, text, emoji: true };
}

function bounded(text: string, max: number): string {
  const chars = [...text.replace(/\s+/gu, " ").trim()];
  return chars.length <= max ? chars.join("") : `${chars.slice(0, max - 1).join("")}…`;
}

function agentOption(agent: SlackAskFormAgent) {
  return {
    text: plain(bounded(agent.name, 75)),
    ...(agent.description.trim() ? { description: plain(bounded(agent.description, 75)) } : {}),
    value: agent.id,
  };
}

/** Quote a message for the shortcut variant, bounded for the modal. */
function quotedMessage(text: string): string {
  const chars = [...text.trim()];
  const shown =
    chars.length <= SLACK_ASK_MESSAGE_PREVIEW_CHARS
      ? chars.join("")
      : `${chars.slice(0, SLACK_ASK_MESSAGE_PREVIEW_CHARS - 1).join("")}…`;
  return escapeSlackMrkdwn(shown)
    .split("\n")
    .map((line) => `>${line}`)
    .join("\n");
}

/**
 * The modal. Opengeni comes first and is chosen unless an agent was
 * preselected; the request is required except on a message, where the message
 * itself is the request.
 */
export function buildSlackAskFormView(input: {
  agents: readonly SlackAskFormAgent[];
  metadata: SlackAskMetadata;
  preselectedAgentId?: string | null;
  /** The message, when opened from the message shortcut. */
  messageText?: string | null;
}): Record<string, unknown> {
  const opengeni = { text: plain("Opengeni"), value: SLACK_ASK_OPENGENI_VALUE };
  const options = [
    opengeni,
    ...input.agents.slice(0, SLACK_ASK_AGENT_OPTIONS_MAX).map(agentOption),
  ];
  const initial = options.find((option) => option.value === input.preselectedAgentId) ?? opengeni;
  const fromMessage = typeof input.messageText === "string" && input.messageText.trim() !== "";
  return {
    type: "modal",
    callback_id: SLACK_ASK_CALLBACK_ID,
    title: plain("Ask Opengeni"),
    submit: plain("Ask"),
    close: plain("Cancel"),
    private_metadata: JSON.stringify(input.metadata),
    blocks: [
      ...(fromMessage
        ? [
            {
              type: "section",
              block_id: "opengeni_ask_message",
              text: { type: "mrkdwn", text: quotedMessage(input.messageText!) },
            },
          ]
        : []),
      {
        type: "input",
        block_id: SLACK_ASK_AGENT_BLOCK_ID,
        label: plain("Who answers"),
        element: {
          type: "static_select",
          action_id: SLACK_ASK_AGENT_ACTION_ID,
          options,
          initial_option: initial,
        },
      },
      {
        type: "input",
        block_id: SLACK_ASK_REQUEST_BLOCK_ID,
        label: plain(fromMessage ? "Anything to add?" : "Request"),
        ...(fromMessage ? { optional: true } : {}),
        element: {
          type: "plain_text_input",
          action_id: SLACK_ASK_REQUEST_ACTION_ID,
          multiline: true,
          max_length: SLACK_ASK_REQUEST_MAX_CHARS,
        },
      },
    ],
  };
}

export type SlackAskSubmission = {
  viewId: string;
  slackTeamId: string;
  slackUserId: string;
  metadata: SlackAskMetadata;
  /** An agent id, or null for Opengeni. */
  agentId: string | null;
  request: string;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedId(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

/** Read a submitted Ask form, or null when it is not one or is malformed. */
export function parseSlackAskSubmission(payload: unknown): SlackAskSubmission | null {
  const envelope = record(payload);
  const view = record(envelope?.view);
  if (envelope?.type !== "view_submission" || view?.callback_id !== SLACK_ASK_CALLBACK_ID) {
    return null;
  }
  const viewId = boundedId(view.id, 64);
  const slackTeamId = boundedId(record(envelope.team)?.id, 64);
  const slackUserId = boundedId(record(envelope.user)?.id, 64);
  let metadata: SlackAskMetadata | null = null;
  try {
    const parsed = SlackAskMetadata.safeParse(JSON.parse(String(view.private_metadata ?? "")));
    metadata = parsed.success ? parsed.data : null;
  } catch {
    metadata = null;
  }
  if (!viewId || !slackTeamId || !slackUserId || !metadata) return null;
  const values = record(record(view.state)?.values);
  const selected = boundedId(
    record(
      record(record(values?.[SLACK_ASK_AGENT_BLOCK_ID])?.[SLACK_ASK_AGENT_ACTION_ID])
        ?.selected_option,
    )?.value,
    64,
  );
  const requestValue = record(values?.[SLACK_ASK_REQUEST_BLOCK_ID])?.[SLACK_ASK_REQUEST_ACTION_ID];
  const rawRequest = record(requestValue)?.value;
  const request =
    typeof rawRequest === "string"
      ? [...rawRequest.trim()].slice(0, SLACK_ASK_REQUEST_MAX_CHARS).join("")
      : "";
  if (selected !== SLACK_ASK_OPENGENI_VALUE && !z.string().uuid().safeParse(selected).success) {
    return null;
  }
  return {
    viewId,
    slackTeamId,
    slackUserId,
    metadata,
    agentId: selected === SLACK_ASK_OPENGENI_VALUE ? null : selected,
    request,
  };
}

/** The shortcut's request: the message, plus what the person added. */
export function slackAskShortcutText(messageText: string, request: string): string {
  const added = request.trim();
  return added ? `${added}\n\nMessage:\n${messageText}` : messageText;
}
