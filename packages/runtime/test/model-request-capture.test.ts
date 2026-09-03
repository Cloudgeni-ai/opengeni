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
