import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

const { userActivityHeaders } = await import("./user-activity");

afterAll(() => {
  GlobalRegistrator.unregister();
});

function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
}

describe("console user activity header", () => {
  test("marks requests only while the tab is visible and recently used", () => {
    setVisibility("visible");
    const loadedAt = Date.now();
    // Loading the console counts as a deliberate visit.
    expect(userActivityHeaders(loadedAt)).toEqual({ "x-opengeni-user-activity": "active" });
    // Five idle minutes later, background polling is not activity.
    expect(userActivityHeaders(loadedAt + 5 * 60_000 + 1_000)).toEqual({});

    window.dispatchEvent(new Event("keydown"));
    expect(userActivityHeaders()).toEqual({ "x-opengeni-user-activity": "active" });

    setVisibility("hidden");
    expect(userActivityHeaders()).toEqual({});
    setVisibility("visible");
  });
});
