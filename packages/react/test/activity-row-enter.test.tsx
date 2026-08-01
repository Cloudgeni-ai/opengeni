import { describe, expect, test } from "bun:test";
import { ActivityRail } from "../src/timeline/activity-rail";
import { EntranceAnimationProvider } from "../src/timeline/entrance";
import { SeenActivityIdsProvider } from "../src/timeline/seen-activity-ids";
import type { ActivityItem } from "../src/timeline/types";
import { actRun, flush, registerDom, renderComponent } from "./render-hook";

registerDom();

function tool(id: string, status: "running" | "complete" = "running"): ActivityItem {
  return {
    kind: "tool-call",
    id,
    turnId: "turn-1",
    callId: `call-${id}`,
    name: "exec_command",
    status,
    occurredAt: "2026-01-01T00:00:00.000Z",
    arguments: { command: `echo ${id}` },
    output: undefined,
    raw: undefined,
  };
}

describe("ActivityRail row enter", () => {
  test("with seen-id map, first live tool fades in (not a hard pop)", async () => {
    const seen = new Set<string>();
    const r = await renderComponent(
      <SeenActivityIdsProvider value={seen}>
        <EntranceAnimationProvider value={true}>
          <ActivityRail items={[tool("t1")]} bare />
        </EntranceAnimationProvider>
      </SeenActivityIdsProvider>,
    );
    expect(r.container.querySelector(".animate-og-row-enter")).not.toBeNull();
    expect(seen.has("t1")).toBe(true);
    await r.unmount();
  });

  test("remount of a known tool does not re-fade", async () => {
    const seen = new Set<string>(["t1"]);
    const r = await renderComponent(
      <SeenActivityIdsProvider value={seen}>
        <EntranceAnimationProvider value={true}>
          <ActivityRail items={[tool("t1", "complete")]} bare />
        </EntranceAnimationProvider>
      </SeenActivityIdsProvider>,
    );
    expect(r.container.querySelector(".animate-og-row-enter")).toBeNull();
    await r.unmount();
  });

  test("append after bulk gate clears still fades the new tool", async () => {
    const seen = new Set<string>();
    const shell = (enter: boolean, items: ActivityItem[]) => (
      <SeenActivityIdsProvider value={seen}>
        <EntranceAnimationProvider value={enter}>
          <ActivityRail items={items} bare />
        </EntranceAnimationProvider>
      </SeenActivityIdsProvider>
    );
    const r = await renderComponent(shell(false, [tool("t1")]));
    expect(r.container.querySelector(".animate-og-row-enter")).toBeNull();
    expect(seen.has("t1")).toBe(true);

    await actRun(() => undefined);
    await r.rerender(shell(true, [tool("t1"), tool("t2")]));
    await flush();
    const entering = Array.from(r.container.querySelectorAll(".animate-og-row-enter"));
    expect(entering).toHaveLength(1);
    expect(entering[0]?.getAttribute("data-og-timeline-row-anchor")).not.toBeNull();
    await r.unmount();
  });
});
