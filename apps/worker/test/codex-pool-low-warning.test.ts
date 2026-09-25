import { expect, test } from "bun:test";
import { createLogThrottle } from "@opengeni/observability";
import {
  CODEX_POOL_LOW_WARNING_INTERVAL_MS,
  warnCodexPoolLow,
} from "../src/activities/agent-turn/codex-capacity";

test("the low Codex pool warning is logged once per workspace depth per interval", () => {
  let now = 0;
  const throttle = createLogThrottle({
    intervalMs: CODEX_POOL_LOW_WARNING_INTERVAL_MS,
    now: () => now,
  });
  const warnings: Array<Record<string, unknown> | undefined> = [];
  const observability = {
    warn: (_message: string, attributes?: Record<string, unknown>) => warnings.push(attributes),
  };
  const observe = (workspaceKey: string, depth: "zero" | "one") =>
    warnCodexPoolLow(
      observability as never,
      {
        workspaceKey,
        workspaceId: `workspace-${workspaceKey}`,
        eligibleCount: depth === "zero" ? 0 : 1,
        connectedCount: 2,
        depth,
      },
      throttle,
    );

  // Every turn of a busy workspace observes the same low pool.
  for (let turn = 0; turn < 30; turn += 1) {
    observe("a", "one");
    now += 10_000;
  }
  // A depth change and another workspace are first occurrences.
  observe("a", "zero");
  observe("b", "one");
  now = CODEX_POOL_LOW_WARNING_INTERVAL_MS;
  observe("a", "one");

  expect(warnings).toEqual([
    { workspaceId: "workspace-a", eligibleCount: 1, connectedCount: 2, depth: "one" },
    { workspaceId: "workspace-a", eligibleCount: 0, connectedCount: 2, depth: "zero" },
    { workspaceId: "workspace-b", eligibleCount: 1, connectedCount: 2, depth: "one" },
    {
      workspaceId: "workspace-a",
      eligibleCount: 1,
      connectedCount: 2,
      depth: "one",
      suppressedCount: 29,
    },
  ]);
});
