import { describe, expect, test } from "bun:test";
import type { Session } from "@/types";

import { sessionStateLabel } from "./session-rail";
import { groupSessionsForRail, summarizeRailNodes } from "./sessions-group";

function session(
  id: string,
  backgroundCommandActivity?: Session["backgroundCommandActivity"],
): Session {
  return {
    id,
    status: "idle",
    backgroundCommandActivity,
    effectiveControl: { state: "active" },
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:00.000Z",
  } as Session;
}

describe("session background command rail status", () => {
  test("an idle session with a running command is grouped as active", () => {
    const active = session("active", { state: "running", count: 1 });
    const idle = session("idle");
    const grouped = groupSessionsForRail([idle, active], new Date("2026-08-23T12:00:00.000Z"));
    expect(grouped.running.map((row) => row.id)).toEqual(["active"]);
    expect(sessionStateLabel(active)).toBe("Background command running");
    expect(
      summarizeRailNodes([{ session: active, children: [], hasActiveDescendant: false }]),
    ).toEqual({ kind: "active", count: 1, total: 1, label: "1 working" });
  });

  test("stopping takes precedence over the idle turn lifecycle", () => {
    const stopping = session("stopping", { state: "stopping", count: 2 });
    expect(sessionStateLabel(stopping)).toBe("Stopping 2 background commands…");
  });
});
