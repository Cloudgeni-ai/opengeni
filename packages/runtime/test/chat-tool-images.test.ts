import { expect, test } from "bun:test";
import { getOrCreateTrace } from "@openai/agents-core";
import { projectChatToolImages } from "../src/chat-tool-images";
import { OpenGeniChatCompletionsModel } from "../src/model-provider-routing";
import { withModelCallOutputBound } from "../src/model-request-capture";
import { ReplayableJsonOpenAI, requestBodyText } from "../src/replayable-json-body";

test("delivers parallel tool images as pixels after every paired result without mutating history", async () => {
  const input = [
    { role: "user", content: "Compare these images" },
    { type: "function_call", callId: "call-1", name: "view_image", arguments: "{}" },
    { type: "function_call", callId: "call-2", name: "view_image", arguments: "{}" },
    {
      type: "function_call_result",
      callId: "call-1",
      name: "view_image",
      status: "completed",
      output: [
        { type: "input_text", text: "First image" },
        { type: "input_image", image: "https://example.com/first.png", detail: "high" },
      ],
    },
    {
      type: "function_call_result",
      callId: "call-2",
      name: "view_image",
      status: "completed",
      output: { type: "image", image: { url: "https://example.com/second.png" } },
    },
  ];
  const before = structuredClone(input);
  const captured: Record<string, any>[] = [];
  const client = new ReplayableJsonOpenAI({
    apiKey: "fixture",
    baseURL: "https://example.com/v1",
    maxRetries: 0,
    fetch: async (_url, init) => {
      captured.push(JSON.parse(await requestBodyText(init?.body)));
      return Response.json({
        id: "reply",
        object: "chat.completion",
        created: 1,
        model: "fixture",
        choices: [
          { index: 0, message: { role: "assistant", content: "Compared" }, finish_reason: "stop" },
        ],
      });
    },
  });
  const model = new OpenGeniChatCompletionsModel(client, "fixture");
  await getOrCreateTrace(() =>
    model.getResponse({
      input,
      modelSettings: {},
      tools: [],
      handoffs: [],
      outputType: "text",
      tracing: false,
    } as never),
  );
  const messages = captured[0]!.messages;
  expect(messages.map((item: any) => item.role)).toEqual([
    "user",
    "assistant",
    "tool",
    "tool",
    "user",
  ]);
  expect(messages[1].tool_calls.map((call: any) => call.id)).toEqual(["call-1", "call-2"]);
  expect(messages[2].tool_call_id).toBe("call-1");
  expect(messages[3].tool_call_id).toBe("call-2");
  expect(typeof messages[2].content).toBe("string");
  expect(messages[2].content).toContain("First image");
  expect(messages[4].content.filter((part: any) => part.type === "image_url")).toEqual([
    { type: "image_url", image_url: { url: "https://example.com/first.png", detail: "high" } },
    { type: "image_url", image_url: { url: "https://example.com/second.png" } },
  ]);
  expect(messages[4].content[1].text).toContain('call "call-1", image 1');
  expect(messages[4].content[3].text).toContain('call "call-2", image 1');
  expect(input).toEqual(before);
});

test("preserves raw image detail and provider extensions across URL and inline forms", () => {
  for (const image of [
    "https://example.com/image.png",
    { url: "https://example.com/image.png" },
    { data: "AQID", mediaType: "image/png" },
    { data: new Uint8Array([1, 2, 3]), mediaType: "image/png" },
  ]) {
    const request = {
      input: [
        {
          type: "function_call_result",
          name: "view_image",
          callId: "call-1",
          output: {
            type: "image",
            image,
            detail: "high",
            providerData: { cache_control: { type: "ephemeral" } },
          },
        },
      ],
    };
    const before = structuredClone(request);
    const projected = projectChatToolImages(request as never);
    const content = (projected.input as any[]).at(-1).content;
    expect(content.at(-1)).toEqual({
      type: "input_image",
      image:
        typeof image === "object" && "data" in image
          ? "data:image/png;base64,AQID"
          : "https://example.com/image.png",
      detail: "high",
      providerData: { cache_control: { type: "ephemeral" } },
    });
    expect(request).toEqual(before);
  }
});

test("provider file references fail explicitly instead of silently dropping pixels", () => {
  expect(() =>
    projectChatToolImages({
      input: [
        {
          type: "function_call_result",
          callId: "call-1",
          name: "view_image",
          output: { type: "image", image: { fileId: "file-fixture" } },
        },
      ],
    } as never),
  ).toThrow("require a URL or inline image bytes");
});

test("ordinary tool text, image errors, and user images keep the original request", () => {
  const request = {
    input: [
      { role: "user", content: [{ type: "input_image", image: "https://example.com/image.png" }] },
      {
        type: "function_call_result",
        callId: "call-1",
        name: "view_image",
        output: "Image could not be opened",
      },
    ],
  } as never;
  expect(projectChatToolImages(request)).toBe(request);
});

for (const streamed of [false, true]) {
  for (const invalidImage of [false, true]) {
    test(`Chat images streamed=${streamed} preserve exact refund evidence for invalid=${invalidImage}`, async () => {
      let fetches = 0;
      let refunds = 0;
      const client = new ReplayableJsonOpenAI({
        apiKey: "fixture",
        maxRetries: 0,
        fetch: async () => {
          fetches += 1;
          throw new Error("ambiguous image transport");
        },
      });
      const model = new OpenGeniChatCompletionsModel(client, "fixture");
      const request = {
        input: [
          { type: "function_call", callId: "image-call", name: "view_image", arguments: "{}" },
          {
            type: "function_call_result",
            callId: "image-call",
            name: "view_image",
            output: {
              type: "image",
              image: invalidImage
                ? { fileId: "file-fixture" }
                : { url: "https://example.com/image.png" },
            },
          },
        ],
        modelSettings: {},
        tools: [],
        handoffs: [],
        outputType: "text",
        tracing: false,
      } as never;
      await expect(
        withModelCallOutputBound(
          {
            maxOutputTokens: 10,
            budgetReserved: true,
            onRequestNotDispatched: async () => {
              refunds += 1;
            },
          },
          () =>
            getOrCreateTrace(async () => {
              if (streamed) {
                for await (const _event of model.getStreamedResponse(request)) {
                  /* Drain. */
                }
              } else await model.getResponse(request);
            }),
        ),
      ).rejects.toThrow(invalidImage ? "require a URL or inline image bytes" : "Connection error");
      expect(fetches).toBe(invalidImage ? 0 : 1);
      expect(refunds).toBe(invalidImage ? 1 : 0);
    });
  }
}
