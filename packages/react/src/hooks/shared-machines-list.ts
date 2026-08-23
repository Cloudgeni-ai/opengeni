import { useCallback, useEffect, useState } from "react";
import type { MachinesResponse } from "../types/machines";
import { usePageLiveActivity } from "./internal";

export const EMPTY_MACHINES: MachinesResponse = {
  activeSandboxId: null,
  activeEpoch: 0,
  machines: [],
};

export type SharedMachinesSnapshot = {
  data: MachinesResponse | null;
  loading: boolean;
  error: Error | null;
};

type Subscriber = {
  load: (signal?: AbortSignal) => Promise<MachinesResponse>;
  pollIntervalMs: number | undefined;
  enabled: boolean;
  pageLive: boolean;
  onChange: () => void;
};

type Share = {
  snapshot: SharedMachinesSnapshot;
  subscribers: Set<Subscriber>;
  timer: ReturnType<typeof setTimeout> | null;
  disposeTimer: ReturnType<typeof setTimeout> | null;
  abort: AbortController | null;
  inFlight: Promise<void> | null;
  trailing: Promise<void> | null;
  generation: number;
};

const shares = new Map<string, Share>();

function emit(share: Share): void {
  for (const subscriber of share.subscribers) {
    subscriber.onChange();
  }
}

function effective(share: Share): { enabled: boolean; pollIntervalMs: number | undefined } {
  let enabled = false;
  let pollIntervalMs: number | undefined;
  for (const subscriber of share.subscribers) {
    if (!subscriber.enabled || !subscriber.pageLive) continue;
    enabled = true;
    if (subscriber.pollIntervalMs !== undefined && subscriber.pollIntervalMs > 0) {
      pollIntervalMs =
        pollIntervalMs === undefined
          ? subscriber.pollIntervalMs
          : Math.min(pollIntervalMs, subscriber.pollIntervalMs);
    }
  }
  return { enabled, pollIntervalMs };
}

function latestLoad(share: Share): ((signal?: AbortSignal) => Promise<MachinesResponse>) | null {
  let load: ((signal?: AbortSignal) => Promise<MachinesResponse>) | null = null;
  for (const subscriber of share.subscribers) {
    if (subscriber.enabled && subscriber.pageLive) load = subscriber.load;
  }
  return load;
}

function stopTimer(share: Share): void {
  if (share.timer !== null) {
    clearTimeout(share.timer);
    share.timer = null;
  }
}

function cancelDispose(share: Share): void {
  if (share.disposeTimer !== null) {
    clearTimeout(share.disposeTimer);
    share.disposeTimer = null;
  }
}

function arm(share: Share): void {
  stopTimer(share);
  const { enabled, pollIntervalMs } = effective(share);
  if (!enabled || pollIntervalMs === undefined) return;
  share.timer = setTimeout(() => {
    share.timer = null;
    void run(share).finally(() => arm(share));
  }, pollIntervalMs);
}

async function runFresh(share: Share): Promise<void> {
  const load = latestLoad(share);
  if (!load) return;
  const ticket = ++share.generation;
  const abort = new AbortController();
  share.abort = abort;
  try {
    const data = await load(abort.signal);
    if (ticket !== share.generation || abort.signal.aborted) return;
    share.snapshot = { data, loading: false, error: null };
    emit(share);
  } catch (cause) {
    if (ticket !== share.generation || abort.signal.aborted) return;
    share.snapshot = {
      data: share.snapshot.data,
      loading: false,
      error: cause instanceof Error ? cause : new Error(String(cause)),
    };
    emit(share);
  } finally {
    if (share.abort === abort) share.abort = null;
  }
}

function run(share: Share, force = false): Promise<void> {
  if (!force && share.inFlight) return share.inFlight;
  if (force && share.inFlight) {
    if (share.trailing) return share.trailing;
    const trailing = share.inFlight
      .then(async () => {
        if (!effective(share).enabled) return;
        await run(share);
      })
      .finally(() => {
        if (share.trailing === trailing) share.trailing = null;
      });
    share.trailing = trailing;
    return trailing;
  }
  const promise = runFresh(share).finally(() => {
    if (share.inFlight === promise) share.inFlight = null;
  });
  share.inFlight = promise;
  return promise;
}

function reconcile(share: Share): void {
  const { enabled } = effective(share);
  if (!enabled) {
    share.generation += 1;
    share.abort?.abort();
    share.abort = null;
    share.inFlight = null;
    stopTimer(share);
    if (share.snapshot.loading) {
      share.snapshot = { ...share.snapshot, loading: false };
      emit(share);
    }
    return;
  }
  if (share.snapshot.data !== null || share.snapshot.error) {
    arm(share);
    return;
  }
  share.snapshot = { ...share.snapshot, loading: true };
  emit(share);
  void run(share).finally(() => arm(share));
}

function getOrCreate(shareKey: string): Share {
  const existing = shares.get(shareKey);
  if (existing) {
    cancelDispose(existing);
    return existing;
  }
  const created: Share = {
    snapshot: { data: null, loading: true, error: null },
    subscribers: new Set(),
    timer: null,
    disposeTimer: null,
    abort: null,
    inFlight: null,
    trailing: null,
    generation: 0,
  };
  shares.set(shareKey, created);
  return created;
}

export async function refreshSharedMachinesList(shareKey: string): Promise<void> {
  const share = shares.get(shareKey);
  if (!share) return;
  await run(share, true);
}

export function useSharedMachinesList(
  shareKey: string,
  load: (signal?: AbortSignal) => Promise<MachinesResponse>,
  options: { pollIntervalMs?: number | undefined; enabled?: boolean | undefined } = {},
): SharedMachinesSnapshot & { refresh: () => Promise<void> } {
  const enabled = options.enabled ?? true;
  const pageLive = usePageLiveActivity();
  const [, setRevision] = useState(0);
  const live = shares.get(shareKey)?.snapshot;
  const view = live ?? { data: null, loading: enabled && pageLive, error: null };

  useEffect(() => {
    const share = getOrCreate(shareKey);
    const subscriber: Subscriber = {
      load,
      pollIntervalMs: options.pollIntervalMs,
      enabled,
      pageLive,
      onChange: () => setRevision((revision) => revision + 1),
    };
    share.subscribers.add(subscriber);
    setRevision((revision) => revision + 1);
    reconcile(share);
    return () => {
      share.subscribers.delete(subscriber);
      if (share.subscribers.size > 0) {
        reconcile(share);
        return;
      }
      // Abort immediately so a session switch does not keep the old GET alive.
      // Keep the snapshot one tick so a same-key remount (poll-interval change)
      // does not flash an empty fleet.
      share.generation += 1;
      share.abort?.abort();
      share.abort = null;
      share.inFlight = null;
      share.trailing = null;
      stopTimer(share);
      cancelDispose(share);
      share.disposeTimer = setTimeout(() => {
        share.disposeTimer = null;
        if (share.subscribers.size === 0 && shares.get(shareKey) === share) {
          shares.delete(shareKey);
        }
      }, 0);
    };
  }, [shareKey, load, options.pollIntervalMs, enabled, pageLive]);

  const refresh = useCallback(() => refreshSharedMachinesList(shareKey), [shareKey]);
  return { ...view, refresh };
}
