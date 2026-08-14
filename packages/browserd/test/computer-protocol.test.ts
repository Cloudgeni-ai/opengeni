import { describe, expect, test } from "bun:test";
import {
  decodeComputerFrameMessage,
  decodeComputerFrameMetadataHeader,
  encodeComputerFrameMessage,
  encodeComputerFrameMetadataHeader,
  type ComputerImageFrame,
} from "../src";

describe("computer control media protocol", () => {
  test("round trips a bounded digest-verified binary frame", () => {
    const original = frame();
    expect(decodeComputerFrameMessage(encodeComputerFrameMessage(original))).toEqual(original);
    expect(
      decodeComputerFrameMetadataHeader(encodeComputerFrameMetadataHeader(original)),
    ).toMatchObject({
      frameId: original.frameId,
      computerSessionId: original.computerSessionId,
      targetId: original.targetId,
    });
  });

  test("rejects image and metadata tampering", () => {
    const encoded = encodeComputerFrameMessage(frame());
    const imageTampered = encoded.slice();
    const finalByte = imageTampered.length - 1;
    imageTampered[finalByte] = imageTampered[finalByte]! ^ 1;
    expect(() => decodeComputerFrameMessage(imageTampered)).toThrow("digest does not match");

    const metadataLength = new DataView(
      encoded.buffer,
      encoded.byteOffset,
      encoded.byteLength,
    ).getUint32(0, false);
    const metadata = JSON.parse(
      Buffer.from(encoded.subarray(4, 4 + metadataLength)).toString("utf8"),
    ) as Record<string, unknown>;
    metadata.sha256 = "0".repeat(64);
    const header = Buffer.from(JSON.stringify(metadata), "utf8");
    const metadataTampered = new Uint8Array(
      4 + header.byteLength + encoded.byteLength - 4 - metadataLength,
    );
    new DataView(metadataTampered.buffer).setUint32(0, header.byteLength, false);
    metadataTampered.set(header, 4);
    metadataTampered.set(encoded.subarray(4 + metadataLength), 4 + header.byteLength);
    expect(() => decodeComputerFrameMessage(metadataTampered)).toThrow("digest does not match");
  });
});

function frame(): ComputerImageFrame {
  return {
    frameId: "frame-1",
    computerSessionId: "10000000-0000-4000-8000-000000000001",
    controllerGeneration: "controller-1",
    targetId: "target-1",
    targetGeneration: "target-generation-1",
    sequence: 1,
    mediaType: "image/png",
    width: 3,
    height: 2,
    data: Uint8Array.from([
      137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 3, 0, 0, 0, 2,
    ]),
    capturedAt: "2026-08-10T12:00:00.000Z",
  };
}
