import { describe, expect, test } from "bun:test";

import {
  DEFAULT_AGENT_SETTINGS,
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

  test("without tools the agent can only talk; with tools it calls Acme's", () => {
    expect(tools(replyBeats("order", DEFAULT_AGENT_SETTINGS))).toEqual([]);
    expect(said(replyBeats("order", DEFAULT_AGENT_SETTINGS))).toContain("can't see orders yet");
    const on = { ...DEFAULT_AGENT_SETTINGS, tools: true };
    expect(tools(replyBeats("order", on))).toEqual(["acme__get_order"]);
    expect(tools(replyBeats("charged", on))).toEqual(["acme__list_charges"]);
    expect(tools(replyBeats("refund", on))).toEqual(["acme__refund_charge"]);
  });

  test("memory looks the customer up and uses it; thinking reasons first", () => {
    const remembered = replyBeats("order", { ...DEFAULT_AGENT_SETTINGS, memory: true });
    expect(tools(remembered)).toEqual(["knowledge_search"]);
    expect(said(remembered)).toContain("You're on Pro");
    const thought = replyBeats("order", { ...DEFAULT_AGENT_SETTINGS, thinking: true });
    expect(thought[0]!.kind).toBe("think");
    expect(replyBeats("order", DEFAULT_AGENT_SETTINGS).some((beat) => beat.kind === "think")).toBe(
      false,
    );
  });

  test("an answer is a whole turn: started, streamed, completed and idle", () => {
    const events = replyTimeline(
      replyBeats("order", { ...DEFAULT_AGENT_SETTINGS, tools: true }),
      "t1",
    );
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
