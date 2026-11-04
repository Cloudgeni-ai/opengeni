import type { AgentRecord } from "@opengeni/db";

/**
 * An agent's Memory (docs/agents.md#memory): one switch. On, the agent has its
 * own Knowledge collection (workspace scope for a shared agent, the owner's
 * personal scope for an Only me one) and its chats may read its other shared
 * chats. Off, neither.
 *
 * Every chat of the agent reads its Memory. Only chats
 * whose audience matches the collection write to it: a shared agent's shared
 * chats, or an Only me agent's owner in a private chat. Private chats (Slack
 * DMs included) of a shared agent, open-use chats and chats with Memory scope
 * off only read, so nothing said privately reaches everyone in the workspace.
 * A Slack DM saves no Knowledge at all, since its saves land in workspace
 * scope. The tools enforce this; the guidance only explains it.
 */
export type AgentMemoryAgent = Pick<
  AgentRecord,
  "memoryEnabled" | "memoryCollectionId" | "visibility" | "ownerSubjectId"
>;

/**
 * The chat asking: whether it is Only me (an app Only me chat or a Slack DM),
 * whose it is, and whether its Memory scope is off. `slackDm` marks a private
 * chat whose session row is shared: Knowledge it saves would land in workspace
 * scope (docs/slack-bot.md), so it saves no Knowledge at all.
 */
export type AgentMemoryChat = {
  private: boolean;
  ownerSubjectId: string | null;
  memoryOff: boolean;
  slackDm?: boolean;
};

export type AgentMemoryAccess = {
  /** The agent's collection (kept while Memory is off, so writes into it stay guarded). */
  collectionId: string | null;
  /** Search the collection, including its unreviewed entries. */
  read: boolean;
  /** Save into the collection. */
  write: boolean;
  /** List the agent's other shared chats (`slack_agent_chats`). */
  listChats: boolean;
  /** Why the chat cannot write, for the refusal and the guidance. */
  readOnlyReason: "private_chat" | "memory_off_for_chat" | "not_owner_chat" | null;
  /**
   * Save any Knowledge at all. False only in a Slack DM, where a save would be
   * workspace scope whatever the agent's Memory (the old DM leak).
   */
  saveKnowledge: boolean;
};

export function agentMemoryAccess(
  agent: AgentMemoryAgent | null,
  chat: AgentMemoryChat,
): AgentMemoryAccess {
  const collectionId = agent?.memoryCollectionId ?? null;
  const saveKnowledge = !(chat.private && chat.slackDm === true);
  if (!agent || !agent.memoryEnabled) {
    return {
      collectionId,
      read: false,
      write: false,
      listChats: false,
      readOnlyReason: null,
      saveKnowledge,
    };
  }
  const ownersOnlyMeChat =
    chat.private && chat.ownerSubjectId !== null && chat.ownerSubjectId === agent.ownerSubjectId;
  // An Only me agent serves only its owner's Only me chats; any other chat
  // with it (one shared later) runs as a plain chat, without its Memory.
  if (agent.visibility !== "workspace" && !ownersOnlyMeChat) {
    return {
      collectionId,
      read: false,
      write: false,
      listChats: false,
      readOnlyReason: "not_owner_chat",
      saveKnowledge,
    };
  }
  const audienceMatches = agent.visibility === "workspace" ? !chat.private : ownersOnlyMeChat;
  const readOnlyReason = chat.memoryOff
    ? ("memory_off_for_chat" as const)
    : audienceMatches
      ? null
      : ("private_chat" as const);
  return {
    collectionId,
    // The agent's switch alone decides reads: an open-use chat (Memory scope
    // off) still reads its agent's Memory.
    read: collectionId !== null,
    write: collectionId !== null && readOnlyReason === null,
    listChats: true,
    readOnlyReason,
    saveKnowledge,
  };
}

/** What a refused write into the agent's Memory tells the chat. */
export function agentMemoryReadOnlyMessage(access: AgentMemoryAccess): string {
  if (!access.saveKnowledge) {
    return "Not saved: nothing from a private Slack chat is saved to Knowledge. Answer without saving.";
  }
  if (access.readOnlyReason === "not_owner_chat")
    return `Not saved. ${AGENT_MEMORY_NOT_THIS_CHAT_MESSAGE}`;
  if (access.readOnlyReason === "private_chat") {
    return "Not saved: nothing from a private chat goes into the agent's Memory. Answer without saving it there.";
  }
  if (access.readOnlyReason === "memory_off_for_chat") {
    return "Not saved: this chat cannot save to the agent's Memory. Answer without saving.";
  }
  return "Not saved: Memory is off for this agent. Someone who can edit the agent can turn it on.";
}

/** What a read of the agent's collection tells a chat that may not read it. */
export const AGENT_MEMORY_UNREADABLE_MESSAGE =
  "Memory is off for this agent. Answer from this chat.";

/** The same for a shared chat with an Only me agent, which runs as a plain chat. */
export const AGENT_MEMORY_NOT_THIS_CHAT_MESSAGE =
  "This Only me agent's Memory is read only in its owner's Only me chats. Answer from this chat.";

export function agentMemoryUnreadableMessage(access: AgentMemoryAccess): string {
  return access.readOnlyReason === "not_owner_chat"
    ? AGENT_MEMORY_NOT_THIS_CHAT_MESSAGE
    : AGENT_MEMORY_UNREADABLE_MESSAGE;
}

const CONTEXT_MISSING = "When context is missing";

/**
 * What an agent's chat is told about its Memory, or null when Memory is off.
 * The collection id is the one place it is named.
 */
export function agentMemoryGuidance(access: AgentMemoryAccess): string | null {
  const dm = access.saveKnowledge
    ? null
    : "This chat is private: never save anything from it to Knowledge.";
  if (!access.listChats) return dm;
  const chats = "check your other chats with slack_agent_chats";
  const id = access.collectionId;
  if (!id || !access.read) return [`${CONTEXT_MISSING}, ${chats}.`, dm].filter(Boolean).join(" ");
  const lines = [
    `Your Memory is Knowledge collection ${id}. ${CONTEXT_MISSING}, search it with knowledge_search (groupId ${id}, also view needs_review; say so when you rely on an unreviewed entry), then ${chats}.`,
  ];
  if (access.write && access.saveKnowledge) {
    lines.push(
      `Save lasting facts, decisions and preferences people share with knowledge_save (groupIds [${id}]), not passing chatter.`,
    );
  } else if (dm) {
    lines.push(dm);
  } else if (access.readOnlyReason === "private_chat") {
    lines.push("This chat is private: never save anything from it to your Memory.");
  } else {
    lines.push("This chat cannot save to your Memory.");
  }
  return lines.join(" ");
}
