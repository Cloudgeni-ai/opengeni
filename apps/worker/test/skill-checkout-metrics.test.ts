import { expect, test } from "bun:test";
import { createObservability } from "@opengeni/observability";
import { testSettings } from "@opengeni/testing";
import { recordSkillCheckout } from "../src/observability-metrics";

function sample(metrics: string, name: string, labels: Record<string, string>): number | null {
  const line = metrics
    .split("\n")
    .find(
      (entry) =>
        entry.startsWith(`${name}{`) &&
        Object.entries(labels).every(([key, value]) => entry.includes(`${key}="${value}"`)),
    );
  return line ? Number(line.split(" ").at(-1)) : null;
}

test("skill checkouts record bounded outcomes, phase timings, and file counts", async () => {
  const observability = createObservability(testSettings(), { component: "worker" });
  recordSkillCheckout(observability, {
    outcome: "written",
    selection: "all",
    written: 11,
    unchanged: 0,
    resolveSeconds: 0.02,
    sandboxSeconds: 0.01,
    writeSeconds: 0.2,
    totalSeconds: 0.23,
  });
  recordSkillCheckout(observability, {
    outcome: "unchanged",
    selection: "paths",
    written: 0,
    unchanged: 1,
    resolveSeconds: 0.02,
    sandboxSeconds: 0.01,
    writeSeconds: 0.1,
    totalSeconds: 0.13,
  });
  // A refused checkout never reached the sandbox, so only resolve and total run.
  recordSkillCheckout(observability, {
    outcome: "refused",
    selection: "all",
    written: 0,
    unchanged: 0,
    resolveSeconds: 0.01,
    sandboxSeconds: null,
    writeSeconds: null,
    totalSeconds: 0.01,
  });
  const metrics = await observability.prometheusMetrics();

  expect(
    sample(metrics, "opengeni_skill_checkouts_total", { outcome: "written", selection: "all" }),
  ).toBe(1);
  expect(
    sample(metrics, "opengeni_skill_checkouts_total", { outcome: "unchanged", selection: "paths" }),
  ).toBe(1);
  expect(
    sample(metrics, "opengeni_skill_checkout_duration_seconds_count", {
      phase: "write",
      outcome: "written",
    }),
  ).toBe(1);
  expect(
    sample(metrics, "opengeni_skill_checkout_duration_seconds_count", {
      phase: "sandbox",
      outcome: "refused",
    }),
  ).toBeNull();
  expect(
    sample(metrics, "opengeni_skill_checkout_duration_seconds_count", {
      phase: "total",
      outcome: "refused",
    }),
  ).toBe(1);
  expect(sample(metrics, "opengeni_skill_checkout_files_total", { result: "written" })).toBe(11);
  expect(sample(metrics, "opengeni_skill_checkout_files_total", { result: "unchanged" })).toBe(1);
});
