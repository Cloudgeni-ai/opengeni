import { expect, mock, test } from "bun:test";
import type { Settings } from "@opengeni/config";
import type { Database } from "@opengeni/db";
import type { EventBus } from "@opengeni/events";
import {
  notifyParentOfChildTerminal,
  reconcilePendingParentSystemUpdates,
  reconcilePendingSessionWorkflowWakes,
  type NotifyServices,
} from "../src/activities/parent-wake";

test("disabled child-completion wakes return before every parent side effect", async () => {
  const info = mock(() => undefined);
  const error = mock(() => undefined);
  const publish = mock(async () => undefined);
  const wakeSessionWorkflow = mock(async () => undefined);
  const db = new Proxy(
    {},
    {
      get() {
        throw new Error("disabled parent wake touched the database");
      },
    },
  ) as Database;

  await notifyParentOfChildTerminal(
    {
      db,
      bus: { publish } as unknown as EventBus,
      settings: { childCompletionParentWakeEnabled: false } as Settings,
      observability: { info, error } as unknown as NotifyServices["observability"],
      wakeSessionWorkflow,
    },
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    "idle",
  );

  expect(publish).not.toHaveBeenCalled();
  expect(wakeSessionWorkflow).not.toHaveBeenCalled();
  expect(info).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
});

test("workflow-wake repair is independent of disabled child-completion delivery", async () => {
  const wakeSessionWorkflow = mock(async () => undefined);
  const claimPendingSessionWorkflowWakes = mock(async () => [
    {
      accountId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      sessionId: "33333333-3333-4333-8333-333333333333",
      temporalWorkflowId: "session-33333333-3333-4333-8333-333333333333",
      wakeRevision: 7,
      controlEventId: null,
    },
  ]);
  const db = {} as Database;

  const result = await reconcilePendingSessionWorkflowWakes(
    {
      db,
      bus: { publish: async () => undefined } as unknown as EventBus,
      settings: { childCompletionParentWakeEnabled: false } as Settings,
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

test("disabled child-completion delivery never claims its own outbox", async () => {
  const claimPendingSessionSystemUpdateOutbox = mock(async () => {
    throw new Error("disabled reaper claimed a child-completion outbox");
  });
  const result = await reconcilePendingParentSystemUpdates(
    {
      db: {} as Database,
      bus: { publish: async () => undefined } as unknown as EventBus,
      settings: { childCompletionParentWakeEnabled: false } as Settings,
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
  expect(claimPendingSessionSystemUpdateOutbox).not.toHaveBeenCalled();
});
