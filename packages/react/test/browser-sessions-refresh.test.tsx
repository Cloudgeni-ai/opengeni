import { expect, test } from "bun:test";
import type { SessionClientLike } from "../src/client";
import { useBrowserSessions } from "../src/hooks/use-browser-sessions";
import { fakeClient, WORKSPACE_ID } from "./fake-client";
import { actRun, flush, registerDom, renderHook } from "./render-hook";

registerDom();

type Inventory = Awaited<ReturnType<SessionClientLike["listBrowserSessions"]>>;

function controlledClient() {
  const requests: Array<{
    workspaceId: string;
    signal: AbortSignal | undefined;
    resolve: (value: Inventory) => void;
    reject: (error: Error) => void;
  }> = [];
  const client = fakeClient({
    listBrowserSessions: (workspaceId, options) =>
      new Promise<Inventory>((resolve, reject) => {
        requests.push({ workspaceId, signal: options?.signal, resolve, reject });
      }),
  });
  return { client, requests };
}

test("refresh bursts let a slow initial inventory appear and retain one trailing read", async () => {
  const { client, requests } = controlledClient();
  const hook = await renderHook(
    () => useBrowserSessions({ client, workspaceId: WORKSPACE_ID, pollIntervalMs: 60_000 }),
    undefined,
  );
  const refreshes: Promise<void>[] = [];
  try {
    await actRun(async () => {
      for (let i = 0; i < 40; i += 1) refreshes.push(hook.result.current.refresh());
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.signal?.aborted).toBe(false);
    expect(hook.result.current.loading).toBe(true);

    await actRun(async () => requests[0]!.resolve({ revision: 1, sessions: [] }));
    await flush(5);
    expect(requests).toHaveLength(2);
    expect(hook.result.current.revision).toBe(1);
    expect(hook.result.current.loading).toBe(false);
    expect(hook.result.current.refreshing).toBe(true);

    await actRun(async () => {
      requests[1]!.resolve({ revision: 2, sessions: [] });
      await Promise.all(refreshes);
    });
    expect(requests).toHaveLength(2);
    expect(hook.result.current.revision).toBe(2);
    expect(hook.result.current.refreshing).toBe(false);
  } finally {
    await hook.unmount();
  }
});

test("workspace changes abort old reads and discard their queued refresh and late response", async () => {
  const { client, requests } = controlledClient();
  const otherWorkspace = "33333333-3333-4333-8333-333333333333";
  const hook = await renderHook(
    ({ workspaceId }) => useBrowserSessions({ client, workspaceId, pollIntervalMs: 60_000 }),
    { workspaceId: WORKSPACE_ID },
  );
  try {
    const oldRefresh = hook.result.current.refresh();
    await hook.rerender({ workspaceId: otherWorkspace });
    expect(requests[0]!.signal?.aborted).toBe(true);
    expect(requests.map((request) => request.workspaceId)).toEqual([WORKSPACE_ID, otherWorkspace]);
    await actRun(async () => {
      requests[0]!.resolve({ revision: 999, sessions: [] });
      await oldRefresh;
    });
    expect(hook.result.current.revision).toBe(0);
    expect(hook.result.current.loading).toBe(true);
    await actRun(async () => requests[1]!.resolve({ revision: 2, sessions: [] }));
    expect(hook.result.current.revision).toBe(2);
    expect(requests).toHaveLength(2);
  } finally {
    await hook.unmount();
  }
});

test("disabled and unmounted hooks never dispatch their queued follow-up", async () => {
  for (const stop of ["disable", "unmount"] as const) {
    const { client, requests } = controlledClient();
    const hook = await renderHook(
      ({ enabled }) =>
        useBrowserSessions({ client, workspaceId: WORKSPACE_ID, enabled, pollIntervalMs: 60_000 }),
      { enabled: true },
    );
    const refresh = hook.result.current.refresh();
    if (stop === "disable") await hook.rerender({ enabled: false });
    else await hook.unmount();
    expect(requests[0]!.signal?.aborted).toBe(true);
    await actRun(async () => {
      requests[0]!.resolve({ revision: 1, sessions: [] });
      await refresh;
    });
    expect(requests).toHaveLength(1);
    if (stop === "disable") {
      expect(hook.result.current.revision).toBe(0);
      await hook.unmount();
    }
  }
});

test("failed reads surface their error and a later refresh can recover", async () => {
  const { client, requests } = controlledClient();
  const hook = await renderHook(
    () => useBrowserSessions({ client, workspaceId: WORKSPACE_ID, pollIntervalMs: 60_000 }),
    undefined,
  );
  try {
    const error = new Error("Inventory unavailable");
    await actRun(async () => requests[0]!.reject(error));
    expect(hook.result.current.error).toBe(error);
    expect(hook.result.current.loading).toBe(false);
    let refreshed!: Promise<void>;
    await actRun(async () => {
      refreshed = hook.result.current.refresh();
    });
    await actRun(async () => {
      requests[1]!.resolve({ revision: 3, sessions: [] });
      await refreshed;
    });
    expect(hook.result.current.error).toBeNull();
    expect(hook.result.current.revision).toBe(3);
  } finally {
    await hook.unmount();
  }
});
