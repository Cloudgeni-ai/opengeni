import { describe, expect, test } from "bun:test";
import { settings } from "./main";
import { DEFAULT_SETTINGS } from "./model";

describe("batcher settings", () => {
  test("unset or empty variables keep the defaults in milliseconds", () => {
    // The workflow passes unset repository variables as empty strings.
    for (const value of [undefined, ""])
      expect(
        settings({
          BATCHER_WINDOW_SECONDS: value,
          BATCHER_START_TIMEOUT_SECONDS: value,
          BATCHER_MAX_BATCH: value,
        }),
      ).toEqual(DEFAULT_SETTINGS);
  });

  test("set variables are read as seconds", () => {
    expect(
      settings({
        BATCHER_WINDOW_SECONDS: "30",
        BATCHER_START_TIMEOUT_SECONDS: "120",
        BATCHER_MAX_BATCH: "32",
      }),
    ).toEqual({ windowMs: 30_000, startTimeoutMs: 120_000, maxBatch: 32 });
  });
});
