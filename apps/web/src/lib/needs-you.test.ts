import { describe, expect, test } from "bun:test";
import type { Session } from "@/types";

import { countNeedsYou, filterNeedsYou, rootNeedsYou } from "./needs-you";

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
