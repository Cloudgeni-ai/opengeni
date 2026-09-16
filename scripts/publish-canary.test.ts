import { describe, expect, test } from "bun:test";
import { nextCanaryVersion, planCanaryVersions, workflowCanarySequence } from "./publish-canary";

describe("workflow canary sequence", () => {
  test("uses distinct safe sequences for runs and retries even with stale registry tags", () => {
    const first = workflowCanarySequence("1234", "1");
    const retry = workflowCanarySequence("1234", "2");
    const later = workflowCanarySequence("1235", "1");
    expect(first).toBe(1234001);
    expect(retry).toBeGreaterThan(first);
    expect(later).toBeGreaterThan(retry);
    expect(nextCanaryVersion("1.0.0", "1.0.0-canary.3", first)).toBe("1.0.0-canary.1234001");
    expect(nextCanaryVersion("1.0.0", null, retry)).toBe("1.0.0-canary.1234002");
    expect(() => nextCanaryVersion("1.0.0", "1.0.0-canary.1234005", first)).toThrow("superseded");
    expect(workflowCanarySequence()).toBe(0);
  });

  test("fails before publication for partial, malformed or unsafe identities", () => {
    for (const [run, attempt] of [
      ["1234", undefined],
      [undefined, "1"],
      ["bad", "1"],
      ["1", "0"],
      ["1", "1000"],
      [String(Number.MAX_SAFE_INTEGER), "1"],
    ]) {
      expect(() => workflowCanarySequence(run, attempt)).toThrow();
    }
    expect(() => nextCanaryVersion("1.0.0", null, -1)).toThrow();
    expect(() => nextCanaryVersion("1.0.0", `1.0.0-canary.${Number.MAX_SAFE_INTEGER}`)).toThrow();
  });

  test("rejects older workflow retries instead of reusing a newer invisible reservation", () => {
    for (const attempt of ["1", "2"]) {
      expect(() =>
        nextCanaryVersion("1.0.0", "1.0.0-canary.1235001", workflowCanarySequence("1234", attempt)),
      ).toThrow("dispatch a new publication run");
    }
    expect(
      nextCanaryVersion("1.0.0", "1.0.0-canary.1235001", workflowCanarySequence("1236", "1")),
    ).toBe("1.0.0-canary.1236001");
  });

  test("keeps fixed groups aligned after an earlier partial publication", () => {
    const packages = [
      { name: "a", version: "1.0.0" },
      { name: "b", version: "1.0.0" },
    ];
    const versions = planCanaryVersions(
      packages,
      new Map([
        ["a", "1.0.0-canary.1234001"],
        ["b", "1.0.0-canary.3"],
      ]),
      [["a", "b"]],
      workflowCanarySequence("1234", "2"),
    );
    expect([...versions.values()]).toEqual(["1.0.0-canary.1234002", "1.0.0-canary.1234002"]);
  });
});

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
