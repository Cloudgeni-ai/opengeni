import { describe, expect, test } from "bun:test";
import { RunRawModelStreamEvent } from "@openai/agents";
import { azurePreflightCommand, ensureReadableStreamFrom, normalizeSdkEvent } from "../src/index";

describe("runtime event normalization", () => {
  test("maps core SDK text deltas into session deltas", () => {
    const [event] = normalizeSdkEvent(new RunRawModelStreamEvent({
      type: "output_text_delta",
      delta: "hello",
    } as any));

    expect(event).toEqual({
      type: "agent.message.delta",
      payload: { text: "hello" },
    });
  });

  test("ignores duplicate raw Responses text delta mirror events", () => {
    const events = normalizeSdkEvent({
      type: "raw_model_stream_event",
      data: {
        type: "model",
        event: {
          type: "response.output_text.delta",
          delta: "hello",
        },
      },
    } as any);

    expect(events).toEqual([]);
  });

  test("maps tool call stream items into tool events", () => {
    const [event] = normalizeSdkEvent({
      type: "run_item_stream_event",
      item: {
        id: "item-1",
        type: "tool_call_item",
        rawItem: {
          callId: "call-1",
          type: "shell_call",
          action: { commands: ["terraform version"] },
        },
      },
    } as any);

    expect(event?.type).toBe("agent.toolCall.created");
    expect((event?.payload as { id: string }).id).toBe("call-1");
  });

  test("uses normal Azure CLI service principal preflight", () => {
    const command = azurePreflightCommand();
    expect(command).toContain("az login --service-principal");
    expect(command).toContain("az account set --subscription");
    expect(command).not.toContain("infra-agent-azure-login");
  });

  test("provides ReadableStream.from for Modal sandbox compatibility under Bun", async () => {
    ensureReadableStreamFrom();
    const stream = (ReadableStream as any).from(["a", "b"]) as ReadableStream<string>;
    const reader = stream.getReader();
    expect(await reader.read()).toEqual({ done: false, value: "a" });
    expect(await reader.read()).toEqual({ done: false, value: "b" });
    expect(await reader.read()).toEqual({ done: true, value: undefined });
  });
});
