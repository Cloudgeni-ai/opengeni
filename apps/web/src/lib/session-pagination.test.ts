import { describe, expect, test } from "bun:test";

import type { Session } from "@/types";
import {
  activeSessionContinuation,
  advanceSessionPageIdentity,
  emptySessionContinuation,
  mergeSessionContinuation,
  sessionPageKey,
} from "./session-pagination";

const row = (id: string) => ({ id }) as Session;

describe("session continuation pagination", () => {
  test("rejects a delayed page after the workspace or search changes", () => {
    const first = { key: sessionPageKey("workspace-a", ""), generation: 0 };
    const second = advanceSessionPageIdentity(first, sessionPageKey("workspace-a", "needle"));
    const state = emptySessionContinuation(second.generation);

    expect(
      mergeSessionContinuation(state, second.generation, first.generation, {
        sessions: [row("stale")],
        nextCursor: "stale-cursor",
      }),
    ).toBe(state);
  });

  test("uses a monotonic generation to reject an A to B to A response", () => {
    const a1 = { key: sessionPageKey("workspace-a", ""), generation: 0 };
    const b = advanceSessionPageIdentity(a1, sessionPageKey("workspace-b", ""));
    const a2 = advanceSessionPageIdentity(b, sessionPageKey("workspace-a", ""));
    expect(a2.generation).toBe(2);

    const state = emptySessionContinuation(a2.generation);
    expect(
      mergeSessionContinuation(state, a2.generation, a1.generation, {
        sessions: [row("stale-a")],
        nextCursor: null,
      }),
    ).toBe(state);
  });

  test("deduplicates active continuation rows and resets stale visible state", () => {
    const initial = {
      generation: 3,
      sessions: [row("first"), row("replace")],
      nextCursor: "next",
      failed: true,
    };
    const merged = mergeSessionContinuation(initial, 3, 3, {
      sessions: [row("replace"), row("last")],
      nextCursor: null,
    });
    expect(merged.sessions.map((session) => session.id)).toEqual(["first", "replace", "last"]);
    expect(merged.nextCursor).toBeNull();
    expect(merged.failed).toBe(false);

    expect(activeSessionContinuation(merged, 4)).toEqual(emptySessionContinuation(4));
  });
});
