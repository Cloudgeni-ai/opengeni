import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  GenerateImageToolInput,
  GeneratedImageReceiptSchema,
  IMAGE_GENERATION_MAX_REFERENCES,
} from "../src/image-generation";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const artifactId = "55555555-5555-4555-8555-555555555555";

describe("GenerateImageToolInput", () => {
  test("accepts ordered sandbox, File, and generated-artifact references", () => {
    const input = {
      prompt: "Use the subject from the first image and style from the second",
      references: [
        { kind: "sandbox_path" as const, path: "/workspace/assets/subject.png" },
        { kind: "file" as const, fileId: "33333333-3333-4333-8333-333333333333" },
        { kind: "artifact" as const, artifactId },
      ],
    };
    expect(GenerateImageToolInput.parse(input)).toEqual(input);
  });

  test("defaults to generation without references and rejects unsafe or excessive paths", () => {
    expect(GenerateImageToolInput.parse({ prompt: "A blue sphere" })).toEqual({
      prompt: "A blue sphere",
      references: [],
    });
    expect(
      GenerateImageToolInput.safeParse({
        prompt: "unsafe",
        references: [{ kind: "sandbox_path", path: "/workspace/../secret.png" }],
      }).success,
    ).toBe(false);
    expect(
      GenerateImageToolInput.safeParse({
        prompt: "unsafe nested path",
        references: [{ kind: "sandbox_path", path: "/workspace/assets/../secret.png" }],
      }).success,
    ).toBe(false);
    expect(
      GenerateImageToolInput.safeParse({
        prompt: "unsafe current directory",
        references: [{ kind: "sandbox_path", path: "/workspace/./image.png" }],
      }).success,
    ).toBe(false);
    expect(
      GenerateImageToolInput.safeParse({
        prompt: "too many",
        references: Array.from({ length: IMAGE_GENERATION_MAX_REFERENCES + 1 }, (_, index) => ({
          kind: "sandbox_path",
          path: `/workspace/reference-${index}.png`,
        })),
      }).success,
    ).toBe(false);
  });

  test("emits a provider-portable path pattern without regex lookaround", () => {
    const schema = z.toJSONSchema(GenerateImageToolInput, { target: "draft-2020-12" });
    const serialized = JSON.stringify(schema);
    expect(serialized).not.toContain("(?!");
    expect(serialized).not.toContain("(?=");
    expect(serialized).not.toContain("(?<=");
    expect(serialized).not.toContain("(?<!");
    expect(serialized).toContain(String.raw`^\\/workspace\\/.+$`);
  });
});

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
