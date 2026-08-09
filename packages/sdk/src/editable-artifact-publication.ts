import {
  PublishEditableArtifactReceiptSchema,
  type PublishEditableArtifactReceipt,
} from "@opengeni/contracts/editable-artifact-publication-receipt";

export type { PublishEditableArtifactReceipt };

/** Parse the closed durable receipt emitted by `publish_editable_artifact`. */
export function parseEditableArtifactPublicationReceipt(
  value: unknown,
): PublishEditableArtifactReceipt | null {
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return null;
    }
  }
  const parsed = PublishEditableArtifactReceiptSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}
