/**
 * Slack agents inside the Slack pipeline: loading them for routing, the
 * instructions a chat started from Slack gets, and the copy people see.
 *
 * An installation without agents never reaches anything here that changes a
 * message, an instruction or a query result, which is what keeps it exactly as
 * it was before agents existed.
 */
import {
  slackAgentCallText as slackAgentCallFor,
  slackAgentDescriptionSentence,
} from "@opengeni/contracts";
import { getWorkspace, listSlackAgentsForConnection, type SlackAgentRecord } from "@opengeni/db";
import type { ApiRouteDeps } from "@opengeni/core";

import type { SlackRoutingAgent } from "./slack-agent-address";
import { escapeSlackMrkdwn } from "./slack-app-home";
import type { SlackMessageBlock } from "./slack-bot";

export type LoadedSlackAgents = {
  records: SlackAgentRecord[];
  routing: SlackRoutingAgent[];
  labels: Map<string, string | null>;
};

export const NO_SLACK_AGENTS: LoadedSlackAgents = {
  records: [],
  routing: [],
  labels: new Map(),
};

/** One installation's agents with their workspace names. One query when there are none. */
export async function loadSlackAgentsForConnection(
  deps: Pick<ApiRouteDeps, "db">,
  home: { accountId: string; workspaceId: string },
  connectionId: string,
): Promise<LoadedSlackAgents> {
  const records = await listSlackAgentsForConnection(deps.db, home, { connectionId });
  if (records.length === 0) return NO_SLACK_AGENTS;
  const labels = new Map<string, string | null>();
  await Promise.all(
    [...new Set(records.map((agent) => agent.targetWorkspaceId))].map(async (workspaceId) => {
      labels.set(workspaceId, (await getWorkspace(deps.db, workspaceId))?.name ?? null);
    }),
  );
  return {
    records,
    labels,
    routing: records.map((agent) => slackRoutingAgent(agent, labels.get(agent.targetWorkspaceId))),
  };
}

export function slackRoutingAgent(
  agent: SlackAgentRecord,
  targetWorkspaceLabel: string | null | undefined,
): SlackRoutingAgent {
  return {
    id: agent.id,
    name: agent.name,
    nameKey: agent.nameKey,
    targetAccountId: agent.targetAccountId,
    targetWorkspaceId: agent.targetWorkspaceId,
    targetWorkspaceLabel: targetWorkspaceLabel ?? null,
    ...(agent.open ? { open: true } : {}),
  };
}

/**
 * How people ask an agent in Slack, for example `@Opengeni Data team`, as
 * mrkdwn with the app's real mention when its user id is known.
 */
export function slackAgentCallText(
  agent: Pick<SlackAgentRecord, "name">,
  botUserId: string | null,
): string {
  const mention =
    botUserId && /^[UWB][A-Z0-9]{1,63}$/u.test(botUserId) ? `<@${botUserId}>` : "@Opengeni";
  return slackAgentCallFor(escapeSlackMrkdwn(agent.name), mention);
}

/** Agents listed by name in a chat's instructions; the first ones with what they do. */
const MAX_LISTED_AGENTS = 50;
const MAX_DESCRIBED_AGENTS = 20;

function workspaceName(loaded: LoadedSlackAgents, workspaceId: string): string {
  return loaded.labels.get(workspaceId) ?? "its workspace";
}

/** How a chat was reached: by an agent's name, or without one. */
export type SlackAgentChatSource =
  | "agent_name"
  | "channel"
  | "handoff"
  | "thread"
  | "prefix"
  | "dm_route"
  | "dm_personal"
  | "sole_candidate"
  | "installation";

/**
 * The hand-off rule every chat in an installation with agents gets. The
 * server enforces its core too: a hand-off needs the message to name the
 * agent, at most once, never to itself or back (see `handOffSlackAgentChat`).
 */
function slackAgentHandoffRule(input: {
  self: string;
  source: SlackAgentChatSource | null;
}): string {
  const how =
    input.source === "channel"
      ? `This channel's settings sent the message to ${input.self}; the person named no agent.`
      : input.source === null || input.source === "agent_name" || input.source === "handoff"
        ? null
        : "The person named no agent.";
  return [
    ...(how ? [how] : []),
    "Answer yourself by default.",
    'Call slack_agent_handoff only when the person asks for one of the agents below by name, even misspelled or without a word like "team"; if it returns passed_on, make your entire final response exactly NO_REPLY.',
    "Never hand off greetings, tests, small talk, questions about Opengeni or its agents, or words that merely match an agent's name.",
    "When a request fits an agent the person did not ask for, answer it yourself and call slack_agent_suggest with that agent's name.",
  ].join(" ");
}

/**
 * What every chat started from Slack in an installation with agents is told:
 * who it is, how it was reached, which agents exist, and how to keep context.
 * Composed after the ordinary Slack instructions.
 */
export function slackAgentSessionInstructions(input: {
  loaded: LoadedSlackAgents;
  agent: SlackAgentRecord | null;
  handedOffBy: SlackAgentRecord | null;
  /** How the chat was reached; null when unknown. */
  source?: SlackAgentChatSource | null;
}): string {
  const { loaded, agent } = input;
  const lines: string[] = [];
  if (agent) {
    const description = slackAgentDescriptionSentence(agent.description);
    lines.push(
      `You are ${agent.name}, a Slack agent.${description ? ` ${description}` : ""} People ask you with "${slackAgentCallFor(agent.name)}"; your messages post as ${agent.name}.`,
    );
    const adminInstructions = agent.instructions.trim();
    if (adminInstructions.length > 0) {
      lines.push(`Instructions for ${agent.name}:\n${adminInstructions}`);
    }
    const memory = agent.knowledgeCollectionId;
    lines.push(
      memory
        ? `Your Memory is Knowledge collection ${memory}. When context is missing, search it with knowledge_search (groupId ${memory}) and check your recent chats with slack_agent_chats. Save lasting facts, decisions and preferences people share with knowledge_save (groupIds [${memory}], scope "workspace"), not passing chatter.`
        : "When context is missing, check your recent chats with slack_agent_chats.",
    );
    // The server refuses a hand-back, so the line only says who passed it on.
    if (input.handedOffBy) {
      lines.push(`${input.handedOffBy.name} passed this request on to you.`);
    }
  }
  const others = loaded.records.filter((candidate) => candidate.id !== agent?.id);
  if (others.length > 0) {
    // The rule comes before the list, and the list is bounded, so cutting the
    // instructions to their limit never drops the rule. Past the first agents
    // only names are listed: a hand-off needs the name, which the server checks.
    const listed = others.slice(0, MAX_LISTED_AGENTS);
    const described = listed.slice(0, MAX_DESCRIBED_AGENTS);
    const namedOnly = listed.slice(MAX_DESCRIBED_AGENTS);
    const unlisted = others.length - listed.length;
    lines.push(
      [
        slackAgentHandoffRule({ self: agent?.name ?? "Opengeni", source: input.source ?? null }),
        "Slack agents people can ask (name, workspace: what it does):",
        ...described.map((other) => {
          const description = slackAgentDescriptionSentence(other.description);
          return `- ${other.name} (${workspaceName(loaded, other.targetWorkspaceId)}):${description ? ` ${description}` : ""}`;
        }),
        ...(namedOnly.length > 0
          ? [
              `Also: ${namedOnly.map((other) => other.name).join(", ")}${unlisted > 0 ? `, and ${unlisted} more` : ""}.`,
            ]
          : []),
      ].join("\n"),
    );
  }
  // How to propose, including the icon, is in the tool's description.
  lines.push("To create a new agent when someone asks, use slack_agent_propose.");
  return lines.join("\n\n");
}

/** The reply to `+name` naming no agent. In Slack people see names, never "bot". */
export function slackUnknownAgentText(
  requested: string,
  usable: readonly Pick<SlackRoutingAgent, "name">[],
): string {
  const named = requested.trim().length > 0 ? ` called ${requested.trim()}` : "";
  const available =
    usable.length > 0 ? ` Available: ${usable.map((agent) => agent.name).join(", ")}.` : "";
  return `No agent${named}.${available} No chat was started.`;
}

/** The reply for an agent the person cannot use: it names the agent and its workspace. */
export function slackNoAccessToAgentText(
  agent: Pick<SlackRoutingAgent, "name" | "targetWorkspaceLabel">,
  requestAccessUrl: string,
): string {
  const where = agent.targetWorkspaceLabel
    ? `the ${agent.targetWorkspaceLabel} workspace`
    : "a workspace";
  return `${agent.name} works in ${where}, which you don't have access to. Request access: ${requestAccessUrl}. No chat was started.`;
}

/**
 * The first message's opening line for an agent's chat: "<Agent> is on it",
 * plus who passed it on, plus the one-time hint for this person. Frozen at
 * bind like every start line.
 */
export function renderSlackAgentStartLine(input: {
  sessionUrl: string;
  agentName: string;
  handedOffByName: string | null;
  hint: string | null;
}): string {
  const name = escapeSlackMrkdwn(input.agentName);
  const passed = input.handedOffByName
    ? ` · Passed on by *${escapeSlackMrkdwn(input.handedOffByName)}*`
    : "";
  const hint = input.hint ? `\n${input.hint}` : "";
  return `<${input.sessionUrl}|${name} is on it>${passed}${hint}`;
}

/**
 * The one-time line under "<Agent> is on it", shown once per person and agent
 * when they reached it without typing its name:
 *
 * > _Data team: Answers questions about metrics. Next time, ask directly with @Opengeni Data team._
 *
 * When the channel's settings sent the message to the agent, it also says how
 * to ask Opengeni itself there: the `in <workspace>:` prefix comes before the
 * channel's setting.
 */
export function slackAgentHintLine(
  agent: Pick<SlackAgentRecord, "name" | "description">,
  botUserId: string | null,
  options: { plainOpengeniWorkspace?: string | null } = {},
): string {
  const description = slackAgentDescriptionSentence(agent.description);
  const plain = options.plainOpengeniWorkspace?.trim()
    ? ` To ask Opengeni itself here, start with \`in ${escapeSlackMrkdwn(options.plainOpengeniWorkspace.trim())}:\``
    : "";
  return `_${escapeSlackMrkdwn(agent.name)}:${description ? ` ${escapeSlackMrkdwn(description)}` : ""} Next time, ask directly with ${slackAgentCallText(agent, botUserId)}.${plain}_`;
}

/** The button under a suggestion: re-sends the answered message to the agent. */
export const SLACK_AGENT_SUGGESTION_ASK_ACTION_ID = "opengeni.agent_suggestion.ask";

/**
 * The line a chat shows after its answer when a request fits an agent the
 * person did not ask for:
 *
 * > Data team handles questions like this. [Ask Data team]
 *
 * Copy and the button are the server's; the chat only names the agent.
 */
export function buildSlackAgentSuggestionMessage(input: {
  agentName: string;
  suggestionId: string;
}): { text: string; blocks: SlackMessageBlock[] } {
  const text = `${input.agentName} handles questions like this.`;
  return {
    text,
    blocks: [
      {
        type: "section",
        block_id: "opengeni_agent_suggestion",
        text: { type: "mrkdwn", text: escapeSlackMrkdwn(text) },
      },
      {
        type: "actions",
        block_id: "opengeni_agent_suggestion_actions",
        elements: [
          {
            type: "button",
            action_id: SLACK_AGENT_SUGGESTION_ASK_ACTION_ID,
            value: input.suggestionId,
            text: {
              type: "plain_text",
              text: [...`Ask ${input.agentName}`].slice(0, 75).join(""),
              emoji: true,
            },
          },
        ],
      },
    ],
  };
}

/** The suggestion once someone asked the agent: the button is gone. */
export function buildSlackAgentSuggestionAskedMessage(input: {
  agentName: string;
  slackUserId: string;
}): { text: string; blocks: SlackMessageBlock[] } {
  const asker = /^[UWB][A-Z0-9]{1,63}$/u.test(input.slackUserId)
    ? `<@${input.slackUserId}>`
    : "Someone";
  const text = `${asker} asked ${escapeSlackMrkdwn(input.agentName)}.`;
  return {
    text,
    blocks: [{ type: "context", elements: [{ type: "mrkdwn", text }] }],
  };
}
