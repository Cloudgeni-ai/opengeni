import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import type { RetainedArtifactMetadata } from "@opengeni/contracts";
import {
  collectRetainedScreenshotRunStateReceipts,
  compactRetainedScreenshotHistory,
  compactRetainedScreenshotRunState,
  collectRetainedScreenshotReceipts,
  historyImagesToOmit,
  inlineImagesFromToolResultItem,
  materializeRetainedScreenshotHistory,
  omitOlderHistoryImages,
  retainedScreenshotIdentity,
  retainedToolImagesEventOutput,
  sdkEventContainsInlineImage,
  ScreenshotValidationError,
  typedScreenshotFromSdkEvent,
  typedScreenshotFromToolOutput,
  unavailableRetainedSessionImage,
  validateComputerScreenshot,
  validateRetainableSessionImage,
} from "../src/activities/retained-screenshots";

const PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
);

const JPEG = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x03, 0x00, 0x02, 0x03, 0x01, 0x11, 0x00, 0x02,
  0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xd9,
]);

const WEBP = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 0x16, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58,
  0x0a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x02, 0x00, 0x00,
]);

describe("retained computer screenshots", () => {
  test("extracts an image before it enters SDK event history", () => {
    expect(
      typedScreenshotFromToolOutput({
        callId: "call-boundary",
        output: {
          type: "image",
          image: { url: `data:image/png;base64,${Buffer.from(PNG).toString("base64")}` },
        },
      }),
    ).toEqual({
      callId: "call-boundary",
      toolOutputId: "call-boundary",
      bytes: PNG,
      mediaType: "image/png",
    });
  });

  test("extracts the SDK typed image and validates exact PNG facts", () => {
    const output = typedScreenshotFromSdkEvent({
      type: "run_item_stream_event",
      item: {
        id: "output-1",
        type: "tool_call_output_item",
        rawItem: { callId: "call-1", id: "output-1" },
        output: { type: "image", image: { data: PNG, mediaType: "image/png" } },
      },
    });
    expect(output).toMatchObject({
      callId: "call-1",
      toolOutputId: "output-1",
    });
    expect(validateComputerScreenshot(output!)).toMatchObject({
      mediaType: "image/png",
      sizeBytes: PNG.byteLength,
      width: 1,
      height: 1,
    });
  });

  test("extracts the Agents SDK input_image data URL used by view_image", () => {
    const event = {
      type: "run_item_stream_event",
      item: {
        id: "output-view-1",
        type: "tool_call_output_item",
        rawItem: { callId: "call-view-1", id: "output-view-1" },
        output: [
          {
            type: "input_image",
            image: `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`,
          },
        ],
      },
    };
    expect(sdkEventContainsInlineImage(event)).toBe(true);
    expect(typedScreenshotFromSdkEvent(event)).toEqual({
      callId: "call-view-1",
      toolOutputId: "output-view-1",
      bytes: PNG,
      mediaType: "image/png",
    });
  });

  test("extracts bounded MCP image blocks from managed computer observations", () => {
    const event = {
      type: "run_item_stream_event",
      item: {
        id: "output-observe-1",
        type: "tool_call_output_item",
        rawItem: { callId: "call-observe-1", id: "output-observe-1" },
        output: {
          content: [
            { type: "text", text: "observation" },
            { type: "image", data: Buffer.from(JPEG).toString("base64"), mimeType: "image/jpeg" },
          ],
        },
      },
    };
    expect(sdkEventContainsInlineImage(event)).toBe(true);
    expect(typedScreenshotFromSdkEvent(event)).toEqual({
      callId: "call-observe-1",
      toolOutputId: "output-observe-1",
      bytes: JPEG,
      mediaType: "image/jpeg",
    });
  });

  test("retains the common JPEG and WebP formats returned by the Agents SDK view_image tool", () => {
    for (const [mediaType, bytes, extension] of [
      ["image/jpeg", JPEG, "jpg"],
      ["image/webp", WEBP, "webp"],
    ] as const) {
      const event = {
        type: "run_item_stream_event",
        item: {
          id: `output-${extension}`,
          type: "tool_call_output_item",
          rawItem: { callId: `call-${extension}`, id: `output-${extension}` },
          output: [
            {
              type: "input_image",
              image: `data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}`,
            },
          ],
        },
      };
      const extracted = typedScreenshotFromSdkEvent(event);
      expect(extracted).toMatchObject({ bytes, mediaType });
      expect(
        validateRetainableSessionImage({
          bytes: extracted!.bytes,
          declaredMediaType: mediaType,
        }),
      ).toMatchObject({ mediaType, extension, width: 2, height: 3 });
    }
  });

  test("uses the run item id when the live output raw item omits callId", () => {
    const event = {
      type: "run_item_stream_event",
      item: {
        id: "call-view-live",
        type: "tool_call_output_item",
        rawItem: {
          type: "function_call_result",
          output: [
            {
              type: "input_image",
              image: `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`,
            },
          ],
        },
        output: [
          {
            type: "input_image",
            image: `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`,
          },
        ],
      },
    };

    expect(typedScreenshotFromSdkEvent(event)).toMatchObject({
      callId: "call-view-live",
      toolOutputId: "call-view-live",
      mediaType: "image/png",
    });
  });

  test("extracts the live SDK input_image URL wrapper", () => {
    const event = {
      type: "run_item_stream_event",
      item: {
        id: "output-view-url",
        type: "tool_call_output_item",
        rawItem: { callId: "call-view-url" },
        output: [
          {
            type: "input_image",
            image: {
              url: `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`,
            },
          },
        ],
      },
    };

    expect(sdkEventContainsInlineImage(event)).toBe(true);
    expect(typedScreenshotFromSdkEvent(event)).toMatchObject({
      callId: "call-view-url",
      toolOutputId: "output-view-url",
      bytes: PNG,
      mediaType: "image/png",
    });
  });

  test("rejects empty, MIME-mismatched, corrupt, polyglot, and oversized input", () => {
    for (const value of [
      { bytes: new Uint8Array(), mediaType: "image/png" },
      { bytes: PNG, mediaType: "image/jpeg" },
      {
        bytes: Uint8Array.from(PNG, (byte, index) => (index === 20 ? byte ^ 1 : byte)),
        mediaType: "image/png",
      },
      {
        bytes: Uint8Array.from([...PNG, 0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e]),
        mediaType: "image/png",
      },
    ]) {
      expect(() => validateComputerScreenshot(value)).toThrow(ScreenshotValidationError);
    }
    expect(() =>
      validateComputerScreenshot(
        { bytes: PNG, mediaType: "image/png" },
        { maxBytes: PNG.byteLength - 1 },
      ),
    ).toThrow("exceeds");
  });

  test("uses retry-stable identity and compacts all RunState copies", () => {
    const identityInput = {
      sessionId: "11111111-1111-4111-8111-111111111111",
      turnId: "22222222-2222-4222-8222-222222222222",
      attemptId: "33333333-3333-4333-8333-333333333333",
      toolCallId: "call-1",
      toolOutputId: "output-1",
    };
    const identity = retainedScreenshotIdentity(identityInput);
    expect(identity).toEqual(retainedScreenshotIdentity(identityInput));
    const artifact = {
      available: true,
      artifactId: identity.artifactId,
      kind: "computer_screenshot",
      contentType: "image/png",
      originalBytes: PNG.byteLength,
      sha256: "a".repeat(64),
      retainedAt: "2026-07-31T00:00:00.000Z",
      dimensions: { width: 1, height: 1 },
      retention: {
        policy: "session_screenshot",
        expiresAt: "2026-08-30T00:00:00.000Z",
      },
      retrieval: {
        method: "GET",
        path: `/v1/workspaces/${identityInput.sessionId}/sessions/${identityInput.sessionId}/artifacts/${identity.artifactId}/content`,
        acceptRanges: "bytes",
        maxRangeBytes: 1024 * 1024,
      },
    } as const satisfies RetainedArtifactMetadata;
    const unavailable = unavailableRetainedSessionImage({
      ...identityInput,
      reason: "pending",
    });
    expect(unavailable).toEqual({
      available: false,
      artifactId: identity.artifactId,
      reason: "pending",
    });
    const result = {
      type: "function_call_result",
      call_id: "call-1",
      output: [
        {
          type: "input_image",
          image: `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`,
        },
      ],
    };
    const directResult = {
      type: "function_call_result",
      call_id: "call-2",
      output: `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`,
    };
    const serialized = JSON.stringify({
      originalInput: [result, directResult],
      generatedItems: [{ rawItem: result }],
      modelResponses: [{ output: [result] }],
      lastModelResponse: { output: [result] },
    });
    const compacted = compactRetainedScreenshotRunState(
      serialized,
      new Map([
        ["call-1", artifact],
        ["call-2", artifact],
      ]),
    );
    expect(compacted).not.toContain("base64");
    expect(compacted).not.toContain("objectKey");
    expect(collectRetainedScreenshotRunStateReceipts(compacted).get("call-1")).toEqual(artifact);
    expect(collectRetainedScreenshotRunStateReceipts(compacted).get("call-2")).toEqual(artifact);
  });

  test("browser screenshot identity is distinct and its MCP image is replaced before history persistence", () => {
    const identityInput = {
      sessionId: "11111111-1111-4111-8111-111111111111",
      turnId: "22222222-2222-4222-8222-222222222222",
      attemptId: "33333333-3333-4333-8333-333333333333",
      toolCallId: "browser-call",
      toolOutputId: "browser-output",
    };
    const browserIdentity = retainedScreenshotIdentity({
      ...identityInput,
      kind: "browser_screenshot",
    });
    expect(browserIdentity.artifactId).not.toBe(
      retainedScreenshotIdentity(identityInput).artifactId,
    );
    expect(
      unavailableRetainedSessionImage({
        ...identityInput,
        kind: "browser_screenshot",
        reason: "pending",
      }).artifactId,
    ).toBe(browserIdentity.artifactId);

    const artifact = {
      available: true,
      artifactId: browserIdentity.artifactId,
      kind: "browser_screenshot",
      contentType: "image/png",
      originalBytes: PNG.byteLength,
      sha256: "a".repeat(64),
      retainedAt: "2026-07-31T00:00:00.000Z",
      dimensions: { width: 1, height: 1 },
      retention: {
        policy: "session_screenshot",
        expiresAt: "2026-08-30T00:00:00.000Z",
      },
      retrieval: {
        method: "GET",
        path: `/v1/workspaces/${identityInput.sessionId}/sessions/${identityInput.sessionId}/artifacts/${browserIdentity.artifactId}/content`,
        acceptRanges: "bytes",
        maxRangeBytes: 1024 * 1024,
      },
    } as const satisfies RetainedArtifactMetadata;
    const history = [
      {
        callId: identityInput.toolCallId,
        output: {
          structuredContent: { kind: "browser_screenshot", frameId: "frame-1" },
          content: [
            { type: "text", text: "Browser screenshot" },
            { type: "image", data: Buffer.from(PNG).toString("base64"), mimeType: "image/png" },
          ],
        },
      },
    ];
    const compacted = compactRetainedScreenshotHistory(
      history,
      new Map([[identityInput.toolCallId, artifact]]),
    );
    expect(JSON.stringify(compacted)).not.toContain(Buffer.from(PNG).toString("base64"));
    expect(JSON.stringify(compacted)).toContain("browser_screenshot");
    expect(
      collectRetainedScreenshotRunStateReceipts(JSON.stringify({ originalInput: compacted })).get(
        identityInput.toolCallId,
      ),
    ).toEqual(artifact);
  });

  test("an undecodable browser image block is still stripped from durable history", () => {
    const event = {
      type: "run_item_stream_event",
      item: {
        id: "bad-browser-output",
        type: "tool_call_output_item",
        rawItem: { callId: "bad-browser-call" },
        output: {
          content: [{ type: "image", data: "unsafe-inline-data", mimeType: "image/png" }],
        },
      },
    };
    expect(sdkEventContainsInlineImage(event)).toBe(true);
    expect(typedScreenshotFromSdkEvent(event)).toBeNull();
    const receipt = unavailableRetainedSessionImage({
      sessionId: "11111111-1111-4111-8111-111111111111",
      turnId: "22222222-2222-4222-8222-222222222222",
      attemptId: "33333333-3333-4333-8333-333333333333",
      toolCallId: "bad-browser-call",
      toolOutputId: "bad-browser-output",
      kind: "browser_screenshot",
      reason: "unsupported",
    });
    const compacted = compactRetainedScreenshotHistory(
      [{ callId: "bad-browser-call", output: event.item.output }],
      new Map([["bad-browser-call", receipt]]),
    );
    expect(JSON.stringify(compacted)).not.toContain("unsafe-inline-data");
    expect(JSON.stringify(compacted)).toContain("unsupported");
  });
});

function receiptFor(
  artifactId: string,
  bytes: Uint8Array,
  contentType: "image/png" | "image/jpeg",
) {
  return {
    available: true,
    artifactId,
    kind: "computer_screenshot",
    contentType,
    originalBytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    retainedAt: "2026-07-31T00:00:00.000Z",
    dimensions: { width: 1, height: 1 },
    retention: { policy: "session_screenshot", expiresAt: "2026-08-30T00:00:00.000Z" },
    retrieval: {
      method: "GET",
      path: `/v1/workspaces/22222222-2222-4222-8222-222222222222/sessions/33333333-3333-4333-8333-333333333333/artifacts/${artifactId}/content`,
      acceptRanges: "bytes",
      maxRangeBytes: 1024 * 1024,
    },
  } as const satisfies RetainedArtifactMetadata;
}

describe("images returned by any tool", () => {
  const pngData = Buffer.from(PNG).toString("base64");
  const jpegData = Buffer.from(JPEG).toString("base64");
  const integrationResult = () => ({
    type: "function_call_result",
    id: "output-kvm",
    callId: "call-kvm",
    output: {
      content: [
        { type: "text", text: '{"width":1,"height":1}' },
        { type: "image", data: pngData, mimeType: "image/png" },
        { type: "image", data: "not-an-image", mimeType: "image/png" },
        { type: "image", data: jpegData, mimeType: "image/jpeg" },
      ],
    },
  });
  const first = receiptFor("44444444-4444-4444-8444-444444444444", PNG, "image/png");
  const third = receiptFor("55555555-5555-4555-8555-555555555555", JPEG, "image/jpeg");

  test("lists every inline image with its own retention identity, keeping undecodable slots", () => {
    const images = inlineImagesFromToolResultItem(integrationResult());
    expect(images).toEqual([
      { callId: "call-kvm", toolOutputId: "output-kvm", bytes: PNG, mediaType: "image/png" },
      null,
      {
        callId: "call-kvm",
        toolOutputId: "output-kvm:image:2",
        bytes: JPEG,
        mediaType: "image/jpeg",
      },
    ]);
  });

  test("history keeps references for retained images and the bytes of the rest", () => {
    const receipts = new Map([["call-kvm", [first, null, third]]]);
    const [compacted] = compactRetainedScreenshotHistory([integrationResult()], receipts);
    const content = (compacted!.output as { content: unknown[] }).content;
    expect(content[0]).toEqual({ type: "text", text: '{"width":1,"height":1}' });
    expect(content[1]).toEqual({
      type: "input_image",
      image: { type: "retained_artifact", artifact: first },
    });
    // The image that could not be retained stays exactly as the tool returned it.
    expect(content[2]).toEqual({ type: "image", data: "not-an-image", mimeType: "image/png" });
    expect(content[3]).toEqual({
      type: "input_image",
      image: { type: "retained_artifact", artifact: third },
    });
    expect(JSON.stringify(compacted)).not.toContain(pngData);
    expect(JSON.stringify(compacted)).not.toContain(jpegData);

    // Re-reading the history recovers the same per-image receipts, so a retry
    // or resume compacts identically.
    expect(collectRetainedScreenshotReceipts([compacted!]).get("call-kvm")).toEqual([
      first,
      null,
      third,
    ]);
    const runState = compactRetainedScreenshotRunState(
      JSON.stringify({ originalInput: [integrationResult()] }),
      receipts,
    );
    expect(runState).not.toContain(pngData);
    expect(collectRetainedScreenshotRunStateReceipts(runState).get("call-kvm")).toEqual([
      first,
      null,
      third,
    ]);
  });

  test("a screenshot receipt shared by every image keeps its single-receipt form", () => {
    const [compacted] = compactRetainedScreenshotHistory(
      [
        {
          callId: "call-shot",
          output: { content: [{ type: "image", data: pngData, mimeType: "image/png" }] },
        },
      ],
      new Map([["call-shot", first]]),
    );
    expect(collectRetainedScreenshotReceipts([compacted!]).get("call-shot")).toEqual(first);
  });

  test("the timeline copy shows retained images as receipts and leaves the rest alone", () => {
    const output = integrationResult().output;
    expect(retainedToolImagesEventOutput(output, [first, null, third])).toEqual({
      content: [
        { type: "text", text: '{"width":1,"height":1}' },
        first,
        { type: "image", data: "not-an-image", mimeType: "image/png" },
        third,
      ],
    });
    expect(retainedToolImagesEventOutput(output, [null, null, null])).toBe(output);
  });
});

describe("older images in the model history", () => {
  const marker = (index: number) => ({
    type: "retained_artifact",
    artifact: receiptFor(
      `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      PNG,
      "image/png",
    ),
  });
  const viewImage = (index: number) => [
    {
      type: "function_call",
      callId: `call-${index}`,
      name: "view_image",
      arguments: JSON.stringify({ path: `/workspace/shots/${index}.png` }),
    },
    { type: "function_call_result", callId: `call-${index}`, output: marker(index) },
  ];
  const history = (images: number) => [
    { role: "user", content: "look at these" },
    ...Array.from({ length: images }, (_, index) => viewImage(index)).flat(),
  ];
  const outputs = (items: Array<Record<string, unknown>>) =>
    items.filter((item) => item.type === "function_call_result").map((item) => item.output);

  const GENERIC_NOTE =
    "[An earlier image was omitted from the conversation to save context. If you need the current state, take a fresh screenshot or observation instead of repeating an action.]";
  const viewNote = (index: number) =>
    `[An earlier image was omitted from the conversation to save context. To see it again, call view_image with path "/workspace/shots/${index}.png"; it shows the file as it is now.]`;

  test("omits whole batches of the oldest images and keeps the newest three to seven", () => {
    expect([0, 1, 3, 7, 8, 9, 12, 13, 18].map((total) => historyImagesToOmit(total))).toEqual([
      0, 0, 0, 0, 5, 5, 5, 10, 15,
    ]);
    // A non-positive batch or negative keep cannot loop or over-omit.
    expect(historyImagesToOmit(5, 3, 0)).toBe(2);
    expect(historyImagesToOmit(2, -1, 1)).toBe(2);
  });

  test("replaces older view_image results with a note naming the path to view again", () => {
    const original = history(9);
    const before = JSON.stringify(original);
    const projected = omitOlderHistoryImages(original);
    expect(JSON.stringify(original)).toBe(before);
    const shown = outputs(projected);
    expect(shown.slice(0, 5)).toEqual([0, 1, 2, 3, 4].map(viewNote));
    expect(shown.slice(5)).toEqual([5, 6, 7, 8].map((index) => marker(index)));
    // Everything except the omitted outputs is the same object.
    expect(projected.filter((item) => item.type !== "function_call_result")).toEqual(
      original.filter((item) => item.type !== "function_call_result"),
    );
    // Below the first batch: the very same array.
    const seven = history(7);
    expect(omitOlderHistoryImages(seven)).toBe(seven);
  });

  test("the SDK's view_image output shape gets the same path note", () => {
    const items: Array<Record<string, unknown>> = Array.from({ length: 8 }, (_, index) => [
      {
        type: "function_call",
        callId: `call-${index}`,
        name: "view_image",
        arguments: JSON.stringify({ path: `/workspace/shots/${index}.png` }),
      },
      {
        type: "function_call_result",
        callId: `call-${index}`,
        output: [{ type: "input_image", image: marker(index) }],
      },
    ]).flat();
    const shown = outputs(omitOlderHistoryImages(items));
    expect(shown.slice(0, 5)).toEqual(
      [0, 1, 2, 3, 4].map((index) => [{ type: "input_text", text: viewNote(index) }]),
    );
    expect(shown.slice(5)).toEqual(
      [5, 6, 7].map((index) => [{ type: "input_image", image: marker(index) }]),
    );
  });

  test("the projected prefix stays identical between omission batches", () => {
    const eighth = JSON.stringify(omitOlderHistoryImages(history(8)));
    const ninth = omitOlderHistoryImages(history(9));
    const twelfth = omitOlderHistoryImages(history(12));
    // Turns that add the ninth to twelfth image only append to the prefix the
    // provider cached for the eighth.
    expect(JSON.stringify(ninth).startsWith(eighth.slice(0, -1))).toBe(true);
    expect(JSON.stringify(twelfth).startsWith(JSON.stringify(ninth).slice(0, -1))).toBe(true);
    // The thirteenth image starts the next batch.
    expect(
      outputs(omitOlderHistoryImages(history(13))).filter((output) => typeof output === "string"),
    ).toHaveLength(10);
  });

  test("content images of any tool get one neutral note per result; computer screenshots are kept", () => {
    const pngData = Buffer.from(PNG).toString("base64");
    const items: Array<Record<string, unknown>> = [
      {
        type: "function_call",
        callId: "call-browser",
        name: "interaction__browser_act",
        arguments: JSON.stringify({ action: "click" }),
      },
      {
        type: "function_call_result",
        callId: "call-browser",
        output: {
          isError: false,
          content: [
            { type: "text", text: "page" },
            { type: "input_image", image: marker(1) },
            { type: "image", data: pngData, mimeType: "image/png" },
            { type: "text", text: "after" },
          ],
        },
      },
      { type: "computer_call_result", callId: "call-computer", output: marker(2) },
      {
        type: "function_call_result",
        callId: "call-unknown",
        output: [{ type: "input_image", image: marker(3) }],
      },
      // Unparseable arguments fall back to the neutral note.
      { type: "function_call", callId: "call-bad", name: "view_image", arguments: "{not json" },
      { type: "function_call_result", callId: "call-bad", output: marker(9) },
      ...viewImage(4),
      ...viewImage(5),
      ...viewImage(6),
      ...viewImage(7),
    ];
    const projected = omitOlderHistoryImages(items);
    const browser = projected[1]!.output as { isError: boolean; content: unknown[] };
    // Sibling fields survive and both images become a single note.
    expect(browser.isError).toBe(false);
    expect(browser.content).toEqual([
      { type: "text", text: "page" },
      { type: "input_text", text: GENERIC_NOTE },
      { type: "text", text: "after" },
    ]);
    expect(GENERIC_NOTE).not.toContain("call it again");
    expect(projected[2]).toBe(items[2]);
    expect(projected[3]!.output).toEqual([{ type: "input_text", text: GENERIC_NOTE }]);
    expect(projected[5]!.output).toBe(GENERIC_NOTE);
    expect(outputs(projected).slice(-4)).toEqual([viewNote(4), marker(5), marker(6), marker(7)]);
  });

  test("a result whose images straddle the cut-off keeps its newest image", () => {
    const items: Array<Record<string, unknown>> = [
      ...[0, 1, 2, 3].map((index) => viewImage(index)).flat(),
      {
        type: "function_call_result",
        callId: "call-pair",
        output: [
          { type: "input_image", image: marker(4) },
          { type: "input_image", image: marker(5) },
        ],
      },
      ...[6, 7].map((index) => viewImage(index)).flat(),
    ];
    // Eight images: the five oldest go, which ends at the first of the pair.
    const projected = omitOlderHistoryImages(items);
    const shown = outputs(projected);
    expect(shown.slice(0, 4)).toEqual([0, 1, 2, 3].map(viewNote));
    expect(shown[4]).toEqual([
      { type: "input_text", text: GENERIC_NOTE },
      { type: "input_image", image: marker(5) },
    ]);
    expect(shown.slice(5)).toEqual([marker(6), marker(7)]);
  });

  test("with the defaults, receipts come from the full history and only kept images are read", async () => {
    const forbidden = new Proxy(
      {},
      {
        get() {
          throw new Error("storage must not be read for omitted images");
        },
      },
    );
    const inline = `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`;
    const full: Array<Record<string, unknown>> = [
      ...history(5),
      ...[5, 6, 7]
        .map((index) => [
          { type: "function_call", callId: `call-${index}`, name: "read_screen", arguments: "{}" },
          { type: "function_call_result", callId: `call-${index}`, output: inline },
        ])
        .flat(),
    ];
    // The order TurnMediaArtifacts.materializeScreenshotHistory uses.
    const receipts = collectRetainedScreenshotReceipts(full);
    const materialized = await materializeRetainedScreenshotHistory({
      db: forbidden as never,
      objectStorage: forbidden as never,
      workspaceId: "22222222-2222-4222-8222-222222222222",
      sessionId: "33333333-3333-4333-8333-333333333333",
      history: omitOlderHistoryImages(full),
    });
    expect([...receipts.keys()].sort()).toEqual([0, 1, 2, 3, 4].map((index) => `call-${index}`));
    expect(outputs(materialized)).toEqual([
      ...[0, 1, 2, 3, 4].map(viewNote),
      inline,
      inline,
      inline,
    ]);
  });

  test("omitted images are never read from storage", async () => {
    const forbidden = new Proxy(
      {},
      {
        get() {
          throw new Error("storage must not be read for omitted images");
        },
      },
    );
    const materialized = await materializeRetainedScreenshotHistory({
      db: forbidden as never,
      objectStorage: forbidden as never,
      workspaceId: "22222222-2222-4222-8222-222222222222",
      sessionId: "33333333-3333-4333-8333-333333333333",
      history: omitOlderHistoryImages(history(3), 0, 1),
    });
    expect(outputs(materialized).every((output) => typeof output === "string")).toBe(true);
    expect(JSON.stringify(materialized)).not.toContain("retained_artifact");
  });
});
