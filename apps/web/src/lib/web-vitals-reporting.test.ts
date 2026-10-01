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

describe("web vitals sampling", () => {
  test("defaults to 25% and accepts only a rate between 0 and 1", async () => {
    const { DEFAULT_WEB_VITALS_SAMPLE_RATE, webVitalsSampleRate } =
      await import("./web-vitals-reporting");
    expect(DEFAULT_WEB_VITALS_SAMPLE_RATE).toBe(0.25);
    expect(webVitalsSampleRate(undefined)).toBe(0.25);
    expect(webVitalsSampleRate("0.1")).toBe(0.1);
    expect(webVitalsSampleRate("1")).toBe(1);
    expect(webVitalsSampleRate("0")).toBe(0);
    for (const invalid of ["", "2", "-1", "half"]) expect(webVitalsSampleRate(invalid)).toBe(0.25);
  });

  test("an unsampled page load installs no observers and reports nothing", async () => {
    const { installWebVitalsReporting } = await import("./web-vitals-reporting");
    const reported: unknown[] = [];
    installWebVitalsReporting({
      pathname: "/",
      sampleRate: 0.25,
      random: () => 0.5,
      report: (...args) => void reported.push(args),
    });
    expect(reported).toEqual([]);
  });
});
