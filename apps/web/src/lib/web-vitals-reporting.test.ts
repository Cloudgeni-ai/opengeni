import { describe, expect, test } from "bun:test";

import { webVitalPage, webVitalValue } from "./web-vitals-reporting";

describe("web vitals projection", () => {
  test("reports seconds for timings and the raw CLS score", () => {
    expect(webVitalValue("lcp", 2_500)).toBe(2.5);
    expect(webVitalValue("inp", 200)).toBe(0.2);
    expect(webVitalValue("ttfb", 800)).toBe(0.8);
    expect(webVitalValue("cls", 0.12)).toBe(0.12);
  });

  test("labels pages with the closed journey label, never an id", () => {
    expect(
      webVitalPage(
        "/workspaces/7c9e6679-7425-40de-944b-e07fc1f90ae7/sessions/0b4f8f3e-3c55-4a8b-9a3e-2f43d93a9c11",
      ),
    ).toBe("sessions");
    expect(webVitalPage("/")).toBe("home");
    expect(webVitalPage("/somewhere/else")).toBe("other");
  });
});
