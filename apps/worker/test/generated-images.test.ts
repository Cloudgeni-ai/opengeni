import { describe, expect, test } from "bun:test";
import { Agent, RunContext, RunState } from "@openai/agents-core";
import {
  assertGeneratedImageHistoryRetained,
  compactGeneratedImageHistory,
  compactGeneratedImageRunState,
  compactGeneratedImageSdkEvent,
  decodeGeneratedImageBase64,
  generatedImageFromSdkEvent,
  isCompletedGeneratedImageSdkEvent,
  generatedImageIdentity,
  generatedImagesFromHistory,
  generatedImageReceiptFromUnknown,
  projectGeneratedImageHistoryForModel,
  projectGeneratedImageRunStateForModel,
  validateGeneratedImage,
  type GeneratedImageReceipt,
} from "../src/activities/generated-images";

const PNG_1X1 = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
);

const JPEG_2X3 = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x03, 0x00, 0x02, 0x03, 0x01, 0x11, 0x00, 0x02,
  0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xd9,
]);

const WEBP_2X3 = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 0x16, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58,
  0x0a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x02, 0x00, 0x00,
]);

const receipt: GeneratedImageReceipt = {
  type: "generated_image",
  artifact: {
    available: true,
    artifactId: "33333333-3333-4333-8333-333333333333",
    kind: "generated_image",
    contentType: "image/png",
    originalBytes: PNG_1X1.byteLength,
    sha256: "c".repeat(64),
    retainedAt: "2026-08-08T00:00:00.000Z",
    dimensions: { width: 1, height: 1 },
    retention: { policy: "workspace_file", expiresAt: null },
    retrieval: {
      method: "GET",
      path: "/v1/workspaces/11111111-1111-4111-8111-111111111111/artifacts/33333333-3333-4333-8333-333333333333/content",
      acceptRanges: "bytes",
      maxRangeBytes: 1024 * 1024,
    },
  },
  sandboxPath:
    "/workspace/generated-images/generated-image-33333333-3333-4333-8333-333333333333.png",
};

describe("generated image retention boundary", () => {
  test("validates real image bytes and ignores untrusted provider MIME", () => {
    const validated = validateGeneratedImage({
      bytes: PNG_1X1,
      declaredMediaType: "image/png",
    });
    expect(validated).toMatchObject({
      mediaType: "image/png",
      extension: "png",
      width: 1,
      height: 1,
      sizeBytes: PNG_1X1.byteLength,
    });
    expect(validated.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(() =>
      validateGeneratedImage({
        bytes: PNG_1X1,
        declaredMediaType: "image/webp",
      }),
    ).toThrow("MIME does not match");
    expect(validateGeneratedImage({ bytes: JPEG_2X3 })).toMatchObject({
      mediaType: "image/jpeg",
      extension: "jpg",
      width: 2,
      height: 3,
    });
    expect(validateGeneratedImage({ bytes: WEBP_2X3 })).toMatchObject({
      mediaType: "image/webp",
      extension: "webp",
      width: 2,
      height: 3,
    });
  });

  test("rejects malformed and non-canonical base64 before decoding unbounded bytes", () => {
    expect(decodeGeneratedImageBase64(Buffer.from(PNG_1X1).toString("base64"))).toEqual(PNG_1X1);
    expect(() => decodeGeneratedImageBase64("not-base64=")).toThrow();
    expect(() => decodeGeneratedImageBase64("AAAA===")).toThrow();
    expect(() => decodeGeneratedImageBase64("AB==")).toThrow("non-canonical");
    expect(() => decodeGeneratedImageBase64("AAB=")).toThrow("non-canonical");
  });

  test("extracts only a completed hosted image SDK item", () => {
    const base64 = Buffer.from(PNG_1X1).toString("base64");
    const event = {
      type: "run_item_stream_event",
      item: {
        type: "tool_call_item",
        id: "ig_1",
        rawItem: {
          type: "hosted_tool_call",
          id: "ig_1",
          name: "image_generation_call",
          status: "completed",
          output: base64,
          providerData: { type: "image_generation_call" },
        },
      },
    };
    expect(generatedImageFromSdkEvent(event)).toEqual({
      toolCallId: "ig_1",
      providerItemId: "ig_1",
      bytes: PNG_1X1,
    });
    expect(isCompletedGeneratedImageSdkEvent(event)).toBe(true);
    expect(
      isCompletedGeneratedImageSdkEvent({
        ...event,
        item: { ...event.item, rawItem: { ...event.item.rawItem, output: undefined } },
      }),
    ).toBe(true);
    expect(
      generatedImageFromSdkEvent({
        ...event,
        item: { ...event.item, type: "message_output_item" },
      }),
    ).toBeNull();
    expect(
      generatedImageFromSdkEvent({
        ...event,
        item: {
          ...event.item,
          rawItem: { ...event.item.rawItem, status: "in_progress" },
        },
      }),
    ).toBeNull();
  });

  test("supports and scrubs the SDK providerData result representation", () => {
    const base64 = Buffer.from(PNG_1X1).toString("base64");
    const raw = {
      type: "hosted_tool_call",
      id: "ig_provider_data",
      name: "image_generation_call",
      status: "completed",
      providerData: { type: "image_generation_call", result: base64 },
    };
    const event = {
      type: "run_item_stream_event",
      item: { type: "tool_call_item", id: "ig_provider_data", rawItem: raw },
    };

    expect(generatedImageFromSdkEvent(event)).toEqual({
      toolCallId: "ig_provider_data",
      providerItemId: "ig_provider_data",
      bytes: PNG_1X1,
    });
    expect(generatedImagesFromHistory([raw])).toEqual([
      {
        toolCallId: "ig_provider_data",
        providerItemId: "ig_provider_data",
        bytes: PNG_1X1,
      },
    ]);

    const compactedEvent = compactGeneratedImageSdkEvent(event, receipt) as any;
    expect(compactedEvent.item.rawItem.providerData).toEqual({
      type: "image_generation_call",
    });
    expect(JSON.stringify(compactedEvent)).not.toContain(base64);

    const compactedHistory = compactGeneratedImageHistory(
      [raw],
      new Map([["ig_provider_data", receipt]]),
    );
    expect(compactedHistory[0]?.providerData).toEqual({
      type: "image_generation_call",
    });
    expect(JSON.stringify(compactedHistory)).not.toContain(base64);
  });

  test("never decodes an already-retained history image again", () => {
    expect(
      generatedImagesFromHistory(
        [
          {
            type: "hosted_tool_call",
            id: "ig_retained",
            name: "image_generation_call",
            status: "completed",
            output: "not-base64",
          },
        ],
        new Map([["ig_retained", receipt]]),
      ),
    ).toEqual([]);
  });

  test("fails closed when a completed native history item has no retained receipt", () => {
    const item = {
      type: "hosted_tool_call",
      name: "image_generation_call",
      status: "completed",
      id: "ig_unknown_shape",
      providerData: { futureImagePayload: "opaque" },
    };
    expect(() => assertGeneratedImageHistoryRetained([item], new Map())).toThrow(
      "no retained-artifact receipt",
    );
    expect(() =>
      assertGeneratedImageHistoryRetained([item], new Map([["ig_unknown_shape", true]])),
    ).not.toThrow();
  });

  test("replaces provider bytes in event, history, and serialized run state", () => {
    const base64 = Buffer.from(PNG_1X1).toString("base64");
    const raw = {
      type: "hosted_tool_call",
      id: "ig_1",
      name: "image_generation_call",
      status: "completed",
      output: base64,
      providerData: { type: "image_generation_call" },
    };
    const event = {
      type: "run_item_stream_event",
      item: { type: "tool_call_item", id: "ig_1", rawItem: raw },
    };
    const compactedEvent = compactGeneratedImageSdkEvent(event, receipt) as any;
    expect(compactedEvent.item.rawItem.output).toEqual(receipt);
    expect(JSON.stringify(compactedEvent)).not.toContain(base64);

    const receipts = new Map([["ig_1", receipt]]);
    const history = compactGeneratedImageHistory([raw], receipts);
    expect(history[0]?.output).toEqual(receipt);
    expect(JSON.stringify(history)).not.toContain(base64);

    const state = JSON.stringify({
      originalInput: [raw],
      generatedItems: [
        {
          type: "tool_call_item",
          rawItem: raw,
          agent: { name: "image-test" },
        },
      ],
      lastProcessedResponse: {
        newItems: [
          {
            type: "tool_call_item",
            rawItem: raw,
            agent: { name: "image-test" },
          },
        ],
      },
    });
    const compactedState = compactGeneratedImageRunState(state, receipts);
    expect(compactedState).not.toContain(base64);
    expect(compactedState).toContain("generated_image");
    const parsed = JSON.parse(compactedState);
    expect(typeof parsed.generatedItems[0].rawItem.output).toBe("string");
    expect(typeof parsed.lastProcessedResponse.newItems[0].rawItem.output).toBe("string");
  });

  test("projects compact receipts to valid assistant facts on SDK resume", async () => {
    const agent = new Agent({ name: "image-test", instructions: "test" });
    const state = new RunState(new RunContext(), "hello", agent, null);
    const root = JSON.parse(state.toString());
    const raw = {
      type: "hosted_tool_call",
      id: "ig_resume",
      name: "image_generation_call",
      status: "completed",
      output: JSON.stringify(receipt),
      providerData: { type: "image_generation_call" },
    };
    const wrapper = {
      type: "tool_call_item",
      rawItem: raw,
      agent: { name: agent.name },
    };
    root.originalInput = [raw];
    root.generatedItems = [wrapper];
    root.modelResponses = [{ usage: root.context.usage, output: [raw] }];
    root.lastModelResponse = {
      usage: root.context.usage,
      output: [raw],
    };
    root.lastProcessedResponse = {
      newItems: [wrapper],
      toolsUsed: [],
      handoffs: [],
      functions: [],
      computerActions: [],
    };

    const projected = projectGeneratedImageRunStateForModel(JSON.stringify(root));
    expect(projected).not.toContain("image_generation_call");
    expect(projected).not.toContain("ig_resume");
    expect(projected).toContain(receipt.artifact.artifactId);
    const projectedRoot = JSON.parse(projected);
    expect(projectedRoot.generatedItems[0]).toMatchObject({
      type: "message_output_item",
      rawItem: {
        type: "message",
        role: "assistant",
        status: "completed",
      },
    });
    expect(projectedRoot.lastProcessedResponse.newItems[0].type).toBe("message_output_item");

    const resumed = await RunState.fromString(agent, projected);
    const reparsed = JSON.parse(resumed.toString());
    expect(reparsed.generatedItems[0].type).toBe("message_output_item");
    expect(reparsed.generatedItems[0].rawItem.content[0].text).toContain(receipt.sandboxPath);
  });

  test("parses only the closed permanent receipt shape", () => {
    expect(generatedImageReceiptFromUnknown(receipt)).toEqual(receipt);
    expect(generatedImageReceiptFromUnknown(JSON.stringify(receipt))).toEqual(receipt);
    expect(generatedImageReceiptFromUnknown({ ...receipt, extra: true })).toBeNull();
    expect(
      generatedImageReceiptFromUnknown({
        ...receipt,
        sandboxPath: "/workspace/../secret.png",
      }),
    ).toBeNull();
    expect(
      generatedImageReceiptFromUnknown({
        ...receipt,
        sandboxPath:
          "/workspace/generated-images/generated-image-44444444-4444-4444-8444-444444444444.png",
      }),
    ).toBeNull();
  });

  test("projects native receipts to one stable provider-neutral model fact", () => {
    const ordinary = { type: "message", role: "user", content: "keep me" };
    const unchanged = [ordinary];
    expect(projectGeneratedImageHistoryForModel(unchanged)).toBe(unchanged);

    const projected = projectGeneratedImageHistoryForModel([
      ordinary,
      {
        type: "hosted_tool_call",
        id: "provider-secret-id",
        name: "image_generation_call",
        status: "completed",
        output: receipt,
        providerData: { type: "image_generation_call" },
      },
    ]);
    expect(projected).toHaveLength(2);
    expect(projected[0]).toBe(ordinary);
    const encoded = JSON.stringify(projected[1]);
    expect(encoded).toContain(receipt.artifact.artifactId);
    expect(encoded).toContain(receipt.sandboxPath);
    expect(encoded).not.toContain("provider-secret-id");
    expect(encoded).not.toContain("providerData");
  });

  test("uses durable provider or tool identities, never transient attempt identity", () => {
    const shared = {
      workspaceId: "11111111-1111-4111-8111-111111111111",
      sessionId: "22222222-2222-4222-8222-222222222222",
      turnId: "44444444-4444-4444-8444-444444444444",
      providerId: "openai",
      providerBindingHash: "d".repeat(64),
      toolCallId: "ig_1",
    };
    const native = generatedImageIdentity({
      ...shared,
      sourceStrategy: "native_hosted",
      providerItemId: "ig_provider_1",
    });
    expect(
      generatedImageIdentity({
        ...shared,
        sessionId: "55555555-5555-4555-8555-555555555555",
        turnId: "66666666-6666-4666-8666-666666666666",
        sourceStrategy: "native_hosted",
        providerItemId: "ig_provider_1",
      }),
    ).toEqual(native);

    const adapter = generatedImageIdentity({
      ...shared,
      sourceStrategy: "provider_adapter",
      providerItemId: null,
    });
    expect(
      generatedImageIdentity({
        ...shared,
        turnId: "66666666-6666-4666-8666-666666666666",
        sourceStrategy: "provider_adapter",
        providerItemId: null,
      }).settlementKey,
    ).not.toBe(adapter.settlementKey);
  });
});
