import { expect, test } from "bun:test";
import { useEffect } from "react";
import { usePolledValue } from "../src/hooks/internal";
import {
  notifySessionListChanged,
  subscribeToWorkspaceSessionListChanges,
} from "../src/app/lib/session-list-invalidation";
import { actRun, flush, registerDom, renderHook } from "./render-hook";

registerDom({ clock: "virtual" });

test("one invalidation during an unfinished loader starts a fresh trailing read without a poll", async () => {
  let finishFirst!: (value: number) => void;
  let finishSecond!: (value: number) => void;
  const first = new Promise<number>((resolve) => {
    finishFirst = resolve;
  });
  const second = new Promise<number>((resolve) => {
    finishSecond = resolve;
  });
  let reads = 0;
  const load = () => (++reads === 1 ? first : second);
  const hook = await renderHook(() => {
    // No polling interval, failed read or retry: only the notification can
    // cause a second load, even when the first transport is already finished.
    const state = usePolledValue(load);
    const { refresh } = state;
    useEffect(
      () =>
        subscribeToWorkspaceSessionListChanges("workspace", () => {
          void refresh();
        }),
      [refresh],
    );
    return state;
  }, undefined);
  try {
    expect(reads).toBe(1);
    await actRun(() => {
      notifySessionListChanged({ workspaceId: "workspace", sessionId: "remote-change" });
    });
    expect(reads).toBe(1);
    await actRun(() => finishFirst(1));
    await flush();
    expect(reads).toBe(2);
    await actRun(() => finishSecond(2));
    await flush();
    expect(hook.result.current.data).toBe(2);
  } finally {
    finishFirst(1);
    finishSecond(2);
    await hook.unmount();
  }
});
