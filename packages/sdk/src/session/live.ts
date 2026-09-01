import type { SessionEvent } from "../types";
import type { SessionRuntimeEnvironment } from "./environment";

type TrackedStore = {
  readonly signal: AbortSignal;
  trackRead<Value>(operation: () => Promise<Value>): Promise<Value>;
  trackStream<Value>(operation: () => Promise<Value>): Promise<Value>;
  trackTimer(delta: 1 | -1): void;
  trackListener(delta: 1 | -1): void;
};

export function createTrackedTimer(store: TrackedStore, environment: SessionRuntimeEnvironment) {
  let handle: unknown;
  return {
    pending: () => handle !== undefined,
    schedule(callback: () => void, delayMs: number): void {
      if (handle !== undefined) environment.clock.clearTimeout(handle);
      else store.trackTimer(1);
      handle = environment.clock.setTimeout(() => {
        handle = undefined;
        store.trackTimer(-1);
        callback();
      }, delayMs);
    },
    clear(): void {
      if (handle === undefined) return;
      environment.clock.clearTimeout(handle);
      handle = undefined;
      store.trackTimer(-1);
    },
  };
}

export function createPageActivity(options: {
  store: TrackedStore;
  environment: SessionRuntimeEnvironment;
  hiddenGraceMs?: number | undefined;
  activate(): void;
  deactivate(): void;
}) {
  let live = true;
  let unsubscribe: (() => void) | undefined;
  const hidden = createTrackedTimer(options.store, options.environment);

  const sync = (): void => {
    const visibility = options.environment.visibility;
    if (!visibility || options.store.signal.aborted) return;
    if (visibility.getState() === "visible") {
      hidden.clear();
      if (live) return;
      live = true;
      options.activate();
      return;
    }
    if (!live || hidden.pending()) return;
    hidden.schedule(() => {
      if (options.environment.visibility?.getState() !== "hidden" || !live) return;
      live = false;
      options.deactivate();
    }, options.hiddenGraceMs ?? 2_000);
  };

  return {
    isLive: () => live,
    start(): void {
      if (!options.environment.visibility) return;
      unsubscribe = options.environment.visibility.subscribe(sync);
      options.store.trackListener(1);
      sync();
    },
    destroy(): void {
      hidden.clear();
      if (!unsubscribe) return;
      unsubscribe();
      unsubscribe = undefined;
      options.store.trackListener(-1);
    },
  };
}

export function createPoller(options: {
  store: TrackedStore;
  environment: SessionRuntimeEnvironment;
  delayMs?: number | undefined;
  enabled(): boolean;
  run(): Promise<void>;
}) {
  const timer = createTrackedTimer(options.store, options.environment);
  const schedule = (): void => {
    if (!options.delayMs || options.delayMs <= 0 || !options.enabled() || timer.pending()) return;
    timer.schedule(() => void options.run().finally(schedule), options.delayMs!);
  };
  return { schedule, clear: timer.clear };
}

export function createDebouncedTask(options: {
  store: TrackedStore;
  environment: SessionRuntimeEnvironment;
  delayMs?: number | undefined;
  enabled(): boolean;
  run(): void;
}) {
  const timer = createTrackedTimer(options.store, options.environment);
  return {
    schedule(): void {
      if (!options.enabled()) return;
      timer.schedule(options.run, options.delayMs ?? 150);
    },
    clear: timer.clear,
  };
}

export function createSessionEventCursor() {
  let initialized = false;
  let hasEvents = false;
  let consumedSequence = 0;
  return {
    apply(
      events: readonly SessionEvent[],
      onEvent: (event: SessionEvent) => void,
      onDiscontinuity: (events: readonly SessionEvent[]) => void,
    ): void {
      if (!initialized) {
        initialized = true;
        hasEvents = events.length > 0;
        consumedSequence = events.at(-1)?.sequence ?? 0;
        return;
      }
      const firstNonEmptyBatch = !hasEvents && events.length > 0;
      if (firstNonEmptyBatch || (events[0]?.sequence ?? 0) > consumedSequence + 1) {
        hasEvents = events.length > 0;
        consumedSequence = events.at(-1)?.sequence ?? consumedSequence;
        onDiscontinuity(events);
        return;
      }
      hasEvents ||= events.length > 0;
      for (const event of events) {
        if (event.sequence <= consumedSequence) continue;
        consumedSequence = event.sequence;
        onEvent(event);
      }
    },
  };
}

export function createSessionEventTail(options: {
  store: TrackedStore;
  client: {
    getSession(workspaceId: string, sessionId: string): Promise<{ lastSequence: number }>;
    streamEvents(
      workspaceId: string,
      sessionId: string,
      options: { after: number; signal: AbortSignal; onOpen?: () => void },
    ): AsyncIterable<SessionEvent>;
  };
  workspaceId: string;
  sessionId: string;
  enabled(): boolean;
  onOpen?(): void;
  onEvent(event: SessionEvent): void;
}) {
  let generation = 0;
  let abort: AbortController | null = null;
  let iterator: AsyncIterator<SessionEvent> | null = null;

  const stop = (invalidate = true): void => {
    if (invalidate) generation += 1;
    abort?.abort();
    abort = null;
    const current = iterator;
    iterator = null;
    if (current?.return) void current.return().catch(() => undefined);
  };

  return {
    start(): void {
      if (!options.enabled() || options.store.signal.aborted) return;
      const owned = ++generation;
      stop(false);
      const controller = new AbortController();
      abort = controller;
      void options.store.trackStream(async () => {
        try {
          const session = await options.store.trackRead(() =>
            options.client.getSession(options.workspaceId, options.sessionId),
          );
          if (owned !== generation || controller.signal.aborted || options.store.signal.aborted) {
            return;
          }
          const stream = options.client.streamEvents(options.workspaceId, options.sessionId, {
            after: session.lastSequence,
            signal: controller.signal,
            ...(options.onOpen
              ? {
                  onOpen: () => {
                    if (
                      owned === generation &&
                      !controller.signal.aborted &&
                      !options.store.signal.aborted
                    ) {
                      options.onOpen?.();
                    }
                  },
                }
              : {}),
          });
          const ownedIterator = stream[Symbol.asyncIterator]();
          iterator = ownedIterator;
          for (;;) {
            if (owned !== generation || controller.signal.aborted || options.store.signal.aborted) {
              break;
            }
            const next = await ownedIterator.next();
            if (next.done) break;
            options.onEvent(next.value);
          }
        } catch {
          // Initial/manual reads own errors; live delivery is best-effort.
        } finally {
          if (owned === generation) {
            abort = null;
            iterator = null;
          }
        }
      });
    },
    stop,
  };
}

export function createCoalescedRead<Value>(options: {
  store: TrackedStore;
  enabled: boolean;
  load(signal: AbortSignal, ticket: number): Promise<Value>;
  accept(value: Value, ticket: number): void;
  reject(cause: unknown, ticket: number): void;
}) {
  let generation = 0;
  let inFlight: { promise: Promise<void>; controller: AbortController; ticket: number } | undefined;
  let trailing: Promise<void> | undefined;

  const run = (): Promise<void> => {
    if (!options.enabled || options.store.signal.aborted) return Promise.resolve();
    if (inFlight) return inFlight.promise;
    const ticket = ++generation;
    const controller = new AbortController();
    const ownsInFlight = () => inFlight?.ticket === ticket;
    let promise!: Promise<void>;
    promise = (async () => {
      try {
        const value = await options.store.trackRead(() => options.load(controller.signal, ticket));
        if (ticket !== generation || controller.signal.aborted || options.store.signal.aborted) {
          return;
        }
        options.accept(value, ticket);
      } catch (cause) {
        if (ticket !== generation || controller.signal.aborted || options.store.signal.aborted) {
          return;
        }
        options.reject(cause, ticket);
      } finally {
        if (ownsInFlight()) inFlight = undefined;
      }
    })();
    inFlight = { promise, controller, ticket };
    return promise;
  };

  const refresh = (): Promise<void> => {
    const current = inFlight;
    if (!current) return run();
    if (trailing) return trailing;
    let promise!: Promise<void>;
    promise = current.promise.then(async () => {
      if (trailing === promise) trailing = undefined;
      if (!options.store.signal.aborted) await run();
    });
    trailing = promise;
    return promise;
  };

  const invalidate = (abort = false): void => {
    generation += 1;
    if (!abort) return;
    inFlight?.controller.abort();
    inFlight = undefined;
    trailing = undefined;
  };

  return { run, refresh, invalidate, destroy: () => invalidate(true) };
}
