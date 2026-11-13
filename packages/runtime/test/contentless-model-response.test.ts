import { describe, expect, test } from "bun:test";
import type { AgentOutputItem, StreamEvent } from "@openai/agents";
import { SandboxAgent } from "@openai/agents/sandbox";
import { assistantMessage, functionCall, ScriptedModel } from "@opengeni/testing/scripted-model";
import { testSettings } from "@opengeni/testing/settings";
import {
  buildOpenGeniAgent,
  isContentlessModelResponse,
  runAgentStream,
  stoppedAtOutputLimit,
} from "../src/index";
import { preemptedResponseDone } from "../src/model-preemption";

const done = (output: unknown[], providerData?: Record<string, unknown>): StreamEvent =>
  ({
    type: "response_done",
    response: {
      id: "r",
      usage: { requests: 1, inputTokens: 1, outputTokens: 3, totalTokens: 4 },
      output,
      ...(providerData ? { providerData } : {}),
    },
  }) as StreamEvent;

const reasoning = {
  type: "reasoning",
  content: [{ type: "input_text", text: "thinking" }],
} as unknown as AgentOutputItem;

describe("contentless model response", () => {
  test("no output, whitespace text or reasoning alone carries nothing", () => {
    expect(isContentlessModelResponse(done([]))).toBe(true);
    expect(isContentlessModelResponse(done([assistantMessage(" \n\n")]))).toBe(true);
    expect(isContentlessModelResponse(done([reasoning]))).toBe(true);
  });

  test("text, a refusal or any call carries content", () => {
    expect(isContentlessModelResponse(done([assistantMessage("Hello")]))).toBe(false);
    expect(
      isContentlessModelResponse(
        done([
          {
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "refusal", refusal: "No." }],
          },
        ]),
      ),
    ).toBe(false);
    expect(isContentlessModelResponse(done([reasoning, functionCall("run", {})]))).toBe(false);
    expect(isContentlessModelResponse(done([{ type: "hosted_tool_call", name: "web" }]))).toBe(
      false,
    );
  });

  test("a Steer's preempted response is not contentless", () => {
    const preempted = preemptedResponseDone({ output: [] }) as unknown as StreamEvent;
    expect(isContentlessModelResponse(preempted)).toBe(false);
  });

  test("an output-limit stop is read from the Responses shape and Claude's stop reason", () => {
    const limit = { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } };
    expect(stoppedAtOutputLimit(done([reasoning], limit))).toBe(true);
    expect(
      stoppedAtOutputLimit(done([reasoning], { anthropic: { stopReason: "max_tokens" } })),
    ).toBe(true);
    expect(
      stoppedAtOutputLimit(
        done([reasoning], {
          status: "incomplete",
          incomplete_details: { reason: "content_filter" },
        }),
      ),
    ).toBe(false);
    expect(stoppedAtOutputLimit(done([reasoning], { status: "completed" }))).toBe(false);
    expect(stoppedAtOutputLimit(done([reasoning]))).toBe(false);
  });
});

function sandbox(agent: ReturnType<typeof buildOpenGeniAgent>) {
  return {
    client: { backendId: "unix_local", serializeSessionState: async () => ({}) },
    session: {
      state: { manifest: (agent as SandboxAgent).defaultManifest },
      exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      execCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      createEditor: () => ({}),
      listDir: async () => [],
      readFile: async () => "",
      pathExists: async () => false,
      materializeEntry: async () => undefined,
    },
  };
}

describe("a run never re-samples after a contentless response", () => {
  const OUTPUT_LIMIT = {
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
  };

  async function runScripted(steps: ConstructorParameters<typeof ScriptedModel>[0]) {
    const settings = testSettings({ sandboxBackend: "local", webSearchEnabled: false });
    const model = new ScriptedModel(steps);
    const agent = buildOpenGeniAgent(settings, [], { model, hostedWebSearch: false });
    let handovers = 0;
    const stream = await runAgentStream(agent, "Continue", settings, {
      ownedSandbox: sandbox(agent) as never,
      onContentlessModelResponse: () => {
        handovers++;
      },
    });
    for await (const event of stream) void event;
    await stream.completed;
    return { model, handovers, finalOutput: stream.finalOutput ?? "" };
  }

  test("reasoning stopped at the output limit is continued", async () => {
    const actual = await runScripted([
      { output: [reasoning], providerData: OUTPUT_LIMIT },
      { outputText: "Answer." },
    ]);
    expect(actual.model.calls).toBe(2);
    expect(actual.handovers).toBe(0);
    expect(actual.finalOutput).toBe("Answer.");
  });

  test("output-limited reasoning is continued at most three times in a row", async () => {
    const actual = await runScripted([
      { output: [reasoning], providerData: OUTPUT_LIMIT },
      { output: [reasoning], providerData: OUTPUT_LIMIT },
      { output: [reasoning], providerData: OUTPUT_LIMIT },
      { output: [reasoning], providerData: OUTPUT_LIMIT },
      { outputText: "never sampled" },
    ]);
    expect(actual.model.calls).toBe(4);
    expect(actual.handovers).toBe(1);
    expect(actual.finalOutput).toBe("");
  });

  test("an empty response at the output limit is still contentless", async () => {
    const actual = await runScripted([
      { output: [], providerData: OUTPUT_LIMIT },
      { outputText: "never sampled" },
    ]);
    expect(actual.model.calls).toBe(1);
    expect(actual.handovers).toBe(1);
  });

  for (const [name, output] of [
    ["no output", []],
    ["reasoning only", [reasoning]],
  ] as const) {
    test(`${name}: the run ends at the next step boundary with an empty output`, async () => {
      const settings = testSettings({ sandboxBackend: "local", webSearchEnabled: false });
      // Without the bound the SDK would sample again and get this reply.
      const model = new ScriptedModel([{ output: [...output] }, { outputText: "second sample" }]);
      const agent = buildOpenGeniAgent(settings, [], { model, hostedWebSearch: false });
      let handovers = 0;
      const stream = await runAgentStream(agent, "Continue", settings, {
        ownedSandbox: sandbox(agent) as never,
        onContentlessModelResponse: () => {
          handovers++;
        },
      });
      for await (const event of stream) void event;
      await stream.completed;
      expect(model.calls).toBe(1);
      expect(handovers).toBe(1);
      expect(stream.finalOutput ?? "").toBe("");
    });
  }

  test("a reply with text ends the run without a handover", async () => {
    const settings = testSettings({ sandboxBackend: "local", webSearchEnabled: false });
    const answered = new ScriptedModel("Hello");
    const answeringAgent = buildOpenGeniAgent(settings, [], {
      model: answered,
      hostedWebSearch: false,
    });
    let answeredHandovers = 0;
    const answeredStream = await runAgentStream(answeringAgent, "Hi", settings, {
      ownedSandbox: sandbox(answeringAgent) as never,
      onContentlessModelResponse: () => {
        answeredHandovers++;
      },
    });
    for await (const event of answeredStream) void event;
    await answeredStream.completed;
    expect(answered.calls).toBe(1);
    expect(answeredHandovers).toBe(0);
    expect(answeredStream.finalOutput).toBe("Hello");
  });
});
