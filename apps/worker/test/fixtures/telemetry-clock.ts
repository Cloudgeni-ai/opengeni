import type { TelemetryScheduler } from "../../src/telemetry-scheduler";

export function telemetryClock(initialMs = 100_000) {
  let time = initialMs;
  let nextId = 0;
  const timers = new Map<number, { at: number; period: number; callback: () => void }>();
  const schedule = (callback: () => void, delay: number, period = 0) => {
    const id = nextId++;
    timers.set(id, { at: time + delay, period, callback });
    return () => { timers.delete(id); };
  };
  const scheduler: TelemetryScheduler = {
    timeout: (callback, delay) => schedule(callback, delay),
    interval: (callback, period) => schedule(callback, period, period),
    defer: queueMicrotask,
  };
  return {
    now: () => time,
    scheduler,
    timers: () => timers.size,
    advance(ms: number) {
      const target = time + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        const [id, timer] = due;
        time = timer.at;
        if (timer.period) timer.at += timer.period;
        else timers.delete(id);
        timer.callback();
      }
      time = target;
    },
  };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export async function flushTelemetry() {
  // A bounded drain of the read/then/catch/finally and deferred SDK sample edges.
  for (let i = 0; i < 8; i++) await Promise.resolve();
}
