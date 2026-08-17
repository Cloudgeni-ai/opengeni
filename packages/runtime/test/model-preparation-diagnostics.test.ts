import { describe, expect, test } from "bun:test";
import {
  recordModelPreparationMeasurement,
  recordModelTransportStarted,
  recordModelPreparationManifestInventory,
  type ModelPreparationMeasurement,
  withModelPreparationObserver,
  withModelTransportStartedObserver,
} from "../src/model-preparation-diagnostics";
import { instrumentedModelFetch } from "../src/model-provider-client";

describe("model preparation diagnostics", () => {
  test("separates the SDK tail after the first routed sandbox operation", () => {
    const measurements: ModelPreparationMeasurement[] = [];

    withModelPreparationObserver(
      (measurement) => measurements.push(measurement),
      () => {
        recordModelPreparationMeasurement({
          phase: "sandbox_first_routed_operation",
          outcome: "completed",
          durationSeconds: 0.01,
        });
        recordModelPreparationMeasurement({
          phase: "sandbox_first_routed_resolution",
          outcome: "completed",
          durationSeconds: 0.005,
        });
        recordModelPreparationMeasurement({
          phase: "input_filter_base",
          outcome: "completed",
          durationSeconds: 0,
        });
        recordModelPreparationMeasurement({
          phase: "input_filter_context",
          outcome: "completed",
          durationSeconds: 0,
        });
      },
    );

    expect(measurements.map(({ phase }) => phase)).toEqual([
      "sandbox_first_routed_operation",
      "sandbox_first_routed_resolution",
      "sdk_after_first_sandbox_operation",
      "input_filter_base",
      "input_filter_context",
    ]);
    expect(
      measurements.find(({ phase }) => phase === "sdk_after_first_sandbox_operation")
        ?.durationSeconds,
    ).toBeGreaterThanOrEqual(0);
  });

  test("manifest inventory remains fail-open when iteration throws", () => {
    const measurements: ModelPreparationMeasurement[] = [];
    const manifest = {
      iterEntries(): Generator<never, void, unknown> {
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

  test("awaits the attempt-local checkpoint before generic transport work", async () => {
    const order: string[] = [];
    await withModelTransportStartedObserver(
      async () => {
        await Promise.resolve();
        order.push("durable-checkpoint");
      },
      async () => {
        await recordModelTransportStarted();
        order.push("wire");
      },
    );
    expect(order).toEqual(["durable-checkpoint", "wire"]);
  });

  test("the instrumented model fetch cannot enter the wire before the checkpoint", async () => {
    const order: string[] = [];
    const transport = instrumentedModelFetch("provider-test", (async () => {
      order.push("wire");
      return new Response("{}", { status: 200 });
    }) as typeof fetch);

    await withModelTransportStartedObserver(
      async () => {
        await Promise.resolve();
        order.push("durable-checkpoint");
      },
      () =>
        transport("https://api.openai.com/v1/responses", {
          method: "POST",
          body: "{}",
        }),
    );
    expect(order).toEqual(["durable-checkpoint", "wire"]);
  });
});
