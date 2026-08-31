import type { SessionEvent } from "@opengeni/contracts";

export type SessionEventLivePublishOutcome = "succeeded" | "failed" | "timed_out";

export type DetachedSessionEventFanoutOutcome = SessionEventLivePublishOutcome | "dropped";

export type DetachedSessionEventFanoutCloseReason =
  | "activity_completed"
  | "activity_failed"
  | "activity_cancelled"
  | "worker_shutdown";

export type SessionEventPublishObserver = {
  onPublish?: (info: { durationSeconds: number; count: number }) => void;
};

export type DetachedSessionEventFanoutReservation = {
  commit: (events: SessionEvent[]) => Promise<void>;
  cancel: () => void;
};

export type DetachedSessionEventFanout = {
  reserve: (
    mode: "detached" | "awaited",
    workspaceId: string,
    sessionId: string,
    observe?: SessionEventPublishObserver,
  ) => DetachedSessionEventFanoutReservation;
  enqueue: (workspaceId: string, sessionId: string, events: SessionEvent[]) => void;
  publishAwaited: (
    workspaceId: string,
    sessionId: string,
    events: SessionEvent[],
    observe?: SessionEventPublishObserver,
  ) => Promise<void>;
  drain: () => Promise<void>;
  close: (reason: DetachedSessionEventFanoutCloseReason) => Promise<void>;
};

export type DetachedSessionEventFanoutOptions = {
  timeoutMs?: number;
  closeTimeoutMs?: number;
  timeoutScheduler?: (callback: () => void, timeoutMs: number) => () => void;
  onPublishOutcome?: (input: {
    outcome: DetachedSessionEventFanoutOutcome;
    durationSeconds: number;
    count: number;
  }) => void;
};

export type SessionEventLivePublisher = {
  publish: (workspaceId: string, sessionId: string, events: SessionEvent[]) => Promise<void>;
  publishWithOutcome?: (
    workspaceId: string,
    sessionId: string,
    events: SessionEvent[],
  ) => Promise<SessionEventLivePublishOutcome>;
};

const DEFAULT_ACTIVITY_FANOUT_TIMEOUT_MS = 2_250;

function observePublish(
  observe: SessionEventPublishObserver | undefined,
  startedAt: number,
  count: number,
): void {
  try {
    observe?.onPublish?.({
      durationSeconds: Math.max(0, (performance.now() - startedAt) / 1_000),
      count,
    });
  } catch {
    // Metrics emission must never affect durable event handling.
  }
}

/**
 * Run one bounded best-effort live fanout lane owned by an agent activity.
 *
 * A caller reserves before its durable append. Ready work for one session is
 * ordered by the committed database sequence, so a faster higher append cannot
 * overtake a slower lower append. An unresolved reservation blocks only its own
 * session. Detached capacity is limited to one active plus the oldest pending
 * batch; awaited publications share the ordering domain but are never dropped
 * for detached overflow.
 *
 * Reservation and provider timeouts release only live-delivery ownership. The
 * durable append remains authoritative and consumers recover through replay.
 */
export function createDetachedSessionEventFanout(
  bus: SessionEventLivePublisher,
  options: DetachedSessionEventFanoutOptions = {},
): DetachedSessionEventFanout {
  const timeoutMs = Math.max(
    1,
    Math.floor(options.timeoutMs ?? DEFAULT_ACTIVITY_FANOUT_TIMEOUT_MS),
  );
  const closeTimeoutMs = Math.max(1, Math.floor(options.closeTimeoutMs ?? timeoutMs));
  const scheduleTimeout =
    options.timeoutScheduler ??
    ((callback: () => void, delayMs: number) => {
      const timer = setTimeout(callback, delayMs);
      return () => clearTimeout(timer);
    });

  type FanoutItem = {
    reservationOrder: number;
    reservedAt: number;
    mode: "detached" | "awaited";
    workspaceId: string;
    sessionId: string;
    events: SessionEvent[] | null;
    observe?: SessionEventPublishObserver;
    state: "reserved" | "ready" | "active" | "settled" | "dropped" | "cancelled";
    cancelReservationTimeout: (() => void) | null;
    dropOutcomeEmitted: boolean;
    resolveCompletion: () => void;
    completion: Promise<void>;
  };

  type ActiveFanout = {
    item: FanoutItem;
    done: Promise<void>;
    forceTimeout: () => void;
  };

  let accepting = true;
  let active: ActiveFanout | null = null;
  const reservations: FanoutItem[] = [];
  let nextReservationOrder = 0;
  let closePromise: Promise<void> | null = null;

  const emitOutcome = (
    outcome: DetachedSessionEventFanoutOutcome,
    startedAt: number,
    count: number,
  ): void => {
    try {
      options.onPublishOutcome?.({
        outcome,
        durationSeconds: Math.max(0, (performance.now() - startedAt) / 1_000),
        count,
      });
    } catch {
      // Detached telemetry must never affect durable event handling.
    }
  };

  const start = (item: FanoutItem): ActiveFanout => {
    const events = item.events;
    if (!events) {
      throw new Error("Session event fanout reservation has no committed events");
    }
    item.state = "active";
    const startedAt = performance.now();
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    let settled = false;
    let cancelTimeout: (() => void) | null = null;
    let operation!: ActiveFanout;

    const finish = (outcome: SessionEventLivePublishOutcome): void => {
      if (settled) return;
      settled = true;
      cancelTimeout?.();
      if (item.mode === "detached") {
        emitOutcome(outcome, startedAt, events.length);
      } else {
        observePublish(item.observe, startedAt, events.length);
      }
      if (active === operation) {
        active = null;
        item.state = "settled";
        item.resolveCompletion();
        pump();
      }
      resolveDone();
    };

    operation = {
      item,
      done,
      forceTimeout: () => finish("timed_out"),
    };
    active = operation;
    cancelTimeout = scheduleTimeout(operation.forceTimeout, timeoutMs);
    try {
      const providerPromise = bus.publishWithOutcome
        ? Promise.resolve(bus.publishWithOutcome(item.workspaceId, item.sessionId, events))
        : Promise.resolve(bus.publish(item.workspaceId, item.sessionId, events)).then(
            () => "succeeded" as const,
            () => "failed" as const,
          );
      // Attach both handlers immediately. A late rejection after timeout or
      // close is observed here and cannot become an unhandled rejection.
      void providerPromise.then(
        (outcome) => finish(outcome),
        () => finish("failed"),
      );
    } catch {
      finish("failed");
    }
    return operation;
  };

  const firstSequence = (item: FanoutItem): number =>
    item.events?.[0]?.sequence ?? Number.MAX_SAFE_INTEGER;

  const pump = (): void => {
    if (active || !accepting) return;
    for (let index = reservations.length - 1; index >= 0; index -= 1) {
      const state = reservations[index]?.state;
      if (state === "settled" || state === "cancelled" || state === "dropped") {
        reservations.splice(index, 1);
      }
    }
    if (reservations.length === 0) return;
    const ready = reservations.filter(
      (candidate) =>
        candidate.state === "ready" &&
        !reservations.some(
          (item) =>
            item.state === "reserved" &&
            item.workspaceId === candidate.workspaceId &&
            item.sessionId === candidate.sessionId,
        ),
    );
    ready.sort((left, right) => {
      if (left.workspaceId !== right.workspaceId || left.sessionId !== right.sessionId) {
        return left.reservationOrder - right.reservationOrder;
      }
      return (
        firstSequence(left) - firstSequence(right) || left.reservationOrder - right.reservationOrder
      );
    });
    const next = ready[0];
    if (!next) return;
    reservations.splice(reservations.indexOf(next), 1);
    start(next);
  };

  const reserve = (
    mode: "detached" | "awaited",
    workspaceId: string,
    sessionId: string,
    observe?: SessionEventPublishObserver,
  ): DetachedSessionEventFanoutReservation => {
    let resolveCompletion!: () => void;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    const liveDetachedReservations =
      (active?.item.mode === "detached" ? 1 : 0) +
      reservations.filter(
        (item) =>
          item.mode === "detached" &&
          item.state !== "settled" &&
          item.state !== "cancelled" &&
          item.state !== "dropped",
      ).length;
    const detachedCapacity =
      active?.item.mode === "detached"
        ? 2
        : active?.item.mode === "awaited" || reservations.some((item) => item.mode === "awaited")
          ? 1
          : 2;
    const dropped =
      !accepting || (mode === "detached" && liveDetachedReservations >= detachedCapacity);
    const item: FanoutItem = {
      reservationOrder: nextReservationOrder++,
      reservedAt: performance.now(),
      mode,
      workspaceId,
      sessionId,
      events: null,
      ...(observe ? { observe } : {}),
      state: dropped ? "dropped" : "reserved",
      cancelReservationTimeout: null,
      dropOutcomeEmitted: false,
      resolveCompletion,
      completion,
    };
    reservations.push(item);
    if (mode === "detached" && !dropped) {
      queueMicrotask(() => {
        if (item.state !== "reserved" || !accepting) return;
        item.cancelReservationTimeout = scheduleTimeout(() => {
          if (item.state !== "reserved") return;
          item.cancelReservationTimeout = null;
          item.state = "dropped";
          item.dropOutcomeEmitted = true;
          emitOutcome("timed_out", item.reservedAt, 0);
          item.resolveCompletion();
          pump();
        }, timeoutMs);
      });
    }

    return {
      async commit(events) {
        if (item.state === "cancelled" || item.state === "settled") return;
        item.cancelReservationTimeout?.();
        item.cancelReservationTimeout = null;
        item.events = events;
        if (item.state === "dropped") {
          if (item.mode === "detached" && events.length > 0 && !item.dropOutcomeEmitted) {
            item.dropOutcomeEmitted = true;
            emitOutcome("dropped", item.reservedAt, events.length);
          }
          item.resolveCompletion();
          pump();
          return;
        }
        if (events.length === 0 || !accepting) {
          item.state = item.mode === "detached" ? "dropped" : "cancelled";
          if (item.mode === "detached" && events.length > 0 && !item.dropOutcomeEmitted) {
            item.dropOutcomeEmitted = true;
            emitOutcome("dropped", item.reservedAt, events.length);
          }
          item.resolveCompletion();
          pump();
          return;
        }
        item.state = "ready";
        pump();
        if (item.mode === "awaited") {
          await item.completion;
        }
      },
      cancel() {
        if (item.state !== "reserved") return;
        item.cancelReservationTimeout?.();
        item.cancelReservationTimeout = null;
        item.state = "cancelled";
        item.resolveCompletion();
        pump();
      },
    };
  };

  const drain = async (): Promise<void> => {
    for (;;) {
      const current = active;
      if (!current) {
        pump();
        if (!active) {
          const pendingCompletion = reservations.find(
            (item) =>
              item.state !== "settled" && item.state !== "cancelled" && item.state !== "dropped",
          )?.completion;
          if (!pendingCompletion) return;
          await pendingCompletion;
        }
        continue;
      }
      await current.done;
    }
  };

  return {
    reserve,
    enqueue(workspaceId, sessionId, events) {
      if (events.length === 0) return;
      void reserve("detached", workspaceId, sessionId).commit(events);
    },
    async publishAwaited(workspaceId, sessionId, events, observe) {
      if (events.length === 0) return;
      await reserve("awaited", workspaceId, sessionId, observe).commit(events);
    },
    drain,
    async close(_reason) {
      if (closePromise) return await closePromise;
      accepting = false;
      for (const item of reservations.splice(0)) {
        if (item.state === "active" || item.state === "settled") continue;
        item.cancelReservationTimeout?.();
        item.cancelReservationTimeout = null;
        if (
          item.mode === "detached" &&
          item.events &&
          item.events.length > 0 &&
          !item.dropOutcomeEmitted
        ) {
          item.dropOutcomeEmitted = true;
          emitOutcome("dropped", item.reservedAt, item.events.length);
        }
        item.state = item.mode === "detached" ? "dropped" : "cancelled";
        item.resolveCompletion();
      }
      const current = active;
      if (!current) return;
      closePromise = (async () => {
        const cancelCloseTimeout = scheduleTimeout(current.forceTimeout, closeTimeoutMs);
        try {
          await current.done;
        } finally {
          cancelCloseTimeout();
          active = null;
        }
      })();
      return await closePromise;
    },
  };
}
