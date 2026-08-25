import { describe, expect, test } from "bun:test";

import type { Session } from "@/types";
import {
  activeSessionContinuation,
  advanceSessionPageIdentity,
  authoritativeSessionContinuation,
  emptySessionContinuation,
  mergeSessionContinuation,
  rebaseSessionContinuation,
  reconcileRetainedSessionContinuationChannel,
  sessionPageKey,
} from "./session-pagination";

const row = (id: string) => ({ id, workspaceId: "workspace-a" }) as Session;

describe("session continuation pagination", () => {
  test("rejects a delayed page after the workspace or search changes", () => {
    const first = { key: sessionPageKey("workspace-a", ""), generation: 0 };
    const second = advanceSessionPageIdentity(first, sessionPageKey("workspace-a", "needle"));
    const state = emptySessionContinuation(second.generation);

    expect(
      mergeSessionContinuation(
        state,
        second.generation,
        first.generation,
        {
          sessions: [row("stale")],
          nextCursor: "stale-cursor",
        },
        1,
      ),
    ).toBe(state);
  });

  test("uses a monotonic generation to reject an A to B to A response", () => {
    const a1 = { key: sessionPageKey("workspace-a", ""), generation: 0 };
    const b = advanceSessionPageIdentity(a1, sessionPageKey("workspace-b", ""));
    const a2 = advanceSessionPageIdentity(b, sessionPageKey("workspace-a", ""));
    expect(a2.generation).toBe(2);

    const state = emptySessionContinuation(a2.generation);
    expect(
      mergeSessionContinuation(
        state,
        a2.generation,
        a1.generation,
        {
          sessions: [row("stale-a")],
          nextCursor: null,
        },
        1,
      ),
    ).toBe(state);
  });

  test("deduplicates active continuation rows and resets stale visible state", () => {
    const initial = {
      generation: 3,
      sessions: [row("first"), row("replace")],
      nextCursor: "next",
      failed: true,
      snapshotReadRevision: 4,
      authoritativeSessionIds: new Set(["first", "replace"]),
    };
    const merged = mergeSessionContinuation(
      initial,
      3,
      3,
      {
        sessions: [row("replace"), row("last")],
        nextCursor: null,
      },
      4,
    );
    expect(merged.sessions.map((session) => session.id)).toEqual(["first", "replace", "last"]);
    expect(merged.nextCursor).toBeNull();
    expect(merged.failed).toBe(false);

    expect(activeSessionContinuation(merged, 4)).toEqual(emptySessionContinuation(4));
  });

  test("rebases an expired cursor without discarding already loaded rows", () => {
    const retained = {
      generation: 7,
      sessions: [row("older-a"), row("older-b")],
      nextCursor: "expired",
      failed: true,
      snapshotReadRevision: 6,
      authoritativeSessionIds: new Set(["older-a", "older-b"]),
    };

    expect(rebaseSessionContinuation(retained, 7, 7, "fresh-next", 8)).toEqual({
      generation: 7,
      sessions: retained.sessions,
      nextCursor: "fresh-next",
      failed: false,
      snapshotReadRevision: 8,
      authoritativeSessionIds: new Set(),
    });
  });

  test("retains thousands of rows across repeated pages, overlaps, and cursor rebases", () => {
    let state = emptySessionContinuation(12);
    const expected = new Set<string>();
    for (let page = 0; page < 80; page += 1) {
      const start = page === 0 ? 0 : page * 50 - 1;
      const sessions = Array.from({ length: 51 }, (_, index) => row(`session-${start + index}`));
      for (const session of sessions) expected.add(session.id);
      state = mergeSessionContinuation(
        state,
        12,
        12,
        {
          sessions,
          nextCursor: page === 79 ? null : `cursor-${page + 1}`,
        },
        20,
      );
      if (page > 0 && page % 10 === 0) {
        state = rebaseSessionContinuation(state, 12, 12, `rebased-${page}`, 20);
      }
    }

    expect(state.sessions).toHaveLength(expected.size);
    expect(state.sessions.map((session) => session.id)).toEqual([...expected]);
    expect(state.nextCursor).toBeNull();
    expect(state.failed).toBe(false);
  });

  test("rejects a delayed cursor rebase after the query generation changes", () => {
    const current = {
      generation: 9,
      sessions: [row("current")],
      nextCursor: "current-next",
      failed: false,
      snapshotReadRevision: 9,
      authoritativeSessionIds: new Set(["current"]),
    };

    expect(rebaseSessionContinuation(current, 9, 8, "stale-next", 10)).toBe(current);
  });

  test("keeps retained rows visible while expiring and reloading their list authority", () => {
    let state = mergeSessionContinuation(
      emptySessionContinuation(4),
      4,
      4,
      { sessions: [row("retained")], nextCursor: "old-next" },
      7,
    );

    expect(authoritativeSessionContinuation(state, 4, 7).map((session) => session.id)).toEqual([
      "retained",
    ]);
    expect(authoritativeSessionContinuation(state, 4, 8)).toEqual([]);
    expect(state.sessions.map((session) => session.id)).toEqual(["retained"]);
    expect(
      reconcileRetainedSessionContinuationChannel(state, 4, 8, {
        id: "retained",
        workspaceId: "workspace-b",
        channelId: "cross-workspace",
      }),
    ).toBe(state);
    state = reconcileRetainedSessionContinuationChannel(state, 4, 8, {
      id: "retained",
      workspaceId: "workspace-a",
      channelId: "channel-new",
    });
    expect(state.sessions[0]?.channelId).toBe("channel-new");

    state = rebaseSessionContinuation(state, 4, 4, "fresh-next", 8);
    expect(authoritativeSessionContinuation(state, 4, 8)).toEqual([]);
    state = mergeSessionContinuation(
      state,
      4,
      4,
      { sessions: [row("retained"), row("newer")], nextCursor: null },
      8,
    );
    expect(state.sessions.map((session) => session.id)).toEqual(["retained", "newer"]);
    expect(authoritativeSessionContinuation(state, 4, 8).map((session) => session.id)).toEqual([
      "retained",
      "newer",
    ]);
    expect(
      reconcileRetainedSessionContinuationChannel(state, 4, 8, {
        id: "retained",
        workspaceId: "workspace-a",
        channelId: "channel-stale-detail",
      }),
    ).toBe(state);
  });
});
