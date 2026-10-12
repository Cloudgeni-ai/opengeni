import { useCallback, useLayoutEffect, useReducer, useRef, useSyncExternalStore } from "react";
import { normalizeError } from "../lib/error-message";
import { usePageLiveActivity } from "./internal";

/**
 * A small client-scoped stale-while-revalidate store for read models that many
 * surfaces show (subscription accounts, their usage limits). Internal to
 * `@opengeni/react`: hosts reach it only through the hooks built on it and the
 * `OpenGeniProvider` `retainReadsAcrossMounts` opt-in.
 *
 * Scoping:
 *
 * - Every entry lives under the exact client object that read it (a WeakMap),
 *   like `createDiscoveryCache`; the key names the exact read
 *   (`["codex-accounts", workspaceId, "session", sessionId]`).
 * - By default nothing outlives its readers: mounted readers of one key share
 *   one request and one snapshot, and the entry is dropped as soon as the last
 *   reader unmounts. Only the reader instance that let go may take it back
 *   (StrictMode, effect re-runs); a different reader mounting in the same
 *   commit (a host re-keying its tree for another person) starts from nothing
 *   and the earlier read is discarded. Only a scope a host retains
 *   (`retainSharedQueries`, used by the provider opt-in) keeps unmounted
 *   entries for `retainMs`, so a host that reuses one client for different
 *   people never serves one person's rows to the next mount. Ending the last
 *   retention clears the scope.
 * - `clearSharedQueries(scope)` drops every row at once. Mounted readers stay
 *   subscribed and read again; writes from operations that started before the
 *   clear are discarded.
 *
 * Semantics:
 *
 * - A mount with retained data renders it immediately and revalidates in the
 *   background once it is older than `staleTimeMs`. An enabled reader reports
 *   `loading` until its key's first read completes.
 * - Page visibility pauses only polling and background revalidation of rows
 *   already on screen; invalidation and `refresh()` read on a hidden page too.
 * - A loader is bound to its key when the render that supplied it commits, so a
 *   render that never commits (a transition) or a key change cannot run one
 *   key's loader for another key's entry.
 * - Failures are never cached. An access refusal (401/403/404) also drops the
 *   retained data; another failure keeps it beside the error.
 * - `invalidateSharedQueries` supersedes any read in flight (its result is
 *   discarded), re-reads mounted entries and evicts unmounted ones, so a later
 *   mount never shows rows a mutation has made wrong.
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
  /** False: never read, and show no data (not even retained rows). */
  enabled?: boolean | undefined;
  /** Poll while mounted and the page is visible. Shortest interval wins. */
  pollIntervalMs?: number | undefined;
  /** Retained data younger than this is not re-read on mount. Default 10s. */
  staleTimeMs?: number | undefined;
  /** How long an unmounted entry is retained in a retained scope. Default 10 minutes. */
  retainMs?: number | undefined;
};

export type SharedQueryResult<T> = SharedQuerySnapshot<T> & {
  /** Force a read now (joining one queued after any in-flight read). */
  refresh: () => Promise<void>;
};

/** Records data read some other way; false when the write was refused. */
export type SharedQueryWriter = <T>(parts: SharedQueryKey, data: T) => boolean;

const DEFAULT_STALE_TIME_MS = 10_000;
const DEFAULT_RETAIN_MS = 10 * 60_000;

type Loader<T> = (signal: AbortSignal) => Promise<T>;
type LoaderBinding = { key: string; load: Loader<unknown> };

type Subscriber = {
  /** The hook instance; only it may take back an entry it just let go of. */
  owner: object;
  /** The committed loader and the key it reads; null for subscribe-only readers. */
  binding: { current: LoaderBinding } | null;
  enabled: boolean;
  pageLive: boolean;
  pollIntervalMs: number | undefined;
  staleTimeMs: number;
  retainMs: number;
};

type Entry = {
  key: string;
  parts: SharedQueryKey;
  snapshot: SharedQuerySnapshot<unknown>;
  listeners: Set<() => void>;
  subscribers: Set<Subscriber>;
  inFlight: Promise<void> | null;
  trailing: Promise<void> | null;
  abort: AbortController | null;
  generation: number;
  /** The retained data may be wrong; the next reconcile re-reads. */
  invalidated: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  /** The interval `timer` was armed with. */
  timerInterval: number | null;
  retainTimer: ReturnType<typeof setTimeout> | null;
  /** The reader instance that last let go of this entry while it awaits release. */
  releasedBy: object | null;
};

type Scope = {
  entries: Map<string, Entry>;
  /** Bumped by every clear; writers from an earlier epoch are refused. */
  epoch: number;
  /** Active retentions; unmounted entries are kept only while positive. */
  retainers: number;
  releaseTimer: ReturnType<typeof setTimeout> | null;
};

const scopes = new WeakMap<object, Scope>();

function idle<T>(loading: boolean): SharedQuerySnapshot<T> {
  return { data: null, loading, fetching: false, error: null, updatedAt: null };
}
const IDLE_LOADING = idle<never>(true);
const IDLE = idle<never>(false);

function serialize(parts: SharedQueryKey): string {
  return JSON.stringify(parts);
}

/** A refusal that repeating the read cannot fix; retained rows must go. */
export function isSharedQueryAccessRefusal(cause: unknown): boolean {
  if (!cause || typeof cause !== "object" || !("status" in cause)) return false;
  const status = (cause as { status: unknown }).status;
  return status === 401 || status === 403 || status === 404;
}

function scopeState(scope: object): Scope {
  let state = scopes.get(scope);
  if (!state) {
    state = { entries: new Map(), epoch: 0, retainers: 0, releaseTimer: null };
    scopes.set(scope, state);
  }
  return state;
}

function setSnapshot(entry: Entry, next: SharedQuerySnapshot<unknown>): void {
  entry.snapshot = next;
  for (const listener of entry.listeners) listener();
}

/** Readers that may read: enabled and bound to this key (visible or not). */
function readers(entry: Entry): Subscriber[] {
  return [...entry.subscribers].filter(
    (each) => each.enabled && each.binding?.current.key === entry.key,
  );
}

function mounted(entry: Entry): boolean {
  return entry.subscribers.size > 0 || entry.listeners.size > 0;
}

function stopTimer(entry: Entry): void {
  if (entry.timer !== null) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  entry.timerInterval = null;
}

function stopRetainTimer(entry: Entry): void {
  if (entry.retainTimer !== null) {
    clearTimeout(entry.retainTimer);
    entry.retainTimer = null;
  }
}

/** Any read in flight or queued is superseded: its result is never stored. */
function supersedeReads(entry: Entry): void {
  entry.generation += 1;
  entry.abort?.abort();
  entry.abort = null;
  entry.inFlight = null;
  entry.trailing = null;
}

function evict(state: Scope, entry: Entry): void {
  supersedeReads(entry);
  stopTimer(entry);
  stopRetainTimer(entry);
  if (state.entries.get(entry.key) === entry) state.entries.delete(entry.key);
}

/** Poll at the shortest interval among readers on a visible page; keep a timer already armed for it. */
function arm(entry: Entry): void {
  let interval: number | undefined;
  for (const each of readers(entry)) {
    if (!each.pageLive) continue;
    if (each.pollIntervalMs === undefined || each.pollIntervalMs <= 0) continue;
    interval =
      interval === undefined ? each.pollIntervalMs : Math.min(interval, each.pollIntervalMs);
  }
  if (entry.timer !== null && entry.timerInterval === interval) return;
  stopTimer(entry);
  if (interval === undefined) return;
  entry.timerInterval = interval;
  entry.timer = setTimeout(() => {
    entry.timer = null;
    entry.timerInterval = null;
    void run(entry).finally(() => arm(entry));
  }, interval);
}

async function runFresh(entry: Entry): Promise<void> {
  const subscriber = readers(entry).at(-1);
  if (!subscriber?.binding) return;
  const { load } = subscriber.binding.current;
  const ticket = ++entry.generation;
  const abort = new AbortController();
  entry.abort = abort;
  entry.invalidated = false;
  if (!entry.snapshot.fetching) setSnapshot(entry, { ...entry.snapshot, fetching: true });
  try {
    const data = await load(abort.signal);
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
    // A forced read issued during another read must observe whatever changed
    // since that read started, so queue exactly one successor read.
    if (entry.trailing) return entry.trailing;
    const predecessor = entry.inFlight;
    let trailing!: Promise<void>;
    trailing = predecessor.then(() => {
      // Superseded meanwhile: the read that replaced it is the newer one.
      if (entry.trailing !== trailing) return entry.inFlight ?? undefined;
      entry.trailing = null;
      if (readers(entry).length > 0) return run(entry);
      // Nobody can read now: what the predecessor stored is not known to be
      // current, so the next mount or resume re-reads.
      entry.invalidated = true;
      return undefined;
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
  const active = readers(entry);
  if (active.length === 0) {
    stopTimer(entry);
    if (entry.snapshot.loading) setSnapshot(entry, { ...entry.snapshot, loading: false });
    return;
  }
  const staleTimeMs = Math.min(...active.map((each) => each.staleTimeMs));
  // A hidden page still reads what it has nothing (or nothing right) to show;
  // it only defers revalidating rows already on screen.
  const due =
    active.some((each) => each.pageLive) || entry.invalidated || entry.snapshot.data === null;
  if (due && isStale(entry, staleTimeMs)) {
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
  // A reader joined or left: the shortest interval may have changed.
  arm(entry);
}

function scheduleRelease(state: Scope, entry: Entry, retainMs: number): void {
  stopRetainTimer(entry);
  // Even an unretained entry waits one task, so StrictMode's immediate
  // unmount/remount keeps sharing the read it already started.
  entry.retainTimer = setTimeout(() => {
    entry.retainTimer = null;
    if (!mounted(entry)) evict(state, entry);
  }, retainMs);
}

function getOrCreate(scope: object, key: string, loading: boolean): Entry {
  const state = scopeState(scope);
  const existing = state.entries.get(key);
  if (existing) {
    stopRetainTimer(existing);
    return existing;
  }
  const created: Entry = {
    key,
    parts: JSON.parse(key) as SharedQueryKey,
    snapshot: idle(loading),
    listeners: new Set(),
    subscribers: new Set(),
    inFlight: null,
    trailing: null,
    abort: null,
    generation: 0,
    invalidated: false,
    timer: null,
    timerInterval: null,
    retainTimer: null,
    releasedBy: null,
  };
  state.entries.set(key, created);
  return created;
}

/**
 * Register a reader instance. In an unretained scope an entry that another
 * instance let go of in this same commit is not adopted: its rows and any read
 * in flight belonged to that reader (possibly another person), so it starts
 * over and writes begun before now are refused. True when it was reset.
 */
function registerSubscriber(scope: object, entry: Entry, subscriber: Subscriber): boolean {
  const state = scopeState(scope);
  const foreign =
    entry.subscribers.size === 0 &&
    entry.releasedBy !== null &&
    entry.releasedBy !== subscriber.owner &&
    state.retainers === 0;
  if (foreign) {
    supersedeReads(entry);
    stopTimer(entry);
    entry.invalidated = false;
    state.epoch += 1;
    setSnapshot(entry, IDLE);
  }
  entry.releasedBy = null;
  entry.subscribers.add(subscriber);
  return foreign;
}

function unsubscribe(scope: object, entry: Entry, subscriber: Subscriber, retainMs: number): void {
  entry.subscribers.delete(subscriber);
  if (entry.subscribers.size > 0) {
    reconcile(entry);
    return;
  }
  entry.releasedBy = subscriber.owner;
  // Only the poll stops: in a retained scope a read in flight still lands
  // for the next mount. Otherwise the entry goes with its last reader.
  stopTimer(entry);
  if (entry.snapshot.loading) setSnapshot(entry, { ...entry.snapshot, loading: false });
  const state = scopes.get(scope);
  if (!state || state.entries.get(entry.key) !== entry) return;
  scheduleRelease(state, entry, state.retainers > 0 ? retainMs : 0);
}

/** The retained snapshot for a key, without subscribing or reading. */
export function peekSharedQuery<T>(
  scope: object,
  parts: SharedQueryKey,
): SharedQuerySnapshot<T> | null {
  return (
    (scopes.get(scope)?.entries.get(serialize(parts))?.snapshot as
      | SharedQuerySnapshot<T>
      | undefined) ?? null
  );
}

/**
 * A writer for data read some other way (for example a live provider refresh).
 * Create it BEFORE starting that read: a clear in between refuses the write,
 * so a retired identity's late result is never recorded. Mounted readers
 * render a write at once; with no reader, only a retained scope keeps it.
 */
export function sharedQueryWriter(scope: object): SharedQueryWriter {
  const state = scopeState(scope);
  const epoch = state.epoch;
  return <T>(parts: SharedQueryKey, data: T): boolean => {
    if (state.epoch !== epoch) return false;
    const key = serialize(parts);
    const existing = state.entries.get(key);
    if (!(existing && mounted(existing)) && state.retainers === 0) return false;
    const entry = existing ?? getOrCreate(scope, key, false);
    // A read already in flight started before this write; its result is older.
    supersedeReads(entry);
    entry.invalidated = false;
    setSnapshot(entry, {
      data,
      loading: false,
      fetching: false,
      error: null,
      updatedAt: Date.now(),
    });
    if (!mounted(entry)) scheduleRelease(state, entry, DEFAULT_RETAIN_MS);
    return true;
  };
}

/**
 * Mark every entry whose key starts with `prefix` as wrong. Reads in flight are
 * superseded. Mounted entries re-read now (keeping their rows on screen
 * meanwhile); paused ones re-read when they resume; unmounted entries are
 * evicted so the next mount never renders them.
 */
export function invalidateSharedQueries(scope: object, prefix: SharedQueryKey): Promise<void> {
  const state = scopes.get(scope);
  if (!state) return Promise.resolve();
  const reads: Promise<void>[] = [];
  for (const entry of [...state.entries.values()]) {
    if (!prefix.every((part, index) => entry.parts[index] === part)) continue;
    if (!mounted(entry)) {
      evict(state, entry);
      continue;
    }
    supersedeReads(entry);
    entry.invalidated = true;
    // Readers keep their rows on screen while the re-read runs, also on a
    // hidden page (a sign-in finished in another tab must not blank Settings).
    if (readers(entry).length > 0) {
      reads.push(run(entry).finally(() => arm(entry)));
      continue;
    }
    // Only disabled or subscribe-only readers: drop the rows; an enabled
    // reader reads again when it appears.
    stopTimer(entry);
    setSnapshot(entry, IDLE);
  }
  return Promise.all(reads).then(() => undefined);
}

/**
 * Drop everything retained for a client. Unmounted entries go; mounted ones
 * are reset in place (their readers stay subscribed) and active ones read
 * again. Writes from operations that began before the clear are refused.
 */
export function clearSharedQueries(scope: object): void {
  const state = scopes.get(scope);
  if (!state) return;
  state.epoch += 1;
  for (const entry of [...state.entries.values()]) {
    if (!mounted(entry)) {
      evict(state, entry);
      continue;
    }
    supersedeReads(entry);
    stopTimer(entry);
    stopRetainTimer(entry);
    entry.invalidated = true;
    const active = readers(entry).length > 0;
    setSnapshot(entry, active ? IDLE_LOADING : IDLE);
    if (active) void run(entry).finally(() => arm(entry));
  }
}

/**
 * Keep unmounted entries for this client until the returned release is
 * called. Releasing the last retention clears the client's entries (after one
 * task, so StrictMode's immediate remount keeps them).
 */
export function retainSharedQueries(scope: object): () => void {
  const state = scopeState(scope);
  state.retainers += 1;
  if (state.releaseTimer !== null) {
    clearTimeout(state.releaseTimer);
    state.releaseTimer = null;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.retainers -= 1;
    if (state.retainers > 0) return;
    if (state.releaseTimer !== null) clearTimeout(state.releaseTimer);
    state.releaseTimer = setTimeout(() => {
      state.releaseTimer = null;
      if (state.retainers === 0) clearSharedQueries(scope);
    }, 0);
  };
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
  // The loader is bound to its key only when the render that supplied both
  // commits. A render React discards (a transition) or the interval between a
  // key change's layout and passive effects must never let another key's
  // loader fill this entry: subscribers whose binding names another key are
  // ignored by every read.
  const binding = useRef<LoaderBinding>({ key, load: load as Loader<unknown> });
  useLayoutEffect(() => {
    binding.current = { key, load: load as Loader<unknown> };
  }, [key, load]);
  const staleTimeMs = options.staleTimeMs ?? DEFAULT_STALE_TIME_MS;
  const retainMs = options.retainMs ?? DEFAULT_RETAIN_MS;
  const pollIntervalMs = options.pollIntervalMs;

  const subscribe = useCallback(
    (listener: () => void) => {
      const entry = getOrCreate(scope, key, enabled);
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
      (scopes.get(scope)?.entries.get(key)?.snapshot as SharedQuerySnapshot<T> | undefined) ??
      (enabled ? IDLE_LOADING : IDLE),
    [scope, key, enabled],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const owner = useRef<object>({});
  const [, rerender] = useReducer((count: number) => count + 1, 0);

  // Registered in the layout phase, after any reader this commit unmounts has
  // let go, so a foreign entry is reset before the browser paints.
  useLayoutEffect(() => {
    const entry = getOrCreate(scope, key, enabled);
    const subscriber: Subscriber = {
      owner: owner.current,
      binding,
      enabled,
      pageLive,
      pollIntervalMs,
      staleTimeMs,
      retainMs,
    };
    const reset = registerSubscriber(scope, entry, subscriber);
    reconcile(entry);
    // This render showed the previous reader's rows: replace them before paint.
    if (reset) rerender();
    return () => unsubscribe(scope, entry, subscriber, retainMs);
  }, [scope, key, enabled, pageLive, pollIntervalMs, staleTimeMs, retainMs]);

  const refresh = useCallback((): Promise<void> => {
    const entry = scopes.get(scope)?.entries.get(key);
    if (!entry || readers(entry).length === 0) return Promise.resolve();
    return run(entry, true).finally(() => arm(entry));
  }, [scope, key]);

  // A disabled reader shows nothing, not even rows retained by other readers.
  if (!enabled) return { ...IDLE, refresh };
  // Enabled with nothing read yet (also the first render after enabling).
  const unread = snapshot.data === null && snapshot.error === null && snapshot.updatedAt === null;
  return { ...snapshot, loading: snapshot.loading || unread, refresh };
}

/**
 * Subscribe to an entry that is only ever written (`sharedQueryWriter`), never
 * read: it renders whatever is recorded and keeps the entry while mounted.
 */
export function useSharedQueryValue<T>(
  scope: object,
  parts: SharedQueryKey,
): SharedQuerySnapshot<T> {
  const key = serialize(parts);
  const subscribe = useCallback(
    (listener: () => void) => {
      const entry = getOrCreate(scope, key, false);
      entry.listeners.add(listener);
      return () => {
        entry.listeners.delete(listener);
      };
    },
    [scope, key],
  );
  const getSnapshot = useCallback(
    () =>
      (scopes.get(scope)?.entries.get(key)?.snapshot as SharedQuerySnapshot<T> | undefined) ?? IDLE,
    [scope, key],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const owner = useRef<object>({});
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  useLayoutEffect(() => {
    const entry = getOrCreate(scope, key, false);
    const subscriber: Subscriber = {
      owner: owner.current,
      binding: null,
      enabled: false,
      pageLive: true,
      pollIntervalMs: undefined,
      staleTimeMs: DEFAULT_STALE_TIME_MS,
      retainMs: DEFAULT_RETAIN_MS,
    };
    if (registerSubscriber(scope, entry, subscriber)) rerender();
    return () => unsubscribe(scope, entry, subscriber, DEFAULT_RETAIN_MS);
  }, [scope, key]);
  return snapshot;
}
