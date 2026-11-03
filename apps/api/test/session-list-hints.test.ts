import { expect, spyOn, test } from "bun:test";
import { waitFor } from "@opengeni/testing/process";
import type { SessionListChangeSource, SessionListNotification } from "@opengeni/db";
import {
  subscribeSessionListHints,
  type SessionListHint,
  type SessionListHintIds,
} from "../src/http/session-list-hints";

function fixture(
  authorizeIds: (ids: string[]) => Promise<SessionListHintIds> = async (ids) => ids,
) {
  let listener: ((event: SessionListNotification) => void) | undefined;
  const source: SessionListChangeSource = {
    subscribe(fn) {
      listener = fn;
      fn({ type: "connected" });
      return () => {
        listener = undefined;
      };
    },
    async close() {},
  };
  const frames: SessionListHint[] = [];
  const reads: string[][] = [];
  const errors: unknown[] = [];
  const stop = subscribeSessionListHints({
    source,
    workspaceId: "workspace",
    subjectId: "viewer",
    intervalMs: 5,
    authorizeIds: async (ids) => {
      reads.push(ids);
      return await authorizeIds(ids);
    },
    write: async (hint) => {
      frames.push(hint);
    },
    fail: (error) => errors.push(error),
  });
  return {
    frames,
    reads,
    errors,
    stop,
    event: (event: SessionListNotification) => listener?.(event),
    change: (
      sessionId: string | null,
      overrides: Partial<Extract<SessionListNotification, { type: "change" }>["change"]> = {},
    ) =>
      listener?.({
        type: "change",
        change: {
          schema: "public",
          workspaceId: "workspace",
          subjectId: null,
          sessionId,
          all: sessionId === null,
          ...overrides,
        },
      }),
  };
}

function manualFixture(authorizeIds?: (ids: string[]) => Promise<SessionListHintIds>) {
  let tick!: () => void;
  const original = globalThis.setInterval;
  const timer = spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void) => {
    tick = callback;
    return original(() => {}, 60_000);
  }) as typeof setInterval);
  try {
    return { ...fixture(authorizeIds), tick: () => tick() };
  } finally {
    timer.mockRestore();
  }
}

test("slow authorization retains one coalesced follow-up instead of a queue per timer tick", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  const f = manualFixture(async (ids) => {
    if (first) {
      first = false;
      await gate;
    }
    return ids;
  });
  try {
    await waitFor(() => f.frames.length === 1);
    f.change("same");
    f.tick();
    await waitFor(() => f.reads.length === 1);
    for (let i = 0; i < 30; i++) {
      f.change("same");
      f.tick();
    }
    f.change("last");
    f.tick();
    expect(f.reads).toHaveLength(1);
    release();
    await waitFor(() => f.frames.some((frame) => frame.sessionIds?.includes("last")));
    expect(f.reads).toEqual([["same"], ["same", "last"]]);
    expect(f.errors).toEqual([]);
  } finally {
    release();
    f.stop();
  }
});

test("an excessive dirty-ID set becomes one content-free reconciliation", async () => {
  const f = manualFixture();
  try {
    await waitFor(() => f.frames.length === 1);
    for (let i = 0; i < 10_000; i++) f.change(`session-${i}`);
    f.tick();
    await waitFor(() => f.frames.length === 2);
    expect(f.reads).toEqual([]);
    expect(f.frames[1]?.sessionIds).toBeNull();
  } finally {
    f.stop();
  }
});

test("changes during a fast read still wait for the normal flush cadence", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = manualFixture(async (ids) => {
    await gate;
    return ids;
  });
  try {
    await waitFor(() => f.frames.length === 1);
    f.change("first");
    f.tick();
    await waitFor(() => f.reads.length === 1);
    f.change("second");
    release();
    await waitFor(() => f.frames.length >= 2);
    expect(f.reads).toEqual([["first"]]);
    f.tick();
    await waitFor(() => f.frames.length === 3);
    expect(f.reads).toEqual([["first"], ["second"]]);
  } finally {
    release();
    f.stop();
  }
});

test("unsubscribe during authorization prevents the pending write", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = manualFixture(async (ids) => {
    await gate;
    return ids;
  });
  try {
    await waitFor(() => f.frames.length === 1);
    f.change("late");
    f.tick();
    await waitFor(() => f.reads.length === 1);
    f.stop();
    release();
    await gate;
    // Drain the authorization/write promise chain without a timing threshold.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(f.frames).toHaveLength(1);
  } finally {
    release();
    f.stop();
  }
});

test("idle costs no authorization reads; dirty IDs are coalesced and filtered before emission", async () => {
  const f = fixture(async (ids) => ids.filter((id) => id !== "private"));
  try {
    await waitFor(() => f.frames.length === 1);
    await Bun.sleep(20);
    expect(f.reads).toEqual([]);
    expect(f.frames).toHaveLength(1);
    f.change("other-workspace", { workspaceId: "other" });
    f.change("other-subject", { subjectId: "other" });
    f.change("visible");
    f.change("visible");
    f.change("private");
    await waitFor(() => f.frames.length === 2);
    expect(f.reads).toEqual([["visible", "private"]]);
    expect(f.frames[1]).toMatchObject({ available: true, sessionIds: ["visible"] });
    f.change("private");
    await waitFor(() => f.reads.length === 2);
    await Bun.sleep(10);
    expect(f.frames).toHaveLength(2);
  } finally {
    f.stop();
  }
});

test("changes during authorization survive; loss cancels stale hints and reconnect reconciles", async () => {
  let release: (() => void) | undefined;
  const f = fixture(async (ids) => {
    if (ids.includes("first"))
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    return ids;
  });
  try {
    await waitFor(() => f.frames.length === 1);
    f.change("first");
    await waitFor(() => Boolean(release));
    f.change("second");
    release!();
    await waitFor(() => f.frames.length === 3);
    expect(f.frames.slice(1).map((frame) => frame.sessionIds)).toEqual([["first"], ["second"]]);
    release = undefined;
    f.change("first");
    await waitFor(() => Boolean(release));
    f.event({ type: "disconnected" });
    f.change("missed-while-down");
    f.event({ type: "connected" });
    release!();
    await waitFor(() => f.frames.length === 5);
    expect(
      f.frames.slice(3).map(({ available, sessionIds }) => ({ available, sessionIds })),
    ).toEqual([
      { available: false, sessionIds: null },
      { available: true, sessionIds: null },
    ]);
    expect(f.errors).toEqual([]);
  } finally {
    f.stop();
  }
});

test("workspace reconciliation reveals no revoked IDs and unsubscribe releases the consumer", async () => {
  const f = fixture();
  await waitFor(() => f.frames.length === 1);
  f.change("known");
  f.change(null);
  await waitFor(() => f.frames.length === 2);
  expect(f.reads).toEqual([]);
  expect(f.frames[1]?.sessionIds).toBeNull();
  f.stop();
  f.change("late");
  await Bun.sleep(15);
  expect(f.frames).toHaveLength(2);
});

test("Site conversations travel separately so ordinary lists can ignore them", async () => {
  const f = fixture(async (ids) => ({
    sessionIds: ids.filter((id) => !id.startsWith("site-")),
    siteSessionIds: ids.filter((id) => id.startsWith("site-")),
  }));
  try {
    await waitFor(() => f.frames.length === 1);
    f.change("site-a");
    await waitFor(() => f.frames.length === 2);
    expect(f.frames[1]).toEqual({
      type: "workspace.sessions.changed",
      workspaceId: "workspace",
      available: true,
      sessionIds: [],
      siteSessionIds: ["site-a"],
    });
    f.change("plain");
    await waitFor(() => f.frames.length === 3);
    expect(f.frames[2]).toEqual({
      type: "workspace.sessions.changed",
      workspaceId: "workspace",
      available: true,
      sessionIds: ["plain"],
    });
  } finally {
    f.stop();
  }
});
