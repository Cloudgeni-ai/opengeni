import type { AgentRecord } from "@opengeni/db";

/**
 * An agent's Memory (docs/agents.md#memory): one switch. On, the agent has its
 * own Knowledge collection (workspace scope for a shared agent, the owner's
 * personal scope for an Only me one) and its chats may read its other shared
 * chats. Off, neither.
 *
 * Every chat of the agent reads its Memory. Only chats whose audience matches
 * the collection write to it: a shared agent's shared chats, or an Only me
 * agent's owner in a private chat. Private chats (Slack DMs included) of a
 * shared agent, open-use chats and chats with Memory scope off only read, so
 * nothing said privately reaches everyone in the workspace. The tools enforce
 * this; the guidance only explains it.
 */
export type AgentMemoryAgent = Pick<
  AgentRecord,
  "memoryEnabled" | "memoryCollectionId" | "visibility" | "ownerSubjectId"
>;

/** The chat asking: whether it is Only me, whose it is, and whether its Memory scope is off. */
export type AgentMemoryChat = {
  private: boolean;
  ownerSubjectId: string | null;
  memoryOff: boolean;
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
  readOnlyReason: "private_chat" | "memory_off_for_chat" | null;
};

export function agentMemoryAccess(
  agent: AgentMemoryAgent | null,
  chat: AgentMemoryChat,
): AgentMemoryAccess {
  const collectionId = agent?.memoryCollectionId ?? null;
  if (!agent || !agent.memoryEnabled) {
    return { collectionId, read: false, write: false, listChats: false, readOnlyReason: null };
  }
  const audienceMatches =
    agent.visibility === "workspace"
      ? !chat.private
      : chat.private &&
        chat.ownerSubjectId !== null &&
        chat.ownerSubjectId === agent.ownerSubjectId;
  const readOnlyReason = chat.memoryOff
    ? ("memory_off_for_chat" as const)
    : audienceMatches
      ? null
      : ("private_chat" as const);
  return {
    collectionId,
    read: collectionId !== null,
    write: collectionId !== null && readOnlyReason === null,
    listChats: true,
    readOnlyReason,
  };
}

/** What a refused write into the agent's Memory tells the chat. */
export function agentMemoryReadOnlyMessage(access: AgentMemoryAccess): string {
  if (access.readOnlyReason === "private_chat") {
    return "Not saved: this chat is private, so nothing from it goes into the agent's Memory, which others' chats read. Answer without saving, or save it without the Memory collection.";
  }
  if (access.readOnlyReason === "memory_off_for_chat") {
    return "Not saved: this chat cannot save to the agent's Memory. Answer without saving.";
  }
  return "Not saved: Memory is off for this agent. Someone who can edit the agent can turn it on.";
}

const CONTEXT_MISSING =
  "When context is missing (for example someone continues a topic outside a thread, or refers to something said before)";

/**
 * What an agent's chat is told about its Memory, or null when Memory is off.
 * The collection id is the one place it is named.
 */
export function agentMemoryGuidance(access: AgentMemoryAccess): string | null {
  if (!access.listChats) return null;
  const chats =
    "list your other chats with slack_agent_chats and read a relevant one with session_events";
  const id = access.collectionId;
  if (!id) return `${CONTEXT_MISSING}, ${chats}.`;
  const lines = [
    `Your Memory is the Knowledge collection ${id}. ${CONTEXT_MISSING}, search it with knowledge_search (groupId ${id}), also with view needs_review: those entries are unreviewed, so say so when you rely on one. Then ${chats}.`,
  ];
  if (access.write) {
    lines.push(
      `Save lasting facts, decisions and preferences people share with you with knowledge_save and groupIds [${id}], so your other chats know them too. Do not save passing chatter.`,
    );
  } else if (access.readOnlyReason === "private_chat") {
    lines.push("This chat is private: never save anything from it to your Memory.");
  } else {
    lines.push("This chat cannot save to your Memory.");
  }
  return lines.join(" ");
}
