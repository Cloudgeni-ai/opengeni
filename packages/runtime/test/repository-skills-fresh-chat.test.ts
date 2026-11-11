// The most common shape of a chat with a repository: the first turn attaches
// the repository, so its Skill index is deferred (the workspace is not
// prepared before the model answers); the second turn indexes it. With the
// index in the system prompt, turn 2 sent a different system prompt than
// turn 1 and Claude rejected turn 1's signed thinking ("system prompt
// differs"). Turn 2's index must instead arrive as history after turn 1.
import { describe, expect, test } from "bun:test";
import { readRepositorySkillsContext } from "@opengeni/contracts";
import { chat, claudeModel, indexesIn, liveBox, responsesModel } from "./live-chat-fixture";

describe.each([
  ["Claude", claudeModel],
  ["Responses", responsesModel],
])("%s: a fresh chat whose first turn is deferred", (_name, wire) => {
  test("deferred, then indexed, then a Skill added keep one prefix", async () => {
    const box = await liveBox();
    await box.addSkill("alpha");
    // Turn 1 calls a tool, so it sends two requests with signed reasoning.
    const { api, model, bodies, system, conversation } = wire(["tool"]);
    const conversationChat = chat(box, model, api);

    await conversationChat.turn("first", { deferred: true });
    await conversationChat.turn("second");
    await box.addSkill("beta");
    await conversationChat.turn("third");

    expect(bodies).toHaveLength(4);
    expect(new Set(bodies.map(system)).size).toBe(1);
    for (let index = 1; index < bodies.length; index++) {
      const previous = conversation(bodies[index - 1]);
      expect(conversation(bodies[index]).slice(0, previous.length)).toEqual(previous);
    }
    // Turn 1 saw no index; turn 2's index comes after all of turn 1.
    expect(indexesIn([system(bodies[1]), conversation(bodies[1])])).toEqual([]);
    expect(indexesIn(conversation(bodies[2]))).toEqual(["alpha"]);
    expect(indexesIn(conversation(bodies[3]))).toEqual(["alpha", "alpha", "beta"]);
    const stored = conversationChat.rows.map((row) => ({
      turn: row.turn,
      index: readRepositorySkillsContext(row.item as Record<string, unknown>),
    }));
    const firstIndex = stored.findIndex((row) => row.index !== null);
    expect(stored[firstIndex]!.turn).toBe(2);
    expect(stored.slice(0, firstIndex).every((row) => row.turn === 1)).toBe(true);
  }, 60_000);
});
