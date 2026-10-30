/**
 * Slack agents inside the Slack pipeline: loading them for routing, the
 * instructions a chat started from Slack gets, and the copy people see.
 *
 * An installation without agents never reaches anything here that changes a
 * message, an instruction or a query result, which is what keeps it exactly as
 * it was before agents existed.
 */
import { slackAgentHandle } from "@opengeni/contracts";
import { getWorkspace, listSlackAgentsForConnection, type SlackAgentRecord } from "@opengeni/db";
import type { ApiRouteDeps } from "@opengeni/core";

import type { SlackRoutingAgent } from "./slack-agent-address";
import { escapeSlackMrkdwn } from "./slack-app-home";

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
  };
}

/** How people call an agent in Slack, for example `@Opengeni +data-team`. */
export function slackAgentCallText(
  agent: Pick<SlackAgentRecord, "name">,
  botUserId: string | null,
): string {
  const mention = botUserId ? `<@${botUserId}>` : "@Opengeni";
  return `${mention} +${slackAgentHandle(agent.name)}`;
}

/** Agents listed by name in a chat's instructions. */
const MAX_LISTED_AGENTS = 50;

function workspaceName(loaded: LoadedSlackAgents, workspaceId: string): string {
  return loaded.labels.get(workspaceId) ?? "its workspace";
}

/**
 * What every chat started from Slack in an installation with agents is told:
 * who it is, which agents exist, and how to keep context. Composed after the
 * ordinary Slack instructions.
 */
export function slackAgentSessionInstructions(input: {
  loaded: LoadedSlackAgents;
  agent: SlackAgentRecord | null;
  handedOffBy: SlackAgentRecord | null;
}): string {
  const { loaded, agent } = input;
  const lines: string[] = [];
  if (agent) {
    const handle = slackAgentHandle(agent.name);
    lines.push(
      `You are ${agent.name}, a Slack agent: ${agent.description} People call you in Slack with "+${handle}" after mentioning Opengeni, and your Slack messages are posted under the name ${agent.name}. Several people may talk to you at once in separate chats; together they are one teammate, so keep your answers consistent with your other chats.`,
    );
    const adminInstructions = agent.instructions.trim();
    if (adminInstructions.length > 0) {
      lines.push(`Instructions for ${agent.name}:\n${adminInstructions}`);
    }
    const memory = agent.knowledgeCollectionId;
    lines.push(
      memory
        ? `Your Memory is the Knowledge collection ${memory} in this workspace. When context is missing (for example someone continues a topic outside a thread, or refers to something said before), search your Memory with knowledge_search (groupId ${memory}) and list your recent chats with slack_agent_chats, then read the relevant chat. Save lasting facts, decisions and preferences people share with you with knowledge_save, with groupIds [${memory}] and scope "workspace", so your other chats know them too. Do not save passing chatter.`
        : "When context is missing (for example someone continues a topic outside a thread), list your recent chats with slack_agent_chats and read the relevant one.",
    );
    if (input.handedOffBy) {
      lines.push(
        `${input.handedOffBy.name} passed this request on to you. Do not hand it back to ${input.handedOffBy.name}.`,
      );
    }
  }
  const others = loaded.records.filter((candidate) => candidate.id !== agent?.id);
  if (others.length > 0) {
    // The rule comes before the list, and the list is bounded, so cutting the
    // instructions to their limit never drops the rule.
    const listed = others.slice(0, MAX_LISTED_AGENTS);
    lines.push(
      [
        `If a request clearly belongs to one of the Slack agents below rather than to you, call slack_agent_handoff with its name and then make your entire final response exactly NO_REPLY. Hand off only when you are confident; otherwise answer yourself, or tell the person they can call an agent with "@Opengeni +name".`,
        "Slack agents people can call in this Slack workspace (name, what it does, where it works):",
        ...listed.map(
          (other) =>
            `- ${other.name} (+${slackAgentHandle(other.name)}): ${other.description} Works in ${workspaceName(loaded, other.targetWorkspaceId)}.`,
        ),
        ...(others.length > listed.length ? [`- and ${others.length - listed.length} more.`] : []),
      ].join("\n"),
    );
  }
  return lines.join("\n\n");
}

/** The reply to `+name` naming no agent. In Slack people see names, never "bot". */
export function slackUnknownAgentText(
  requested: string,
  usable: readonly Pick<SlackRoutingAgent, "name">[],
): string {
  const named = requested.trim().length > 0 ? ` called ${requested.trim()}` : "";
  const available =
    usable.length > 0
      ? ` Available: ${usable.map((agent) => `+${slackAgentHandle(agent.name)}`).join(", ")}.`
      : "";
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

/** "<Agent> · next time: `@Opengeni +name`", shown once per person per agent. */
export function slackAgentHintLine(
  agent: Pick<SlackAgentRecord, "name">,
  botUserId: string | null,
): string {
  return `_${escapeSlackMrkdwn(agent.name)} · next time: ${slackAgentCallText(agent, botUserId)}_`;
}
