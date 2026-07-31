import { describe, expect, test } from "bun:test";
import type { RetainedArtifactMetadata } from "@opengeni/contracts";
import {
  collectRetainedScreenshotRunStateReceipts,
  compactRetainedScreenshotRunState,
  retainedScreenshotIdentity,
  ScreenshotValidationError,
  typedScreenshotFromSdkEvent,
  validateComputerScreenshot,
} from "../src/activities/retained-screenshots";

const PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
);

describe("retained computer screenshots", () => {
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
    expect(output).toMatchObject({ callId: "call-1", toolOutputId: "output-1" });
    expect(validateComputerScreenshot(output!)).toMatchObject({
      mediaType: "image/png",
      sizeBytes: PNG.byteLength,
      width: 1,
      height: 1,
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
      retention: { policy: "session_screenshot", expiresAt: "2026-08-30T00:00:00.000Z" },
      retrieval: {
        method: "GET",
        path: `/v1/workspaces/${identityInput.sessionId}/sessions/${identityInput.sessionId}/artifacts/${identity.artifactId}/content`,
        acceptRanges: "bytes",
        maxRangeBytes: 1024 * 1024,
      },
    } as const satisfies RetainedArtifactMetadata;
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
    const serialized = JSON.stringify({
      originalInput: [result],
      generatedItems: [{ rawItem: result }],
      modelResponses: [{ output: [result] }],
      lastModelResponse: { output: [result] },
    });
    const compacted = compactRetainedScreenshotRunState(
      serialized,
      new Map([["call-1", artifact]]),
    );
    expect(compacted).not.toContain("base64");
    expect(compacted).not.toContain("objectKey");
    expect(collectRetainedScreenshotRunStateReceipts(compacted).get("call-1")).toEqual(artifact);
  });
});
