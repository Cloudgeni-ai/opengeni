import { describe, expect, test } from "bun:test";
import {
  recordModelPreparationManifestInventory,
  type ModelPreparationMeasurement,
  withModelPreparationObserver,
} from "../src/model-preparation-diagnostics";

describe("model preparation diagnostics", () => {
  test("manifest inventory remains fail-open when iteration throws", () => {
    const measurements: ModelPreparationMeasurement[] = [];
    const manifest = {
      *iterEntries(): Generator<never, void, unknown> {
        throw new Error("legacy manifest cannot normalize an entry");
      },
    };

    expect(() =>
      withModelPreparationObserver(
        (measurement) => measurements.push(measurement),
        () => recordModelPreparationManifestInventory("sandbox_agent_manifest_inventory", manifest),
      ),
    ).not.toThrow();
    expect(measurements).toHaveLength(1);
    expect(measurements[0]).toMatchObject({
      phase: "sandbox_agent_manifest_inventory",
      outcome: "failed",
      count: 0,
    });
  });
});
