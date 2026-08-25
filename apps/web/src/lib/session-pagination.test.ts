import { describe, expect, test } from "bun:test";

import type { Session } from "@/types";
import { SessionChannelProjectionAuthority } from "./session-pins";
import {
  activeSessionContinuation,
  advanceSessionPageIdentity,
  authoritativeSessionContinuation,
  authoritativeSessionContinuationChannels,
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
      snapshotReadGeneration: 14,
      snapshotSource: "root" as const,
      authoritativeSessionIds: new Set(["first", "replace"]),
      channelReadGenerations: new Map([
        ["first", 14],
        ["replace", 14],
      ]),
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
      snapshotReadGeneration: 16,
      snapshotSource: "root" as const,
      authoritativeSessionIds: new Set(["older-a", "older-b"]),
      channelReadGenerations: new Map([
        ["older-a", 16],
        ["older-b", 16],
      ]),
    };

    expect(
      rebaseSessionContinuation(retained, 7, 7, { sessions: [], nextCursor: "fresh-next" }, 8),
    ).toEqual({
      generation: 7,
      sessions: retained.sessions,
      nextCursor: "fresh-next",
      failed: false,
      snapshotReadRevision: 8,
      snapshotReadGeneration: 0,
      snapshotSource: "root",
      authoritativeSessionIds: new Set(),
      channelReadGenerations: new Map(),
    });
  });

  test("adopts fresh page-one channel evidence when an expired cursor rebases", () => {
    const stale = { ...row("shared"), channelId: "channel-a" } as Session;
    const fresh = { ...stale, channelId: "channel-b" } as Session;
    let state = mergeSessionContinuation(
      emptySessionContinuation(11),
      11,
      11,
      { sessions: [stale, row("retained")], nextCursor: "expired" },
      30,
      40,
    );
    const freshFirstPage = { sessions: [fresh], nextCursor: null };

    // This mirrors the production cursor-expiry path: page one returned B,
    // but the old rebase API retained only its cursor and silently discarded
    // the row itself.
    state = rebaseSessionContinuation(state, 11, 11, freshFirstPage, 31, 41, "rebase");

    expect(state.sessions.find((session) => session.id === fresh.id)?.channelId).toBe("channel-b");
    expect(authoritativeSessionContinuationChannels(state, 11, 31, 41)).toEqual([
      { session: fresh, readGeneration: 41 },
    ]);
    expect(state.sessions.map((session) => session.id)).toEqual(["shared", "retained"]);
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
        state = rebaseSessionContinuation(
          state,
          12,
          12,
          { sessions: [], nextCursor: `rebased-${page}` },
          20,
        );
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
      snapshotReadGeneration: 19,
      snapshotSource: "root" as const,
      authoritativeSessionIds: new Set(["current"]),
      channelReadGenerations: new Map([["current", 19]]),
    };

    expect(
      rebaseSessionContinuation(current, 9, 8, { sessions: [], nextCursor: "stale-next" }, 10),
    ).toBe(current);
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

    state = rebaseSessionContinuation(state, 4, 4, { sessions: [], nextCursor: "fresh-next" }, 8);
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

  test("orders cursor-rebase authority on its own shared causal generation", () => {
    const authority = new SessionChannelProjectionAuthority();
    const continuationOwner = {};
    const rootOwner = {};
    const detailA = { ...row("retained"), channelId: "channel-a" } as Session;
    const rebasedB = { ...detailA, channelId: "channel-b" } as Session;
    const rootC = { ...detailA, channelId: "channel-c" } as Session;

    const detailGeneration = authority.beginRead();
    authority.recordRead(detailA, detailGeneration);
    const rebaseGeneration = authority.beginRead();
    let state = rebaseSessionContinuation(
      emptySessionContinuation(5),
      5,
      5,
      { sessions: [], nextCursor: "rebased-next" },
      91,
      rebaseGeneration,
      "rebase",
    );
    state = mergeSessionContinuation(
      state,
      5,
      5,
      { sessions: [rebasedB], nextCursor: null },
      91,
      rebaseGeneration,
      "rebase",
    );
    const rebasedEvidence = authoritativeSessionContinuation(state, 5, 12, detailGeneration);
    authority.replace(continuationOwner, rebasedEvidence, 0, state.snapshotReadGeneration);
    expect(authority.owns(rebasedB)).toBe(true);
    expect(authority.owns(detailA)).toBe(false);

    // A rebase that actually started earlier cannot borrow the revision or
    // generation of a later root read when it finally completes.
    const staleRebaseGeneration = authority.beginRead();
    const newerRootGeneration = authority.beginRead();
    authority.replace(rootOwner, [rootC], 0, newerRootGeneration);
    let staleState = rebaseSessionContinuation(
      emptySessionContinuation(6),
      6,
      6,
      { sessions: [], nextCursor: "stale-next" },
      92,
      staleRebaseGeneration,
      "rebase",
    );
    staleState = mergeSessionContinuation(
      staleState,
      6,
      6,
      { sessions: [rebasedB], nextCursor: null },
      92,
      staleRebaseGeneration,
      "rebase",
    );
    expect(authoritativeSessionContinuation(staleState, 6, 13, newerRootGeneration)).toEqual([]);
    expect(authority.owns(rootC)).toBe(true);
  });

  test("orders live continuation rows by their own request start", () => {
    const authority = new SessionChannelProjectionAuthority();
    const continuationOwner = {};
    const pageOneGeneration = authority.beginRead();
    const detailA = { ...row("retained"), channelId: "channel-a" } as Session;
    const detailGeneration = authority.beginRead();
    authority.recordRead(detailA, detailGeneration);

    const continuationGeneration = authority.beginRead();
    const continuationB = { ...detailA, channelId: "channel-b" } as Session;
    const state = mergeSessionContinuation(
      emptySessionContinuation(7),
      7,
      7,
      { sessions: [continuationB], nextCursor: null },
      101,
      pageOneGeneration,
      "root",
      continuationGeneration,
    );
    const evidence = authoritativeSessionContinuationChannels(state, 7, 101, pageOneGeneration);
    authority.replaceEvidence(
      continuationOwner,
      evidence.map(({ session, readGeneration }) => ({ projection: session, readGeneration })),
    );

    expect(evidence).toEqual([{ session: continuationB, readGeneration: continuationGeneration }]);
    expect(authority.owns(continuationB)).toBe(true);
    expect(authority.owns(detailA)).toBe(false);
  });

  test("keeps stale continuations fenced but accepts a later post-rebase page", () => {
    const authority = new SessionChannelProjectionAuthority();
    const continuationOwner = {};
    const rootOwner = {};
    const detailC = { ...row("retained"), channelId: "channel-c" } as Session;
    const staleB = { ...detailC, channelId: "channel-b" } as Session;
    const freshD = { ...detailC, channelId: "channel-d" } as Session;

    const snapshotGeneration = authority.beginRead();
    const staleContinuationGeneration = authority.beginRead();
    const detailGeneration = authority.beginRead();
    authority.recordRead(detailC, detailGeneration);
    let state = mergeSessionContinuation(
      emptySessionContinuation(8),
      8,
      8,
      { sessions: [staleB], nextCursor: "expired" },
      102,
      snapshotGeneration,
      "root",
      staleContinuationGeneration,
    );
    let evidence = authoritativeSessionContinuationChannels(state, 8, 102, snapshotGeneration);
    authority.replaceEvidence(
      continuationOwner,
      evidence.map(({ session, readGeneration }) => ({ projection: session, readGeneration })),
    );
    expect(authority.owns(detailC)).toBe(true);
    expect(authority.owns(staleB)).toBe(false);
    expect(authority.project(staleB, staleContinuationGeneration).channelId).toBe("channel-c");

    const newerRootGeneration = authority.beginRead();
    authority.replace(rootOwner, [detailC], 0, newerRootGeneration);
    expect(authoritativeSessionContinuationChannels(state, 8, 103, newerRootGeneration)).toEqual(
      [],
    );

    const rebaseGeneration = authority.beginRead();
    state = rebaseSessionContinuation(
      state,
      8,
      8,
      { sessions: [], nextCursor: "rebased-next" },
      103,
      rebaseGeneration,
      "rebase",
    );
    const postRebaseContinuationGeneration = authority.beginRead();
    state = mergeSessionContinuation(
      state,
      8,
      8,
      { sessions: [freshD], nextCursor: null },
      103,
      rebaseGeneration,
      "rebase",
      postRebaseContinuationGeneration,
    );
    evidence = authoritativeSessionContinuationChannels(state, 8, 103, newerRootGeneration);
    authority.replaceEvidence(
      continuationOwner,
      evidence.map(({ session, readGeneration }) => ({ projection: session, readGeneration })),
    );
    expect(evidence).toEqual([
      { session: freshD, readGeneration: postRebaseContinuationGeneration },
    ]);
    expect(authority.owns(freshD)).toBe(true);
  });
});
