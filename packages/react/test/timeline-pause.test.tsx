import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@opengeni/sdk";
import { MessageTimeline } from "../src";
import { createOpenGeniText } from "../src/messages/runtime";
import {
  buildTimeline,
  groupTimeline,
  timelineLivePause,
  timelinePauseSpans,
  type TimelineGroup,
  type TimelineLivePause,
} from "../src/timeline";
import { readableWorkStatus } from "../src/timeline/work-presentation";
import { flush, registerDom, renderComponent } from "./render-hook";

registerDom();

const englishText = createOpenGeniText();

/*
 * Pause parks a running turn for Resume instead of ending it, so the turn stays
 * open. Every live indicator must read "Paused" with its clock stopped, and the
 * paused time is not work.
 */

let sequence = 0;
const START = Date.UTC(2026, 10, 3, 9, 0, 0);

function at(seconds: number): string {
  return new Date(START + seconds * 1000).toISOString();
}

function event(
  type: string,
  payload: unknown,
  seconds: number,
  turnId: string | null = "turn-1",
): SessionEvent {
  sequence += 1;
  return {
    id: `pause-evt-${sequence}`,
    workspaceId: "ws-1",
    sessionId: "session-1",
    sequence,
    type,
    payload,
    occurredAt: at(seconds),
    turnId,
  };
}

/** A turn running a tool for two minutes. */
function running(): SessionEvent[] {
  sequence = 0;
  return [
    event("user.message", { text: "Count new users" }, 0, null),
    event("turn.started", {}, 1),
    event("agent.message.delta", { text: "Counting now." }, 1),
    event("agent.toolCall.created", { id: "count", name: "exec_command", arguments: {} }, 3),
  ];
}

/** The events staging records when Pause interrupts that turn at 2m 1s. */
function pausedDirectly(): SessionEvent[] {
  return [
    ...running(),
    event(
      "session.control.paused",
      { actor: { kind: "user" }, reason: null, revision: 2 },
      121,
      null,
    ),
    event("agent.toolCall.output", { id: "count", output: { interrupted: true } }, 122),
    event("turn.recovery.requested", { reason: "session_pause" }, 122),
    event("session.status.changed", { status: "recovering" }, 122, null),
    event("session.queue.changed", { reason: "attempt_quiesced" }, 123, null),
    event(
      "session.status.changed",
      { status: "idle", reason: "paused_recovery_settled" },
      123,
      null,
    ),
  ];
}

function liveWork(events: SessionEvent[], live?: TimelineLivePause) {
  const groups = groupTimeline(englishText, buildTimeline(englishText, events), {
    readableTurns: true,
    pauses: timelinePauseSpans(events, live),
  });
  const work = groups.find(
    (group): group is Extract<TimelineGroup, { kind: "activity" }> =>
      group.kind === "activity" && group.work !== undefined,
  );
  if (!work?.work) throw new Error("no readable work row");
  return readableWorkStatus(englishText, { ...work, work: work.work });
}

describe("paused work", () => {
  test("a direct Pause stops the turn's clock where the pause began", () => {
    // The turn started at 1s; the pause began at 121s.
    expect(liveWork(pausedDirectly())).toEqual({ kind: "paused", durationMs: 120_000 });
  });

  test("an ancestor's Pause, seen only as the interruption, pauses the turn", () => {
    const events = [
      ...running(),
      event("agent.toolCall.output", { id: "count", output: { interrupted: true } }, 61),
      event("turn.recovery.requested", { reason: "session_pause" }, 61),
      event("session.status.changed", { status: "idle", reason: "paused_recovery_settled" }, 62),
    ];
    expect(liveWork(events)).toEqual({ kind: "paused", durationMs: 60_000 });
  });

  test("a workspace Pause pauses the turn", () => {
    const events = [
      ...running(),
      event("turn.recovery.requested", { reason: "workspace_pause" }, 31),
    ];
    expect(liveWork(events)).toEqual({ kind: "paused", durationMs: 30_000 });
  });

  test("a pause that interrupted nothing comes from the live control", () => {
    const events = running();
    expect(liveWork(events).kind).toBe("working");
    expect(liveWork(events, { paused: true, since: at(41) })).toEqual({
      kind: "paused",
      durationMs: 40_000,
    });
  });

  test("Cancel is not a pause", () => {
    const events = [
      ...running(),
      event("session.control.paused", { terminal: true, revision: 2 }, 50, null),
    ];
    expect(timelinePauseSpans(events)).toEqual([]);
    expect(liveWork(events).kind).toBe("working");
  });

  test("Resume returns to working, and the paused time is not work", () => {
    const events = [
      ...pausedDirectly(),
      event("session.control.resumed", { revision: 3 }, 421, null),
      event("session.status.changed", { status: "running" }, 422, null),
    ];
    const status = liveWork(events);
    expect(status.kind).toBe("working");
    // Started at 1s, paused for 300s: the clock reads as if it started at 301s.
    expect(status).toMatchObject({ since: at(301) });

    const settled = liveWork([
      ...events,
      event("agent.toolCall.output", { id: "again", output: "ok" }, 480),
      event("turn.completed", { output: "" }, 481),
    ]);
    // 480s of wall time minus the 300s pause.
    expect(settled).toEqual({ kind: "worked", durationMs: 180_000 });
  });

  test("the live resume ends the pause before its events arrive", () => {
    const spans = timelinePauseSpans(pausedDirectly(), { paused: false, resumedAt: at(200) });
    expect(spans).toEqual([{ startedAt: at(121), endedAt: at(200) }]);
    expect(liveWork(pausedDirectly(), { paused: false, resumedAt: at(200) })).toMatchObject({
      kind: "working",
      since: at(80),
    });
  });

  test("a capacity wait inside a pause is not subtracted twice", () => {
    const events = [
      ...pausedDirectly(),
      event("turn.capacity_waiting", { reason: "no_eligible_capacity" }, 150),
      event("session.control.resumed", { revision: 3 }, 221, null),
      event("session.status.changed", { status: "running" }, 260, null),
      event("turn.completed", { output: "" }, 300),
    ];
    // 299s of wall time; the pause (121s to 221s) and the capacity wait
    // (150s to 260s) overlap, so 139s was not work.
    expect(liveWork(events)).toEqual({ kind: "worked", durationMs: 160_000 });
  });

  test("the live pause comes from the effective control", () => {
    expect(timelineLivePause(undefined)).toBeUndefined();
    expect(timelineLivePause({ state: "active" })).toEqual({ paused: false });
    expect(timelineLivePause({ state: "paused", primaryBlocker: { changedAt: at(9) } })).toEqual({
      paused: true,
      since: at(9),
    });
  });
});

describe("MessageTimeline", () => {
  test("a paused turn reads Paused with its clock stopped", async () => {
    const view = await renderComponent(
      <MessageTimeline events={pausedDirectly()} turnSummary={{ rolling: true }} />,
    );
    try {
      await flush(50);
      const status = () => view.container.querySelector("[data-og-exchange-status]");
      expect(status()?.getAttribute("data-og-exchange-status")).toBe("paused");
      expect(status()?.textContent).toBe("Paused · 2m");
      expect(view.container.textContent).not.toContain("Working");
      await flush(1_100);
      expect(status()?.textContent).toBe("Paused · 2m");
    } finally {
      await view.unmount();
    }
  });

  test("the live control pauses and resumes the row", async () => {
    const events = running();
    const view = await renderComponent(
      <MessageTimeline
        events={events}
        turnSummary={{ rolling: true }}
        pause={{ paused: true, since: at(61) }}
      />,
    );
    try {
      await flush(50);
      const status = () => view.container.querySelector("[data-og-exchange-status]");
      expect(status()?.getAttribute("data-og-exchange-status")).toBe("paused");
      expect(status()?.textContent).toBe("Paused · 1m");
      await view.rerender(
        <MessageTimeline
          events={events}
          turnSummary={{ rolling: true }}
          pause={{ paused: false }}
        />,
      );
      await flush(50);
      expect(status()?.getAttribute("data-og-exchange-status")).toBe("working");
    } finally {
      await view.unmount();
    }
  });
});
