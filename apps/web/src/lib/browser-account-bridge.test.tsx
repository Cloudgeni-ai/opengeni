import { describe, expect, test } from "bun:test";

import { actRun, registerDom, renderHook } from "../../../../packages/react/test/render-hook";
import {
  browserAccountBridgeBlockersSnapshot,
  installBrowserAccountBridgeOperations,
  useBrowserAccountBridgeBlocker,
  useOptionalBrowserAccountBridge,
  type BrowserAccountBridgeBlockerInspector,
  type BrowserAccountBridgeOperations,
} from "./browser-account-bridge";

registerDom();

function operations(name: string): BrowserAccountBridgeOperations {
  return {
    resolveDeepLink: async () => ({ kind: "unavailable" }),
    selectSlot: async (slotId) => slotId === name,
  };
}

describe("browser account bridge", () => {
  test("publishes sorted blockers, refreshes inspectors, and unregisters on unmount", async () => {
    const inspectA: BrowserAccountBridgeBlockerInspector = () => ({ id: "a", label: "first" });
    const inspectB: BrowserAccountBridgeBlockerInspector = () => ({ id: "b", label: "second" });
    const hook = await renderHook(
      (props: { id: string; inspect: BrowserAccountBridgeBlockerInspector }) =>
        useBrowserAccountBridgeBlocker(props.id, props.inspect),
      { id: "b", inspect: inspectB },
    );
    const second = await renderHook(
      (props: { id: string; inspect: BrowserAccountBridgeBlockerInspector }) =>
        useBrowserAccountBridgeBlocker(props.id, props.inspect),
      { id: "a", inspect: inspectA },
    );

    expect(browserAccountBridgeBlockersSnapshot().map(({ id }) => id)).toEqual(["a", "b"]);
    expect(browserAccountBridgeBlockersSnapshot()[1]?.inspect()).toEqual({
      id: "b",
      label: "second",
    });

    const refreshed: BrowserAccountBridgeBlockerInspector = () => ({
      id: "b",
      label: "refreshed",
    });
    await hook.rerender({ id: "b", inspect: refreshed });
    expect(browserAccountBridgeBlockersSnapshot()[1]?.inspect()?.label).toBe("refreshed");

    await second.unmount();
    expect(browserAccountBridgeBlockersSnapshot().map(({ id }) => id)).toEqual(["b"]);
    await hook.unmount();
    expect(browserAccountBridgeBlockersSnapshot()).toEqual([]);
  });

  test("keeps the latest operation owner when an older runtime releases", async () => {
    const hook = await renderHook(useOptionalBrowserAccountBridge, undefined);
    const first = operations("first");
    const second = operations("second");

    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    await actRun(() => {
      releaseFirst = installBrowserAccountBridgeOperations(first);
    });
    expect(hook.result.current).toBe(first);

    await actRun(() => {
      releaseSecond = installBrowserAccountBridgeOperations(second);
      releaseFirst();
    });
    expect(hook.result.current).toBe(second);

    await actRun(() => releaseSecond());
    expect(hook.result.current).toBeNull();
    await hook.unmount();
  });
});
