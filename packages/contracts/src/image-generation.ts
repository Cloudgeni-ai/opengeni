import { z } from "zod";
import { RETAINED_OUTPUT_MAX_PAGE_BYTES, RetainedArtifactReferenceSchema } from "./retained-output";

// Codex accepts five references, while the current Gateway GPT Image 2 route
// accepts four. Keep the provider-neutral tool at the reliable shared limit.
export const IMAGE_GENERATION_MAX_REFERENCES = 4;

/** One ordered, workspace-owned input used to guide or edit an image. */
export const ImageGenerationReferenceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("sandbox_path"),
      path: z
        .string()
        .max(512)
        .regex(/^\/workspace\/(?!\.{1,2}(?:\/|$))(?!.*\/\.{1,2}(?:\/|$)).+$/),
    })
    .strict(),
  z
    .object({
      kind: z.literal("file"),
      fileId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("artifact"),
      artifactId: z.string().uuid(),
    })
    .strict(),
]);
export type ImageGenerationReference = z.infer<typeof ImageGenerationReferenceSchema>;

/** Provider-neutral minimum shared by native and adapter-backed image tools. */
export const GenerateImageToolInput = z
  .object({
    prompt: z.string().trim().min(1).max(32_000),
    references: z
      .array(ImageGenerationReferenceSchema)
      .max(IMAGE_GENERATION_MAX_REFERENCES)
      .optional()
      .default([]),
  })
  .strict();
export type GenerateImageToolInput = z.infer<typeof GenerateImageToolInput>;

/** Closed durable result shared by native and adapter-backed image tools. */
export const GeneratedImageReceiptSchema = z
  .object({
    type: z.literal("generated_image"),
    artifact: RetainedArtifactReferenceSchema,
    sandboxPath: z
      .string()
      .max(256)
      .regex(
        /^\/workspace\/generated-images\/generated-image-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(png|jpg|webp)$/,
      ),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.artifact.kind !== "generated_image") {
      ctx.addIssue({
        code: "custom",
        path: ["artifact", "kind"],
        message: "generated-image receipt requires a generated-image artifact",
      });
      return;
    }
    if (value.artifact.retrieval.maxRangeBytes !== RETAINED_OUTPUT_MAX_PAGE_BYTES) {
      ctx.addIssue({
        code: "custom",
        path: ["artifact", "retrieval", "maxRangeBytes"],
        message: "generated-image receipt requires the canonical range size",
      });
    }
    const extension =
      value.artifact.contentType === "image/png"
        ? "png"
        : value.artifact.contentType === "image/jpeg"
          ? "jpg"
          : value.artifact.contentType === "image/webp"
            ? "webp"
            : null;
    if (
      extension === null ||
      value.sandboxPath !==
        `/workspace/generated-images/generated-image-${value.artifact.artifactId}.${extension}`
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["sandboxPath"],
        message: "generated-image sandbox path does not match its artifact",
      });
    }
  });
export type GeneratedImageReceipt = z.infer<typeof GeneratedImageReceiptSchema>;
