import { describe, expect, test } from "bun:test";
import {
  generatedImageSandboxPathMatches,
  parseGeneratedImageReceipt,
  parseRetainedGeneratedImageReference,
} from "../src/retained-artifacts";
import type { RetainedArtifactReference } from "../src/types";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const artifactId = "55555555-5555-4555-8555-555555555555";
const reference = {
  available: true,
  artifactId,
  kind: "generated_image",
  contentType: "image/png",
  originalBytes: 1024,
  sha256: "a".repeat(64),
  retainedAt: "2026-08-08T00:00:00.000Z",
  dimensions: { width: 1024, height: 1024 },
  retention: { policy: "workspace_file", expiresAt: null },
  retrieval: {
    method: "GET",
    path: `/v1/workspaces/${workspaceId}/artifacts/${artifactId}/content`,
    acceptRanges: "bytes",
    maxRangeBytes: 1024 * 1024,
  },
} satisfies RetainedArtifactReference;

describe("retained generated image wire validation", () => {
  test("accepts only an exact permanent workspace receipt", () => {
    const parsed = parseRetainedGeneratedImageReference(reference, workspaceId);
    expect(parsed).toEqual(reference);
    expect(parseRetainedGeneratedImageReference({ ...reference, secret: "leak" })).toBeNull();
    expect(
      parseRetainedGeneratedImageReference(reference, "22222222-2222-4222-8222-222222222222"),
    ).toBeNull();
    expect(
      parseRetainedGeneratedImageReference({
        ...reference,
        dimensions: { width: 16_384, height: 16_384 },
      }),
    ).toBeNull();
    expect(
      parseRetainedGeneratedImageReference({
        ...reference,
        retainedAt: "August 8, 2026",
      }),
    ).toBeNull();
  });

  test("binds sandbox path, artifact id, and media extension exactly", () => {
    const parsed = parseRetainedGeneratedImageReference(reference)!;
    expect(
      generatedImageSandboxPathMatches(
        parsed,
        `/workspace/generated-images/generated-image-${artifactId}.png`,
      ),
    ).toBe(true);
    expect(
      generatedImageSandboxPathMatches(
        parsed,
        `/workspace/generated-images/generated-image-${artifactId}.webp`,
      ),
    ).toBe(false);
  });

  test("parses the closed receipt from objects or compact JSON", () => {
    const receipt = {
      type: "generated_image" as const,
      artifact: reference,
      sandboxPath: `/workspace/generated-images/generated-image-${artifactId}.png`,
    };
    expect(parseGeneratedImageReceipt(receipt, workspaceId)).toEqual(receipt);
    expect(parseGeneratedImageReceipt(JSON.stringify(receipt), workspaceId)).toEqual(receipt);
    expect(parseGeneratedImageReceipt({ ...receipt, provider: "openai" })).toBeNull();
    expect(
      parseGeneratedImageReceipt({
        ...receipt,
        artifact: {
          ...reference,
          retrieval: { ...reference.retrieval, maxRangeBytes: 512 * 1024 },
        },
      }),
    ).toBeNull();
  });
});
