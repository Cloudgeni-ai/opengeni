import { expect, mock, test } from "bun:test";
import type { Settings } from "@opengeni/config";
import type { Database } from "@opengeni/db";
import { SESSION_EVENT_DURABLE_FANOUT_CAPABILITY_VERSION, type EventBus } from "@opengeni/events";
import {
  deliverChildRequiresActionToParent,
  reconcileAutomaticSessionTitleFanout,
  reconcilePendingParentSystemUpdates,
  reconcilePendingSessionWorkflowWakes,
  type NotifyServices,
} from "../src/activities/parent-wake";

const titleFanoutDelivery = {
  outboxId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  event: {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    sessionId: "33333333-3333-4333-8333-333333333333",
    sequence: 7,
    type: "session.title_set" as const,
    payload: { title: "New conversation", source: "agent" },
    occurredAt: "2026-08-25T00:00:00.000Z",
    clientEventId: null,
    turnId: null,
    turnGeneration: null,
    turnAttemptId: null,
    turnAssociation: null,
    duplicateOfEventId: null,
    duplicateReason: null,
  },
};

function durableFanoutBus(methods: Record<string, unknown>): EventBus {
  return {
    sessionEventDurableFanout: {
      version: SESSION_EVENT_DURABLE_FANOUT_CAPABILITY_VERSION,
      subscribeRecovery: () => () => {},
    },
    ...methods,
  } as unknown as EventBus;
}

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

test("automatic-title migration fanout publishes and acknowledges the durable event", async () => {
  const publish = mock(async () => undefined);
  const publishConfirmed = mock(async () => undefined);
  const claimAutomaticSessionTitleFanout = mock(async () => [titleFanoutDelivery]);
  const markAutomaticSessionTitleFanoutDelivered = mock(async () => true);
  const markAutomaticSessionTitleFanoutFailed = mock(async () => true);
  const db = {} as Database;

  const result = await reconcileAutomaticSessionTitleFanout(
    {
      db,
      bus: durableFanoutBus({ publish, publishConfirmed, isConnected: () => true }),
      settings: {} as Settings,
      observability: {} as NotifyServices["observability"],
      wakeSessionWorkflow: null,
    },
    17,
    {
      claimAutomaticSessionTitleFanout,
      markAutomaticSessionTitleFanoutDelivered,
      markAutomaticSessionTitleFanoutFailed,
    },
  );

  expect(result).toEqual({ claimed: 1, delivered: 1, failed: 0 });
  expect(claimAutomaticSessionTitleFanout).toHaveBeenCalledWith(db, 17);
  expect(publishConfirmed).toHaveBeenCalledWith(
    titleFanoutDelivery.event.workspaceId,
    titleFanoutDelivery.event.sessionId,
    [titleFanoutDelivery.event],
  );
  expect(publish).not.toHaveBeenCalled();
  expect(markAutomaticSessionTitleFanoutDelivered).toHaveBeenCalledWith(db, titleFanoutDelivery);
  expect(markAutomaticSessionTitleFanoutFailed).not.toHaveBeenCalled();
});

test("automatic-title migration fanout refuses a legacy publish-only bus before claiming", async () => {
  const claimAutomaticSessionTitleFanout = mock(async () => [titleFanoutDelivery]);

  await expect(
    reconcileAutomaticSessionTitleFanout(
      {
        db: {} as Database,
        bus: { publish: async () => undefined } as unknown as EventBus,
        settings: {} as Settings,
        observability: {} as NotifyServices["observability"],
        wakeSessionWorkflow: null,
      },
      17,
      { claimAutomaticSessionTitleFanout },
    ),
  ).rejects.toThrow("sessionEventDurableFanout v1");
  expect(claimAutomaticSessionTitleFanout).not.toHaveBeenCalled();
});

test("automatic-title migration fanout drains through a recovery-capable embedding bus without confirmed publish", async () => {
  let acceptDelivery: (() => void) | undefined;
  let notePublishStarted: (() => void) | undefined;
  const accepted = new Promise<void>((resolve) => {
    acceptDelivery = resolve;
  });
  const publishStarted = new Promise<void>((resolve) => {
    notePublishStarted = resolve;
  });
  const publish = mock(async () => {
    notePublishStarted!();
    await accepted;
  });
  const claimAutomaticSessionTitleFanout = mock(async () => [titleFanoutDelivery]);
  const markAutomaticSessionTitleFanoutDelivered = mock(async () => true);
  const markAutomaticSessionTitleFanoutFailed = mock(async () => true);
  const db = {} as Database;

  const reconciliation = reconcileAutomaticSessionTitleFanout(
    {
      db,
      // Embedding implementations may omit the stronger publishConfirmed and
      // isConnected capabilities, but the paired subscriber-recovery contract
      // is mandatory before a durable row can be acknowledged.
      bus: durableFanoutBus({ publish }),
      settings: {} as Settings,
      observability: {} as NotifyServices["observability"],
      wakeSessionWorkflow: null,
    },
    17,
    {
      claimAutomaticSessionTitleFanout,
      markAutomaticSessionTitleFanoutDelivered,
      markAutomaticSessionTitleFanoutFailed,
    },
  );

  await publishStarted;
  expect(publish).toHaveBeenCalledWith(
    titleFanoutDelivery.event.workspaceId,
    titleFanoutDelivery.event.sessionId,
    [titleFanoutDelivery.event],
  );
  expect(markAutomaticSessionTitleFanoutDelivered).not.toHaveBeenCalled();

  acceptDelivery!();
  expect(await reconciliation).toEqual({ claimed: 1, delivered: 1, failed: 0 });
  expect(markAutomaticSessionTitleFanoutDelivered).toHaveBeenCalledWith(db, titleFanoutDelivery);
  expect(markAutomaticSessionTitleFanoutFailed).not.toHaveBeenCalled();
});

test("automatic-title migration fanout retries a real embedding-bus failure", async () => {
  let publishAttempts = 0;
  const publish = mock(async () => {
    publishAttempts += 1;
    if (publishAttempts === 1) {
      throw new Error("embedded broker unavailable");
    }
  });
  const claimAutomaticSessionTitleFanout = mock(async () => [titleFanoutDelivery]);
  const markAutomaticSessionTitleFanoutDelivered = mock(async () => true);
  const markAutomaticSessionTitleFanoutFailed = mock(async () => true);
  const db = {} as Database;
  const services = {
    db,
    bus: durableFanoutBus({ publish }),
    settings: {} as Settings,
    observability: {} as NotifyServices["observability"],
    wakeSessionWorkflow: null,
  };
  const overrides = {
    claimAutomaticSessionTitleFanout,
    markAutomaticSessionTitleFanoutDelivered,
    markAutomaticSessionTitleFanoutFailed,
  };

  expect(await reconcileAutomaticSessionTitleFanout(services, 17, overrides)).toEqual({
    claimed: 1,
    delivered: 0,
    failed: 1,
  });
  expect(markAutomaticSessionTitleFanoutDelivered).not.toHaveBeenCalled();
  expect(markAutomaticSessionTitleFanoutFailed).toHaveBeenCalledWith(
    db,
    titleFanoutDelivery,
    "embedded broker unavailable",
  );

  expect(await reconcileAutomaticSessionTitleFanout(services, 17, overrides)).toEqual({
    claimed: 1,
    delivered: 1,
    failed: 0,
  });
  expect(publish).toHaveBeenCalledTimes(2);
  expect(markAutomaticSessionTitleFanoutDelivered).toHaveBeenCalledWith(db, titleFanoutDelivery);
});

test("automatic-title migration fanout leaves a disconnected delivery retryable", async () => {
  const publishConfirmed = mock(async () => undefined);
  const claimAutomaticSessionTitleFanout = mock(async () => [titleFanoutDelivery]);
  const markAutomaticSessionTitleFanoutDelivered = mock(async () => true);
  const markAutomaticSessionTitleFanoutFailed = mock(async () => true);
  const db = {} as Database;

  const result = await reconcileAutomaticSessionTitleFanout(
    {
      db,
      bus: durableFanoutBus({ publishConfirmed, isConnected: () => false }),
      settings: {} as Settings,
      observability: {} as NotifyServices["observability"],
      wakeSessionWorkflow: null,
    },
    17,
    {
      claimAutomaticSessionTitleFanout,
      markAutomaticSessionTitleFanoutDelivered,
      markAutomaticSessionTitleFanoutFailed,
    },
  );

  expect(result).toEqual({ claimed: 1, delivered: 0, failed: 1 });
  expect(publishConfirmed).not.toHaveBeenCalled();
  expect(markAutomaticSessionTitleFanoutDelivered).not.toHaveBeenCalled();
  expect(markAutomaticSessionTitleFanoutFailed).toHaveBeenCalledWith(
    db,
    titleFanoutDelivery,
    "session event bus is disconnected",
  );
});

test("automatic-title migration fanout retries when publish confirmation fails", async () => {
  const publishConfirmed = mock(async () => {
    throw new Error("NATS publish confirmation failed");
  });
  const claimAutomaticSessionTitleFanout = mock(async () => [titleFanoutDelivery]);
  const markAutomaticSessionTitleFanoutDelivered = mock(async () => true);
  const markAutomaticSessionTitleFanoutFailed = mock(async () => true);
  const db = {} as Database;

  const result = await reconcileAutomaticSessionTitleFanout(
    {
      db,
      bus: durableFanoutBus({ publishConfirmed, isConnected: () => true }),
      settings: {} as Settings,
      observability: {} as NotifyServices["observability"],
      wakeSessionWorkflow: null,
    },
    17,
    {
      claimAutomaticSessionTitleFanout,
      markAutomaticSessionTitleFanoutDelivered,
      markAutomaticSessionTitleFanoutFailed,
    },
  );

  expect(result).toEqual({ claimed: 1, delivered: 0, failed: 1 });
  expect(markAutomaticSessionTitleFanoutDelivered).not.toHaveBeenCalled();
  expect(markAutomaticSessionTitleFanoutFailed).toHaveBeenCalledWith(
    db,
    titleFanoutDelivery,
    "NATS publish confirmation failed",
  );
});

test("automatic-title migration fanout bounds concurrent broker confirmations", async () => {
  const deliveries = Array.from({ length: 25 }, (_, index) => ({
    ...titleFanoutDelivery,
    outboxId: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}`,
    event: {
      ...titleFanoutDelivery.event,
      id: `bbbbbbbb-bbbb-4bbb-8bbb-${String(index).padStart(12, "0")}`,
      sequence: index + 1,
    },
  }));
  let active = 0;
  let maxActive = 0;
  const publishConfirmed = mock(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
    active -= 1;
  });
  const claimAutomaticSessionTitleFanout = mock(async () => deliveries);
  const markAutomaticSessionTitleFanoutDelivered = mock(async () => true);
  const markAutomaticSessionTitleFanoutFailed = mock(async () => true);

  const result = await reconcileAutomaticSessionTitleFanout(
    {
      db: {} as Database,
      bus: durableFanoutBus({ publishConfirmed, isConnected: () => true }),
      settings: {} as Settings,
      observability: {} as NotifyServices["observability"],
      wakeSessionWorkflow: null,
    },
    deliveries.length,
    {
      claimAutomaticSessionTitleFanout,
      markAutomaticSessionTitleFanoutDelivered,
      markAutomaticSessionTitleFanoutFailed,
    },
  );

  expect(result).toEqual({ claimed: 25, delivered: 25, failed: 0 });
  expect(maxActive).toBeGreaterThan(1);
  expect(maxActive).toBeLessThanOrEqual(20);
  expect(markAutomaticSessionTitleFanoutFailed).not.toHaveBeenCalled();
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

test("child requires_action delivery is inert while the rollout flag is off", async () => {
  const error = mock(() => undefined);
  // No database access may happen: a thrown `db` call would surface as an
  // observability error, which the disabled path never reaches.
  const db = new Proxy(
    {},
    {
      get() {
        throw new Error("database must not be touched while notices are disabled");
      },
    },
  ) as Database;
  await deliverChildRequiresActionToParent(
    {
      db,
      bus: { publish: async () => undefined } as unknown as EventBus,
      settings: { childLifecycleNoticesEnabled: false } as Settings,
      observability: {
        info: () => undefined,
        error,
      } as unknown as NotifyServices["observability"],
      wakeSessionWorkflow: null,
    },
    "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333",
    { turnId: "44444444-4444-4444-8444-444444444444", turnGeneration: 1 },
  );
  expect(error).not.toHaveBeenCalled();
});
