import { describe, expect, test } from "bun:test";
import { resolveImageGenerationReferences } from "../src/activities/image-generation-references";

const PNG_1X1 = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
);

describe("image generation references", () => {
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

  test("fails before provider execution when sandbox bytes are not an image", async () => {
    await expect(
      resolveImageGenerationReferences({
        db: {} as never,
        objectStorage: {} as never,
        accountId: "00000000-0000-4000-8000-000000000000",
        workspaceId: "11111111-1111-4111-8111-111111111111",
        subjectId: "user:image-reference-authority",
        references: [{ kind: "sandbox_path", path: "/workspace/not-an-image.txt" }],
        readSandboxFile: async () => new TextEncoder().encode("not an image"),
      }),
    ).rejects.toThrow();
  });
});
