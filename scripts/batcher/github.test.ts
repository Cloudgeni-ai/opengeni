import { describe, expect, test } from "bun:test";
import { queuedTime } from "./github";
import { IN_BATCH_LABEL, QUEUE_LABEL } from "./model";

const event = (name: string, at: string) => ({ createdAt: at, label: { name } });

describe("queuedTime", () => {
  test("is the latest time the queue label was added", () => {
    const events = [
      event(QUEUE_LABEL, "2026-10-30T10:00:00Z"),
      event(IN_BATCH_LABEL, "2026-10-30T10:05:00Z"),
      event(QUEUE_LABEL, "2026-10-30T11:00:00Z"),
      null,
    ];
    expect(queuedTime(events, QUEUE_LABEL)).toBe(Date.parse("2026-10-30T11:00:00Z"));
  });

  test("keeps a PR queued when other labels pushed its queue event out of the window", () => {
    const events = [
      event(IN_BATCH_LABEL, "2026-10-30T12:00:00Z"),
      event(IN_BATCH_LABEL, "2026-10-30T12:30:00Z"),
    ];
    expect(queuedTime(events, QUEUE_LABEL)).toBe(Date.parse("2026-10-30T12:00:00Z"));
    expect(queuedTime([], QUEUE_LABEL)).toBe(0);
  });
});
