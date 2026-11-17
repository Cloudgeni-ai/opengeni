import { describe, expect, test } from "bun:test";
import { DEFAULT_SANDBOX_FLEET_LIMITS, parseSandboxFleetLimitsJson } from "../src/index";

describe("OPENGENI_SANDBOX_FLEET_LIMITS_JSON", () => {
  test("blank keeps the safe defaults", () => {
    expect(parseSandboxFleetLimitsJson("")).toEqual({
      limits: DEFAULT_SANDBOX_FLEET_LIMITS,
      issues: [],
    });
    expect(DEFAULT_SANDBOX_FLEET_LIMITS).toEqual({
      unpaidRunningBoxes: 40,
      unpaidBoxSecondsPerDay: 1_080_000,
      youngOrganizationAgeMs: 86_400_000,
      youngOrganizationRunningBoxes: 1,
      pressureEngageWarmBoxes: 50,
      pressureReleaseWarmBoxes: 35,
      pressureUnpaidRunningBoxes: 0,
    });
  });

  test("fields override the defaults and null removes a bound", () => {
    const { limits, issues } = parseSandboxFleetLimitsJson(
      JSON.stringify({ unpaidRunningBoxes: 12, pressureEngageWarmBoxes: null }),
    );
    expect(issues).toEqual([]);
    expect(limits.unpaidRunningBoxes).toBe(12);
    expect("pressureEngageWarmBoxes" in limits).toBe(false);
    expect(limits.unpaidBoxSecondsPerDay).toBe(1_080_000);
  });

  test("never throws: unknown fields, bad values and bad JSON keep the defaults", () => {
    const unknown = parseSandboxFleetLimitsJson(JSON.stringify({ laterField: 1 }));
    expect(unknown.limits).toEqual(DEFAULT_SANDBOX_FLEET_LIMITS);
    expect(unknown.issues).toHaveLength(1);
    for (const value of [-1, 1.5, "3", true]) {
      const bad = parseSandboxFleetLimitsJson(JSON.stringify({ unpaidRunningBoxes: value }));
      expect(bad.limits.unpaidRunningBoxes).toBe(40);
      expect(bad.issues).toHaveLength(1);
    }
    for (const raw of ["{", "[]", "3"]) {
      const bad = parseSandboxFleetLimitsJson(raw);
      expect(bad.limits).toEqual(DEFAULT_SANDBOX_FLEET_LIMITS);
      expect(bad.issues).toHaveLength(1);
    }
  });
});
