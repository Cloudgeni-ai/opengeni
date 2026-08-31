import { type ImageGenerationReference, type FileAsset } from "@opengeni/contracts";
import { getGeneratedImageArtifact, requireFileForSubject, type Database } from "@opengeni/db";
import type { ObjectStorage } from "@opengeni/storage";
import {
  GeneratedImageValidationError,
  validateGeneratedImage,
  type GeneratedImageMediaType,
} from "./generated-images";

export const IMAGE_GENERATION_REFERENCE_MAX_BYTES = 30 * 1024 * 1024;
export const IMAGE_GENERATION_REFERENCES_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

export type ResolvedImageGenerationReference = Readonly<{
  mediaType: GeneratedImageMediaType;
  bytes: Uint8Array;
  sizeBytes: number;
  sha256: string;
}>;

export type SandboxImageReferenceReader = (path: string, maxBytes: number) => Promise<Uint8Array>;

export type ImageGenerationReferenceErrorCode =
  | "invalid_reference"
  | "unsupported_reference_media"
  | "reference_too_large"
  | "reference_not_ready"
  | "reference_unavailable"
  | "reference_integrity_mismatch";

/** A deterministic input rejection that occurs before any image provider request. */
export class ImageGenerationReferenceError extends Error {
  constructor(
    readonly code: ImageGenerationReferenceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ImageGenerationReferenceError";
  }
}

export type ImageGenerationReferenceRejectedResult = Readonly<{
  isError: true;
  status: "rejected";
  code: ImageGenerationReferenceErrorCode;
  message: string;
  operationCreated: false;
  content: readonly [{ readonly type: "text"; readonly text: string }];
}>;

export type ResolveImageGenerationReferencesInput = Readonly<{
  db: Database;
  objectStorage: ObjectStorage;
  accountId: string;
  workspaceId: string;
  subjectId: string | null;
  references: readonly ImageGenerationReference[];
  readSandboxFile?: SandboxImageReferenceReader;
}>;

export type ImageGenerationReferenceResolution =
  | Readonly<{
      status: "resolved";
      references: ResolvedImageGenerationReference[];
    }>
  | Readonly<{
      status: "rejected";
      result: ImageGenerationReferenceRejectedResult;
    }>;

/**
 * Carry deterministic pre-provider input failures on the tool output. Unknown
 * database and object-storage failures still throw, and provider execution
 * remains outside this boundary so an outcome-unknown operation can never be
 * reported rejected.
 */
export async function resolveImageGenerationReferencesForTool(
  input: ResolveImageGenerationReferencesInput,
): Promise<ImageGenerationReferenceResolution> {
  try {
    return {
      status: "resolved",
      references: await resolveImageGenerationReferences(input),
    };
  } catch (error) {
    if (!(error instanceof ImageGenerationReferenceError)) throw error;
    const text = `Image generation was not started: ${error.message}`;
    return {
      status: "rejected",
      result: {
        isError: true,
        status: "rejected",
        code: error.code,
        message: error.message,
        operationCreated: false,
        content: [{ type: "text", text }],
      },
    };
  }
}

/**
 * Resolve ordered model-facing references without accepting arbitrary URLs.
 * Stored files remain workspace-RLS scoped; sandbox reads stay rooted beneath
 * /workspace. Provider adapters receive only validated immutable bytes.
 */
export async function resolveImageGenerationReferences(
  input: ResolveImageGenerationReferencesInput,
): Promise<ResolvedImageGenerationReference[]> {
  const resolved: ResolvedImageGenerationReference[] = [];
  let totalBytes = 0;

  for (const reference of input.references) {
    const source = await referenceBytes(input, reference);
    if (source.bytes.byteLength > IMAGE_GENERATION_REFERENCE_MAX_BYTES) {
      throw new ImageGenerationReferenceError(
        "reference_too_large",
        "An image reference exceeds the per-image byte limit.",
      );
    }
    totalBytes += source.bytes.byteLength;
    if (totalBytes > IMAGE_GENERATION_REFERENCES_MAX_TOTAL_BYTES) {
      throw new ImageGenerationReferenceError(
        "reference_too_large",
        "The image references exceed the combined byte limit.",
      );
    }

    const image = validateReferenceImage(source.bytes);
    if (source.file) assertStoredFileMatches(source.file, image);
    resolved.push({
      mediaType: image.mediaType,
      bytes: source.bytes,
      sizeBytes: image.sizeBytes,
      sha256: image.sha256,
    });
  }

  return resolved;
}

async function referenceBytes(
  input: ResolveImageGenerationReferencesInput,
  reference: ImageGenerationReference,
): Promise<{ bytes: Uint8Array; file?: FileAsset }> {
  if (reference.kind === "sandbox_path") {
    if (!input.readSandboxFile) {
      throw new ImageGenerationReferenceError(
        "reference_unavailable",
        "Sandbox image references require an available workspace sandbox.",
      );
    }
    try {
      return {
        bytes: await input.readSandboxFile(
          reference.path,
          IMAGE_GENERATION_REFERENCE_MAX_BYTES + 1,
        ),
      };
    } catch (error) {
      if (error instanceof ImageGenerationReferenceError) throw error;
      throw new ImageGenerationReferenceError(
        "reference_unavailable",
        "The sandbox image reference could not be read. Verify that the file still exists in the current workspace.",
        { cause: error },
      );
    }
  }

  let file: FileAsset;
  if (reference.kind === "file") {
    try {
      file = await requireFileForSubject(input.db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        subjectId: input.subjectId,
        fileId: reference.fileId,
      });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("File not found:")) throw error;
      throw new ImageGenerationReferenceError(
        "reference_unavailable",
        "The workspace File image reference is unavailable.",
        { cause: error },
      );
    }
  } else {
    file = await artifactFile(input.db, input.workspaceId, reference.artifactId);
  }
  if (file.status !== "ready" || !file.sha256) {
    throw new ImageGenerationReferenceError(
      "reference_not_ready",
      "The image reference is not durably ready yet.",
    );
  }
  if (file.sizeBytes <= 0 || file.sizeBytes > IMAGE_GENERATION_REFERENCE_MAX_BYTES) {
    throw new ImageGenerationReferenceError(
      "reference_too_large",
      "The image reference file exceeds the supported size.",
    );
  }
  return {
    bytes: await readStoredImageReferenceFile(input.objectStorage, file),
    file,
  };
}

export async function readStoredImageReferenceFile(
  objectStorage: Pick<ObjectStorage, "getFileBytes">,
  file: FileAsset,
): Promise<Uint8Array> {
  const bytes = await objectStorage.getFileBytes(file);
  if (bytes.byteLength !== file.sizeBytes) {
    throw new ImageGenerationReferenceError(
      "reference_integrity_mismatch",
      "The durable image reference bytes do not match their file metadata.",
    );
  }
  return bytes;
}

async function artifactFile(
  db: Database,
  workspaceId: string,
  artifactId: string,
): Promise<FileAsset> {
  const artifact = await getGeneratedImageArtifact(db, workspaceId, artifactId);
  if (!artifact || artifact.status !== "ready") {
    throw new ImageGenerationReferenceError(
      "reference_unavailable",
      "The generated-image artifact reference is unavailable.",
    );
  }
  return artifact.file;
}

function assertStoredFileMatches(
  file: FileAsset,
  image: Pick<ResolvedImageGenerationReference, "sizeBytes" | "sha256">,
): void {
  if (file.sizeBytes !== image.sizeBytes || file.sha256 !== image.sha256) {
    throw new ImageGenerationReferenceError(
      "reference_integrity_mismatch",
      "The image reference bytes do not match their durable file metadata.",
    );
  }
}

function validateReferenceImage(bytes: Uint8Array) {
  try {
    return validateGeneratedImage({ bytes });
  } catch (error) {
    if (!(error instanceof GeneratedImageValidationError)) throw error;
    if (error.reason === "unsupported") {
      throw new ImageGenerationReferenceError(
        "unsupported_reference_media",
        "Image references must be PNG, JPEG, or WebP. Convert SVG or other formats before calling generate_image.",
        { cause: error },
      );
    }
    if (error.reason === "oversized") {
      throw new ImageGenerationReferenceError(
        "reference_too_large",
        "The image reference exceeds the supported dimensions or byte size.",
        { cause: error },
      );
    }
    throw new ImageGenerationReferenceError(
      "invalid_reference",
      "The image reference is not a valid PNG, JPEG, or WebP image.",
      { cause: error },
    );
  }
}
