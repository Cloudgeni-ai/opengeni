import { hasPendingSteerForTurn, type Database } from "@opengeni/db";
import type { EventBus } from "@opengeni/events";
import { ModelPreemption } from "@opengeni/runtime";

/** Session events after which a Steer may be waiting for the running turn. */
const STEER_EVENT_TYPES = new Set([
  "session.control.steer_requested",
  "session.queue.changed",
  "system.update.pending",
]);
/** Safety recheck in case a live event is lost; the bus normally wakes the watch. */
const SAFETY_RECHECK_MS = 10_000;
/** Recheck cadence while live session events are unavailable. */
const FALLBACK_RECHECK_MS = 2_000;

export type SteerWatch = {
  /**
   * Aborts with {@link ModelPreemption} once a Steer waits for this turn. The
   * model request in flight ends early and keeps what had completed.
   */
  signal(): AbortSignal;
  /** Recheck now, for example after the turn resumed from a withdrawn Steer. */
  recheck(): Promise<void>;
  /** Start watching again after a Steer was withdrawn before its handover. */
  rearm(): void;
  close(): void;
};

/**
 * Notice a Steer for the running turn within moments, not at the next model
 * step. The session's live events wake the watch; the durable queue decides.
 * When one is waiting, the in-flight model request is cut short and every
 * foreground wait returns early (`onPending(true)`), so the turn reaches its
 * next model-step boundary, where the existing admission check hands over.
 */
export async function startSteerWatch(input: {
  db: Database;
  bus: EventBus | null | undefined;
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  onPending: (pending: boolean) => void;
  onError?: (error: unknown) => void;
}): Promise<SteerWatch> {
  let controller = new AbortController();
  let closed = false;
  let checking: Promise<void> | null = null;
  let again = false;
  let liveEvents = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const check = async (): Promise<void> => {
    if (closed || controller.signal.aborted) return;
    if (checking) {
      // Coalesce: one more read after the one in flight covers every event.
      again = true;
      return await checking;
    }
    checking = (async () => {
      for (;;) {
        again = false;
        try {
          const pending = await hasPendingSteerForTurn(input.db, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            turnId: input.turnId,
          });
          if (pending && !closed && !controller.signal.aborted) {
            input.onPending(true);
            controller.abort(new ModelPreemption());
          }
        } catch (error) {
          // A failed read only delays the Steer until the next wake or the
          // next model step, which checks again on its own.
          input.onError?.(error);
        }
        // `again` and `closed` change while the read is in flight.
        if (!again || closed || controller.signal.aborted) break;
      }
    })().finally(() => {
      checking = null;
    });
    return await checking;
  };

  const schedule = () => {
    if (closed) return;
    clearTimeout(timer);
    timer = setTimeout(
      () => {
        void check().finally(schedule);
      },
      liveEvents ? SAFETY_RECHECK_MS : FALLBACK_RECHECK_MS,
    );
    timer.unref?.();
  };

  let unsubscribe: (() => void) | undefined;
  if (input.bus) {
    try {
      unsubscribe = await input.bus.subscribe(
        input.workspaceId,
        input.sessionId,
        (events) => {
          if (events.some((event) => STEER_EVENT_TYPES.has(event.type))) void check();
        },
        {
          onTerminated: () => {
            liveEvents = false;
            schedule();
          },
        },
      );
      liveEvents = true;
    } catch (error) {
      input.onError?.(error);
    }
  }
  schedule();

  return {
    signal: () => controller.signal,
    recheck: check,
    rearm: () => {
      if (closed || !controller.signal.aborted) return;
      controller = new AbortController();
      input.onPending(false);
      schedule();
    },
    close: () => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      unsubscribe?.();
      input.onPending(false);
    },
  };
}
