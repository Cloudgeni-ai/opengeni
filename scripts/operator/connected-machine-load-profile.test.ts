import { describe, expect, test } from "bun:test";
import {
  executeBounded,
  parseConnectedMachineLoadArgs,
  percentile,
} from "./connected-machine-load-profile";

describe("Connected Machine load profile", () => {
  test("parses a generic staircase without retaining duplicate session ids", () => {
    const args = parseConnectedMachineLoadArgs(
      [
        "--base-url",
        "https://opengeni.example.test",
        "--workspace-id",
        "workspace-1",
        "--session-id",
        "session-1,session-2",
        "--session-id",
        "session-1",
        "--stages",
        "2,20,200",
        "--requests-per-stage",
        "400",
      ],
      {},
    );

    expect(args.sessionIds).toEqual(["session-1", "session-2"]);
    expect(args.stages).toEqual([2, 20, 200]);
    expect(args.requestsPerStage).toBe(400);
    expect(args.command).toBe("echo opengeni-load-probe");
  });

  test("requires the outer HTTP timeout to exceed the machine command timeout", () => {
    expect(() =>
      parseConnectedMachineLoadArgs(
        [
          "--base-url",
          "https://opengeni.example.test",
          "--workspace-id",
          "workspace-1",
          "--session-id",
          "session-1",
          "--timeout-ms",
          "30000",
          "--request-timeout-ms",
          "30000",
        ],
        {},
      ),
    ).toThrow("--request-timeout-ms must be greater");
  });

  test("rejects an invalid base URL", () => {
    expect(() =>
      parseConnectedMachineLoadArgs(
        ["--base-url", "not a URL", "--workspace-id", "workspace-1", "--session-id", "session-1"],
        {},
      ),
    ).toThrow("--base-url must be a valid URL");
  });

  test("computes nearest-rank percentiles", () => {
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5], 95)).toBe(5);
    expect(percentile([], 99)).toBe(0);
  });

  test("never exceeds requested concurrency", async () => {
    let active = 0;
    let peak = 0;
    let completed = 0;
    await executeBounded(31, 4, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await Bun.sleep(2);
      active -= 1;
      completed += 1;
    });

    expect(completed).toBe(31);
    expect(peak).toBe(4);
  });
});
