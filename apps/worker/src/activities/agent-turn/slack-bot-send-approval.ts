import type { Settings } from "@opengeni/config";
import type { McpPersonalConnectionDelegation } from "@opengeni/contracts";
import {
  isOfficialSlackMcpConfig,
  type ConnectorActionPolicyHooks,
  type ConnectorActionToolCall,
} from "@opengeni/runtime";

export const SLACK_BOT_SEND_TOOL_NAME = "slack_bot_send_prepared_message";
/** The personal Slack write whose permission a bot send follows. */
export const PERSONAL_SLACK_SEND_TOOL_NAME = "slack_send_message";

/** One personal Slack account this turn may write with, and its unchosen default. */
export type PersonalSlackSendTarget = {
  connectionId: string;
  serverId: string;
  defaultDecision: "allow" | "ask";
};

/**
 * The personal Slack accounts frozen on this turn, with the default a send
 * through each would get when nobody chose a permission for it: Ask when the
 * server's configuration asks for it, Allow otherwise, as the runtime decides
 * for the personal tool itself.
 */
export function personalSlackSendTargets(
  delegations: readonly McpPersonalConnectionDelegation[],
  settings: Pick<Settings, "mcpServers">,
): PersonalSlackSendTarget[] {
  return delegations.flatMap((delegation) => {
    if (delegation.providerDomain.toLowerCase() !== "slack.com") return [];
    // The account route this turn runs, or its canonical server.
    const server =
      settings.mcpServers.find((candidate) => candidate.id === delegation.serverId) ??
      settings.mcpServers.find((candidate) => candidate.id === delegation.canonicalServerId);
    if (!server || !isOfficialSlackMcpConfig(server.url ?? "", server.connectionRef)) return [];
    const asks =
      server.requireApproval === true ||
      (Array.isArray(server.requireApproval) &&
        server.requireApproval.includes(PERSONAL_SLACK_SEND_TOOL_NAME));
    return [
      {
        connectionId: delegation.connectionId,
        serverId: server.id,
        defaultDecision: asks ? ("ask" as const) : ("allow" as const),
      },
    ];
  });
}

/** What a bot-send card shows, read from the prepared message when it can be. */
export type PreparedSlackBotMessageFacts = { channelId: string; text: string };

const FACT_VALUE_LIMIT = 256;

function factValue(value: string): string {
  if (value.length <= FACT_VALUE_LIMIT) return value;
  let cut = "";
  for (const point of value) {
    if (cut.length + point.length > FACT_VALUE_LIMIT - 1) break;
    cut += point;
  }
  return `${cut.trimEnd()}…`;
}

/**
 * Decide, per `slack_bot_send_prepared_message`, whether it waits for the
 * person's approval in the chat. In an interactive chat it does whenever the
 * person's own Slack send would (an Ask or Block chosen for it, or an Ask
 * default), so the Opengeni bot is not a way around that choice. Scheduled
 * and unattended runs, chats without a personal Slack account on the turn,
 * and a permission that cannot be read keep the bot's existing default: the
 * send runs at once. Every other call passes through untouched.
 *
 * One call keeps its first decision within an attempt, so its preparation and
 * execution agree.
 */
export function withSlackBotSendApproval(
  policy: ConnectorActionPolicyHooks,
  chat: {
    interactive: boolean;
    /** The strictest decision among this turn's personal Slack sends; null when there are none. */
    personalSlackSendDecision: () => Promise<"allow" | "ask" | "block" | null>;
    /** The prepared message the card names. Optional; a failed read keeps the plain card. */
    preparedMessage?: (messageId: string) => Promise<PreparedSlackBotMessageFacts | null>;
  },
): ConnectorActionPolicyHooks {
  let personal: Promise<"allow" | "ask" | "block" | null> | undefined;
  const personalDecision = () =>
    (personal ??= chat.personalSlackSendDecision().catch((error: unknown) => {
      console.warn("[slack-bot] personal Slack send permission unavailable; bot send allowed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }));
  const decided = new Map<string, Promise<PreparedSlackBotMessageFacts | false | null>>();
  const decide = async (call: ConnectorActionToolCall): Promise<ConnectorActionToolCall> => {
    if (call.serverId !== "opengeni" || call.toolName !== SLACK_BOT_SEND_TOOL_NAME) return call;
    let pending = decided.get(call.approvalId);
    if (!pending) {
      pending = (async () => {
        if (!chat.interactive) return false;
        const decision = await personalDecision();
        if (decision !== "ask" && decision !== "block") return false;
        const messageId =
          call.arguments && typeof call.arguments === "object" && !Array.isArray(call.arguments)
            ? (call.arguments as Record<string, unknown>).messageId
            : undefined;
        if (typeof messageId !== "string" || !chat.preparedMessage) return null;
        return await chat.preparedMessage(messageId).catch(() => null);
      })();
      decided.set(call.approvalId, pending);
      pending.catch(() => decided.delete(call.approvalId));
    }
    const asks = await pending;
    if (asks !== false) {
      const { targetFacts: _earlier, ...context } = call.reviewContext ?? {};
      return {
        ...call,
        approvalMode: "session_mcp",
        defaultDecision: "ask",
        reviewContext: {
          kind: "generic",
          ...context,
          title: "Send a Slack message as the Opengeni bot",
          ...(asks
            ? {
                targetFacts: [
                  { label: "Channel", value: factValue(asks.channelId) },
                  { label: "Message", value: factValue(asks.text) },
                ],
              }
            : {}),
        },
      };
    }
    const { approvalMode: _approvalMode, ...rest } = call;
    return { ...rest, defaultDecision: "allow" };
  };
  return {
    ...(policy.preview
      ? { preview: async (call) => await policy.preview!(await decide(call)) }
      : {}),
    prepare: async (call) => await policy.prepare(await decide(call)),
    begin: async (call) => await policy.begin(await decide(call)),
    complete: policy.complete,
  };
}

/** The strictest of several decisions: Block, then Ask, then Allow; null for none. */
export function strictestDecision(
  decisions: readonly ("allow" | "ask" | "block")[],
): "allow" | "ask" | "block" | null {
  if (decisions.length === 0) return null;
  if (decisions.includes("block")) return "block";
  if (decisions.includes("ask")) return "ask";
  return "allow";
}
