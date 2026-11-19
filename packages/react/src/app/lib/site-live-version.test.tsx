import { afterEach, expect, jest, test } from "bun:test";
import { OpenGeniApiError } from "@opengeni/sdk/browser";
import type { WorkspaceArtifactDetailResponse } from "@opengeni/sdk";
import { actRun, registerDom, renderHook } from "../../../test/render-hook";
import {
  SITE_VERSION_LIVE_POLL_MS,
  SITE_VERSION_POLL_MAX_MS,
  SITE_VERSION_POLL_MS,
  useSiteLiveVersion,
} from "./site-live-version";

registerDom();
afterEach(() => {
  jest.useRealTimers();
});

const detailAt = (revision: number, updatedAt = "2026-10-23T12:00:00Z") =>
  ({
    artifact: {
      id: "site",
      title: "Usage",
      status: "active",
      currentVersion: { id: `version-${revision}`, revision },
      updatedAt,
    },
    versions: [{ id: `version-${revision}`, revision }],
    events: [],
  }) as unknown as WorkspaceArtifactDetailResponse;

/** A Site whose live version the test moves, counting each kind of read. */
function site() {
  const state = {
    revision: 4,
    reads: 0,
    checks: 0,
    check: null as null | (() => Promise<unknown>),
    read: null as null | (() => Promise<unknown>),
  };
  const client = {
    getWorkspaceArtifact: async () => {
      state.reads++;
      if (state.read) await state.read();
      return detailAt(state.revision);
    },
    getWorkspaceArtifactCurrent: async () => {
      state.checks++;
      if (state.check) await state.check();
      return { artifact: detailAt(state.revision).artifact };
    },
  };
  return { state, client };
}

const settle = () => actRun(() => new Promise((resolve) => setTimeout(resolve, 5)));

test("a check reads only the Site's current version, and its history only when that changed", async () => {
  const { state, client } = site();
  const hook = await renderHook(() => useSiteLiveVersion(client, "space", "site"), undefined);
  try {
    await settle();
    // Opening reads the history once.
    expect([state.reads, state.checks]).toEqual([1, 0]);
    expect(hook.result.current.detail?.artifact.currentVersion?.id).toBe("version-4");
    // Nothing changed: a cheap check, no history.
    await actRun(() => hook.result.current.check());
    await settle();
    expect([state.reads, state.checks]).toEqual([1, 1]);
    // A new version is live: the check sees it and reads the history once.
    state.revision = 5;
    await actRun(() => hook.result.current.check());
    await settle();
    expect([state.reads, state.checks]).toEqual([2, 2]);
    expect(hook.result.current.detail?.artifact.currentVersion?.id).toBe("version-5");
    expect(hook.result.current.watch).toBe("live");
  } finally {
    await hook.unmount();
  }
});

test("against a server without the cheap check, every check reads the history", async () => {
  const { state, client } = site();
  state.check = async () => {
    throw new OpenGeniApiError(404, "Not found");
  };
  const hook = await renderHook(() => useSiteLiveVersion(client, "space", "site"), undefined);
  try {
    await settle();
    state.revision = 5;
    await actRun(() => hook.result.current.check());
    await settle();
    expect(hook.result.current.detail?.artifact.currentVersion?.id).toBe("version-5");
    expect(hook.result.current.watch).toBe("live");
    // It isn't asked again.
    await actRun(() => hook.result.current.check());
    await settle();
    expect([state.reads, state.checks]).toEqual([3, 1]);
  } finally {
    await hook.unmount();
  }
});

test("a failed check says reconnecting and the next good one clears it", async () => {
  const { state, client } = site();
  const hook = await renderHook(() => useSiteLiveVersion(client, "space", "site"), undefined);
  try {
    await settle();
    state.check = async () => {
      throw new Error("offline");
    };
    await actRun(() => hook.result.current.check());
    await settle();
    expect(hook.result.current.watch).toBe("reconnecting");
    // What was read stays.
    expect(hook.result.current.detail?.artifact.currentVersion?.id).toBe("version-4");
    state.check = null;
    await actRun(() => hook.result.current.check());
    await settle();
    expect(hook.result.current.watch).toBe("live");
    expect(hook.result.current.failed).toBe(false);
  } finally {
    await hook.unmount();
  }
});

test("a Site that is gone stops the timed checks; coming back to the page checks again", async () => {
  jest.useFakeTimers();
  const { state, client } = site();
  const hook = await renderHook(() => useSiteLiveVersion(client, "space", "site"), undefined);
  try {
    await actRun(() => jest.advanceTimersByTime(0));
    await actRun(() => jest.advanceTimersByTime(SITE_VERSION_POLL_MS));
    expect(state.checks).toBe(1);
    // Deleted, or no longer shared with this person.
    state.check = async () => {
      throw new OpenGeniApiError(404, "Not found");
    };
    state.read = async () => {
      throw new OpenGeniApiError(404, "Not found");
    };
    // The unchanged check doubled the wait.
    await actRun(() => jest.advanceTimersByTime(SITE_VERSION_POLL_MS * 2));
    expect(hook.result.current.watch).toBe("reconnecting");
    const reads = state.reads;
    await actRun(() => jest.advanceTimersByTime(SITE_VERSION_POLL_MAX_MS * 4));
    expect(state.reads).toBe(reads);
    // Coming back to the page asks once more.
    await actRun(() => window.dispatchEvent(new Event("focus")));
    await actRun(() => jest.advanceTimersByTime(0));
    expect(state.reads).toBe(reads + 1);
  } finally {
    await hook.unmount();
  }
});

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

test("unchanged checks back off, a hidden page makes none, and coming back starts over", async () => {
  jest.useFakeTimers();
  const { state, client } = site();
  const hook = await renderHook(() => useSiteLiveVersion(client, "space", "site"), undefined);
  try {
    await actRun(() => jest.advanceTimersByTime(0));
    await actRun(() => jest.advanceTimersByTime(SITE_VERSION_POLL_MS));
    expect(state.checks).toBe(1);
    // Next one waits twice as long.
    await actRun(() => jest.advanceTimersByTime(SITE_VERSION_POLL_MS));
    expect(state.checks).toBe(1);
    await actRun(() => jest.advanceTimersByTime(SITE_VERSION_POLL_MS));
    expect(state.checks).toBe(2);
    // Hidden: no timed checks at all.
    await actRun(() => setVisibility("hidden"));
    await actRun(() => jest.advanceTimersByTime(SITE_VERSION_POLL_MAX_MS * 10));
    expect(state.checks).toBe(2);
    // Visible again: checks at once, then on the short timer.
    await actRun(() => setVisibility("visible"));
    await actRun(() => jest.advanceTimersByTime(0));
    expect(state.checks).toBe(3);
    await actRun(() => jest.advanceTimersByTime(SITE_VERSION_POLL_MS));
    expect(state.checks).toBe(4);
  } finally {
    setVisibility("visible");
    await hook.unmount();
  }
});

class FakeSocket {
  static sockets: FakeSocket[] = [];
  listeners = new Map<string, ((event: { data?: unknown }) => void)[]>();
  closed = false;
  constructor(readonly url: string) {
    FakeSocket.sockets.push(this);
  }
  addEventListener(type: string, listener: (event: { data?: unknown }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: string, event: { data?: unknown } = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  send(hint: unknown) {
    this.emit("message", { data: JSON.stringify(hint) });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.emit("close");
  }
}

test("the live connection checks on new versions, passes data hints on, and slows the timer", async () => {
  jest.useFakeTimers();
  const original = globalThis.WebSocket;
  FakeSocket.sockets = [];
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  const { state, client } = site();
  let tickets = 0;
  const liveClient = {
    ...client,
    createWorkspaceArtifactLiveTicket: async () => {
      tickets++;
      return { url: "wss://og.example/_og/live?ticket=t", expiresAt: "", seq: 3 };
    },
  };
  const hook = await renderHook(() => useSiteLiveVersion(liveClient, "space", "site"), undefined);
  const changes: unknown[] = [];
  const stop = hook.result.current.subscribeDataChanges((change) => changes.push(change));
  try {
    await actRun(() => jest.advanceTimersByTime(0));
    expect(tickets).toBe(1);
    const socket = FakeSocket.sockets[0]!;
    await actRun(() =>
      socket.send({ type: "hello", seq: 3, collections: ["todos"], ttlSeconds: 900 }),
    );
    // Live: the short timer gives way to the slow fallback.
    await actRun(() => jest.advanceTimersByTime(SITE_VERSION_POLL_MAX_MS));
    expect(state.checks).toBe(0);
    await actRun(() => jest.advanceTimersByTime(SITE_VERSION_LIVE_POLL_MS));
    expect(state.checks).toBe(1);
    // Data hints reach the frame, also out of order.
    await actRun(() => socket.send({ type: "data", seq: 5, collections: ["notes"] }));
    await actRun(() => socket.send({ type: "data", seq: 4, collections: ["todos"] }));
    expect(changes).toEqual([
      { collections: ["notes"], seq: 5 },
      { collections: ["todos"], seq: 4 },
    ]);
    // A new version: checked at once.
    state.revision = 5;
    await actRun(() => socket.send({ type: "version", versionId: "version-5" }));
    await actRun(() => jest.advanceTimersByTime(0));
    expect(hook.result.current.detail?.artifact.currentVersion?.id).toBe("version-5");
    // A dropped connection comes back; changes missed meanwhile say "anything".
    await actRun(() => socket.close());
    await actRun(() => jest.advanceTimersByTime(40_000));
    expect(tickets).toBe(2);
    await actRun(() =>
      FakeSocket.sockets[1]!.send({
        type: "hello",
        seq: 7,
        collections: ["todos"],
        ttlSeconds: 900,
      }),
    );
    expect(changes.at(-1)).toEqual({ collections: null, seq: 7 });
    // A page left in the background lets the connection go, and reconnects when shown.
    await actRun(() => setVisibility("hidden"));
    await actRun(() => jest.advanceTimersByTime(30_000));
    expect(FakeSocket.sockets[1]!.closed).toBe(true);
    await actRun(() => jest.advanceTimersByTime(SITE_VERSION_LIVE_POLL_MS));
    expect(tickets).toBe(2);
    await actRun(() => setVisibility("visible"));
    await actRun(() => jest.advanceTimersByTime(0));
    expect(tickets).toBe(3);
  } finally {
    setVisibility("visible");
    stop();
    await hook.unmount();
    globalThis.WebSocket = original;
  }
});

test("without live hints in this deployment, the ticket is not asked again", async () => {
  jest.useFakeTimers();
  const { client } = site();
  let tickets = 0;
  const liveClient = {
    ...client,
    createWorkspaceArtifactLiveTicket: async () => {
      tickets++;
      throw new OpenGeniApiError(404, "Not found");
    },
  };
  const hook = await renderHook(() => useSiteLiveVersion(liveClient, "space", "site"), undefined);
  try {
    await actRun(() => jest.advanceTimersByTime(SITE_VERSION_POLL_MAX_MS * 20));
    expect(tickets).toBe(1);
  } finally {
    await hook.unmount();
  }
});
