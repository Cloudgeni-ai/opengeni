import { afterEach, describe, expect, mock, test } from "bun:test";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";

import { actRun, registerDom, renderHook } from "../../../../packages/react/test/render-hook";

const context: { client: OpenGeniBrowserClient } = { client: {} as OpenGeniBrowserClient };

mock.module("@/context", () => ({ useAppContext: () => context }));

const { useWorkspaceModelCatalog } = await import("./use-workspace-model-catalog");

registerDom();
afterEach(() => document.body.replaceChildren());

describe("useWorkspaceModelCatalog", () => {
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
