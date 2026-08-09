import { z } from "zod";
import {
  editableArtifactOfficeMimeType,
  editableArtifactOfficeMimeTypeFor,
  editableArtifactReceiptText,
} from "./editable-artifact-publication-common";

const portableId = /^[0-9a-f]+$/u;
const sha256Hex = /^[0-9a-f]{64}$/u;

/** Closed durable receipt emitted by `publish_editable_artifact`. */
export const PublishEditableArtifactReceiptSchema = z
  .object({
    type: z.literal("editable_artifact"),
    schemaVersion: z.literal(1),
    artifact: z
      .object({
        id: z
          .string()
          .length(32)
          .regex(portableId)
          .refine((value) => !/^0+$/u.test(value)),
        modality: z.enum(["document", "spreadsheet", "presentation"]),
        title: editableArtifactReceiptText,
      })
      .strict(),
    sourceFile: z
      .object({
        id: z.string().uuid(),
        filename: editableArtifactReceiptText,
        contentType: editableArtifactOfficeMimeType,
        sizeBytes: z.number().int().positive(),
        sha256: z.string().regex(sha256Hex),
      })
      .strict(),
    editorPath: z
      .string()
      .max(512)
      .regex(
        /^\/workspaces\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/artifacts\/editable\/[0-9a-f]{32}$/u,
      ),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.editorPath.endsWith(`/artifacts/editable/${value.artifact.id}`)) {
      context.addIssue({
        code: "custom",
        path: ["editorPath"],
        message: "editable-artifact editor path does not match its artifact",
      });
    }
    if (
      value.sourceFile.contentType !== editableArtifactOfficeMimeTypeFor(value.artifact.modality)
    ) {
      context.addIssue({
        code: "custom",
        path: ["sourceFile", "contentType"],
        message: "editable-artifact source MIME type does not match its modality",
      });
    }
  });

export type PublishEditableArtifactReceipt = z.infer<typeof PublishEditableArtifactReceiptSchema>;
