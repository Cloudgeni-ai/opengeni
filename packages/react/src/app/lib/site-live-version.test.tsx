import { afterEach, expect, jest, test } from "bun:test";
import { OpenGeniApiError } from "@opengeni/sdk/browser";
import type { WorkspaceArtifactDetailResponse } from "@opengeni/sdk";
import { actRun, registerDom, renderHook } from "../../../test/render-hook";
import { SITE_VERSION_POLL_MS, useSiteLiveVersion } from "./site-live-version";

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
    await actRun(() => jest.advanceTimersByTime(SITE_VERSION_POLL_MS));
    expect(hook.result.current.watch).toBe("reconnecting");
    const reads = state.reads;
    await actRun(() => jest.advanceTimersByTime(SITE_VERSION_POLL_MS * 4));
    expect(state.reads).toBe(reads);
    // Coming back to the page asks once more.
    await actRun(() => window.dispatchEvent(new Event("focus")));
    await actRun(() => jest.advanceTimersByTime(0));
    expect(state.reads).toBe(reads + 1);
  } finally {
    await hook.unmount();
  }
});
