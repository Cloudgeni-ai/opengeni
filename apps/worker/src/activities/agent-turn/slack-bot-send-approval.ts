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
export type PreparedSlackBotMessageFacts = {
  channelId: string;
  /** The thread the message replies in; null or omitted for a new message. */
  threadTimestamp?: string | null;
  text: string;
};

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

type Decision = "allow" | "ask" | "block";

/** How the root of a worker chain runs; null when the session is the root. */
export type SlackBotSendChainRoot = { rootUnattended: boolean; rootTurnScheduled: boolean };

/**
 * Whether a person can answer a bot-send approval in this chat. Not when this
 * turn is scheduled or the chat runs unattended, and not in a worker whose
 * chain was started by a scheduled turn or runs under an unattended root
 * chat: nobody there would answer, so those keep sending at once. A worker of
 * an attended chat is asked like the chat itself, so spawning a worker is no
 * way around the approval. If the root cannot be read, the session's own
 * facts decide.
 */
export async function slackBotSendHasPerson(input: {
  scheduled: boolean;
  unattended: boolean;
  chainRoot: () => Promise<SlackBotSendChainRoot | null>;
}): Promise<boolean> {
  if (input.scheduled || input.unattended) return false;
  try {
    const root = await input.chainRoot();
    return !root || (!root.rootUnattended && !root.rootTurnScheduled);
  } catch (error) {
    console.warn("[slack-bot] worker chain root unavailable; asking as this chat", {
      error: error instanceof Error ? error.message : String(error),
    });
    return true;
  }
}

/**
 * Decide, per `slack_bot_send_prepared_message`, whether it waits for the
 * person's approval in the chat. Where a person can answer, it follows the
 * person's own Slack send permission, so the Opengeni bot is not a way around
 * that choice: Ask (chosen, or the server's default) asks, Block blocks, and a
 * permission that cannot be read asks. Scheduled and unattended runs and chats
 * without a personal Slack account on the turn keep the bot's existing
 * default: the send runs at once. Every other call passes through untouched.
 *
 * One call keeps its first decision within an attempt, so its preparation and
 * execution agree.
 */
export function withSlackBotSendApproval(
  policy: ConnectorActionPolicyHooks,
  chat: {
    /** Whether a person can answer here; read at the first bot send, once per attempt. */
    interactive: boolean | (() => Promise<boolean>);
    /** The strictest decision among this turn's personal Slack sends; null when there are none. */
    personalSlackSendDecision: () => Promise<Decision | null>;
    /** The prepared message the card names. Optional; a failed read keeps the plain card. */
    preparedMessage?: (messageId: string) => Promise<PreparedSlackBotMessageFacts | null>;
  },
): ConnectorActionPolicyHooks {
  let interactive: Promise<boolean> | undefined;
  const hasPerson = () =>
    (interactive ??=
      typeof chat.interactive === "boolean"
        ? Promise.resolve(chat.interactive)
        : chat.interactive().catch(() => true));
  let personal: Promise<Decision | null> | undefined;
  const personalDecision = () =>
    (personal ??= chat.personalSlackSendDecision().catch((error: unknown) => {
      console.warn("[slack-bot] personal Slack send permission unavailable; bot send asks", {
        error: error instanceof Error ? error.message : String(error),
      });
      return "ask" as const;
    }));
  type Outcome =
    | { kind: "allow" }
    | { kind: "block" }
    | { kind: "ask"; message: PreparedSlackBotMessageFacts | null };
  const decided = new Map<string, Promise<Outcome>>();
  const outcome = (call: ConnectorActionToolCall): Promise<Outcome> => {
    let pending = decided.get(call.approvalId);
    if (!pending) {
      pending = (async (): Promise<Outcome> => {
        if (!(await hasPerson())) return { kind: "allow" };
        const decision = await personalDecision();
        if (decision === "block") return { kind: "block" };
        if (decision !== "ask") return { kind: "allow" };
        const messageId =
          call.arguments && typeof call.arguments === "object" && !Array.isArray(call.arguments)
            ? (call.arguments as Record<string, unknown>).messageId
            : undefined;
        if (typeof messageId !== "string" || !chat.preparedMessage)
          return { kind: "ask", message: null };
        return {
          kind: "ask",
          message: await chat.preparedMessage(messageId).catch(() => null),
        };
      })();
      decided.set(call.approvalId, pending);
      pending.catch(() => decided.delete(call.approvalId));
    }
    return pending;
  };
  const isBotSend = (call: ConnectorActionToolCall) =>
    call.serverId === "opengeni" && call.toolName === SLACK_BOT_SEND_TOOL_NAME;
  const withOutcome = (
    call: ConnectorActionToolCall,
    decision: Exclude<Outcome, { kind: "block" }>,
  ): ConnectorActionToolCall => {
    if (decision.kind === "allow") {
      const { approvalMode: _approvalMode, ...rest } = call;
      return { ...rest, defaultDecision: "allow" };
    }
    const { targetFacts: _earlier, ...context } = call.reviewContext ?? {};
    const message = decision.message;
    return {
      ...call,
      approvalMode: "session_mcp",
      defaultDecision: "ask",
      reviewContext: {
        kind: "generic",
        ...context,
        title: "Send a Slack message as the Opengeni bot",
        ...(message
          ? {
              targetFacts: [
                { label: "Channel", value: factValue(message.channelId) },
                ...(message.threadTimestamp
                  ? [{ label: "Reply in thread", value: factValue(message.threadTimestamp) }]
                  : []),
                { label: "Message", value: factValue(message.text) },
              ],
            }
          : {}),
      },
    };
  };
  // Block never reaches the ledger as a request: the runtime refuses a
  // blocked preparation before the call can run, as for any blocked tool.
  const blocked = { managed: true, decision: "block" } as const;
  const prepareWith =
    (inner: NonNullable<ConnectorActionPolicyHooks["preview"]>) =>
    async (call: ConnectorActionToolCall) => {
      if (!isBotSend(call)) return await inner(call);
      const decision = await outcome(call);
      return decision.kind === "block" ? blocked : await inner(withOutcome(call, decision));
    };
  return {
    ...(policy.preview ? { preview: prepareWith(policy.preview) } : {}),
    prepare: prepareWith(policy.prepare),
    begin: async (call) => {
      if (!isBotSend(call)) return await policy.begin(call);
      const decision = await outcome(call);
      return decision.kind === "block"
        ? { allowed: false, managed: true, requestId: call.approvalId, reason: "blocked" }
        : await policy.begin(withOutcome(call, decision));
    },
    complete: policy.complete,
  };
}

/** The strictest of several decisions: Block, then Ask, then Allow; null for none. */
export function strictestDecision(decisions: readonly Decision[]): Decision | null {
  if (decisions.length === 0) return null;
  if (decisions.includes("block")) return "block";
  if (decisions.includes("ask")) return "ask";
  return "allow";
}
