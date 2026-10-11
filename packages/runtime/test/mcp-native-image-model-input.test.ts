import { describe, expect, test } from "bun:test";
import type { MCPServer } from "@openai/agents";
import {
  ScriptedModel,
  functionCall as scriptedFunctionCall,
  testSettings,
} from "@opengeni/testing";
import {
  buildOpenGeniAgent,
  normalizeSdkEvent,
  OPENGENI_MCP_RESULT_CUSTOM_DATA_KEY,
  PrefixedMcpServer,
  runAgentStream,
} from "../src";

// A tiny but real JPEG (SOI + EOI) keeps the fixture readable.
const JPEG_BASE64 = "/9j/2Q==";

function serverReturning(result: Record<string, unknown>): MCPServer {
  return {
    name: "camera-inner",
    cacheToolsList: false,
    async connect() {},
    async close() {},
    async listTools() {
      return [
        {
          name: "capture",
          description: "Capture one frame.",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
        },
      ];
    },
    async callTool() {
      return result.content as never;
    },
    async callToolResult() {
      return result as never;
    },
    async invalidateToolsCache() {},
  };
}

async function runOneCall(result: Record<string, unknown>, nested = false) {
  const inner = serverReturning(result);
  const wrapped = nested
    ? new PrefixedMcpServer(new PrefixedMcpServer(inner, "camera"), "outer")
    : new PrefixedMcpServer(inner, "camera");
  const toolName = nested ? "outer__camera__capture" : "camera__capture";
  const settings = testSettings({ sandboxBackend: "none", webSearchEnabled: false });
  const model = new ScriptedModel([
    { output: [scriptedFunctionCall(toolName, {}, "capture-call")] },
    { outputText: "done" },
  ]);
  const agent = buildOpenGeniAgent(settings, [], {
    model,
    hostedWebSearch: false,
    mcpServers: [wrapped],
  });
  const run = await runAgentStream(agent, "Capture it", settings);
  const streamed: any[] = [];
  for await (const event of run.toStream()) streamed.push(event);
  await run.completed;
  const outputEvent = streamed.find(
    (event) =>
      event.type === "run_item_stream_event" && event.item?.type === "tool_call_output_item",
  );
  const modelOutput = ((model.requests[1]?.input ?? []) as any[]).find(
    (item) => item.type === "function_call_result",
  )?.output;
  return { outputEvent, modelOutput };
}

describe("MCP tool results reach the model as native content", () => {
  test("text and image blocks become text and image model input, not serialized JSON", async () => {
    const result = {
      content: [
        { type: "text", text: "frame 1920x1080" },
        { type: "image", data: JPEG_BASE64, mimeType: "image/jpeg" },
      ],
      _meta: { providerTrace: "trace-1" },
    };
    const { outputEvent, modelOutput } = await runOneCall(result);

    expect(modelOutput).toEqual([
      { type: "input_text", text: "frame 1920x1080" },
      { type: "input_image", image: `data:image/jpeg;base64,${JPEG_BASE64}` },
    ]);
    // Protocol metadata is retained for audit, never paid for by the model.
    expect(JSON.stringify(modelOutput)).not.toContain("providerTrace");
    expect(outputEvent?.item.customData[OPENGENI_MCP_RESULT_CUSTOM_DATA_KEY]).toEqual(result);
    // The audit timeline keeps the envelope but never becomes an image store.
    const [durable] = normalizeSdkEvent(outputEvent);
    expect((durable!.payload as { output?: unknown }).output).toMatchObject({
      _meta: { providerTrace: "trace-1" },
      content: [
        { type: "text", text: "frame 1920x1080" },
        { type: "media_preview", mediaType: "image/jpeg" },
      ],
    });
  });

  test("a nested prefixed server still delivers the image natively", async () => {
    const result = {
      content: [{ type: "image", data: JPEG_BASE64, mimeType: "image/jpeg" }],
    };
    const { modelOutput } = await runOneCall(result, true);
    expect(modelOutput).toEqual([
      { type: "input_image", image: `data:image/jpeg;base64,${JPEG_BASE64}` },
    ]);
  });

  test("a text-only result reaches the model as its text", async () => {
    const { modelOutput } = await runOneCall({
      content: [{ type: "text", text: "model-visible content" }],
      _meta: { providerTrace: "trace-1" },
    });
    expect(JSON.stringify(modelOutput)).toContain("model-visible content");
    expect(JSON.stringify(modelOutput)).not.toContain("providerTrace");
    expect(JSON.stringify(modelOutput)).not.toContain('\\"content\\"');
  });

  test("structured content the text does not repeat is kept once, beside the image", async () => {
    const structuredContent = { frameId: "frame-1", width: 1920 };
    const { modelOutput } = await runOneCall({
      content: [
        { type: "text", text: JSON.stringify(structuredContent) },
        { type: "image", data: JPEG_BASE64, mimeType: "image/jpeg" },
      ],
      structuredContent,
    });
    expect(modelOutput).toEqual([
      { type: "input_image", image: `data:image/jpeg;base64,${JPEG_BASE64}` },
      { type: "input_text", text: `Structured result: ${JSON.stringify(structuredContent)}` },
    ]);
  });

  test("a tool error stays marked as an error for the model", async () => {
    const { modelOutput } = await runOneCall({
      content: [{ type: "text", text: "camera offline" }],
      isError: true,
    });
    expect(modelOutput).toEqual([
      { type: "input_text", text: "The tool reported an error." },
      { type: "input_text", text: "camera offline" },
    ]);
  });

  test("blocks the model cannot take natively are described as text without raw bytes", async () => {
    const audio = "UklGRgAAAABXQVZF";
    const { modelOutput } = await runOneCall({
      content: [
        { type: "audio", data: audio, mimeType: "audio/wav" },
        {
          type: "resource",
          resource: { uri: "file:///notes.txt", mimeType: "text/plain", text: "remember this" },
        },
        {
          type: "resource",
          resource: { uri: "file:///clip.bin", mimeType: "application/octet-stream", blob: "AAAA" },
        },
        { type: "resource_link", uri: "file:///report.pdf", name: "report.pdf" },
      ],
    });
    const text = JSON.stringify(modelOutput);
    expect(text).not.toContain(audio);
    expect(text).toContain("audio/wav");
    expect(text).toContain("remember this");
    expect(text).toContain("file:///clip.bin");
    expect(text).not.toContain('"AAAA"');
    expect(text).toContain("file:///report.pdf");
    expect((modelOutput as any[]).every((part) => part.type === "input_text")).toBe(true);
  });
});
