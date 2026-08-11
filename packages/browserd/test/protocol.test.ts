import { describe, expect, test } from "bun:test";
import {
  decodeBrowserFrameMessage,
  decodeBrowserFrameMetadataHeader,
  encodeBrowserFrameMessage,
  encodeBrowserFrameMetadataHeader,
  type BrowserImageFrame,
} from "../src";

describe("browser control media protocol", () => {
  test("round trips one bounded self-describing binary frame", () => {
    const original = frame();
    const decoded = decodeBrowserFrameMessage(encodeBrowserFrameMessage(original));
    expect(decoded).toEqual(original);
    const { data: _data, ...metadata } = original;
    expect(decodeBrowserFrameMetadataHeader(encodeBrowserFrameMetadataHeader(original))).toEqual(
      metadata,
    );
  });

  test("rejects truncated, mismatched, and extended frame envelopes", () => {
    expect(() => decodeBrowserFrameMessage(Uint8Array.of(0, 0, 0, 1, 123))).toThrow();
    const original = frame();
    expect(() => encodeBrowserFrameMessage({ ...original, width: 99 })).toThrow(
      "do not match metadata",
    );
    const metadata = JSON.parse(
      Buffer.from(encodeBrowserFrameMetadataHeader(original), "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    metadata.extra = true;
    expect(() =>
      decodeBrowserFrameMetadataHeader(
        Buffer.from(JSON.stringify(metadata), "utf8").toString("base64url"),
      ),
    ).toThrow("unknown fields");
  });
});

function frame(): BrowserImageFrame {
  return {
    frameId: "frame-1",
    browserSessionId: "10000000-0000-4000-8000-000000000001",
    controllerGeneration: "controller-1",
    targetId: "target-1",
    targetGeneration: "target-generation-1",
    documentGeneration: "document-generation-1",
    sequence: 1,
    mediaType: "image/png",
    width: 3,
    height: 2,
    deviceScaleFactor: 1,
    scrollX: 0,
    scrollY: 0,
    data: png(),
    capturedAt: "2026-08-09T12:00:00.000Z",
  };
}

function png(): Uint8Array {
  return Uint8Array.from([
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 3, 0, 0, 0, 2,
  ]);
}
