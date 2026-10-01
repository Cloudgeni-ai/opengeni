import { describe, expect, test } from "bun:test";
import { getOrCreateTrace, OpenAIChatCompletionsModel, OpenAIResponsesModel } from "@openai/agents";
import type { ModelRequest } from "@openai/agents";
import { BadRequestError } from "openai";
import {
  markModelPreparationFirstSandboxOperation,
  recordModelPreparationMeasurement,
  recordModelTransportStarted,
  recordModelPreparationManifestInventory,
  type ModelPreparationMeasurement,
  withModelPreparationObserver,
  withModelTransportStartedObserver,
} from "../src/model-preparation-diagnostics";
import { instrumentedModelFetch } from "../src/model-provider-client";
import { ModelRequestCaptureModel, withModelCallLifecycle } from "../src/model-request-capture";
import { ReplayableJsonOpenAI } from "../src/replayable-json-body";

// Runtime receives admission errors from its host; it must preserve their
// identity and fields without depending on a worker/core error class.
class UsageAllowanceExceededError extends Error {
  readonly code = "allowance_exhausted";
  readonly refusal = {
    code: "allowance_exhausted",
    scope: "member",
    subjectId: "human:test",
    resetsAt: "2026-10-01T00:00:00.000Z",
    message: "Member allowance exhausted before provider dispatch",
  };

  constructor() {
    super("Member allowance exhausted before provider dispatch");
    this.name = "UsageAllowanceExceededError";
  }
}

describe("model preparation diagnostics", () => {
  test("splits SDK work around the first sandbox operation without an overlapping parent", () => {
    const measurements: ModelPreparationMeasurement[] = [];

    withModelPreparationObserver(
      (measurement) => measurements.push(measurement),
      () => {
        markModelPreparationFirstSandboxOperation(0.01);
        recordModelPreparationMeasurement({
          phase: "sandbox_first_routed_resolution_other",
          outcome: "completed",
          durationSeconds: 0.004,
        });
        recordModelPreparationMeasurement({
          phase: "mcp_tools_snapshot",
          outcome: "completed",
          durationSeconds: 0.002,
        });
        recordModelPreparationMeasurement({
          phase: "input_filter_base",
          outcome: "completed",
          durationSeconds: 0,
        });
      },
    );

    expect(measurements.map(({ phase }) => phase)).toEqual([
      "runner_before_first_sandbox_operation",
      "sandbox_first_routed_resolution_other",
      "sdk_after_first_sandbox_operation",
      "mcp_tools_snapshot",
      "mcp_tools_before_input_filter",
      "input_filter_base",
    ]);
    expect(measurements.some(({ phase }) => phase === "runner_before_mcp_tools")).toBe(false);
  });

  test("attributes repository skill discovery without charging it to surrounding SDK gaps", () => {
    const measurements: ModelPreparationMeasurement[] = [];

    withModelPreparationObserver(
      (measurement) => measurements.push(measurement),
      () => {
        recordModelPreparationMeasurement({
          phase: "mcp_tools_snapshot",
          outcome: "completed",
          durationSeconds: 0,
        });
        markModelPreparationFirstSandboxOperation(0.001);
        recordModelPreparationMeasurement({
          phase: "sandbox_first_routed_provider_operation",
          outcome: "completed",
          durationSeconds: 0.001,
        });
        recordModelPreparationMeasurement({
          phase: "repository_skill_discovery",
          outcome: "completed",
          durationSeconds: 0.01,
          count: 10,
        });
        recordModelPreparationMeasurement({
          phase: "input_filter_base",
          outcome: "completed",
          durationSeconds: 0,
        });
      },
    );

    expect(measurements.map(({ phase }) => phase)).toEqual([
      "runner_before_mcp_tools",
      "mcp_tools_snapshot",
      "sandbox_first_routed_provider_operation",
      "mcp_tools_before_repository_skill_discovery",
      "repository_skill_discovery",
      "repository_skill_discovery_before_input_filter",
      "input_filter_base",
    ]);
    expect(measurements.find(({ phase }) => phase === "repository_skill_discovery")).toMatchObject({
      outcome: "completed",
      count: 10,
    });
    const discoverySeconds = measurements.find(
      ({ phase }) => phase === "repository_skill_discovery",
    )!.durationSeconds;
    const routedSandboxSeconds = measurements.find(
      ({ phase }) => phase === "sandbox_first_routed_provider_operation",
    )!.durationSeconds;
    expect(discoverySeconds).toBeLessThan(0.01);
    expect(discoverySeconds + routedSandboxSeconds).toBeLessThanOrEqual(0.0105);
    expect(
      measurements.some(
        ({ phase }) =>
          phase === "sdk_after_first_sandbox_operation" ||
          phase === "mcp_tools_before_input_filter",
      ),
    ).toBe(false);
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

  for (const protocol of ["responses", "chat"] as const) {
    for (const streamed of [false, true]) {
      test(`preserves typed allowance refusal between model entry and ${protocol} fetch without SDK retries (${streamed ? "streamed" : "non-streamed"})`, async () => {
        const refusal = new UsageAllowanceExceededError();
        let admissionChecks = 0;
        let sdkFetchCalls = 0;
        let wireCalls = 0;
        let checkpointCalls = 0;
        const transport = instrumentedModelFetch("provider-test", (async () => {
          wireCalls += 1;
          throw new Error("refused request must not reach the wire");
        }) as typeof fetch);
        const client = new ReplayableJsonOpenAI({
          apiKey: "test-key",
          maxRetries: 2,
          fetch: (async (input, init) => {
            sdkFetchCalls += 1;
            return transport(input, init);
          }) as typeof fetch,
        });
        const model = new ModelRequestCaptureModel(
          protocol === "responses"
            ? new OpenAIResponsesModel(client, "test-model")
            : new OpenAIChatCompletionsModel(client, "test-model"),
        );
        const request: ModelRequest = {
          input: "test",
          modelSettings: {},
          tools: [],
          handoffs: [],
          outputType: "text",
          tracing: false,
        };
        let caught: unknown;
        await withModelCallLifecycle(
          {
            beforeModelRequest: async () => {
              admissionChecks += 1;
              // Model entry was admitted; capacity exhausts during SDK
              // preparation, before the transport's second admission check.
              if (admissionChecks > 1) throw refusal;
            },
          },
          () =>
            withModelTransportStartedObserver(
              () => {
                checkpointCalls += 1;
              },
              async () => {
                try {
                  if (streamed) {
                    for await (const _event of model.getStreamedResponse(request)) {
                      throw new Error("refused request must not produce model events");
                    }
                  } else {
                    await getOrCreateTrace(() => model.getResponse(request));
                  }
                } catch (error) {
                  caught = error;
                }
              },
            ),
        );
        expect(caught).toBe(refusal);
        expect(caught).toBeInstanceOf(UsageAllowanceExceededError);
        expect(admissionChecks).toBe(2);
        expect(sdkFetchCalls).toBe(1);
        expect(wireCalls).toBe(0);
        expect(checkpointCalls).toBe(0);
      });
    }
  }

  test("isolates a transport refusal from a concurrent request sharing the SDK client", async () => {
    const refusal = new UsageAllowanceExceededError();
    let wireCalls = 0;
    const client = new ReplayableJsonOpenAI({
      apiKey: "test-key",
      maxRetries: 2,
      fetch: instrumentedModelFetch("provider-test", (async () => {
        wireCalls += 1;
        return Response.json({ id: "allowed-response" });
      }) as typeof fetch),
    });
    const [denied, allowed] = await Promise.allSettled([
      withModelCallLifecycle(
        {
          beforeModelRequest: async () => {
            await Promise.resolve();
            throw refusal;
          },
        },
        () => client.responses.create({ model: "test-model", input: "denied" }),
      ),
      withModelCallLifecycle({ beforeModelRequest: async () => {} }, () =>
        client.responses.create({ model: "test-model", input: "allowed" }),
      ),
    ]);
    expect(denied.status).toBe("rejected");
    if (denied.status === "rejected") expect(denied.reason).toBe(refusal);
    expect(allowed.status).toBe("fulfilled");
    if (allowed.status === "fulfilled") expect(allowed.value.id).toBe("allowed-response");
    expect(wireCalls).toBe(1);
    // A later request through the same client must not retain the refusal.
    expect((await client.responses.create({ model: "test-model", input: "later" })).id).toBe(
      "allowed-response",
    );
    expect(wireCalls).toBe(2);
  });

  test("preserves a failed durable checkpoint without SDK retries or wire work", async () => {
    const failure = new Error("durable checkpoint unavailable");
    let checkpointCalls = 0;
    let wireCalls = 0;
    const client = new ReplayableJsonOpenAI({
      apiKey: "test-key",
      maxRetries: 2,
      fetch: instrumentedModelFetch("provider-test", (async () => {
        wireCalls += 1;
        return Response.json({});
      }) as typeof fetch),
    });
    await expect(
      withModelTransportStartedObserver(
        () => {
          checkpointCalls += 1;
          throw failure;
        },
        async () => await client.responses.create({ model: "test-model", input: "test" }),
      ),
    ).rejects.toBe(failure);
    expect(checkpointCalls).toBe(1);
    expect(wireCalls).toBe(0);
  });

  test("does not reinterpret a provider response with refusal-shaped fields", async () => {
    const client = new ReplayableJsonOpenAI({
      apiKey: "test-key",
      maxRetries: 2,
      fetch: instrumentedModelFetch("provider-test", (async () =>
        Response.json(
          { error: { code: "allowance_exhausted", message: "provider error" } },
          { status: 400, headers: { "x-should-retry": "false" } },
        )) as typeof fetch),
    });
    await expect(
      Promise.resolve(client.responses.create({ model: "test-model", input: "test" })),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  test("native transports still throw the exact admission error", async () => {
    const refusal = new UsageAllowanceExceededError();
    let wireCalls = 0;
    const transport = instrumentedModelFetch("provider-test", (async () => {
      wireCalls += 1;
      return Response.json({});
    }) as typeof fetch);
    await expect(
      withModelCallLifecycle(
        {
          beforeModelRequest: async () => {
            throw refusal;
          },
        },
        () => transport("https://api.openai.com/v1/responses", { method: "POST", body: "{}" }),
      ),
    ).rejects.toBe(refusal);
    expect(wireCalls).toBe(0);
  });
});
