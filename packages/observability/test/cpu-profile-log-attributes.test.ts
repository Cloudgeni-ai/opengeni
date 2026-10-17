import { expect, test } from "bun:test";
import { createObservability } from "../src";

test("structured logs keep CPU profile summary attributes", () => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    const observability = createObservability(
      { observabilityStructuredLogs: true, serviceName: "opengeni", environment: "test" } as never,
      { component: "api" },
    );
    observability.info("cpu sampling profile completed", {
      cpuProfilePath: "/tmp/opengeni-cpu-profile-1-1792201865703.json",
      cpuProfileWindowMs: 30_000,
      cpuProfileSamples: 6015,
      cpuProfileBusyMs: 11_180,
      cpuProfileLongestBlockMs: 1425,
      cpuProfileBlocksOver100Ms: 4,
      cpuProfileTopSelf: "419 fnv1a64 chunk-7g1azxyq.js:210:277843 | 416 asUintN",
      cpuProfileLongestBlockTopStack:
        "asUintN < fnv1a64 chunk-7g1azxyq.js:210:277869 < (anonymous) < processTicksAndRejections",
    });
    observability.info("cpu sampling profile completed", {
      cpuProfileTopSelf: 'leak "quoted request text"',
    });
  } finally {
    console.log = original;
  }
  const [kept, rejected] = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(kept).toMatchObject({
    cpuProfilePath: "/tmp/opengeni-cpu-profile-1-1792201865703.json",
    cpuProfileBusyMs: 11_180,
    cpuProfileLongestBlockMs: 1425,
    cpuProfileTopSelf: "419 fnv1a64 chunk-7g1azxyq.js:210:277843 | 416 asUintN",
  });
  expect(rejected).not.toHaveProperty("cpuProfileTopSelf");
});
