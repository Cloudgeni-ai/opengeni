// The repository Skill index is published during a run, after the run's
// input was loaded, as a durable history item placed before the turn. These
// tests run the real runAgentStream against a live unix_local box and the
// real Claude and Responses wire adapters, over several turns of one chat
// whose repository Skills change. Every request's system prompt must be the
// same, and every request must extend the previous one byte for byte: Claude
// binds signed thinking to the system prompt and the request prefix, and both
// providers cache that prefix.
import { describe, expect, test } from "bun:test";
import { readRepositorySkillsContext } from "@opengeni/contracts";
import { chat, claudeModel, indexesIn, liveBox, responsesModel } from "./live-chat-fixture";

describe.each([
  ["Claude", claudeModel],
  ["Responses", responsesModel],
])("%s requests keep one prefix while repository skills change", (_name, wire) => {
  test("a skill added mid-chat, a deferred turn and an unchanged index", async () => {
    const box = await liveBox();
    await box.addSkill("alpha");
    const { api, model, bodies, system, conversation } = wire();
    const conversationChat = chat(box, model, api);

    await conversationChat.turn("first"); // indexed, two requests (tool call)
    await box.addSkill("beta");
    await conversationChat.turn("second", { deferred: true }); // no index yet
    await conversationChat.turn("third"); // the skill added mid-chat appears
    await conversationChat.turn("fourth"); // unchanged: nothing new
    box.setOffline(true);
    await conversationChat.turn("fifth"); // unreachable: a notice replaces the index
    box.setOffline(false);
    await conversationChat.turn("sixth"); // restored: the index again

    expect(bodies).toHaveLength(7);
    // One system prompt for the whole chat. (Claude's adapter also moves
    // leading system and developer history items into its system field; the
    // first index is such an item, identically in every request.)
    expect(new Set(bodies.map(system)).size).toBe(1);
    // Each request extends the previous one exactly, across turns too.
    for (let index = 1; index < bodies.length; index++) {
      const previous = conversation(bodies[index - 1]);
      expect(conversation(bodies[index]).slice(0, previous.length)).toEqual(previous);
    }
    // The index reaches the model as history: alpha from the first request,
    // alpha and beta once the third turn indexed the workspace again.
    const whole = (body: unknown) => [system(body), conversation(body)];
    expect(indexesIn(whole(bodies[0]))).toEqual(["alpha"]);
    expect(indexesIn(whole(bodies[2]))).toEqual(["alpha"]);
    expect(indexesIn(whole(bodies[3]))).toEqual(["alpha", "alpha", "beta"]);
    expect(indexesIn(whole(bodies[4]))).toEqual(["alpha", "alpha", "beta"]);
    expect(JSON.stringify(conversation(bodies[5]))).toContain("the workspace was unreachable");
    expect(indexesIn(whole(bodies[6]))).toEqual(["alpha", "alpha", "beta", "alpha", "beta"]);

    // Durable history holds each index before the turn that first saw it.
    const stored = conversationChat.rows.map((row) => ({
      turn: row.turn,
      index: readRepositorySkillsContext(row.item as Record<string, unknown>),
      role: (row.item as { role?: string }).role,
    }));
    const firstOfTurn = (turn: number) => stored.find((row) => row.turn === turn)!;
    expect(indexesIn(firstOfTurn(1).index)).toEqual(["alpha"]);
    expect(firstOfTurn(2).role).toBe("user");
    expect(indexesIn(firstOfTurn(3).index)).toEqual(["alpha", "beta"]);
    expect(firstOfTurn(4).role).toBe("user");
    expect(firstOfTurn(5).index).toContain("the workspace was unreachable");
    expect(indexesIn(firstOfTurn(6).index)).toEqual(["alpha", "beta"]);
  }, 60_000);
});
