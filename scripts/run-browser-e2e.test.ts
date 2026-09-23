import { describe, expect, test } from "bun:test";
import { isMissingBrowserLibraryError } from "./run-browser-e2e";

describe("browser runtime library recovery", () => {
  test("recognizes loader failures and Playwright dependency preflight failures", () => {
    expect(
      isMissingBrowserLibraryError("error while loading shared libraries: libgtk-3.so.0"),
    ).toBe(true);
    expect(
      isMissingBrowserLibraryError(
        "Host system is missing dependencies to run browsers.\nMissing libraries: libgtk-3.so.0",
      ),
    ).toBe(true);
  });

  test("does not retry assertion failures, timeouts, or missing browser installations", () => {
    for (const output of [
      "expect(received).toBe(expected)",
      "TimeoutError: waitForFunction: Timeout 2000ms exceeded.",
      "Executable doesn't exist at /browser/firefox",
    ]) {
      expect(isMissingBrowserLibraryError(output)).toBe(false);
    }
  });
});
