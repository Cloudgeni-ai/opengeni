import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  ComputerFrameEvidenceMismatchError,
  validateComputerControlFrameEvidence,
  type ComputerControlFrameMetadata,
  type ExpectedComputerFrameEvidence,
} from "../src/sandbox/browser-control-client";

const expected: ExpectedComputerFrameEvidence = {
  computerSessionId: "00000000-0000-4000-8000-000000000001",
  controllerGeneration: "controller:7",
  targetId: "screen:0",
};

describe("computer frame evidence", () => {
  test.each([
    ["image/png" as const, png()],
    ["image/jpeg" as const, jpeg()],
  ])("accepts coupled %s bytes and metadata for opaque target ids", (mediaType, data) => {
    const frame = validateComputerControlFrameEvidence(wireFrame({ mediaType, data }), expected);

    expect(frame.data).toEqual(data);
    expect(frame.metadata).toMatchObject({
      computerSessionId: expected.computerSessionId,
      controllerGeneration: expected.controllerGeneration,
      targetId: "screen:0",
      mediaType,
    });
  });

  test.each([
    ["frame_session_mismatch", { computerSessionId: "00000000-0000-4000-8000-000000000002" }],
    ["frame_target_mismatch", { targetId: "screen:1" }],
    ["frame_controller_mismatch", { controllerGeneration: "controller:8" }],
  ] as const)("rejects %s independently", (reason, metadata) => {
    expectMismatch(
      () => validateComputerControlFrameEvidence(wireFrame(metadata), expected),
      reason,
    );
  });

  test("rejects a metadata MIME that differs from the exact response MIME", () => {
    expectMismatch(
      () =>
        validateComputerControlFrameEvidence(
          wireFrame({ mediaType: "image/png", responseMediaType: "image/jpeg", data: png() }),
          expected,
        ),
      "frame_media_mismatch",
    );
  });

  test("rejects an invalid metadata digest before forwarding bytes", () => {
    expectMismatch(
      () => validateComputerControlFrameEvidence(wireFrame({ sha256: "z".repeat(64) }), expected),
      "frame_digest_mismatch",
    );
  });

  test("rejects body bytes that do not match otherwise-valid metadata", () => {
    const original = png();
    const frame = wireFrame({ data: original });
    frame.data = Uint8Array.from([...original, 0]);
    expectMismatch(
      () => validateComputerControlFrameEvidence(frame, expected),
      "frame_digest_mismatch",
    );
  });
});

function wireFrame(
  overrides: Partial<ComputerControlFrameMetadata> & {
    data?: Uint8Array;
    responseMediaType?: "image/jpeg" | "image/png";
  } = {},
) {
  const { data = png(), responseMediaType, ...metadataOverrides } = overrides;
  const metadata: ComputerControlFrameMetadata = {
    frameId: "frame-1",
    ...expected,
    targetGeneration: "target-generation-1",
    sequence: 3,
    mediaType: "image/png",
    width: 1,
    height: 1,
    capturedAt: "2026-08-30T10:00:00.000Z",
    sha256: createHash("sha256").update(data).digest("hex"),
    ...metadataOverrides,
  };
  return {
    data,
    mediaType: responseMediaType ?? metadata.mediaType,
    metadataHeader: Buffer.from(JSON.stringify(metadata), "utf8").toString("base64url"),
  };
}

function expectMismatch(
  run: () => unknown,
  reason: ComputerFrameEvidenceMismatchError["reason"],
): void {
  try {
    run();
    throw new Error("expected computer frame evidence mismatch");
  } catch (error) {
    expect(error).toBeInstanceOf(ComputerFrameEvidenceMismatchError);
    expect((error as ComputerFrameEvidenceMismatchError).reason).toBe(reason);
  }
}

function png(): Uint8Array {
  return Uint8Array.from(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  );
}

function jpeg(): Uint8Array {
  return Uint8Array.from(
    Buffer.from(
      "/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgj/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABykX//Z",
      "base64",
    ),
  );
}
