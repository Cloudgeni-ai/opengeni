import { describe, expect, test } from "bun:test";
import { useCallback } from "react";

import { useWindowedSections } from "../src/hooks/use-windowed-sections";
import { registerDom, renderHook } from "./render-hook";

registerDom();

describe("useWindowedSections", () => {
  test("re-seeds cached heights when a same-size diff is replaced", async () => {
    const hook = await renderHook(
      ({ estimates }: { estimates: number[] }) => {
        const estimateHeight = useCallback((index: number) => estimates[index] ?? 0, [estimates]);
        return useWindowedSections({
          count: estimates.length,
          estimateHeight,
        });
      },
      { estimates: [100, 200] },
    );

    expect(hook.result.current.offsets).toEqual([0, 100, 300]);

    await hook.rerender({ estimates: [400, 500] });

    expect(hook.result.current.offsets).toEqual([0, 400, 900]);
    await hook.unmount();
  });
});
