import { describe, expect, test } from "bun:test";

import {
  QUESTIONS,
  matchQuestion,
  replyBeats,
  replyTimeline,
  type ScriptBeat,
} from "./acme-script";

const tools = (beats: ScriptBeat[]) =>
  beats.flatMap((beat) => (beat.kind === "tool" ? [beat.name] : []));
const said = (beats: ScriptBeat[]) =>
  beats.flatMap((beat) => (beat.kind === "say" ? [beat.text] : [])).join(" ");

describe("Acme's recorded answers", () => {
  test("typed messages find their answer", () => {
    expect(matchQuestion(QUESTIONS.order)).toBe("order");
    expect(matchQuestion("where's my package?")).toBe("order");
    expect(matchQuestion(QUESTIONS.charged)).toBe("charged");
    expect(matchQuestion("Why did you bill me twice")).toBe("charged");
    expect(matchQuestion(QUESTIONS.refund)).toBe("refund");
    expect(matchQuestion("hello")).toBe("other");
  });

  test("each answer uses Acme's own tool first", () => {
    expect(tools(replyBeats("order"))).toEqual(["acme__get_order"]);
    expect(said(replyBeats("order"))).toContain("out for delivery");
    expect(tools(replyBeats("charged"))).toEqual(["acme__list_charges"]);
    expect(tools(replyBeats("refund"))).toEqual(["acme__refund_charge"]);
    expect(tools(replyBeats("other"))).toEqual([]);
  });

  test("an answer is a whole turn: started, streamed, completed and idle", () => {
    const events = replyTimeline(replyBeats("order"), "t1");
    const types = events.map((event) => event.type);
    expect(types[0]).toBe("turn.queued");
    expect(types).toContain("turn.started");
    expect(types).toContain("agent.toolCall.created");
    expect(types).toContain("agent.toolCall.output");
    expect(types).toContain("agent.message.delta");
    expect(types.slice(-2)).toEqual(["turn.completed", "session.status.changed"]);
    const times = events.map((event) => event.afterMs);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });
});
