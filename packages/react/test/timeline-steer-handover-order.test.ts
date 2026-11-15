import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@opengeni/sdk";
import { coalesceSessionEventDeltas } from "@opengeni/events";
import { buildTimeline, groupTimeline } from "../src/timeline/projection";
import type { TimelineGroup, TimelineItem } from "../src/timeline/types";
import { createOpenGeniText } from "../src/messages/runtime";
import recorded from "./fixtures/steer-into-new-turn.json";

const englishText = createOpenGeniText();

// A recorded chat (metadata kept, text rewritten): "Hi" is answered, then
// "Check all the open issues" arrives three seconds after that turn ended.
// The server resolves its `steer_or_send` to a Steer (`delivery: "steer"`,
// `accepted_for_steering`) although nothing runs, so it starts its own turn,
// which works for half a minute and posts a progress note. "Hello again" then
// steers that turn, which hands over at its next model step.
const recordedEvents = recorded as SessionEvent[];

/** What the chat reads top to bottom: people's and the agent's text, and each turn's work row. */
function readingOrder(groups: TimelineGroup[]): string[] {
  return groups.flatMap((group) => {
    if (group.kind === "activity") return [`work ${turnLabel(group.id)}`];
    if (group.kind !== "item") return [];
    const item = group.item;
    if (item.kind === "user-message") return [`person: ${item.text}`];
    if (item.kind === "agent-message") return [`agent: ${item.text}`];
    return [];
  });
}
const turnLabel = (groupId: string) =>
  groupId.replace(/^work-/, "").replace(/^aaaaaaaa-.*-0+/, "turn ");
const fold = (events: SessionEvent[]) =>
  groupTimeline(englishText, buildTimeline(englishText, events), { readableTurns: true });
/** The same history as a refresh loads it: each message's streamed text coalesced. */
const refreshed = (events: SessionEvent[]) =>
  coalesceSessionEventDeltas(
    events as Parameters<typeof coalesceSessionEventDeltas>[0],
  ) as SessionEvent[];
const texts = (items: TimelineItem[]) =>
  items.flatMap((item) =>
    item.kind === "user-message" || item.kind === "agent-message" ? [item.text] : [],
  );

describe("a Steer accepted while no turn runs", () => {
  const settled = [
    "person: Hi",
    "work turn 1",
    "agent: Hello! What can I help you with?",
    "person: Check all the open issues",
    "work turn 2",
    "agent: I'll go through all the open issues and see what is urgent or lacks follow-up.",
    "person: Hello again",
    "work turn 3",
    "agent: Hello again! Shall I carry on with the open issues?",
  ];

  test("stays above the turn it started, after a later Steer hands that turn over", () => {
    expect(readingOrder(fold(recordedEvents))).toEqual(settled);
  });

  test("a refreshed history reads the same as the live stream", () => {
    expect(readingOrder(fold(refreshed(recordedEvents)))).toEqual(settled);
  });

  test("right after the handover, the replacement turn is the only work still running", () => {
    // The moment the second message was answered by a new turn: the work row
    // at the end is that turn, just started, not a leftover of the old one.
    const started = recordedEvents.filter((event) => event.sequence <= 93);
    const groups = fold(started);
    expect(readingOrder(groups)).toEqual([...settled.slice(0, 8)]);
    const running = groups.flatMap((group) =>
      group.kind === "activity" && !group.work?.endedAt ? [turnLabel(group.id)] : [],
    );
    expect(running).toEqual(["turn 3"]);
  });

  test("no message ever moves above something it came after, at any point of the stream", () => {
    const finalOrder = texts(buildTimeline(englishText, recordedEvents));
    for (const event of recordedEvents) {
      const prefix = recordedEvents.filter((candidate) => candidate.sequence <= event.sequence);
      for (const events of [prefix, refreshed(prefix)]) {
        const seen = texts(buildTimeline(englishText, events)).filter((text) =>
          finalOrder.includes(text),
        );
        expect(seen).toEqual(finalOrder.filter((text) => seen.includes(text)));
      }
    }
  });
});

// The same shapes as the recorded chat, for the related cases.
function chat() {
  const events: SessionEvent[] = [];
  let sequence = 0;
  let clock = Date.UTC(2026, 0, 5, 9);
  const add = (type: string, payload: Record<string, unknown>, turnId: string | null) => {
    sequence += 1;
    clock += 1000;
    const event: SessionEvent = {
      id: `event-${sequence}`,
      workspaceId: "ws",
      sessionId: "session",
      sequence,
      type,
      payload,
      turnId,
      occurredAt: new Date(clock).toISOString(),
    };
    events.push(event);
    return event;
  };
  const api = {
    events,
    /** A person's message and the turn it queues. */
    message(
      text: string,
      turnId: string,
      admission: { routing: string; delivery?: string; replaces?: string },
    ) {
      const message = add(
        "user.message",
        {
          text,
          routing: admission.routing,
          ...(admission.delivery ? { delivery: admission.delivery } : {}),
        },
        null,
      );
      add(
        "turn.queued",
        { source: "user", turnId, routing: admission.routing, triggerEventId: message.id },
        null,
      );
      if (admission.replaces) {
        add(
          "session.control.steer_requested",
          {
            stopping: false,
            targetTurnId: turnId,
            replacedTurnId: admission.replaces,
            deferredUntilModelStep: true,
          },
          admission.replaces,
        );
      }
      return message;
    },
    start(turnId: string, trigger: SessionEvent) {
      add("turn.started", { triggerEventId: trigger.id }, turnId);
      return api;
    },
    say(turnId: string, messageId: string, text: string, phase = "commentary") {
      add("agent.message.delta", { messageId, phase, text }, turnId);
      add("agent.message.completed", { messageId, phase, text }, turnId);
      return api;
    },
    /** A streamed message whose completion arrives later (or never). */
    stream(turnId: string, messageId: string, text: string) {
      add("agent.message.delta", { messageId, phase: "commentary", text }, turnId);
      return api;
    },
    complete(turnId: string, messageId: string, text: string) {
      add("agent.message.completed", { messageId, phase: "commentary", text }, turnId);
      return api;
    },
    tool(turnId: string, id: string) {
      add("agent.toolCall.created", { id, name: "list_records", arguments: {} }, turnId);
      add("agent.toolCall.output", { id, output: "ok" }, turnId);
      return api;
    },
    handOver(turnId: string, extra: Record<string, unknown> = {}) {
      add("turn.superseded", { reason: "steer", atModelStep: true, ...extra }, turnId);
      return api;
    },
    finish(turnId: string) {
      add("turn.completed", {}, turnId);
      add("session.status.changed", { status: "idle" }, turnId);
      return api;
    },
  };
  return api;
}
const send = { routing: "accepted_for_execution" };
const steerInto = (replaces: string) => ({
  routing: "accepted_for_steering",
  delivery: "steer",
  replaces,
});

function expectSameOrderLiveAndRefreshed(events: SessionEvent[], expected: string[]) {
  expect(readingOrder(fold(events))).toEqual(expected);
  expect(readingOrder(fold(refreshed(events)))).toEqual(expected);
}

describe("Steers keep every message where it happened", () => {
  test("one Steer into a running turn: the turn's answer stays above it", () => {
    const c = chat();
    const first = c.message("Summarize the report", "t1", send);
    c.start("t1", first).tool("t1", "c1").say("t1", "m1", "Reading the report");
    const steer = c.message("Only the totals", "t2", steerInto("t1"));
    c.handOver("t1").start("t2", steer).say("t2", "m2", "Totals: 12", "final_answer").finish("t2");
    expectSameOrderLiveAndRefreshed(c.events, [
      "person: Summarize the report",
      "work t1",
      "agent: Reading the report",
      "person: Only the totals",
      "work t2",
      "agent: Totals: 12",
    ]);
  });

  test("a message finishing after the Steer bubble still stays above it", () => {
    const c = chat();
    const first = c.message("Summarize the report", "t1", send);
    c.start("t1", first).stream("t1", "m1", "Reading the report");
    const steer = c.message("Only the totals", "t2", steerInto("t1"));
    c.complete("t1", "m1", "Reading the report").handOver("t1");
    c.start("t2", steer).say("t2", "m2", "Totals: 12", "final_answer").finish("t2");
    expectSameOrderLiveAndRefreshed(c.events, [
      "person: Summarize the report",
      "work t1",
      "agent: Reading the report",
      "person: Only the totals",
      "work t2",
      "agent: Totals: 12",
    ]);
  });

  test("two Steers into the same running turn both follow its answer", () => {
    const c = chat();
    const first = c.message("Summarize the report", "t1", send);
    c.start("t1", first).say("t1", "m1", "Reading the report");
    c.message("Only the totals", "t2", steerInto("t1"));
    const second = c.message("And the dates", "t3", steerInto("t1"));
    c.handOver("t1").start("t3", second).say("t3", "m3", "Totals and dates", "final_answer");
    c.finish("t3");
    expectSameOrderLiveAndRefreshed(c.events, [
      "person: Summarize the report",
      "work t1",
      "agent: Reading the report",
      "person: Only the totals",
      "person: And the dates",
      "work t3",
      "agent: Totals and dates",
    ]);
  });

  test("a turn that finishes before its next model step leaves the Steer to start its own turn", () => {
    const c = chat();
    const first = c.message("Summarize the report", "t1", send);
    c.start("t1", first).say("t1", "m1", "Here is the summary", "final_answer");
    const steer = c.message("Only the totals", "t2", {
      routing: "accepted_for_steering",
      delivery: "steer",
    });
    c.finish("t1").start("t2", steer).say("t2", "m2", "Totals: 12", "final_answer").finish("t2");
    expectSameOrderLiveAndRefreshed(c.events, [
      "person: Summarize the report",
      "work t1",
      "agent: Here is the summary",
      "person: Only the totals",
      "work t2",
      "agent: Totals: 12",
    ]);
  });

  test("a Steer that started its own turn stays above that turn when a later Steer hands it over", () => {
    const c = chat();
    const first = c.message("Summarize the report", "t1", send);
    c.start("t1", first).say("t1", "m1", "Here is the summary", "final_answer").finish("t1");
    const idleSteer = c.message("Check every section", "t2", {
      routing: "accepted_for_steering",
      delivery: "steer",
    });
    c.start("t2", idleSteer).tool("t2", "c1").say("t2", "m2", "Going through each section");
    c.tool("t2", "c2").stream("t2", "m3", "Section two lo");
    const later = c.message("Stop and say hi", "t3", steerInto("t2"));
    c.handOver("t2", { cutOffText: "Section two lo" });
    c.start("t3", later).say("t3", "m4", "Hi!", "final_answer").finish("t3");
    expectSameOrderLiveAndRefreshed(c.events, [
      "person: Summarize the report",
      "work t1",
      "agent: Here is the summary",
      "person: Check every section",
      "work t2",
      "agent: Going through each section",
      "agent: Section two lo",
      "person: Stop and say hi",
      "work t3",
      "agent: Hi!",
    ]);
  });

  test("a steer_or_send the server resolved to a Send reads like any message", () => {
    const c = chat();
    const first = c.message("Summarize the report", "t1", send);
    c.start("t1", first).say("t1", "m1", "Here is the summary", "final_answer").finish("t1");
    const resolvedToSend = c.message("Check every section", "t2", send);
    c.start("t2", resolvedToSend).say("t2", "m2", "Going through each section");
    const later = c.message("Stop and say hi", "t3", steerInto("t2"));
    c.handOver("t2").start("t3", later).say("t3", "m3", "Hi!", "final_answer").finish("t3");
    expectSameOrderLiveAndRefreshed(c.events, [
      "person: Summarize the report",
      "work t1",
      "agent: Here is the summary",
      "person: Check every section",
      "work t2",
      "agent: Going through each section",
      "person: Stop and say hi",
      "work t3",
      "agent: Hi!",
    ]);
  });
});
