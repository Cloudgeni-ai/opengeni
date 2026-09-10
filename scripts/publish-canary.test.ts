import { describe, expect, test } from "bun:test";
import { nextCanaryVersion, planCanaryVersions } from "./publish-canary";

describe("nextCanaryVersion", () => {
  test("starts at canary.0 from a stable version", () => {
    expect(nextCanaryVersion("2.0.0", null)).toBe("2.0.0-canary.0");
  });

  test("increments N for the same base", () => {
    expect(nextCanaryVersion("2.0.0", "2.0.0-canary.3")).toBe("2.0.0-canary.4");
  });

  test("restarts at 0 when the committed base moved", () => {
    expect(nextCanaryVersion("2.1.0", "2.0.0-canary.9")).toBe("2.1.0-canary.0");
  });
});

describe("planCanaryVersions", () => {
  const packages = ["tool", "document", "presentation", "spreadsheet", "unrelated"].map((name) => ({
    name,
    version: "1.0.0",
  }));
  const fixed = [["tool", "document", "presentation", "spreadsheet"]];

  test("recovers a partial publish without splitting fixed package versions", () => {
    const versions = planCanaryVersions(
      packages,
      new Map([
        ["tool", "1.0.0-canary.6"],
        ["document", "1.0.0-canary.5"],
        ["presentation", "1.0.0-canary.5"],
        ["spreadsheet", "1.0.0-canary.5"],
        ["unrelated", "1.0.0-canary.2"],
      ]),
      fixed,
    );
    for (const name of fixed[0]!) expect(versions.get(name)).toBe("1.0.0-canary.7");
    expect(versions.get("unrelated")).toBe("1.0.0-canary.3");
  });

  test("uses the furthest published member, even when the tool is behind", () => {
    const versions = planCanaryVersions(
      packages,
      new Map([["spreadsheet", "1.0.0-canary.12"]]),
      fixed,
    );
    for (const name of fixed[0]!) expect(versions.get(name)).toBe("1.0.0-canary.13");
  });

  test("starts a new shared base at zero", () => {
    const versions = planCanaryVersions(packages, new Map([["tool", "0.9.0-canary.99"]]), fixed);
    for (const name of fixed[0]!) expect(versions.get(name)).toBe("1.0.0-canary.0");
  });

  test("refuses inconsistent or incomplete fixed groups before writing versions", () => {
    expect(() =>
      planCanaryVersions(
        [{ name: "tool", version: "2.0.0" }, ...packages.slice(1)],
        new Map(),
        fixed,
      ),
    ).toThrow("committed base version");
    expect(() => planCanaryVersions(packages.slice(1), new Map(), fixed)).toThrow(
      "not publishable",
    );
  });
});
