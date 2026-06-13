import { describe, expect, test } from "bun:test";
import {
  applyTurnEdit,
  applyTurnRemoval,
  applyTurnReorder,
  queueFromTurns,
} from "@opengeni/react";
import type { SessionTurn } from "@opengeni/sdk";

import {
  deliveryModeExplanation,
  editedTurnFate,
  finishedTurns,
  isMidTurn,
  moveTurnInQueue,
  reorderQueueByDrag,
  turnElapsedSeconds,
  turnSourceLabel,
} from "./queue";

describe("queue reorder math", () => {
  test("moves a turn up or down one slot", () => {
    expect(moveTurnInQueue(["a", "b", "c"], "c", "up")).toEqual(["a", "c", "b"]);
    expect(moveTurnInQueue(["a", "b", "c"], "a", "down")).toEqual(["b", "a", "c"]);
  });

  test("refuses to move past the edges or move unknown turns", () => {
    expect(moveTurnInQueue(["a", "b"], "a", "up")).toBeNull();
    expect(moveTurnInQueue(["a", "b"], "b", "down")).toBeNull();
    expect(moveTurnInQueue(["a", "b"], "missing", "up")).toBeNull();
  });

  test("projects a drag onto the target slot in both directions", () => {
    expect(reorderQueueByDrag(["a", "b", "c", "d"], "a", "c")).toEqual(["b", "c", "a", "d"]);
    expect(reorderQueueByDrag(["a", "b", "c", "d"], "d", "b")).toEqual(["a", "d", "b", "c"]);
  });

  test("ignores no-op and unknown drags", () => {
    expect(reorderQueueByDrag(["a", "b"], "a", "a")).toBeNull();
    expect(reorderQueueByDrag(["a", "b"], "a", "missing")).toBeNull();
  });
});

describe("optimistic queue ops + event reconciliation", () => {
  // The optimistic projections live in @opengeni/react; these tests pin the
  // console's end-to-end flow over them: optimistic apply, then server-view
  // reconciliation re-deriving the rendered queue with queueFromTurns.
  test("an edit projects optimistically and only touches queued turns", () => {
    const turns = [turn("t1", "running", 0), turn("t2", "queued", 1), turn("t3", "queued", 2)];
    const edited = applyTurnEdit(turns, "t2", { prompt: "rewritten" });
    expect(edited.find((candidate) => candidate.id === "t2")?.prompt).toBe("rewritten");
    // Editing the running turn is impossible: the projection refuses it too.
    expect(applyTurnEdit(turns, "t1", { prompt: "nope" }).find((candidate) => candidate.id === "t1")?.prompt).toBe("prompt t1");
  });

  test("a reorder renumbers exactly the listed queued turns and the queue re-sorts", () => {
    const turns = [turn("t1", "running", 0), turn("t2", "queued", 1), turn("t3", "queued", 2)];
    const reordered = applyTurnReorder(turns, ["t3", "t2"]);
    expect(queueFromTurns(reordered).map((candidate) => candidate.id)).toEqual(["t3", "t2"]);
    // The running turn keeps its position untouched.
    expect(reordered.find((candidate) => candidate.id === "t1")?.position).toBe(0);
  });

  test("a delete projects to cancelled and falls out of the rendered queue", () => {
    const turns = [turn("t2", "queued", 1), turn("t3", "queued", 2)];
    const removed = applyTurnRemoval(turns, "t2");
    expect(removed.find((candidate) => candidate.id === "t2")?.status).toBe("cancelled");
    expect(queueFromTurns(removed).map((candidate) => candidate.id)).toEqual(["t3"]);
  });

  test("a turn claimed mid-edit is reported as too late", () => {
    const before = [turn("t2", "queued", 1)];
    expect(editedTurnFate(before, "t2").kind).toBe("editable");
    // turn.started arrives; the server view now shows the turn running.
    const after = [turn("t2", "running", 1)];
    expect(editedTurnFate(after, "t2")).toEqual({ kind: "claimed", turn: after[0]! });
    // ... or already finished before the next refresh landed.
    expect(editedTurnFate([turn("t2", "completed", 1)], "t2").kind).toBe("claimed");
  });

  test("a turn deleted or vanished mid-edit is reported distinctly", () => {
    expect(editedTurnFate([turn("t2", "cancelled", 1)], "t2").kind).toBe("cancelled");
    expect(editedTurnFate([], "t2")).toEqual({ kind: "missing" });
  });
});

describe("queue rail display helpers", () => {
  test("elapsed seconds count from startedAt and clamp at zero", () => {
    const startedAt = "2026-06-11T10:00:00.000Z";
    expect(turnElapsedSeconds({ startedAt }, new Date("2026-06-11T10:02:05.000Z"))).toBe(125);
    expect(turnElapsedSeconds({ startedAt }, new Date("2026-06-11T09:59:59.000Z"))).toBe(0);
    expect(turnElapsedSeconds({ startedAt: null })).toBe(0);
  });

  test("labels turn sources for humans", () => {
    expect(turnSourceLabel("user")).toBe("user");
    expect(turnSourceLabel("scheduled_task")).toBe("schedule");
    expect(turnSourceLabel("goal")).toBe("goal continuation");
  });

  test("finished turns sort newest first and exclude live ones", () => {
    const turns = [
      { ...turn("t1", "completed", 0), finishedAt: "2026-06-11T10:00:00.000Z" },
      { ...turn("t2", "failed", 1), finishedAt: "2026-06-11T11:00:00.000Z" },
      turn("t3", "running", 2),
      turn("t4", "queued", 3),
    ];
    expect(finishedTurns(turns).map((candidate) => candidate.id)).toEqual(["t2", "t1"]);
  });
});

describe("deliveryModeExplanation", () => {
  test("queue mode is honest about running vs idle sessions", () => {
    expect(deliveryModeExplanation("queue", "running")).toContain("Queues behind the running turn");
    expect(deliveryModeExplanation("queue", "idle")).toContain("starts immediately");
  });

  test("steer mode admits there is nothing to interrupt on idle sessions", () => {
    expect(deliveryModeExplanation("steer", "running")).toContain("interrupts the running turn");
    expect(deliveryModeExplanation("steer", "idle")).toContain("Nothing is running");
    expect(deliveryModeExplanation("steer", "failed")).toContain("Nothing is running");
  });

  // The hint must match steerMessage's actual behavior per status: interrupt
  // only on running/requires_action, promote-without-interrupt on queued.
  test("requires_action steers as an interrupt of the approval-blocked turn, not a plain send", () => {
    const steer = deliveryModeExplanation("steer", "requires_action");
    expect(steer).toContain("interrupts the turn waiting on approval");
    expect(steer).not.toContain("Nothing is running");
  });

  test("requires_action queue hint admits the message waits on the approval instead of starting immediately", () => {
    const queue = deliveryModeExplanation("queue", "requires_action");
    expect(queue).toContain("approval is decided");
    expect(queue).not.toContain("starts immediately");
  });

  test("queued steers promote to the queue front without claiming an interrupt", () => {
    const steer = deliveryModeExplanation("steer", "queued");
    expect(steer).toContain("front of the queue");
    expect(steer).not.toContain("interrupts");
  });

  test("queued queue hint says the message waits behind pending turns", () => {
    const queue = deliveryModeExplanation("queue", "queued");
    expect(queue).toContain("behind the pending turns");
    expect(queue).not.toContain("starts immediately");
  });

  test("unknown/null status reads as a plain send", () => {
    expect(deliveryModeExplanation("steer", null)).toContain("Nothing is running");
    expect(deliveryModeExplanation("queue", undefined)).toContain("starts immediately");
  });
});

describe("isMidTurn", () => {
  // Drives the steer-mode reset: an armed steer toggle falls back to queue
  // once there is nothing left to steer, never across a live turn or queue.
  test("running, queued, and requires_action keep steer armed", () => {
    expect(isMidTurn("running")).toBe(true);
    expect(isMidTurn("queued")).toBe(true);
    expect(isMidTurn("requires_action")).toBe(true);
  });

  test("idle, terminal, and unknown statuses reset steer to the queue default", () => {
    expect(isMidTurn("idle")).toBe(false);
    expect(isMidTurn("failed")).toBe(false);
    expect(isMidTurn("cancelled")).toBe(false);
    expect(isMidTurn(null)).toBe(false);
    expect(isMidTurn(undefined)).toBe(false);
  });
});

function turn(id: string, status: SessionTurn["status"], position: number): SessionTurn {
  return {
    id,
    workspaceId: "workspace-1",
    sessionId: "session-1",
    triggerEventId: `event-${id}`,
    temporalWorkflowId: "wf-1",
    status,
    source: "user",
    position,
    prompt: `prompt ${id}`,
    resources: [],
    tools: [],
    model: "scripted-model",
    reasoningEffort: "low",
    sandboxBackend: "none",
    metadata: {},
    startedAt: status === "running" ? "2026-06-11T10:00:00.000Z" : null,
    finishedAt: null,
    createdAt: `2026-06-11T09:0${position}:00.000Z`,
    updatedAt: `2026-06-11T09:0${position}:00.000Z`,
  };
}
