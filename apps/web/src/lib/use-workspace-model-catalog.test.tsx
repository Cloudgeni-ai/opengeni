import { afterEach, describe, expect, mock, test } from "bun:test";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";

import { actRun, registerDom, renderHook } from "../../../../packages/react/test/render-hook";
import { notifyCreditBalanceChanged } from "./credit-balance-events";

const context: { client: OpenGeniBrowserClient } = { client: {} as OpenGeniBrowserClient };

mock.module("@/context", () => ({ useAppContext: () => context }));

const { useWorkspaceModelCatalog } = await import("./use-workspace-model-catalog");

registerDom();
afterEach(() => document.body.replaceChildren());

describe("useWorkspaceModelCatalog", () => {
  test("settled usage and returning to the app refresh funding without reopening the picker", async () => {
    const getWorkspaceModelCatalog = mock(async () => ({ models: [] }));
    context.client = { getWorkspaceModelCatalog } as unknown as OpenGeniBrowserClient;
    const hook = await renderHook(
      ({ revision }: { revision: number }) => useWorkspaceModelCatalog("workspace-a", revision),
      { revision: 0 },
    );
    expect(getWorkspaceModelCatalog).toHaveBeenCalledTimes(1);
    await hook.rerender({ revision: 1 });
    expect(getWorkspaceModelCatalog).toHaveBeenCalledTimes(2);
    expect(hook.result.current.loading).toBe(false);
    await actRun(() => window.dispatchEvent(new Event("focus")));
    expect(getWorkspaceModelCatalog).toHaveBeenCalledTimes(3);
    await hook.unmount();
    await actRun(() => window.dispatchEvent(new Event("focus")));
    expect(getWorkspaceModelCatalog).toHaveBeenCalledTimes(3);
  });
  test("confirmed credits refresh funding for an already mounted composer", async () => {
    const getWorkspaceModelCatalog = mock(async () => ({ models: [] }));
    context.client = { getWorkspaceModelCatalog } as unknown as OpenGeniBrowserClient;
    const hook = await renderHook(() => useWorkspaceModelCatalog("workspace-a"), {});
    expect(getWorkspaceModelCatalog).toHaveBeenCalledTimes(1);
    await actRun(() => notifyCreditBalanceChanged("account-a"));
    expect(getWorkspaceModelCatalog).toHaveBeenCalledTimes(2);
    expect(hook.result.current.loading).toBe(false);
    await hook.unmount();
    await actRun(() => notifyCreditBalanceChanged("account-a"));
    expect(getWorkspaceModelCatalog).toHaveBeenCalledTimes(2);
  });
  test("a background funding refresh preserves the mounted picker until new data arrives", async () => {
    const first = {
      models: [],
      defaultSelection: { model: "covered", reasoningEffort: "low", source: "credits" },
    };
    let finish!: (value: typeof first) => void;
    let calls = 0;
    context.client = {
      getWorkspaceModelCatalog: mock(() =>
        ++calls === 1
          ? Promise.resolve(first)
          : new Promise<typeof first>((resolve) => {
              finish = resolve;
            }),
      ),
    } as unknown as OpenGeniBrowserClient;
    const hook = await renderHook(
      ({ workspaceId }: { workspaceId: string }) => useWorkspaceModelCatalog(workspaceId),
      { workspaceId: "workspace-a" },
    );
    expect(hook.result.current.loading).toBe(false);
    await actRun(() => {
      void hook.result.current.refresh();
    });
    expect(hook.result.current.loading).toBe(false);
    expect(hook.result.current.defaultSelection?.model).toBe("covered");
    await actRun(() =>
      finish({ ...first, defaultSelection: { ...first.defaultSelection, model: "newly-covered" } }),
    );
    expect(hook.result.current.defaultSelection?.model).toBe("newly-covered");
    await hook.unmount();
  });
  test("unmount aborts a refresh that replaced the initial request", async () => {
    const signals: AbortSignal[] = [];
    context.client = {
      getWorkspaceModelCatalog: mock(
        async (_workspaceId: string, options?: { signal?: AbortSignal }) => {
          if (options?.signal) signals.push(options.signal);
          return await new Promise<never>(() => undefined);
        },
      ),
    } as unknown as OpenGeniBrowserClient;

    const hook = await renderHook(
      ({ workspaceId }: { workspaceId: string }) => useWorkspaceModelCatalog(workspaceId),
      { workspaceId: "workspace-a" },
    );

    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);

    await actRun(() => {
      void hook.result.current.refresh();
    });

    expect(signals).toHaveLength(2);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);

    await hook.unmount();
    expect(signals[1]?.aborted).toBe(true);
  });
});
