import { z } from "zod";
import {
  editableArtifactOfficeMimeType,
  editableArtifactOfficeMimeTypeFor,
  isWellFormedEditableArtifactText,
} from "./editable-artifact-publication-common";

const sha256Text = /^sha256:[0-9a-f]{64}$/u;
const replicaId = /^[0-9a-f]{16}$/u;

export {
  PublishEditableArtifactReceiptSchema,
  type PublishEditableArtifactReceipt,
} from "./editable-artifact-publication-receipt";

const PreparedSnapshotCommon = {
  byteSize: z
    .number()
    .int()
    .positive()
    .max(512 * 1024 * 1024),
  contentHash: z.string().regex(sha256Text),
  mimeType: z.literal("application/vnd.opengeni.editable-artifact-snapshot"),
  coveredHeadSequence: z.literal(0),
  stateHash: z.string().regex(sha256Text),
  modelSchemaVersion: z.literal(1),
  kernelVersion: z.string().min(1).max(1_024),
} as const;

/** Closed output of the manifest-pinned sandbox publication preparer. */
export const PreparedEditableArtifactPublicationSchema = z
  .object({
    schemaVersion: z.literal(1),
    modality: z.enum(["document", "spreadsheet", "presentation"]),
    source: z
      .object({
        byteSize: z
          .number()
          .int()
          .positive()
          .max(64 * 1024 * 1024),
        contentHash: z.string().regex(sha256Text),
        mimeType: editableArtifactOfficeMimeType,
      })
      .strict(),
    snapshot: z.discriminatedUnion("modality", [
      z
        .object({
          ...PreparedSnapshotCommon,
          modality: z.literal("spreadsheet"),
          coveredCausalFrontier: z
            .array(
              z
                .object({
                  replicaId: z
                    .string()
                    .regex(replicaId)
                    .refine((value) => !/^0+$/u.test(value)),
                  counter: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
                })
                .strict(),
            )
            .max(65_536),
          operationProtocolVersion: z.literal(1),
          crdtStateVersion: z.literal(1),
        })
        .strict(),
      z
        .object({
          ...PreparedSnapshotCommon,
          modality: z.literal("document"),
          nativeRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        })
        .strict(),
      z
        .object({
          ...PreparedSnapshotCommon,
          modality: z.literal("presentation"),
          nativeRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        })
        .strict(),
    ]),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.snapshot.modality !== value.modality) {
      context.addIssue({
        code: "custom",
        path: ["snapshot", "modality"],
        message: "publication snapshot modality does not match its source",
      });
    }
    const expectedMime = editableArtifactOfficeMimeTypeFor(value.modality);
    if (value.source.mimeType !== expectedMime) {
      context.addIssue({
        code: "custom",
        path: ["source", "mimeType"],
        message: "publication source MIME type does not match its modality",
      });
    }
    if (value.snapshot.modality === "spreadsheet") {
      let previous = "";
      for (const [index, entry] of value.snapshot.coveredCausalFrontier.entries()) {
        if (entry.replicaId <= previous) {
          context.addIssue({
            code: "custom",
            path: ["snapshot", "coveredCausalFrontier", index, "replicaId"],
            message: "publication frontier must be uniquely sorted",
          });
          break;
        }
        previous = entry.replicaId;
      }
    }
  });
export type PreparedEditableArtifactPublication = z.infer<
  typeof PreparedEditableArtifactPublicationSchema
>;

export const PublishEditableArtifactToolInput = z
  .object({
    path: z
      .string()
      .min(1)
      .max(4_096)
      .refine((value) => value.trim() === value && isWellFormedEditableArtifactText(value)),
    title: z
      .string()
      .min(1)
      .refine(
        (value) =>
          value.trim() === value &&
          isWellFormedEditableArtifactText(value) &&
          new TextEncoder().encode(value).byteLength <= 512,
      ),
    modality: z.enum(["document", "spreadsheet", "presentation"]),
  })
  .strict();
export type PublishEditableArtifactToolInput = z.infer<typeof PublishEditableArtifactToolInput>;
