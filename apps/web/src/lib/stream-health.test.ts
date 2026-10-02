import { describe, expect, test } from "bun:test";

import { createStreamHealthMonitor } from "./stream-health";

function harness() {
  let now = 0;
  let visible = true;
  const timers: Array<{ at: number; run: () => void; cleared: boolean }> = [];
  const reports: string[] = [];
  const monitor = createStreamHealthMonitor({
    report: (event) => reports.push(event),
    now: () => now,
    isVisible: () => visible,
    setTimer: (run, ms) => {
      const timer = { at: now + ms, run, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      (timer as { cleared: boolean }).cleared = true;
    },
  });
  const advance = (ms: number) => {
    now += ms;
    for (const timer of [...timers]) {
      if (!timer.cleared && timer.at <= now) {
        timer.cleared = true;
        timer.run();
      }
    }
  };
  return {
    monitor,
    reports,
    advance,
    setVisible(value: boolean) {
      visible = value;
      monitor.visibilityChanged();
    },
  };
}

describe("stream health", () => {
  test("a dropped live stream reports one reconnect per minute", () => {
    const { monitor, reports, advance } = harness();
    monitor.observe("connecting");
    monitor.observe("live");
    for (let flap = 0; flap < 10; flap += 1) {
      monitor.observe("reconnecting");
      advance(1_000);
      monitor.observe("live");
    }
    expect(reports).toEqual(["reconnect"]);
    advance(60_000);
    monitor.observe("reconnecting");
    expect(reports).toEqual(["reconnect", "reconnect"]);
  });

  test("reports a long disconnection after 30 visible seconds, once", () => {
    const { monitor, reports, advance, setVisible } = harness();
    monitor.observe("live");
    monitor.observe("reconnecting");
    advance(20_000);
    setVisible(false);
    // Hidden time does not count.
    advance(120_000);
    expect(reports).toEqual(["reconnect"]);
    setVisible(true);
    advance(9_000);
    expect(reports).toEqual(["reconnect"]);
    advance(1_000);
    expect(reports).toEqual(["reconnect", "long_disconnect"]);
    advance(60_000);
    expect(reports).toEqual(["reconnect", "long_disconnect"]);
  });

  test("a stream that gives up reports reconnect_exhausted; recovering cancels the timer", () => {
    const { monitor, reports, advance } = harness();
    monitor.observe("connecting");
    advance(10_000);
    monitor.observe("live");
    advance(60_000);
    expect(reports).toEqual([]);
    monitor.observe("reconnecting");
    monitor.observe("error");
    advance(60_000);
    expect(reports).toEqual(["reconnect", "reconnect_exhausted"]);
  });

  test("an idle or ended stream is not a disconnection", () => {
    const { monitor, reports, advance } = harness();
    monitor.observe("connecting");
    monitor.observe("idle");
    advance(60_000);
    monitor.observe("error");
    expect(reports).toEqual([]);
  });
});
