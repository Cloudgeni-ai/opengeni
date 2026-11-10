import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@opengeni/sdk";
import { registerDom, renderComponent, flush } from "./render-hook";
import { MessageTimeline } from "../src/components/message-timeline";
import { buildTimeline, groupTimeline } from "../src/timeline/projection";
import type { TimelineGroup, TimelineItem } from "../src/timeline/types";
import { createOpenGeniText } from "../src/messages/runtime";
import { bannerFailureEventIds } from "../src/app/lib/timeline-failure-owner";

/*
 * A failure is shown once, where the person can act on it. While the host's
 * failed banner (with Retry) presents a failure, the timeline keeps only a
 * quiet "Failed" on the turn's row; the failed step keeps its own status; a
 * retried attempt is one quiet disclosure; and the status changes around the
 * failure add no "failed" or "work resumed" dividers.
 *
 * The fixture is the shape of production chat ae0245f3 (10 Nov): a Claude
 * request rejected with HTTP 400, a human Retry of the same turn, and the
 * same rejection again.
 */

registerDom();

const t = createOpenGeniText();
const ERROR = "Claude request failed (HTTP 400)";
const DETAIL =
  "invalid_request_error: messages.7.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.";

let sequence = 0;
function event(type: string, payload: unknown, turnId: string | null = "turn-1"): SessionEvent {
  sequence += 1;
  return {
    id: `evt-${sequence}`,
    workspaceId: "ws",
    sessionId: "session",
    sequence,
    type,
    payload,
    turnId,
    occurredAt: new Date(Date.UTC(2026, 10, 10, 14, 30, sequence)).toISOString(),
  };
}

function attempt(): SessionEvent[] {
  return [
    event("turn.started", {}),
    event("turn.startup.phase.started", { phase: "model_preparation" }),
    event("turn.startup.phase.completed", { phase: "model_preparation", durationMs: 2301 }),
    event("agent.model.request", { phase: "started", provider: "anthropic", dispatchId: "2" }),
    event("agent.model.request", { phase: "failed", provider: "anthropic", durationMs: 713 }),
  ];
}

function failure(): SessionEvent[] {
  return [
    event("turn.failed", {
      code: "anthropic_http_error",
      error: ERROR,
      detail: DETAIL,
      retryable: false,
    }),
    event("session.status.changed", { status: "failed" }),
  ];
}

function retriedTwice(): { events: SessionEvent[]; finalFailureId: string } {
  sequence = 0;
  const events = [
    event(
      "user.message",
      { text: "Okay, and we added the delete action? And what did we decide on approvals?" },
      null,
    ),
    ...attempt(),
    ...failure(),
    event("turn.recovery.requested", { reason: "human_retry", model: "anthropic/claude-opus" }),
    event("session.status.changed", { status: "recovering" }),
    event("session.status.changed", { status: "running" }),
    ...attempt(),
    ...failure(),
  ];
  const finalFailureId = events.filter((e) => e.type === "turn.failed").at(-1)!.id;
  return { events, finalFailureId };
}

function flatten(groups: TimelineGroup[]): TimelineItem[] {
  return groups.flatMap((group) =>
    group.kind === "item"
      ? [group.item]
      : group.kind === "activity"
        ? [...group.items, ...flatten(group.work?.details ?? [])]
        : flatten(group.groups),
  );
}

function workRows(groups: TimelineGroup[]) {
  return groups.filter(
    (group): group is Extract<TimelineGroup, { kind: "activity" }> =>
      group.kind === "activity" && group.work !== undefined,
  );
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe("a failure is shown once", () => {
  test("the status changes around a failed turn add no failed or work-resumed dividers", () => {
    const { events } = retriedTwice();
    const groups = groupTimeline(t, buildTimeline(t, events), { readableTurns: true });
    expect(flatten(groups).filter((item) => item.kind === "session-status")).toEqual([]);
    // One work row: the Retry continues the same turn.
    expect(workRows(groups)).toHaveLength(1);
    expect(workRows(groups)[0]!.outcome).toBe("failed");
  });

  test("a failed status recorded before its turn's failure is not repeated either", () => {
    sequence = 0;
    const events = [
      event("user.message", { text: "Go" }, null),
      ...attempt(),
      event("session.status.changed", { status: "failed" }),
      event("turn.failed", { error: ERROR, detail: DETAIL }),
    ];
    const items = buildTimeline(t, events);
    expect(items.filter((item) => item.kind === "session-status")).toEqual([]);
  });

  test("a failure before any turn keeps its quiet status divider", () => {
    sequence = 0;
    const items = buildTimeline(t, [
      event("user.message", { text: "Go" }, null),
      event("session.status.changed", { status: "failed", code: "pre_claim_failure" }, null),
    ]);
    expect(items.filter((item) => item.kind === "session-status")).toHaveLength(1);
  });

  test("a retried attempt is one quiet step that keeps its recorded text", () => {
    const { events } = retriedTwice();
    for (const readableTurns of [true, false]) {
      const groups = groupTimeline(t, buildTimeline(t, events), { readableTurns });
      const notices = flatten(groups).filter((item) => item.kind === "notice");
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({ retriedAttempt: true, tone: "failed" });
      expect(JSON.stringify(notices[0])).toContain("Invalid `signature`");
      if (!readableTurns) {
        // The non-rolling view folds the whole turn once, with its final outcome.
        const turns = groups.filter((group) => group.kind === "turn");
        expect(turns).toHaveLength(1);
      }
    }
  });

  test("a failure the host presents keeps only its outcome on the turn row", () => {
    const { events, finalFailureId } = retriedTwice();
    const items = buildTimeline(t, events);
    const shown = workRows(groupTimeline(t, items, { readableTurns: true }))[0]!;
    expect(shown.failureText).toContain(ERROR);
    const presented = workRows(
      groupTimeline(t, items, { readableTurns: true, presentedFailureEventIds: [finalFailureId] }),
    )[0]!;
    expect(presented.outcome).toBe("failed");
    expect(presented.failureText).toBeUndefined();
    expect(presented.failureDetail).toBeUndefined();
  });

  test("a failure before any work that the host presents leaves no second notice", () => {
    sequence = 0;
    const events = [
      event("user.message", { text: "Go" }, null),
      event("turn.started", {}),
      event("turn.failed", { error: "The model provider denied access to this model." }),
      event("session.status.changed", { status: "failed" }),
    ];
    const id = events[2]!.id;
    const items = buildTimeline(t, events);
    const notices = (ids?: string[]) =>
      flatten(
        groupTimeline(t, items, { readableTurns: true, presentedFailureEventIds: ids }),
      ).filter((item) => item.kind === "notice");
    expect(notices()).toHaveLength(1);
    expect(notices([id])).toHaveLength(0);
  });

  test("a credit stop that ended its turn as completed is presented through that turn end", () => {
    sequence = 0;
    const events = [
      event("user.message", { text: "Go" }, null),
      event("turn.started", {}),
      event("agent.toolCall.created", { id: "c", name: "exec_command", arguments: {} }),
      event("agent.toolCall.output", { id: "c", output: "ok" }),
      event("turn.completed", {
        detail: "insufficient workspace credits",
        output: "",
        segmentLimit: "budget_exhausted",
      }),
    ];
    const ids = bannerFailureEventIds(events, { failureEventId: null }, true);
    expect(ids).toEqual([events[4]!.id]);
    const groups = groupTimeline(t, buildTimeline(t, events), {
      readableTurns: true,
      presentedFailureEventIds: ids,
    });
    expect(flatten(groups).filter((item) => item.kind === "notice")).toEqual([]);
    expect(workRows(groups)[0]).toMatchObject({ outcome: "failed" });
    expect(workRows(groups)[0]!.failureText).toBeUndefined();
    expect(bannerFailureEventIds(events, { failureEventId: null }, false)).toEqual([]);
  });

  test("a retried attempt that failed before any work is a quiet step too", () => {
    sequence = 0;
    const events = [
      event("user.message", { text: "Go" }, null),
      event("turn.started", {}),
      event("turn.failed", { error: ERROR, detail: DETAIL }),
      event("session.status.changed", { status: "failed" }),
      event("turn.recovery.requested", { reason: "human_retry" }),
      event("session.status.changed", { status: "running" }),
      event("turn.failed", { error: ERROR, detail: DETAIL }),
      event("session.status.changed", { status: "failed" }),
    ];
    const finalId = events[6]!.id;
    const notices = flatten(
      groupTimeline(t, buildTimeline(t, events), {
        readableTurns: true,
        presentedFailureEventIds: [finalId],
      }),
    ).filter((item) => item.kind === "notice");
    // The first attempt stays reachable as one quiet step; the banner has the current one.
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ id: events[2]!.id, retriedAttempt: true });
  });

  test("an older failure in the same chat keeps its own text", () => {
    sequence = 0;
    const events = [
      event("user.message", { text: "First" }, null),
      ...attempt(),
      event("turn.failed", { error: "OLDER FAILURE", detail: "older detail" }),
      event("session.status.changed", { status: "failed" }),
      event("user.message", { text: "Second" }, null),
      ...attempt().map((e) => ({ ...e, turnId: "turn-2" })),
      { ...event("turn.failed", { error: ERROR, detail: DETAIL }), turnId: "turn-2" },
      { ...event("session.status.changed", { status: "failed" }), turnId: "turn-2" },
    ];
    const finalId = events.filter((e) => e.type === "turn.failed").at(-1)!.id;
    const items = buildTimeline(t, events);
    for (const readableTurns of [true, false]) {
      const shown = JSON.stringify(
        groupTimeline(t, items, { readableTurns, presentedFailureEventIds: [finalId] }),
      );
      expect(shown).toContain("OLDER FAILURE");
      expect(shown).not.toContain(ERROR);
    }
  });
});

describe("the non-rolling timeline", () => {
  const nonRolling = (events: SessionEvent[]) => groupTimeline(t, buildTimeline(t, events));

  test("a failure before any work is told by its notice, not again on the turn header", () => {
    sequence = 0;
    const events = [
      event("user.message", { text: "Go" }, null),
      event("turn.started", {}),
      event("turn.failed", { error: ERROR, detail: DETAIL }),
    ];
    const groups = nonRolling(events);
    expect(flatten(groups).filter((item) => item.kind === "notice")).toHaveLength(1);
    expect(occurrences(JSON.stringify(groups), ERROR)).toBe(1);
  });

  test("an attempt whose failure has its own row gets no second quiet step", () => {
    sequence = 0;
    const skipped = () =>
      event("session.context.compaction.skipped", {
        trigger: "auto",
        reason: "summarization_failed",
        providerRejection: { httpStatus: 400, type: "invalid_request_error" },
      });
    const compactionFailed = () =>
      event("turn.failed", {
        error: "compaction summarization failed: 400",
        code: "context_compaction_failed",
      });
    const events = [
      event("user.message", { text: "Go" }, null),
      event("turn.started", {}),
      skipped(),
      compactionFailed(),
      event("turn.recovery.requested", { reason: "human_retry" }),
      skipped(),
      compactionFailed(),
    ];
    const notices = flatten(nonRolling(events)).filter(
      (item) => item.kind === "notice" && item.retriedAttempt,
    );
    expect(notices).toEqual([]);
  });

  test("a Retry refused before it started folds the turn once, as its outcome", () => {
    sequence = 0;
    const events = refusedRetry();
    const turns = nonRolling(events).filter((group) => group.kind === "turn");
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ outcome: "failed" });
  });

  test("each attempt's steps keep their own outcome", () => {
    sequence = 0;
    const second = "SECOND ATTEMPT ERROR";
    const work = (id: string) => [
      event("agent.toolCall.created", { id, name: "exec_command", arguments: {} }),
      event("agent.toolCall.output", { id, output: "ok" }),
    ];
    const events = [
      event("user.message", { text: "Go" }, null),
      event("turn.started", {}),
      ...work("a"),
      event("turn.failed", { error: ERROR, detail: DETAIL }),
      event("turn.recovery.requested", { reason: "human_retry" }),
      ...work("b"),
      event("turn.failed", { error: second }),
    ];
    const turn = nonRolling(events).find((group) => group.kind === "turn")!;
    const clusters = (turn.kind === "turn" ? turn.groups : []).filter(
      (group) => group.kind === "activity",
    );
    expect(clusters).toHaveLength(2);
    expect(JSON.stringify(clusters[0])).not.toContain(second);
  });

  test("an attempt with work whose failure has its own usage-limit row gets no retried step", () => {
    sequence = 0;
    const limit = () =>
      event("turn.failed", {
        error: "Usage allowance exhausted",
        code: "allowance_exhausted",
        message: "Usage allowance exhausted",
        scope: "workspace",
        resetsAt: "2026-11-11T00:00:00.000Z",
      });
    const events = [
      event("user.message", { text: "Go" }, null),
      event("turn.started", {}),
      event("agent.toolCall.created", { id: "a", name: "exec_command", arguments: {} }),
      event("agent.toolCall.output", { id: "a", output: "ok" }),
      limit(),
      event("turn.recovery.requested", { reason: "human_retry" }),
      event("agent.toolCall.created", { id: "b", name: "exec_command", arguments: {} }),
      event("agent.toolCall.output", { id: "b", output: "ok" }),
      event("turn.completed", { output: "" }),
    ];
    for (const readableTurns of [true, false]) {
      const notices = flatten(groupTimeline(t, buildTimeline(t, events), { readableTurns }));
      expect(notices.filter((item) => item.kind === "notice" && item.retriedAttempt)).toEqual([]);
      expect(notices.some((item) => item.kind === "notice" && item.allowance)).toBe(true);
    }
  });

  test("an attempt that failed before any work after an earlier attempt's work keeps a step", () => {
    sequence = 0;
    const work = (id: string) => [
      event("agent.toolCall.created", { id, name: "exec_command", arguments: {} }),
      event("agent.toolCall.output", { id, output: "ok" }),
    ];
    const events = [
      event("user.message", { text: "Go" }, null),
      event("turn.started", {}),
      ...work("a"),
      event("turn.failed", { error: "FIRST" }),
      event("turn.recovery.requested", { reason: "human_retry" }),
      event("turn.failed", { error: "SECOND" }),
      event("turn.recovery.requested", { reason: "human_retry" }),
      ...work("b"),
      event("turn.completed", { output: "" }),
    ];
    for (const readableTurns of [true, false]) {
      const retried = flatten(groupTimeline(t, buildTimeline(t, events), { readableTurns })).filter(
        (item) => item.kind === "notice" && item.retriedAttempt,
      );
      expect(
        retried.map((item) => (item.kind === "notice" ? item.details?.value : undefined)),
      ).toEqual(["FIRST", "SECOND"]);
    }
  });

  test("a Retry refused before it started shows each failure once, without a divider", () => {
    sequence = 0;
    const events = refusedRetry();
    const refusalId = events.filter((e) => e.type === "turn.failed").at(-1)!.id;
    for (const readableTurns of [true, false]) {
      const items = buildTimeline(t, events);
      expect(items.filter((item) => item.kind === "session-status")).toEqual([]);
      const groups = groupTimeline(t, items, {
        readableTurns,
        presentedFailureEventIds: [refusalId],
      });
      const shown = JSON.stringify(groups);
      // The banner has the refusal; the first attempt's text is behind its quiet step.
      expect(shown).not.toContain(REFUSAL);
      expect(occurrences(shown, ERROR)).toBe(1);
    }
  });
});

const REFUSAL = "This chat's machine is offline.";

/** A Retry the server refused before it started: its own failure, then the failed status. */
function refusedRetry(): SessionEvent[] {
  return [
    event("user.message", { text: "Go" }, null),
    ...attempt(),
    ...failure(),
    event("turn.recovery.requested", { reason: "human_retry" }),
    event("turn.failed", { error: REFUSAL, code: "pre_claim_failure" }),
    event("session.status.changed", { status: "failed", code: "pre_claim_failure" }),
  ];
}

describe("the rendered timeline (web and the desktop app)", () => {
  test("with the failed banner, the error text appears only behind the retried attempt", async () => {
    const { events, finalFailureId } = retriedTwice();
    const rendered = await renderComponent(
      <MessageTimeline
        events={events}
        status="failed"
        turnSummary={{ rolling: true }}
        presentedFailureEventIds={[finalFailureId]}
      />,
    );
    await flush();
    const text = rendered.container.textContent ?? "";
    expect(text).toContain("Failed");
    expect(text).toContain("Attempt failed · retried");
    expect(text).not.toContain("work resumed");
    expect(text).not.toMatch(/failed · \d/);
    // The only copy is the retried attempt's, inside its closed disclosure.
    expect(occurrences(text, ERROR)).toBe(1);
    const retried = rendered.container.querySelector("details[data-og-retried-attempt]");
    expect(retried?.hasAttribute("open")).toBe(false);
    expect(retried?.textContent).toContain(ERROR);
    await rendered.unmount();
  });

  test("without a banner the turn row is the failure's one place", async () => {
    sequence = 0;
    const events = [event("user.message", { text: "Go" }, null), ...attempt(), ...failure()];
    const rendered = await renderComponent(
      <MessageTimeline events={events} status="failed" turnSummary={{ rolling: true }} />,
    );
    await flush();
    const text = rendered.container.textContent ?? "";
    expect(occurrences(text, ERROR)).toBe(1);
    expect(text).not.toMatch(/failed · \d/);
    await rendered.unmount();
  });
});
