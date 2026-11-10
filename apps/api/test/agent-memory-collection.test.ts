import { describe, expect, test } from "bun:test";
import type { AgentRecord, Database } from "@opengeni/db";
import { ensureAgentMemoryCollection } from "../src/integrations/agent-memory-collection";

// Paths that end before the collection is linked to the agent, so no database is needed.
const db = {} as Database;
const home = { accountId: crypto.randomUUID(), workspaceId: crypto.randomUUID() };

function agent(patch: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: crypto.randomUUID(),
    name: "Growth analyst",
    visibility: "workspace",
    ownerSubjectId: null,
    memoryEnabled: true,
    memoryCollectionId: null,
    ...patch,
  } as AgentRecord;
}

function refusal(message: string): Error {
  return Object.assign(new Error(message), { code: "42501" });
}

describe("what happened to a new agent's Memory", () => {
  test("Memory off saves nothing", async () => {
    let called = false;
    const result = await ensureAgentMemoryCollection(
      db,
      home,
      agent({ memoryEnabled: false }),
      async () => {
        called = true;
        return undefined as never;
      },
    );
    expect(result.memory).toBe("off");
    expect(called).toBe(false);
  });

  test("an agent that has its collection is ready", async () => {
    const result = await ensureAgentMemoryCollection(
      db,
      home,
      agent({ memoryCollectionId: crypto.randomUUID() }),
      async () => undefined as never,
    );
    expect(result.memory).toBe("ready");
  });

  test("Agent learning Off is told apart from other failures", async () => {
    const off = await ensureAgentMemoryCollection(db, home, agent(), async () => {
      throw refusal("Knowledge learning is Off for this task");
    });
    expect(off.memory).toBe("learning_off");
    const failed = await ensureAgentMemoryCollection(db, home, agent(), async () => {
      throw new Error("connection reset");
    });
    expect(failed.memory).toBe("not_saved");
    expect(failed.agent.memoryCollectionId).toBeNull();
  });

  test("a rejected collection is not saved", async () => {
    const result = await ensureAgentMemoryCollection(
      db,
      home,
      agent(),
      async () => ({ entryId: crypto.randomUUID(), outcome: "rejected" }) as never,
    );
    expect(result.memory).toBe("not_saved");
  });
});
