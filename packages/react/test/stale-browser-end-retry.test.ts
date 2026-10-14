import { describe, expect, test } from "bun:test";
import { staleBrowserEndRetryDelayMs } from "../src/components/browser-viewer";

describe("staleBrowserEndRetryDelayMs", () => {
  test("never retries a refusal", () => {
    for (const status of [400, 403, 404, 409, 422]) {
      expect(staleBrowserEndRetryDelayMs({ status }, 1)).toBeNull();
    }
  });

  test("retries a transient failure with backoff, then stops", () => {
    expect(staleBrowserEndRetryDelayMs({ status: 503 }, 1)).toBe(5_000);
    expect(staleBrowserEndRetryDelayMs(new TypeError("fetch failed"), 2)).toBe(10_000);
    expect(staleBrowserEndRetryDelayMs({ status: 500 }, 3)).toBeNull();
  });
});
