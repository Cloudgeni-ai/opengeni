import type { OpenGeniExternalStore, OpenGeniStoreDiagnostics } from "./store";
import { createExternalStore } from "./store";

export type ResourceSnapshot<Value> = Readonly<{
  value: Value | null;
  loading: boolean;
  error: Error | null;
  readRevision: number;
  readGeneration: number;
}>;

export type ResourceController<Value> = OpenGeniExternalStore<ResourceSnapshot<Value>> & {
  refresh(): Promise<Value | null>;
  invalidate(): void;
  diagnostics(): OpenGeniStoreDiagnostics;
};

export function createResourceController<Value>(options: {
  enabled?: boolean;
  load(signal: AbortSignal, readGeneration: number): Promise<Value | null>;
  pollIntervalMs?: number;
  setTimeout?: (callback: () => void, delayMs: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  isCurrent?: () => boolean;
}): ResourceController<Value> {
  let generation = 0;
  let revision = 0;
  let timer: unknown;
  let active = false;
  const enabled = options.enabled ?? true;
  const schedule =
    options.setTimeout ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
  const cancel = options.clearTimeout ?? ((handle) => globalThis.clearTimeout(handle as number));
  const store = createExternalStore<ResourceSnapshot<Value>>({
    initialSnapshot: {
      value: null,
      loading: enabled,
      error: null,
      readRevision: 0,
      readGeneration: 0,
    },
    start: async () => {
      if (!enabled) {
        store.publish((current) => ({ ...current, loading: false }));
        return;
      }
      active = true;
      await refresh();
      schedulePoll();
    },
    destroy: () => {
      active = false;
      generation += 1;
      if (timer !== undefined) {
        cancel(timer);
        timer = undefined;
        store.trackTimer(-1);
      }
    },
  });

  const refresh = async (): Promise<Value | null> => {
    if (!enabled || store.signal.aborted) return null;
    const ticket = ++generation;
    store.publish((current) => ({ ...current, loading: true, error: null }));
    try {
      const value = await store.trackRead(() => options.load(store.signal, ticket));
      if (store.signal.aborted || ticket !== generation || options.isCurrent?.() === false) {
        return null;
      }
      store.publish({
        value,
        loading: false,
        error: null,
        readRevision: ++revision,
        readGeneration: ticket,
      });
      return value;
    } catch (cause) {
      if (store.signal.aborted || ticket !== generation) return null;
      store.publish((current) => ({ ...current, loading: false, error: asError(cause) }));
      return null;
    }
  };

  const schedulePoll = () => {
    const delay = options.pollIntervalMs;
    if (!active || !delay || delay <= 0 || store.signal.aborted) return;
    store.trackTimer(1);
    timer = schedule(() => {
      timer = undefined;
      store.trackTimer(-1);
      void refresh().finally(schedulePoll);
    }, delay);
  };

  return Object.assign(store, {
    refresh,
    invalidate() {
      generation += 1;
    },
    diagnostics: store.diagnostics,
  });
}

export function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

export function isOutcomeUnknownError(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    (cause as { outcomeUnknown?: unknown }).outcomeUnknown === true
  );
}
