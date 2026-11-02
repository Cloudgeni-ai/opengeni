import { describe, expect, test } from "bun:test";
import {
  agentMemoryAccess,
  agentMemoryGuidance,
  agentMemoryReadOnlyMessage,
  type AgentMemoryAgent,
} from "../src/domain/agent-memory";

const COLLECTION = "11111111-1111-4111-8111-111111111111";
const shared: AgentMemoryAgent = {
  memoryEnabled: true,
  memoryCollectionId: COLLECTION,
  visibility: "workspace",
  ownerSubjectId: null,
};
const onlyMe: AgentMemoryAgent = {
  memoryEnabled: true,
  memoryCollectionId: COLLECTION,
  visibility: "private",
  ownerSubjectId: "user:kari",
};
const chat = (overrides: Partial<Parameters<typeof agentMemoryAccess>[1]> = {}) => ({
  private: false,
  ownerSubjectId: "user:kari",
  memoryOff: false,
  ...overrides,
});

describe("an agent's Memory", () => {
  test("a shared agent's shared chats read and write; its private chats only read", () => {
    expect(agentMemoryAccess(shared, chat())).toEqual({
      collectionId: COLLECTION,
      read: true,
      write: true,
      listChats: true,
      readOnlyReason: null,
      saveKnowledge: true,
    });
    expect(agentMemoryAccess(shared, chat({ private: true }))).toMatchObject({
      read: true,
      write: false,
      listChats: true,
      readOnlyReason: "private_chat",
    });
  });

  test("an Only me agent writes only from its owner's private chats", () => {
    expect(agentMemoryAccess(onlyMe, chat({ private: true })).write).toBe(true);
    expect(agentMemoryAccess(onlyMe, chat()).write).toBe(false);
    expect(
      agentMemoryAccess(onlyMe, chat({ private: true, ownerSubjectId: "user:ola" })).write,
    ).toBe(false);
  });

  test("a chat with Memory scope off neither reads nor writes, and is not told to search", () => {
    const access = agentMemoryAccess(shared, chat({ memoryOff: true }));
    expect(access).toMatchObject({
      read: false,
      write: false,
      listChats: true,
      readOnlyReason: "memory_off_for_chat",
    });
    const guidance = agentMemoryGuidance(access)!;
    expect(guidance).toContain("slack_agent_chats");
    expect(guidance).not.toContain("knowledge_search");
  });

  test("a Slack DM saves no Knowledge at all, whatever the agent's Memory", () => {
    const dm = agentMemoryAccess(shared, chat({ private: true, slackDm: true }));
    expect(dm).toMatchObject({ read: true, write: false, saveKnowledge: false });
    const guidance = agentMemoryGuidance(dm)!;
    expect(guidance).toContain(`groupId ${COLLECTION}`);
    expect(guidance).toContain("never save anything from it to Knowledge");
    expect(agentMemoryReadOnlyMessage(dm)).toContain("private Slack chat");
    const off = agentMemoryAccess(
      { ...shared, memoryEnabled: false },
      chat({ private: true, slackDm: true }),
    );
    expect(off.saveKnowledge).toBe(false);
    expect(agentMemoryGuidance(off)).toContain("never save anything from it to Knowledge");
  });

  test("Memory off: no reads, no writes, no other chats; the collection stays guarded", () => {
    const off = agentMemoryAccess({ ...shared, memoryEnabled: false }, chat());
    expect(off).toEqual({
      collectionId: COLLECTION,
      read: false,
      write: false,
      listChats: false,
      readOnlyReason: null,
      saveKnowledge: true,
    });
    expect(agentMemoryGuidance(off)).toBeNull();
    expect(agentMemoryReadOnlyMessage(off)).toContain("Memory is off");
    expect(agentMemoryAccess(null, chat()).listChats).toBe(false);
  });

  test("the guidance names the collection, unreviewed entries and whether to save", () => {
    const writer = agentMemoryGuidance(agentMemoryAccess(shared, chat()))!;
    expect(writer).toContain(`groupId ${COLLECTION}`);
    expect(writer).toContain("view needs_review");
    expect(writer).toContain("unreviewed");
    expect(writer).toContain(`groupIds [${COLLECTION}]`);
    expect(writer).toContain("slack_agent_chats");
    // The old DM leak: no chat is told to save with workspace scope.
    expect(writer).not.toContain('scope "workspace"');

    const dm = agentMemoryGuidance(agentMemoryAccess(shared, chat({ private: true })))!;
    expect(dm).toContain(`groupId ${COLLECTION}`);
    expect(dm).toContain("never save anything from it to your Memory");
    expect(dm).not.toContain("knowledge_save");

    // Memory on before its collection exists: other chats only.
    const pending = agentMemoryGuidance(
      agentMemoryAccess({ ...shared, memoryCollectionId: null }, chat()),
    )!;
    expect(pending).toContain("slack_agent_chats");
    expect(pending).not.toContain("knowledge_search");
  });
});
