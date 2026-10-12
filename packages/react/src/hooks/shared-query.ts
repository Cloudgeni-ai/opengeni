import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { normalizeError } from "../lib/error-message";
import { usePageLiveActivity } from "./internal";

/**
 * A small client-scoped stale-while-revalidate store for read models that many
 * surfaces show (subscription accounts, their usage limits). Scoping:
 *
 * - Every entry lives under the exact client object that read it (a WeakMap),
 *   like `createDiscoveryCache`. A host that signs in someone else must hand
 *   hooks a new client (the Opengeni console rotates its client on every
 *   identity or actor change), so another person's rows are never reachable.
 *   `clearSharedQueries(client)` drops a scope explicitly.
 * - The key names the exact read (`["codex-accounts", workspaceId, sessionId]`).
 *
 * Semantics:
 *
 * - A mount with retained data renders it immediately and revalidates in the
 *   background once it is older than `staleTimeMs`; concurrent readers share one
 *   in-flight request.
 * - Failures are never cached. An access refusal (401/403/404) also drops the
 *   retained data; another failure keeps it beside the error so the caller can
 *   decide what to show.
 * - `invalidateSharedQueries` re-reads mounted entries and evicts unmounted
 *   ones, so a later mount never shows rows a mutation has made wrong.
 * - Unmounted entries are dropped after `retainMs` (default 10 minutes).
 */

export type SharedQueryKey = readonly (string | number | boolean | null)[];

export type SharedQuerySnapshot<T> = {
  data: T | null;
  /** True only while there is nothing to show yet (first read for this key). */
  loading: boolean;
  /** True while any read for this key is in flight, including background ones. */
  fetching: boolean;
  error: Error | null;
  /** Epoch milliseconds of the last successful read or write, or null. */
  updatedAt: number | null;
};

export type SharedQueryOptions = {
  enabled?: boolean | undefined;
  /** Poll while mounted and the page is visible. Shortest interval wins. */
  pollIntervalMs?: number | undefined;
  /** Retained data younger than this is not re-read on mount. Default 10s. */
  staleTimeMs?: number | undefined;
  /** How long an unmounted entry is retained. Default 10 minutes. */
  retainMs?: number | undefined;
};

export type SharedQueryResult<T> = SharedQuerySnapshot<T> & {
  /** Force a read now (joining one queued after any in-flight read). */
  refresh: () => Promise<void>;
};

const DEFAULT_STALE_TIME_MS = 10_000;
const DEFAULT_RETAIN_MS = 10 * 60_000;

type Loader<T> = (signal: AbortSignal) => Promise<T>;

type Subscriber = {
  load: { current: Loader<unknown> };
  enabled: boolean;
  pageLive: boolean;
  pollIntervalMs: number | undefined;
  staleTimeMs: number;
  retainMs: number;
};

type Entry = {
  parts: SharedQueryKey;
  snapshot: SharedQuerySnapshot<unknown>;
  listeners: Set<() => void>;
  subscribers: Set<Subscriber>;
  inFlight: Promise<void> | null;
  trailing: Promise<void> | null;
  abort: AbortController | null;
  generation: number;
  /** A mutation made the retained data wrong; the next reconcile re-reads. */
  invalidated: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  retainTimer: ReturnType<typeof setTimeout> | null;
};

const scopes = new WeakMap<object, Map<string, Entry>>();

function idle<T>(enabled: boolean): SharedQuerySnapshot<T> {
  return { data: null, loading: enabled, fetching: false, error: null, updatedAt: null };
}
const IDLE_ENABLED = idle<never>(true);
const IDLE_DISABLED = idle<never>(false);

function serialize(parts: SharedQueryKey): string {
  return JSON.stringify(parts);
}

/** A refusal that repeating the read cannot fix; retained rows must go. */
export function isSharedQueryAccessRefusal(cause: unknown): boolean {
  if (!cause || typeof cause !== "object" || !("status" in cause)) return false;
  const status = (cause as { status: unknown }).status;
  return status === 401 || status === 403 || status === 404;
}

function entries(scope: object): Map<string, Entry> {
  let map = scopes.get(scope);
  if (!map) {
    map = new Map();
    scopes.set(scope, map);
  }
  return map;
}

function setSnapshot(entry: Entry, next: SharedQuerySnapshot<unknown>): void {
  entry.snapshot = next;
  for (const listener of entry.listeners) listener();
}

function activeSubscribers(entry: Entry): Subscriber[] {
  return [...entry.subscribers].filter((each) => each.enabled && each.pageLive);
}

function stopTimer(entry: Entry): void {
  if (entry.timer !== null) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
}

function arm(entry: Entry): void {
  stopTimer(entry);
  let interval: number | undefined;
  for (const each of activeSubscribers(entry)) {
    if (each.pollIntervalMs === undefined || each.pollIntervalMs <= 0) continue;
    interval =
      interval === undefined ? each.pollIntervalMs : Math.min(interval, each.pollIntervalMs);
  }
  if (interval === undefined) return;
  entry.timer = setTimeout(() => {
    entry.timer = null;
    void run(entry).finally(() => arm(entry));
  }, interval);
}

async function runFresh(entry: Entry): Promise<void> {
  const subscriber = activeSubscribers(entry).at(-1);
  if (!subscriber) return;
  const ticket = ++entry.generation;
  const abort = new AbortController();
  entry.abort = abort;
  entry.invalidated = false;
  if (!entry.snapshot.fetching) setSnapshot(entry, { ...entry.snapshot, fetching: true });
  try {
    const data = await subscriber.load.current(abort.signal);
    if (ticket !== entry.generation) return;
    setSnapshot(entry, {
      data,
      loading: false,
      fetching: false,
      error: null,
      updatedAt: Date.now(),
    });
  } catch (cause) {
    if (ticket !== entry.generation) return;
    const refused = isSharedQueryAccessRefusal(cause);
    setSnapshot(entry, {
      data: refused ? null : entry.snapshot.data,
      loading: false,
      fetching: false,
      error: normalizeError(cause),
      // A failure is never a fresh read: the next mount re-reads.
      updatedAt: null,
    });
  } finally {
    if (entry.abort === abort) entry.abort = null;
  }
}

function run(entry: Entry, force = false): Promise<void> {
  if (entry.inFlight) {
    if (!force) return entry.inFlight;
    // A forced read issued during another read (a mutation just settled)
    // must observe the mutation, so queue exactly one successor read.
    if (entry.trailing) return entry.trailing;
    const predecessor = entry.inFlight;
    let trailing!: Promise<void>;
    trailing = predecessor
      .then(() => {
        if (entry.trailing === trailing) entry.trailing = null;
        if (activeSubscribers(entry).length > 0) return run(entry);
      })
      .finally(() => {
        if (entry.trailing === trailing) entry.trailing = null;
      });
    entry.trailing = trailing;
    return trailing;
  }
  let promise!: Promise<void>;
  promise = runFresh(entry).finally(() => {
    if (entry.inFlight === promise) entry.inFlight = null;
  });
  entry.inFlight = promise;
  return promise;
}

function isStale(entry: Entry, staleTimeMs: number): boolean {
  const updatedAt = entry.snapshot.updatedAt;
  return entry.invalidated || updatedAt === null || Date.now() - updatedAt >= staleTimeMs;
}

function reconcile(entry: Entry): void {
  const active = activeSubscribers(entry);
  if (active.length === 0) {
    stopTimer(entry);
    if (entry.snapshot.loading) setSnapshot(entry, { ...entry.snapshot, loading: false });
    return;
  }
  const staleTimeMs = Math.min(...active.map((each) => each.staleTimeMs));
  if (isStale(entry, staleTimeMs)) {
    // A mount or resume never inherits an earlier failure: it reads again and
    // shows a loading state (or retained rows) until that read settles.
    if (entry.snapshot.error || (entry.snapshot.data === null && !entry.snapshot.loading)) {
      setSnapshot(entry, {
        ...entry.snapshot,
        error: null,
        loading: entry.snapshot.data === null,
      });
    }
    void run(entry).finally(() => arm(entry));
    return;
  }
  if (entry.timer === null) arm(entry);
}

function scheduleRelease(scope: object, key: string, entry: Entry, retainMs: number): void {
  if (entry.retainTimer !== null) clearTimeout(entry.retainTimer);
  entry.retainTimer = setTimeout(() => {
    entry.retainTimer = null;
    if (entry.subscribers.size > 0) return;
    const map = scopes.get(scope);
    if (map?.get(key) === entry) map.delete(key);
  }, retainMs);
}

function getOrCreate(scope: object, parts: SharedQueryKey, enabled: boolean): Entry {
  const map = entries(scope);
  const key = serialize(parts);
  const existing = map.get(key);
  if (existing) {
    if (existing.retainTimer !== null) {
      clearTimeout(existing.retainTimer);
      existing.retainTimer = null;
    }
    return existing;
  }
  const created: Entry = {
    parts,
    snapshot: idle(enabled),
    listeners: new Set(),
    subscribers: new Set(),
    inFlight: null,
    trailing: null,
    abort: null,
    generation: 0,
    invalidated: false,
    timer: null,
    retainTimer: null,
  };
  map.set(key, created);
  return created;
}

/** The retained snapshot for a key, without subscribing or reading. */
export function peekSharedQuery<T>(
  scope: object,
  parts: SharedQueryKey,
): SharedQuerySnapshot<T> | null {
  return (scopes.get(scope)?.get(serialize(parts))?.snapshot as SharedQuerySnapshot<T>) ?? null;
}

/**
 * Record data a caller read some other way (for example the result of a live
 * provider refresh). Mounted readers render it at once.
 */
export function setSharedQueryData<T>(scope: object, parts: SharedQueryKey, data: T): void {
  const map = entries(scope);
  const key = serialize(parts);
  const entry = map.get(key) ?? getOrCreate(scope, parts, false);
  // A read already in flight started before this write; its result is older.
  entry.generation += 1;
  entry.abort?.abort();
  entry.abort = null;
  entry.invalidated = false;
  setSnapshot(entry, { data, loading: false, fetching: false, error: null, updatedAt: Date.now() });
  if (entry.subscribers.size === 0) scheduleRelease(scope, key, entry, DEFAULT_RETAIN_MS);
}

/**
 * Mark every entry whose key starts with `prefix` as wrong. Mounted entries
 * re-read now (keeping their rows on screen meanwhile); unmounted entries are
 * evicted so the next mount never renders them.
 */
export function invalidateSharedQueries(scope: object, prefix: SharedQueryKey): Promise<void> {
  const map = scopes.get(scope);
  if (!map) return Promise.resolve();
  const reads: Promise<void>[] = [];
  for (const [key, entry] of [...map]) {
    if (!prefix.every((part, index) => entry.parts[index] === part)) continue;
    if (activeSubscribers(entry).length > 0) {
      entry.invalidated = true;
      reads.push(run(entry, true).finally(() => arm(entry)));
      continue;
    }
    if (entry.subscribers.size > 0) {
      // Mounted but paused (hidden page or disabled): re-read when it resumes.
      entry.invalidated = true;
      entry.generation += 1;
      entry.abort?.abort();
      setSnapshot(entry, { ...idle(false), error: null });
      continue;
    }
    entry.generation += 1;
    entry.abort?.abort();
    if (entry.retainTimer !== null) clearTimeout(entry.retainTimer);
    map.delete(key);
  }
  return Promise.all(reads).then(() => undefined);
}

/** Drop everything retained for a client (for hosts that reuse one client across people). */
export function clearSharedQueries(scope: object): void {
  const map = scopes.get(scope);
  if (!map) return;
  for (const entry of map.values()) {
    entry.generation += 1;
    entry.abort?.abort();
    stopTimer(entry);
    if (entry.retainTimer !== null) clearTimeout(entry.retainTimer);
    setSnapshot(entry, idle(false));
  }
  scopes.delete(scope);
}

/**
 * Subscribe to one shared read. `scope` is the client object that performs
 * the read; `parts` must name every input the loader depends on.
 */
export function useSharedQuery<T>(
  scope: object,
  parts: SharedQueryKey,
  load: Loader<T>,
  options: SharedQueryOptions = {},
): SharedQueryResult<T> {
  const enabled = options.enabled ?? true;
  const pageLive = usePageLiveActivity();
  const key = serialize(parts);
  const loadRef = useRef<Loader<unknown>>(load);
  loadRef.current = load;
  const partsRef = useRef(parts);
  partsRef.current = parts;
  const staleTimeMs = options.staleTimeMs ?? DEFAULT_STALE_TIME_MS;
  const retainMs = options.retainMs ?? DEFAULT_RETAIN_MS;
  const pollIntervalMs = options.pollIntervalMs;

  const subscribe = useCallback(
    (listener: () => void) => {
      const entry = getOrCreate(scope, partsRef.current, enabled);
      entry.listeners.add(listener);
      return () => {
        entry.listeners.delete(listener);
      };
    },
    // `key` identifies the entry; `enabled` only seeds a brand-new one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scope, key],
  );
  const getSnapshot = useCallback(
    () =>
      (scopes.get(scope)?.get(key)?.snapshot as SharedQuerySnapshot<T> | undefined) ??
      (enabled ? IDLE_ENABLED : IDLE_DISABLED),
    [scope, key, enabled],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    const entry = getOrCreate(scope, partsRef.current, enabled);
    const subscriber: Subscriber = {
      load: loadRef,
      enabled,
      pageLive,
      pollIntervalMs,
      staleTimeMs,
      retainMs,
    };
    entry.subscribers.add(subscriber);
    reconcile(entry);
    return () => {
      entry.subscribers.delete(subscriber);
      if (entry.subscribers.size > 0) {
        reconcile(entry);
        return;
      }
      // Let an in-flight read land in the cache for the next mount; only the
      // poll stops. Unmounted entries are released after `retainMs`.
      stopTimer(entry);
      if (entry.snapshot.loading) setSnapshot(entry, { ...entry.snapshot, loading: false });
      scheduleRelease(scope, key, entry, retainMs);
    };
  }, [scope, key, enabled, pageLive, pollIntervalMs, staleTimeMs, retainMs]);

  const refresh = useCallback((): Promise<void> => {
    const entry = scopes.get(scope)?.get(key);
    if (!entry || activeSubscribers(entry).length === 0) return Promise.resolve();
    return run(entry, true).finally(() => arm(entry));
  }, [scope, key]);

  const visible = enabled ? snapshot : { ...snapshot, loading: false };
  return { ...visible, refresh };
}
