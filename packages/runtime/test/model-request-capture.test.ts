import { describe, expect, test } from "bun:test";
import { Usage } from "@openai/agents";
import type {
  Model,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  StreamEvent,
} from "@openai/agents";
import {
  ModelRequestCaptureModel,
  ModelRequestCaptureProvider,
  notifyModelRequestCapture,
  withModelRequestCapture,
} from "../src/model-request-capture";

class InnerModel implements Model {
  requests: ModelRequest[] = [];

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    return { usage: new Usage(), output: [] };
  }

  async *getStreamedResponse(_request: ModelRequest): AsyncIterable<StreamEvent> {
    yield {
      type: "response_done",
      response: {
        id: "r1",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        output: [],
      },
    } as StreamEvent;
  }
}

class InnerProvider implements ModelProvider {
  constructor(private readonly model: Model) {}
  async getModel(): Promise<Model> {
    return this.model;
  }
}

function requestWith(systemInstructions: string, toolNames: string[]): ModelRequest {
  return {
    input: [],
    modelSettings: {},
    tools: toolNames.map((name) => ({ type: "function", name })),
    outputType: "text",
    tracing: false,
    systemInstructions,
  } as ModelRequest;
}

describe("model request capture", () => {
  test("captures the ModelRequest passed to getResponse, not a reconstruction", async () => {
    const inner = new InnerModel();
    const captured: ModelRequest[] = [];
    const model = new ModelRequestCaptureModel(inner);
    const sent = requestWith("# Agent instructions\n\nBe terse.", ["exec_command"]);
    await withModelRequestCapture(
      (request) => {
        captured.push(request);
      },
      async () => {
        await model.getResponse(sent);
      },
    );
    expect(captured).toHaveLength(1);
    expect(captured[0]?.systemInstructions).toBe("# Agent instructions\n\nBe terse.");
    expect(captured[0]?.tools).toEqual(sent.tools);
    expect(inner.requests[0]?.systemInstructions).toBe(captured[0]?.systemInstructions);
  });

  test("name-resolved models are wrapped so string agent.model still captures", async () => {
    const inner = new InnerModel();
    const provider = new ModelRequestCaptureProvider(new InnerProvider(inner));
    const model = await provider.getModel("gpt-5.4");
    const captured: string[] = [];
    await withModelRequestCapture(
      (request) => {
        captured.push(
          typeof request.systemInstructions === "string" ? request.systemInstructions : "",
        );
      },
      async () => {
        await model.getResponse(requestWith("sandbox-wrapped instructions", []));
      },
    );
    expect(captured).toEqual(["sandbox-wrapped instructions"]);
  });

  test("copies tools before the original request array is mutated", async () => {
    const sent = requestWith("keep me", ["exec_command"]);
    let capturedNames: string[] | undefined;
    await withModelRequestCapture(
      (request) => {
        capturedNames = (request.tools ?? []).map((tool) => (tool as { name?: string }).name ?? "");
      },
      async () => {
        const pending = notifyModelRequestCapture(sent);
        sent.tools?.splice(0, sent.tools.length);
        await pending;
      },
    );
    expect(capturedNames).toEqual(["exec_command"]);
    expect(sent.tools).toEqual([]);
  });
});

describe("final HTTP body capture", () => {
  test("invalid UTF-8 records unavailability and preserves upload bytes", async () => {
    const { captureProviderRequestBody } = await import("../src/model-request-capture");
    const receipts: unknown[] = [];
    const observer = Object.assign(() => {}, {
      onProviderRequest: (_provider: string, body: string | null, reason?: string) => {
        receipts.push({ body, reason });
      },
    });
    await withModelRequestCapture(observer, async () => {
      const bytes = new Uint8Array([0xc3, 0x28]);
      const capture = captureProviderRequestBody("test", "https://example.com", {
        body: new Blob([bytes]).stream(),
      });
      expect(new Uint8Array(await new Response(capture.init?.body).arrayBuffer())).toEqual(bytes);
      await capture.captured;
    });
    expect(receipts).toEqual([
      { body: null, reason: "The provider body could not be read as UTF-8." },
    ]);
  });
  test("observes exact provider-transformed bytes without consuming the upload", async () => {
    const { captureProviderRequestBody } = await import("../src/model-request-capture");
    const { buildProviderRequestSnapshot } = await import("../src/model-context-inspector");
    const { ModelContextSnapshot } = await import("@opengeni/contracts");
    const body =
      '{ "model":"provider-model", "instructions":"exact\\n  whitespace", "tools":[{"type":"function","strict":true,"name":"tool"}], "input":[{"role":"user","content":[{"type":"input_text","text":"hello"}]}] }';
    let observed: string | null = null;
    const capture = Object.assign(() => {}, {
      onProviderRequest: (provider: string, text: string | null) => {
        observed = text;
        const snapshot = ModelContextSnapshot.parse(
          buildProviderRequestSnapshot({ provider, body: text, requestIndex: 1 }),
        );
        expect(snapshot.providerRequest?.body).toBe(body);
        expect(snapshot.providerRequest?.parts.map((part) => part.key)).toEqual([
          "model",
          "instructions",
          "tools",
          "input",
        ]);
      },
    });
    await withModelRequestCapture(capture, async () => {
      const stream = new Blob([body]).stream();
      const result = captureProviderRequestBody("test", "https://example.test/responses", {
        body: stream,
      });
      expect(await new Response(result.init?.body).text()).toBe(body);
      await result.captured;
    });
    expect(observed).toBe(body);
  });

  test("oversized bodies produce an unavailable receipt, never a truncated payload", async () => {
    const { captureProviderRequestBody } = await import("../src/model-request-capture");
    const body = "x".repeat(4 * 1024 * 1024 + 1);
    let reason: string | undefined;
    let observed: unknown = "not called";
    const capture = Object.assign(() => {}, {
      onProviderRequest: (_provider: string, text: string | null, why?: string) => {
        observed = text;
        reason = why;
      },
    });
    await withModelRequestCapture(capture, async () => {
      const result = captureProviderRequestBody("test", "https://example.test/responses", {
        body: new Blob([body]).stream(),
      });
      expect((await new Response(result.init?.body).text()).length).toBe(body.length);
      await result.captured;
    });
    expect(observed).toBeNull();
    expect(reason).toContain("4 MiB");
  });

  test("capture failure cannot change transport bytes", async () => {
    const { captureProviderRequestBody } = await import("../src/model-request-capture");
    const capture = Object.assign(() => {}, {
      onProviderRequest: () => {
        throw new Error("database unavailable");
      },
    });
    await withModelRequestCapture(capture, async () => {
      const init = { body: '{"input":"unchanged"}' };
      const result = captureProviderRequestBody("test", "https://example.test/responses", init);
      expect(result.init).toBe(init);
      await result.captured;
    });
  });
});

test("failed uploads cancel a stalled diagnostic read without waiting for persistence", async () => {
  const { captureProviderRequestBody } = await import("../src/model-request-capture");
  let captured = false;
  await withModelRequestCapture(
    Object.assign(() => {}, {
      onProviderRequest: () => {
        captured = true;
      },
    }),
    async () => {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"input":'));
        },
      });
      const result = captureProviderRequestBody("test", "https://example.test/responses", { body });
      result.cancel();
      await result.captured;
      expect(captured).toBe(false);
      void (result.init!.body as ReadableStream).cancel();
    },
  );
});

test("capture ordinals survive stream re-entry and remain isolated between agents", async () => {
  const { nextModelContextCaptureIndex } = await import("../src/model-request-capture");
  const agent = {};
  const otherAgent = {};
  expect(nextModelContextCaptureIndex(agent)).toBe(1);
  expect(nextModelContextCaptureIndex(agent)).toBe(2);
  expect(nextModelContextCaptureIndex(otherAgent)).toBe(1);
  expect(nextModelContextCaptureIndex(agent)).toBe(3);
});

test("media and encrypted state are unknown token costs, not base64 text estimates", async () => {
  const { buildProviderRequestSnapshot } = await import("../src/model-context-inspector");
  const snapshot = buildProviderRequestSnapshot({
    provider: "test",
    requestIndex: 1,
    body: JSON.stringify({
      input: [
        {
          role: "user",
          content: [{ type: "input_image", image_url: "data:image/png;base64,AAAA" }],
        },
        { type: "reasoning", encrypted_content: "opaque" },
        { role: "user", content: "Plain text" },
      ],
    }),
  });
  const input = snapshot.providerRequest!.parts[0]!;
  expect(input.estimatedTokens).toBeNull();
  expect(input.itemEstimatedTokens?.slice(0, 2)).toEqual([null, null]);
  expect(input.itemEstimatedTokens?.[2]).toBeGreaterThan(0);
});
