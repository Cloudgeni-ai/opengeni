import { describe, expect, test } from "bun:test";
import type { Session } from "../types";

import {
  awaitingPersonSince,
  awaitsConnection,
  awaitsPerson,
  countNeedsYou,
  filterNeedsYou,
  rootNeedsYou,
} from "./needs-you";

function session(overrides: Partial<Session> & { id: string }): Session {
  const { id, ...rest } = overrides;
  return {
    status: "idle",
    parentSessionId: null,
    rootSessionId: id,
    archived: false,
    ...rest,
    id,
  } as Session;
}

describe("needs you", () => {
  test("an idle chat whose agent waits on a connection card needs you, as an approval does", () => {
    const since = "2026-11-19T14:00:00.000Z";
    const waiting = session({ id: "a", awaitingConnectionSince: since } as never);
    expect(awaitsConnection(waiting)).toBe(true);
    expect(awaitsPerson(waiting)).toBe(true);
    expect(awaitingPersonSince(waiting)).toBe(since);
    expect(rootNeedsYou(waiting)).toBe(true);
    expect(countNeedsYou([waiting])).toBe(1);
    const child = session({
      id: "a1",
      parentSessionId: "r",
      rootSessionId: "r",
      awaitingConnectionSince: since,
    } as never);
    expect(filterNeedsYou([child])).toEqual([child]);
    // Only while nothing runs: a resumed turn no longer waits on the card.
    const running = session({
      id: "b",
      status: "running",
      awaitingConnectionSince: since,
    } as never);
    expect(awaitsPerson(running)).toBe(false);
    expect(rootNeedsYou(running)).toBe(false);
    expect(awaitsPerson(session({ id: "c" }))).toBe(false);
  });

  test("a session the runtime could not start is stuck, not waiting on the person", () => {
    const stuck = session({
      id: "a",
      status: "requires_action",
      admissionBlock: { code: "database_claim_rejected" },
    } as never);
    expect(rootNeedsYou(stuck)).toBe(false);
    expect(countNeedsYou([stuck])).toBe(0);
    expect(filterNeedsYou([stuck])).toEqual([]);
  });

  test("a sub-agent whose questions are with the agent that started it does not wait on the person", () => {
    const waiting = { id: "b", status: "requires_action" as const, parentSessionId: "a" };
    const withAgent = session({ ...waiting, rootSessionId: "a", questionWithAgent: true });
    expect(awaitsPerson(withAgent)).toBe(false);
    expect(filterNeedsYou([withAgent])).toEqual([]);
    expect(awaitsPerson(session({ ...waiting, rootSessionId: "a" }))).toBe(true);
  });

  test("a root needs you when it, or a spawned agent, waits on a person or failed", () => {
    expect(rootNeedsYou(session({ id: "a", status: "requires_action" }))).toBe(true);
    expect(rootNeedsYou(session({ id: "a", status: "failed" }))).toBe(true);
    expect(rootNeedsYou(session({ id: "a", status: "running" }))).toBe(false);
    expect(
      rootNeedsYou(
        session({ id: "a", status: "running", treeStats: { attentionDescendants: 1 } } as never),
      ),
    ).toBe(true);
    expect(
      rootNeedsYou(
        session({ id: "b", status: "requires_action", parentSessionId: "a", rootSessionId: "a" }),
      ),
    ).toBe(false);
  });

  test("counts unarchived roots only", () => {
    expect(
      countNeedsYou([
        session({ id: "a", status: "requires_action" }),
        session({ id: "b", status: "requires_action", archived: true }),
        session({ id: "c", status: "running" }),
      ]),
    ).toBe(1);
  });

  test("keeps a needing workstream with its spawned agents and drops the rest", () => {
    const rows = [
      session({ id: "a", status: "running", treeStats: { attentionDescendants: 1 } } as never),
      session({ id: "a1", status: "requires_action", parentSessionId: "a", rootSessionId: "a" }),
      session({ id: "a2", status: "running", parentSessionId: "a", rootSessionId: "a" }),
      session({ id: "b", status: "running" }),
      session({ id: "b1", status: "running", parentSessionId: "b", rootSessionId: "b" }),
      session({ id: "c", status: "requires_action" }),
    ];
    expect(filterNeedsYou(rows).map((row) => row.id)).toEqual(["a", "a1", "a2", "c"]);
  });

  test("a flat projection keeps a waiting child whose root is not loaded", () => {
    const rows = [
      session({ id: "x1", status: "requires_action", parentSessionId: "x", rootSessionId: "x" }),
      session({ id: "x2", status: "running", parentSessionId: "x", rootSessionId: "x" }),
    ];
    expect(filterNeedsYou(rows).map((row) => row.id)).toEqual(["x1"]);
  });
});
