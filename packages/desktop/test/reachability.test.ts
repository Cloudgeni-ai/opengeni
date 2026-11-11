import { describe, expect, test } from "bun:test";

import { MainFrameLoad, retryDelayMs } from "../src/main/reachability";

describe("main frame load", () => {
  test("a page that commits and finishes is loaded", () => {
    const load = new MainFrameLoad();
    load.navigated("https://app.example.com/w", 200);
    expect(load.finished()).toEqual({ kind: "loaded" });
  });

  test("a network failure is reported once; Chromium's error page that follows is not", () => {
    const load = new MainFrameLoad();
    expect(load.failedToLoad(-106, "https://app.example.com/w", true)).toEqual({
      kind: "failed",
      url: "https://app.example.com/w",
    });
    expect(load.finished()).toBeNull();
  });

  test("cancelled loads and subframes don't count", () => {
    const load = new MainFrameLoad();
    expect(load.failedToLoad(-3, "https://app.example.com/w", true)).toBeNull();
    expect(load.failedToLoad(-105, "https://cdn.example.com/x", false)).toBeNull();
    load.navigated("https://app.example.com/w", 200);
    expect(load.finished()).toEqual({ kind: "loaded" });
  });

  test("a proxy's server error page is a failure; client errors are the web app's own", () => {
    const load = new MainFrameLoad();
    load.navigated("https://app.example.com/w", 502);
    expect(load.finished()).toEqual({ kind: "failed", url: "https://app.example.com/w" });
    load.navigated("https://app.example.com/missing", 404);
    expect(load.finished()).toEqual({ kind: "loaded" });
  });

  test("a successful try after a failure is loaded", () => {
    const load = new MainFrameLoad();
    load.failedToLoad(-106, "https://app.example.com/w", true);
    expect(load.finished()).toBeNull();
    load.navigated("https://app.example.com/w", 200);
    expect(load.finished()).toEqual({ kind: "loaded" });
  });
});

describe("retry delay", () => {
  test("backs off quickly, then settles at 30 seconds", () => {
    expect([0, 1, 2, 3, 4, 50].map(retryDelayMs)).toEqual([
      3_000, 6_000, 12_000, 30_000, 30_000, 30_000,
    ]);
    expect(retryDelayMs(-1)).toBe(3_000);
  });
});
