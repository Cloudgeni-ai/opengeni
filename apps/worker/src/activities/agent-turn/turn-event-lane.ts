/**
 * Orders one attempt's event appends without making startup wait on progress
 * receipts.
 *
 * Startup writes several progress receipts ("preparing tools", "tools ready",
 * "preparing the model request") that nothing reads back before the first
 * model request. Each is a full fenced append, so awaiting them one by one put
 * a database round trip per receipt on the path to the first request. A
 * background receipt starts at once, after every append already issued; every
 * awaited append and the settlement start only after the background receipts
 * issued before them. The event log therefore keeps the order the work
 * produced it in, and the model-request audit still commits after every
 * receipt that precedes it.
 *
 * Awaited appends keep their existing concurrency with each other; only the
 * background receipts are ordered against them.
 *
 * A background receipt's failure does not fail the turn, like the existing
 * sandbox startup receipts: a fenced attempt is still refused by its next
 * awaited append (the model-request audit at the latest), because fencing is
 * durable and every append checks it.
 */
import type { TurnBackgroundEventPublisher, TurnEventPublisher } from "./model-usage";

export type TurnEventLane = {
  /** Runs an awaited append after the background receipts issued before it. */
  run<T>(work: () => Promise<T>): Promise<T>;
  /** Starts a receipt after every append issued so far; nothing waits on it. */
  runInBackground(work: () => Promise<unknown>): void;
  /** Settles once every background receipt issued so far has finished, never
   * rejecting. Awaited appends are their callers' to wait for. */
  backgroundSettled(): Promise<void>;
};

export function createTurnEventLane(): TurnEventLane {
  // Last background receipt; awaited appends start after it.
  let background: Promise<void> = Promise.resolve();
  // Awaited appends in flight; the next background receipt starts after them.
  const inFlight = new Set<Promise<void>>();
  const quiet = (promise: Promise<unknown>): Promise<void> =>
    promise.then(
      () => undefined,
      () => undefined,
    );
  return {
    run<T>(work: () => Promise<T>): Promise<T> {
      const result = background.then(work);
      const settled = quiet(result);
      inFlight.add(settled);
      void settled.then(() => inFlight.delete(settled));
      return result;
    },
    runInBackground(work: () => Promise<unknown>): void {
      const before = Promise.all([background, ...inFlight]);
      background = quiet(before.then(work));
    },
    async backgroundSettled(): Promise<void> {
      // A receipt issued while waiting is included by waiting again.
      for (let last = background; ; last = background) {
        await last;
        if (last === background) return;
      }
    },
  };
}

/** Share the next checkpoint's transaction with observations still queued behind
 * an earlier append. No timer or extra delay: an idle lane starts immediately. */
export function createTurnEventPublisher(append: TurnEventPublisher): {
  publish: TurnEventPublisher;
  publishInBackground: TurnBackgroundEventPublisher;
  backgroundSettled: () => Promise<void>;
  run: TurnEventLane["run"];
} {
  const lane = createTurnEventLane();
  type Batch = { events: Parameters<TurnEventPublisher>[0] };
  let pending: Batch | null = null;
  return {
    run: (work) => {
      pending = null;
      return lane.run(work);
    },
    publish(events, immediate, mutate, project) {
      const preceding = pending?.events.splice(0) ?? [];
      pending = null;
      const result = lane.run(() => append([...preceding, ...events], immediate, mutate, project));
      // Moving a receipt into this commit must not remove its ordering barrier.
      // Later appends and the background drain still owe that receipt's delivery.
      if (preceding.length) lane.runInBackground(() => result);
      return result;
    },
    publishInBackground(events, options) {
      // Timed startup receipts retain their own measurement boundary.
      if (options?.measureDelivery) {
        pending = null;
        lane.runInBackground(() => options.measureDelivery!(() => append(events)));
        return;
      }
      if (pending) {
        pending.events.push(...events);
        return;
      }
      const batch: Batch = { events: [...events] };
      pending = batch;
      lane.runInBackground(async () => {
        if (pending === batch) pending = null;
        const ready = batch.events.splice(0);
        if (ready.length) await append(ready);
      });
    },
    backgroundSettled: () => lane.backgroundSettled(),
  };
}
