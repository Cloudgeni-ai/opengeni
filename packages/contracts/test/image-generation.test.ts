import { describe, expect, test } from "bun:test";
import { GeneratedImageReceiptSchema } from "../src/image-generation";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const artifactId = "55555555-5555-4555-8555-555555555555";

function receipt() {
  return {
    type: "generated_image" as const,
    artifact: {
      available: true as const,
      artifactId,
      kind: "generated_image" as const,
      contentType: "image/png",
      originalBytes: 1_024,
      sha256: "a".repeat(64),
      retainedAt: "2026-08-08T00:00:00.000Z",
      dimensions: { width: 1_024, height: 1_024 },
      retention: { policy: "workspace_file" as const, expiresAt: null },
      retrieval: {
        method: "GET" as const,
        path: `/v1/workspaces/${workspaceId}/artifacts/${artifactId}/content`,
        acceptRanges: "bytes" as const,
        maxRangeBytes: 1_024 * 1_024,
      },
    },
    sandboxPath: `/workspace/generated-images/generated-image-${artifactId}.png`,
  };
}

describe("GeneratedImageReceiptSchema", () => {
  test("accepts the one closed canonical receipt", () => {
    expect(GeneratedImageReceiptSchema.parse(receipt())).toEqual(receipt());
  });

  test("rejects cross-artifact paths and noncanonical retrieval ranges", () => {
    expect(
      GeneratedImageReceiptSchema.safeParse({
        ...receipt(),
        sandboxPath:
          "/workspace/generated-images/generated-image-66666666-6666-4666-8666-666666666666.png",
      }).success,
    ).toBe(false);
    expect(
      GeneratedImageReceiptSchema.safeParse({
        ...receipt(),
        artifact: {
          ...receipt().artifact,
          retrieval: { ...receipt().artifact.retrieval, maxRangeBytes: 512 * 1_024 },
        },
      }).success,
    ).toBe(false);
  });
});
