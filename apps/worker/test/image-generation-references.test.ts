import { describe, expect, test } from "bun:test";
import {
  ImageGenerationReferenceError,
  readStoredImageReferenceFile,
  resolveImageGenerationReferences,
  resolveImageGenerationReferencesForTool,
} from "../src/activities/image-generation-references";

const PNG_1X1 = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
);

describe("image generation references", () => {
  test("reads stored image references larger than one object page", async () => {
    const expected = Uint8Array.from({ length: 1024 * 1024 + 7 }, (_, index) => index % 251);
    const files: unknown[] = [];
    const bytes = await readStoredImageReferenceFile(
      {
        getFileBytes: async (file) => {
          files.push(file);
          return expected;
        },
      },
      {
        sizeBytes: expected.byteLength,
        objectKey: "generated/reference.png",
      } as unknown as never,
    );

    expect(files).toHaveLength(1);
    expect(bytes).toEqual(expected);
  });

  test("rejects stored image bytes that disagree with file metadata", async () => {
    await expect(
      readStoredImageReferenceFile({ getFileBytes: async () => PNG_1X1 }, {
        sizeBytes: PNG_1X1.byteLength + 1,
      } as unknown as never),
    ).rejects.toMatchObject({ code: "reference_integrity_mismatch" });
  });

  test("validates sandbox images and preserves caller order", async () => {
    const paths: string[] = [];
    const references = await resolveImageGenerationReferences({
      db: {} as never,
      objectStorage: {} as never,
      accountId: "00000000-0000-4000-8000-000000000000",
      workspaceId: "11111111-1111-4111-8111-111111111111",
      subjectId: "user:image-reference-authority",
      references: [
        { kind: "sandbox_path", path: "/workspace/first.png" },
        { kind: "sandbox_path", path: "/workspace/second.png" },
      ],
      readSandboxFile: async (path) => {
        paths.push(path);
        return PNG_1X1;
      },
    });

    expect(paths).toEqual(["/workspace/first.png", "/workspace/second.png"]);
    expect(references).toHaveLength(2);
    expect(references.map((reference) => reference.mediaType)).toEqual(["image/png", "image/png"]);
    expect(references[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("classifies SVG as unsupported before provider execution", async () => {
    try {
      await resolveImageGenerationReferences({
        db: {} as never,
        objectStorage: {} as never,
        accountId: "00000000-0000-4000-8000-000000000000",
        workspaceId: "11111111-1111-4111-8111-111111111111",
        subjectId: "user:image-reference-authority",
        references: [{ kind: "sandbox_path", path: "/workspace/logo.svg" }],
        readSandboxFile: async () =>
          new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
      });
      throw new Error("Expected SVG reference rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ImageGenerationReferenceError);
      expect((error as ImageGenerationReferenceError).code).toBe("unsupported_reference_media");
      expect((error as Error).message).toContain("PNG, JPEG, or WebP");
    }
  });

  test("returns a model-readable failed tool result when a sandbox reference is unavailable", async () => {
    const resolution = await resolveImageGenerationReferencesForTool({
      db: {} as never,
      objectStorage: {} as never,
      accountId: "00000000-0000-4000-8000-000000000000",
      workspaceId: "11111111-1111-4111-8111-111111111111",
      subjectId: "user:image-reference-authority",
      references: [{ kind: "sandbox_path", path: "/workspace/missing.png" }],
      readSandboxFile: async () => {
        throw new Error("Sandbox image reference is unavailable");
      },
    });

    expect(resolution).toEqual({
      status: "rejected",
      result: {
        isError: true,
        status: "rejected",
        code: "reference_unavailable",
        message:
          "The sandbox image reference could not be read. Verify that the file still exists in the current workspace.",
        operationCreated: false,
        content: [
          {
            type: "text",
            text: "Image generation was not started: The sandbox image reference could not be read. Verify that the file still exists in the current workspace.",
          },
        ],
      },
    });
  });
});
