import { expect, mock, test } from "bun:test";
import type { Settings } from "@opengeni/config";
import type { Database } from "@opengeni/db";
import type { EventBus } from "@opengeni/events";
import {
  reconcilePendingParentSystemUpdates,
  reconcilePendingSessionWorkflowWakes,
  type NotifyServices,
} from "../src/activities/parent-wake";

test("workflow-wake repair delivers an outstanding session receipt", async () => {
  const wakeSessionWorkflow = mock(async () => undefined);
  const claimPendingSessionWorkflowWakes = mock(async () => [
    {
      accountId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      sessionId: "33333333-3333-4333-8333-333333333333",
      temporalWorkflowId: "session-33333333-3333-4333-8333-333333333333",
      wakeRevision: 7,
      interruptionRequested: false,
    },
  ]);
  const db = {} as Database;

  const result = await reconcilePendingSessionWorkflowWakes(
    {
      db,
      bus: { publish: async () => undefined } as unknown as EventBus,
      settings: {} as Settings,
      observability: {
        info: () => undefined,
        error: () => undefined,
      } as unknown as NotifyServices["observability"],
      wakeSessionWorkflow,
    },
    17,
    { claimPendingSessionWorkflowWakes },
  );

  expect(result).toEqual({ claimed: 1, delivered: 1, failed: 0 });
  expect(claimPendingSessionWorkflowWakes).toHaveBeenCalledWith(db, 17);
  expect(wakeSessionWorkflow).toHaveBeenCalledWith({
    accountId: "11111111-1111-4111-8111-111111111111",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    sessionId: "33333333-3333-4333-8333-333333333333",
    workflowId: "session-33333333-3333-4333-8333-333333333333",
    wakeRevision: 7,
  });
});

test("child-terminal reconciliation always checks its durable outbox", async () => {
  const claimPendingSessionSystemUpdateOutbox = mock(async () => []);
  const result = await reconcilePendingParentSystemUpdates(
    {
      db: {} as Database,
      bus: { publish: async () => undefined } as unknown as EventBus,
      settings: {} as Settings,
      observability: {
        info: () => undefined,
        error: () => undefined,
      } as unknown as NotifyServices["observability"],
      wakeSessionWorkflow: null,
    },
    17,
    { claimPendingSessionSystemUpdateOutbox },
  );
  expect(result).toEqual({ claimed: 0, delivered: 0, failed: 0 });
  expect(claimPendingSessionSystemUpdateOutbox).toHaveBeenCalledWith({} as Database, 17);
});
