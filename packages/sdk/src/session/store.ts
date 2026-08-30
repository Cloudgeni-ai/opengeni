export interface OpenGeniExternalStore<Snapshot> {
  getSnapshot(): Snapshot;
  subscribe(listener: () => void): () => void;
  start(): void | Promise<void>;
  destroy(): void;
}

export type OpenGeniStoreDiagnostics = Readonly<{
  started: boolean;
  destroyed: boolean;
  subscribers: number;
  pendingReads: number;
  streams: number;
  timers: number;
  listeners: number;
  objectUrls: number;
}>;

export type MutableExternalStore<Snapshot> = OpenGeniExternalStore<Snapshot> & {
  publish(next: Snapshot | ((current: Snapshot) => Snapshot)): void;
  diagnostics(): OpenGeniStoreDiagnostics;
  trackRead<T>(operation: () => Promise<T>): Promise<T>;
  trackStream<T>(operation: () => Promise<T>): Promise<T>;
  trackTimer(delta: 1 | -1): void;
  trackListener(delta: 1 | -1): void;
  trackObjectUrl(delta: 1 | -1): void;
  readonly signal: AbortSignal;
  readonly generation: number;
};

export function createExternalStore<Snapshot>(options: {
  initialSnapshot: Snapshot;
  start?: (store: MutableExternalStore<Snapshot>) => void | Promise<void>;
  destroy?: () => void;
}): MutableExternalStore<Snapshot> {
  let snapshot = freezeSnapshot(options.initialSnapshot);
  let started = false;
  let destroyed = false;
  let generation = 0;
  let pendingReads = 0;
  let streams = 0;
  let timers = 0;
  let resourceListeners = 0;
  let objectUrls = 0;
  const listeners = new Set<() => void>();
  const abortController = new AbortController();

  const store: MutableExternalStore<Snapshot> = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (destroyed) return () => undefined;
      listeners.add(listener);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        listeners.delete(listener);
      };
    },
    start() {
      if (started || destroyed) return;
      started = true;
      return options.start?.(store);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      generation += 1;
      abortController.abort();
      listeners.clear();
      options.destroy?.();
    },
    publish(next) {
      if (destroyed) return;
      const candidate =
        typeof next === "function" ? (next as (current: Snapshot) => Snapshot)(snapshot) : next;
      if (Object.is(candidate, snapshot)) return;
      snapshot = freezeSnapshot(candidate);
      for (const listener of [...listeners]) listener();
    },
    diagnostics: () =>
      Object.freeze({
        started,
        destroyed,
        subscribers: listeners.size,
        pendingReads,
        streams,
        timers,
        listeners: resourceListeners,
        objectUrls,
      }),
    async trackRead(operation) {
      pendingReads += 1;
      try {
        return await operation();
      } finally {
        pendingReads = Math.max(0, pendingReads - 1);
      }
    },
    async trackStream(operation) {
      streams += 1;
      try {
        return await operation();
      } finally {
        streams = Math.max(0, streams - 1);
      }
    },
    trackTimer(delta) {
      timers = Math.max(0, timers + delta);
    },
    trackListener(delta) {
      resourceListeners = Math.max(0, resourceListeners + delta);
    },
    trackObjectUrl(delta) {
      objectUrls = Math.max(0, objectUrls + delta);
    },
    get signal() {
      return abortController.signal;
    },
    get generation() {
      return generation;
    },
  };
  return store;
}

export type AcquiredStore<Controller extends OpenGeniExternalStore<unknown>> = {
  controller: Controller;
  release(): void;
};

export function createSharedStoreRegistry<Controller extends OpenGeniExternalStore<unknown>>() {
  const entries = new Map<string, { controller: Controller; owners: number }>();
  return {
    acquire(key: string, create: () => Controller): AcquiredStore<Controller> {
      let entry = entries.get(key);
      if (!entry) {
        entry = { controller: create(), owners: 0 };
        entries.set(key, entry);
      }
      entry.owners += 1;
      const starting = entry.controller.start();
      if (starting && typeof starting.then === "function") {
        void starting.catch(() => undefined);
      }
      let released = false;
      return {
        controller: entry.controller,
        release() {
          if (released) return;
          released = true;
          const current = entries.get(key);
          if (!current || current.controller !== entry!.controller) return;
          current.owners -= 1;
          if (current.owners > 0) return;
          entries.delete(key);
          current.controller.destroy();
        },
      };
    },
    activeCount: () => entries.size,
    ownerCount: (key: string) => entries.get(key)?.owners ?? 0,
    clear() {
      for (const entry of entries.values()) entry.controller.destroy();
      entries.clear();
    },
  };
}

export type SessionControllerIdentity = Readonly<{
  client: object;
  workspaceId: string;
  sessionId?: string | null | undefined;
  kind: string;
  actorFence?: string | null | undefined;
  /** Stable caller-owned encoding of every behavior-changing option. */
  optionsKey?: string | undefined;
}>;

export type SharedSessionControllerDiagnostics = Readonly<{
  activeControllers: number;
  owners: number;
}>;

const sharedSessionControllers = createSharedStoreRegistry<OpenGeniExternalStore<unknown>>();
const sharedSessionOwnerCounts = new Map<string, number>();

export function acquireSessionController<Controller extends OpenGeniExternalStore<unknown>>(
  identity: SessionControllerIdentity,
  create: () => Controller,
): AcquiredStore<Controller> {
  const key = sessionStoreKey(
    identity.client,
    identity.workspaceId,
    identity.sessionId,
    `${identity.actorFence ?? ""}\u0000${identity.kind}\u0000${identity.optionsKey ?? ""}`,
  );
  const acquired = sharedSessionControllers.acquire(key, create) as AcquiredStore<Controller>;
  sharedSessionOwnerCounts.set(key, (sharedSessionOwnerCounts.get(key) ?? 0) + 1);
  let released = false;
  return {
    controller: acquired.controller,
    release() {
      if (released) return;
      released = true;
      const owners = Math.max(0, (sharedSessionOwnerCounts.get(key) ?? 1) - 1);
      if (owners === 0) sharedSessionOwnerCounts.delete(key);
      else sharedSessionOwnerCounts.set(key, owners);
      acquired.release();
    },
  };
}

export function sharedSessionControllerDiagnostics(): SharedSessionControllerDiagnostics {
  let owners = 0;
  for (const count of sharedSessionOwnerCounts.values()) owners += count;
  return Object.freeze({ activeControllers: sharedSessionControllers.activeCount(), owners });
}

/** Test/dev teardown for process-global shared controller ownership. */
export function clearSharedSessionControllers(): void {
  sharedSessionControllers.clear();
  sharedSessionOwnerCounts.clear();
}

const clientIds = new WeakMap<object, number>();
let nextClientId = 1;

export function sessionStoreKey(
  client: object,
  workspaceId: string,
  sessionId: string | null | undefined,
  optionsKey = "",
): string {
  let clientId = clientIds.get(client);
  if (!clientId) {
    clientId = nextClientId++;
    clientIds.set(client, clientId);
  }
  return `${clientId}\u0000${workspaceId}\u0000${sessionId ?? ""}\u0000${optionsKey}`;
}

function freezeSnapshot<Snapshot>(snapshot: Snapshot): Snapshot {
  if (snapshot && typeof snapshot === "object" && !Object.isFrozen(snapshot)) {
    return Object.freeze(snapshot);
  }
  return snapshot;
}
