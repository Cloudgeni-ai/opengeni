import { z } from "zod";
import { RETAINED_OUTPUT_MAX_PAGE_BYTES, RetainedArtifactReferenceSchema } from "./retained-output";

/** Provider-neutral minimum shared by native and adapter-backed image tools. */
export const GenerateImageToolInput = z
  .object({
    prompt: z.string().trim().min(1).max(32_000),
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
