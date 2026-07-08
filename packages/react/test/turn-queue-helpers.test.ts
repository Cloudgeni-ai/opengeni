import { describe, expect, test } from "bun:test";
import {
  activeTurnFromTurns,
  applyTurnEdit,
  applyTurnRemoval,
  applyTurnReorder,
  isTurnQueueEvent,
  queueFromTurns,
} from "../src/hooks/use-turn-queue";
import { fakeTurn } from "./fake-client";

describe("queueFromTurns", () => {
  test("keeps only queued turns, ordered by position then createdAt", () => {
    const turns = [
      fakeTurn({ id: "done", status: "completed", position: 1 }),
      fakeTurn({ id: "b", position: 2 }),
      fakeTurn({ id: "a", position: 1 }),
      fakeTurn({ id: "tie-late", position: 3, createdAt: "2026-06-12T00:05:00.000Z" }),
      fakeTurn({ id: "tie-early", position: 3, createdAt: "2026-06-12T00:01:00.000Z" }),
      fakeTurn({ id: "running", status: "running", position: 0 }),
    ];
    expect(queueFromTurns(turns).map((turn) => turn.id)).toEqual([
      "a",
      "b",
      "tie-early",
      "tie-late",
    ]);
  });
});

describe("activeTurnFromTurns", () => {
  test("finds the running or requires_action turn", () => {
    expect(activeTurnFromTurns([fakeTurn({ id: "q" })])).toBeNull();
    expect(activeTurnFromTurns([fakeTurn({ id: "r", status: "running" })])?.id).toBe("r");
    expect(activeTurnFromTurns([fakeTurn({ id: "ra", status: "requires_action" })])?.id).toBe("ra");
  });
});

describe("applyTurnEdit", () => {
  test("patches only the targeted queued turn", () => {
    const turns = [fakeTurn({ id: "a", prompt: "old" }), fakeTurn({ id: "b", prompt: "other" })];
    const next = applyTurnEdit(turns, "a", { prompt: "new", reasoningEffort: "high" });
    expect(next.find((turn) => turn.id === "a")?.prompt).toBe("new");
    expect(next.find((turn) => turn.id === "a")?.reasoningEffort).toBe("high");
    expect(next.find((turn) => turn.id === "b")?.prompt).toBe("other");
  });

  test("never edits a non-queued turn", () => {
    const turns = [fakeTurn({ id: "a", status: "running", prompt: "live" })];
    expect(applyTurnEdit(turns, "a", { prompt: "rewrite" })[0]!.prompt).toBe("live");
  });
});

describe("applyTurnReorder", () => {
  test("assigns positions 1..n in the requested order, like the server", () => {
    const turns = [
      fakeTurn({ id: "a", position: 1 }),
      fakeTurn({ id: "b", position: 2 }),
      fakeTurn({ id: "c", position: 3 }),
    ];
    const next = applyTurnReorder(turns, ["c", "a", "b"]);
    expect(queueFromTurns(next).map((turn) => turn.id)).toEqual(["c", "a", "b"]);
  });

  test("leaves non-queued and unlisted turns untouched", () => {
    const turns = [
      fakeTurn({ id: "running", status: "running", position: 9 }),
      fakeTurn({ id: "a", position: 5 }),
    ];
    const next = applyTurnReorder(turns, ["a", "running"]);
    expect(next.find((turn) => turn.id === "running")?.position).toBe(9);
    expect(next.find((turn) => turn.id === "a")?.position).toBe(1);
  });
});

describe("applyTurnRemoval", () => {
  test("marks the queued turn cancelled (matching the server's delete)", () => {
    const turns = [fakeTurn({ id: "a" }), fakeTurn({ id: "b" })];
    const next = applyTurnRemoval(turns, "a");
    expect(next.find((turn) => turn.id === "a")?.status).toBe("cancelled");
    expect(next.find((turn) => turn.id === "b")?.status).toBe("queued");
  });
});

describe("isTurnQueueEvent", () => {
  test("matches turn.* and nothing else", () => {
    expect(isTurnQueueEvent({ type: "turn.queued" })).toBe(true);
    expect(isTurnQueueEvent({ type: "turn.updated" })).toBe(true);
    expect(isTurnQueueEvent({ type: "turn.cancelled" })).toBe(true);
    expect(isTurnQueueEvent({ type: "agent.message.delta" })).toBe(false);
    expect(isTurnQueueEvent({ type: "goal.paused" })).toBe(false);
  });
});
