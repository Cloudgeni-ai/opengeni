import { expect, spyOn, test } from "bun:test";
import { createObservability } from "../src/index";

test("public telemetry keeps bounded SDK versions and drops malformed values", () => {
  const output = spyOn(console, "log").mockImplementation(() => {});
  try {
    const observability = createObservability(
      {
        serviceName: "opengeni",
        environment: "test",
        observabilityStructuredLogs: true,
        observabilityMetricsEnabled: false,
      },
      { component: "api" },
    );
    for (const value of [
      "4.6.1",
      "5.5.2-canary.41014501986001",
      "6.5.1+build.2",
      "unknown",
      `1.2.3-${"x".repeat(81)}`,
    ]) {
      observability.info("HTTP request completed", {
        sdkVersion: value,
        "opengeni.sdk.version": value,
      });
      const line = JSON.parse(String(output.mock.calls.at(-1)?.[0]));
      const expected = value === "unknown" || value.length > 80 ? undefined : value;
      expect(line.sdkVersion).toBe(expected);
      expect(line["opengeni.sdk.version"]).toBe(expected);
    }
  } finally {
    output.mockRestore();
  }
});
