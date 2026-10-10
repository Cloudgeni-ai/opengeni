import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@opengeni/sdk";
import { MessageTimeline } from "../src";
import { buildTimeline, groupTimeline, type TimelineGroup } from "../src/timeline";
import { readableWorkStatus } from "../src/timeline/work-presentation";
import { actRun, flush, registerDom, renderComponent } from "./render-hook";

registerDom();

/*
 * Long orchestration runs repeat "agent update / worked / waited" without
 * saying anything. Two or more consecutive quiet cycles fold into one row that
 * states the count, the span and the latest wait reason; replies, people's
 * messages, failures and the current wait stay where they are.
 */

const WORKER = "5f0c1a2e-7b3d-4c8e-9a61-000000000001";
let sequence = 0;
const START = Date.UTC(2026, 9, 8, 6, 0, 0);

function event(type: string, payload: unknown, turnId: string | null): SessionEvent {
  sequence += 1;
  return {
    id: `cycle-evt-${sequence}`,
    workspaceId: "ws-1",
    sessionId: "session-1",
    sequence,
    type,
    payload,
    occurredAt: new Date(START + sequence * 60_000).toISOString(),
    turnId,
  };
}

function update(turnId: string): SessionEvent {
  return event(
    "system.update.delivered",
    {
      count: 1,
      members: [
        {
          id: `update-${turnId}`,
          kind: "child_progress",
          classification: "info",
          sourceId: WORKER,
          summary: "Worker progress: another piece is in review.",
        },
      ],
    },
    turnId,
  );
}

function tool(id: string, turnId: string): SessionEvent[] {
  return [
    event("agent.toolCall.created", { id, name: "exec_command", arguments: { cmd: id } }, turnId),
    event("agent.toolCall.output", { id, output: "ok" }, turnId),
  ];
}

function waitAndSettle(turnId: string, reason: string): SessionEvent[] {
  return [
    event(
      "agent.toolCall.created",
      { id: `${turnId}-wait`, name: "opengeni__wait_for_input", arguments: {} },
      turnId,
    ),
    event("session.wait.started", { actor: "agent", reason, waitTurnId: turnId }, turnId),
    event(
      "agent.toolCall.output",
      { id: `${turnId}-wait`, output: { status: "waiting_for_input" } },
      turnId,
    ),
    event("turn.completed", { output: "" }, turnId),
  ];
}

/** A cycle opened by an agent update with the given member kind and result. */
function cycleFrom(
  turnId: string,
  kind: string,
  classification: "success" | "failure" | "action_required" | "info",
): SessionEvent[] {
  return [
    event(
      "system.update.delivered",
      {
        count: 1,
        members: [
          {
            id: `update-${turnId}`,
            kind,
            classification,
            sourceId: WORKER,
            summary: `Worker ${classification}.`,
          },
        ],
      },
      turnId,
    ),
    event("turn.started", {}, turnId),
    ...tool(`${turnId}-check`, turnId),
    ...waitAndSettle(turnId, `Waiting for the worker (${turnId}).`),
  ];
}

/** Routine input, a few silent steps, then the wait is re-registered. */
function quietCycle(turnId: string, reason = `Waiting for the worker (${turnId}).`) {
  return [
    update(turnId),
    event("turn.started", {}, turnId),
    ...tool(`${turnId}-check`, turnId),
    ...waitAndSettle(turnId, reason),
  ];
}

function answer(text: string, turnId: string): SessionEvent[] {
  return [event("agent.message.completed", { text, phase: "commentary" }, turnId)];
}

function opening(): SessionEvent[] {
  sequence = 0;
  return [
    event("user.message", { text: "Ship the cutover" }, null),
    event("turn.started", {}, "turn-0"),
    ...tool("spawn", "turn-0"),
    ...answer("Started the cutover worker; I'll wait for its pieces.", "turn-0"),
    ...waitAndSettle("turn-0", "Waiting for the cutover worker."),
  ];
}

function readable(events: SessionEvent[]): TimelineGroup[] {
  return groupTimeline(buildTimeline(events), { readableTurns: true });
}

function cycleRows(groups: TimelineGroup[]) {
  return groups.filter(
    (group): group is Extract<TimelineGroup, { kind: "activity" }> =>
      group.kind === "activity" && !!group.work?.cycles,
  );
}

function shape(groups: TimelineGroup[]): string[] {
  return groups.map((group) =>
    group.kind === "item"
      ? group.item.kind
      : group.kind === "activity" && group.work?.cycles
        ? `cycles(${group.work.cycles.count})`
        : group.kind,
  );
}

describe("quiet wait cycles", () => {
  test("consecutive quiet cycles fold into one row with count, span and latest reason", () => {
    const events = [
      ...opening(),
      ...quietCycle("turn-1"),
      ...quietCycle("turn-2"),
      ...quietCycle("turn-3", "Waiting for the cutover worker to merge its next piece."),
      update("turn-4"),
      event("turn.started", {}, "turn-4"),
      ...tool("turn-4-check", "turn-4"),
      ...waitAndSettle("turn-4", "Waiting for the final piece."),
    ];
    const groups = readable(events);
    // The reply's own wait stays beside it; the current (open) wait stays last.
    expect(shape(groups)).toEqual([
      "user-message",
      "activity",
      "agent-message",
      "notice",
      "cycles(3)",
      "machine-input-batch",
      "activity",
      "notice",
    ]);
    const [row] = cycleRows(groups);
    expect(row!.work!.cycles).toEqual({
      count: 3,
      summary: "Waiting for the cutover worker to merge its next piece.",
    });
    // Expanding shows the original rows, in order, unchanged.
    expect(
      row!.work!.details.map((group) => (group.kind === "item" ? group.item.kind : group.kind)),
    ).toEqual([
      "machine-input-batch",
      "activity",
      "notice",
      "machine-input-batch",
      "activity",
      "notice",
      "machine-input-batch",
      "activity",
      "notice",
    ]);
    expect(row!.items.filter((item) => item.kind === "tool-call")).toHaveLength(6);
    const status = readableWorkStatus({ ...row!, work: row!.work! });
    expect(status.kind).toBe("worked");
    expect(status.label).toBe("3 updates over");
    // From the first cycle's work to the end of its last wait.
    expect(status.durationMs).toBeGreaterThan(10 * 60_000);
  });

  test("a single quiet cycle is left as it is", () => {
    const events = [...opening(), ...quietCycle("turn-1"), update("turn-2")];
    expect(cycleRows(readable(events))).toHaveLength(0);
  });

  test("a cycle that publishes a file or generates an image is not quiet", () => {
    for (const name of ["opengeni__sandbox_file_publish", "generate_image"]) {
      const events = [
        ...opening(),
        ...quietCycle("turn-1"),
        update("turn-2"),
        event("turn.started", {}, "turn-2"),
        event("agent.toolCall.created", { id: "turn-2-out", name, arguments: {} }, "turn-2"),
        event("agent.toolCall.output", { id: "turn-2-out", output: "ok" }, "turn-2"),
        ...waitAndSettle("turn-2", "Waiting for the worker (turn-2)."),
        ...quietCycle("turn-3"),
        update("turn-4"),
      ];
      // Without turn-2 the run would hold three cycles; it breaks into two single cycles.
      expect(cycleRows(readable(events))).toHaveLength(0);
    }
  });

  test("an agent that failed, paused or needs action is news, not a quiet cycle", () => {
    for (const [kind, classification] of [
      ["child_terminal_result", "failure"],
      ["child_paused", "info"],
      ["child_progress", "action_required"],
    ] as const) {
      const events = [
        ...opening(),
        ...quietCycle("turn-1"),
        ...cycleFrom("turn-2", kind, classification),
        ...quietCycle("turn-3"),
        update("turn-4"),
      ];
      // The news input stays visible and splits the run into two single cycles.
      expect(cycleRows(readable(events))).toHaveLength(0);
    }
  });

  test("work that compacted context or recovered from a failure is not quiet", () => {
    const compacted = [
      ...opening(),
      ...quietCycle("turn-1"),
      update("turn-2"),
      event("turn.started", {}, "turn-2"),
      event("session.context.compaction.started", { trigger: "auto" }, "turn-2"),
      event(
        "session.context.compacted",
        { trigger: "auto", estimatedTokensBefore: 600_000, estimatedTokensAfter: 20_000 },
        "turn-2",
      ),
      ...tool("turn-2-check", "turn-2"),
      ...waitAndSettle("turn-2", "Waiting for the worker (turn-2)."),
      ...quietCycle("turn-3"),
      update("turn-4"),
    ];
    expect(cycleRows(readable(compacted))).toHaveLength(0);
    const recovered = [
      ...opening(),
      ...quietCycle("turn-1"),
      update("turn-2"),
      event("turn.started", {}, "turn-2"),
      ...tool("turn-2-check", "turn-2"),
      event("turn.failed", { error: "The model provider failed.", retryable: true }, "turn-2"),
      event("turn.recovery.requested", { error: "The model provider failed." }, "turn-2"),
      event("turn.started", {}, "turn-2"),
      ...tool("turn-2-retry", "turn-2"),
      ...waitAndSettle("turn-2", "Waiting for the worker (turn-2)."),
      ...quietCycle("turn-3"),
      update("turn-4"),
    ];
    expect(cycleRows(readable(recovered))).toHaveLength(0);
  });

  test("the turn answering a person stays visible behind a non-routine input", () => {
    const events = [
      ...opening(),
      ...quietCycle("turn-1"),
      event("user.message", { text: "Status?" }, null),
      ...cycleFrom("turn-x", "child_requires_action", "action_required"),
      ...quietCycle("turn-2"),
      ...quietCycle("turn-3"),
      update("turn-4"),
    ];
    const groups = readable(events);
    const rows = cycleRows(groups);
    // Only turn-2 and turn-3 fold; turn-x answered the person.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.work!.cycles!.count).toBe(2);
    const folded = rows[0]!.work!.details.flatMap((group) =>
      group.kind === "activity" ? group.items.map((item) => item.turnId) : [],
    );
    expect(folded).not.toContain("turn-x");
  });

  test("a visible reply ends the run and keeps its own work row", () => {
    const events = [
      ...opening(),
      ...quietCycle("turn-1"),
      ...quietCycle("turn-2"),
      update("turn-3"),
      event("turn.started", {}, "turn-3"),
      ...tool("turn-3-check", "turn-3"),
      ...answer("Two pieces merged; the last one is in review.", "turn-3"),
      ...waitAndSettle("turn-3", "Waiting for the last piece."),
      ...quietCycle("turn-4"),
      ...quietCycle("turn-5"),
      update("turn-6"),
    ];
    const groups = readable(events);
    expect(shape(groups).slice(4)).toEqual([
      "cycles(2)",
      "machine-input-batch",
      "activity",
      "agent-message",
      "notice",
      "cycles(2)",
      "machine-input-batch",
    ]);
  });

  test("a person's message and failed work are never folded", () => {
    const events = [
      ...opening(),
      ...quietCycle("turn-1"),
      event("user.message", { text: "Status?" }, null),
      ...quietCycle("turn-x"),
      update("turn-2"),
      event("turn.started", {}, "turn-2"),
      ...tool("turn-2-check", "turn-2"),
      event("turn.failed", { error: "The model provider failed." }, "turn-2"),
      ...quietCycle("turn-3"),
      ...quietCycle("turn-4"),
      update("turn-5"),
    ];
    const groups = readable(events);
    // Only the two quiet cycles after the failed turn fold.
    const rows = cycleRows(groups);
    expect(rows.map((row) => row.work!.cycles!.count)).toEqual([2]);
    const failedIndex = groups.findIndex(
      (group) => group.kind === "activity" && group.outcome === "failed",
    );
    expect(failedIndex).toBeGreaterThan(0);
    expect(groups.indexOf(rows[0]!)).toBeGreaterThan(failedIndex);
    const personIndex = shape(groups).indexOf("user-message", 1);
    expect(shape(groups).slice(personIndex, personIndex + 4)).toEqual([
      "user-message",
      "machine-input-batch",
      "activity",
      "notice",
    ]);
  });

  test("the folded row renders its count and reason, and expands to the original rows", async () => {
    const events = [
      ...opening(),
      ...quietCycle("turn-1"),
      ...quietCycle("turn-2", "Waiting for the cutover worker to merge its next piece."),
      update("turn-3"),
    ];
    const view = await renderComponent(
      <MessageTimeline events={events} status="idle" turnSummary={{ rolling: true }} />,
    );
    try {
      await flush(50);
      const summary = view.container.querySelector("[data-og-cycles-summary]");
      expect(summary?.textContent).toBe("Waiting for the cutover worker to merge its next piece.");
      const trigger = summary
        ?.closest("[data-og-work-section]")
        ?.querySelector<HTMLButtonElement>("[data-og-work-header]");
      expect(trigger?.textContent).toContain("2 updates over");
      expect(trigger?.getAttribute("aria-expanded")).toBe("false");
      await actRun(() => trigger!.click());
      await flush(50);
      expect(trigger?.getAttribute("aria-expanded")).toBe("true");
      // Nested work rows inside the fold never become sticky outer headers.
      const section = trigger!.closest("[data-og-work-section]")!;
      expect(section.querySelectorAll('[data-og-work-header="nested"]').length).toBe(2);
    } finally {
      await view.unmount();
    }
  });

  test("a search hit inside the fold opens only its own cycle", async () => {
    const events = [
      ...opening(),
      ...quietCycle("turn-1"),
      ...quietCycle("turn-2"),
      ...quietCycle("turn-3"),
      update("turn-4"),
    ];
    const hit = events.find(
      (entry) =>
        entry.type === "agent.toolCall.created" &&
        (entry.payload as { id?: string }).id === "turn-2-check",
    )!;
    const view = await renderComponent(
      <MessageTimeline
        events={events}
        status="idle"
        autoFollow={false}
        turnSummary={{ rolling: true }}
        searchTarget={{ sequence: hit.sequence, query: "turn-2-check" }}
      />,
    );
    try {
      await flush(50);
      // The wait-reason preview hides while the fold is open; find it by its label.
      const header = [...view.container.querySelectorAll("[data-og-work-header]")].find((entry) =>
        entry.textContent?.includes("3 updates over"),
      )!;
      const section = header.closest("[data-og-work-section]")!;
      expect(section.querySelector("[data-og-work-header]")?.getAttribute("aria-expanded")).toBe(
        "true",
      );
      const nested = [...section.querySelectorAll('[data-og-work-header="nested"]')];
      expect(nested).toHaveLength(3);
      expect(nested.map((row) => row.getAttribute("aria-expanded"))).toEqual([
        "false",
        "true",
        "false",
      ]);
    } finally {
      await view.unmount();
    }
  });
});
