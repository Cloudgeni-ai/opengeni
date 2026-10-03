import { describe, expect, test } from "bun:test";

import {
  startWorkspaceWebhookDispatchPump,
  WORKSPACE_WEBHOOK_DISPATCH_BATCH_SIZE,
  type WorkspaceWebhookBatchResult,
  type WorkspaceWebhookDispatchDeps,
} from "../src/workspace-webhook-dispatch";

const deps = {} as WorkspaceWebhookDispatchDeps;

function batch(claimed: number): WorkspaceWebhookBatchResult {
  return { claimed, delivered: claimed, failed: 0 };
}

describe("workspace webhook dispatch pump", () => {
  test("drains a backlog back to back instead of one batch per interval", async () => {
    const results = [
      batch(WORKSPACE_WEBHOOK_DISPATCH_BATCH_SIZE),
      batch(WORKSPACE_WEBHOOK_DISPATCH_BATCH_SIZE),
      batch(5),
    ];
    let drains = 0;
    const stop = startWorkspaceWebhookDispatchPump(deps, {
      intervalMs: 60_000,
      drain: async () => results[drains++] ?? batch(0),
    });
    await Bun.sleep(50);
    await stop();
    expect(drains).toBe(3);
  });

  test("waits for the interval after a partial batch", async () => {
    let drains = 0;
    const stop = startWorkspaceWebhookDispatchPump(deps, {
      intervalMs: 60_000,
      drain: async () => {
        drains += 1;
        return batch(1);
      },
    });
    await Bun.sleep(50);
    await stop();
    expect(drains).toBe(1);
  });

  test("stops draining a backlog once stopped", async () => {
    let drains = 0;
    let stop!: () => Promise<void>;
    stop = startWorkspaceWebhookDispatchPump(deps, {
      intervalMs: 60_000,
      drain: async () => {
        drains += 1;
        if (drains === 2) void stop();
        return batch(WORKSPACE_WEBHOOK_DISPATCH_BATCH_SIZE);
      },
    });
    await Bun.sleep(50);
    await stop();
    expect(drains).toBe(2);
  });
});
