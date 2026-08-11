import { type ImageGenerationReference, type FileAsset } from "@opengeni/contracts";
import { getGeneratedImageArtifact, requireFile, type Database } from "@opengeni/db";
import type { ObjectStorage } from "@opengeni/storage";
import { validateGeneratedImage, type GeneratedImageMediaType } from "./generated-images";

export const IMAGE_GENERATION_REFERENCE_MAX_BYTES = 30 * 1024 * 1024;
export const IMAGE_GENERATION_REFERENCES_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

export type ResolvedImageGenerationReference = Readonly<{
  mediaType: GeneratedImageMediaType;
  bytes: Uint8Array;
  sizeBytes: number;
  sha256: string;
}>;

export type SandboxImageReferenceReader = (path: string, maxBytes: number) => Promise<Uint8Array>;

/**
 * Resolve ordered model-facing references without accepting arbitrary URLs.
 * Stored files remain workspace-RLS scoped; sandbox reads stay rooted beneath
 * /workspace. Provider adapters receive only validated immutable bytes.
 */
export async function resolveImageGenerationReferences(input: {
  db: Database;
  objectStorage: ObjectStorage;
  workspaceId: string;
  references: readonly ImageGenerationReference[];
  readSandboxFile?: SandboxImageReferenceReader;
}): Promise<ResolvedImageGenerationReference[]> {
  const resolved: ResolvedImageGenerationReference[] = [];
  let totalBytes = 0;

  for (const reference of input.references) {
    const source = await referenceBytes(input, reference);
    if (source.bytes.byteLength > IMAGE_GENERATION_REFERENCE_MAX_BYTES) {
      throw new Error("Image reference exceeds the per-image byte limit");
    }
    totalBytes += source.bytes.byteLength;
    if (totalBytes > IMAGE_GENERATION_REFERENCES_MAX_TOTAL_BYTES) {
      throw new Error("Image references exceed the combined byte limit");
    }

    const image = validateGeneratedImage({ bytes: source.bytes });
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
  input: {
    db: Database;
    objectStorage: ObjectStorage;
    workspaceId: string;
    readSandboxFile?: SandboxImageReferenceReader;
  },
  reference: ImageGenerationReference,
): Promise<{ bytes: Uint8Array; file?: FileAsset }> {
  if (reference.kind === "sandbox_path") {
    if (!input.readSandboxFile) {
      throw new Error("Sandbox image references require an active sandbox");
    }
    return {
      bytes: await input.readSandboxFile(reference.path, IMAGE_GENERATION_REFERENCE_MAX_BYTES + 1),
    };
  }

  const file =
    reference.kind === "file"
      ? await requireFile(input.db, input.workspaceId, reference.fileId)
      : await artifactFile(input.db, input.workspaceId, reference.artifactId);
  if (file.status !== "ready" || !file.sha256) {
    throw new Error("Image reference file is not durably ready");
  }
  if (file.sizeBytes <= 0 || file.sizeBytes > IMAGE_GENERATION_REFERENCE_MAX_BYTES) {
    throw new Error("Image reference file exceeds the supported size");
  }
  return {
    bytes: await readStoredFile(input.objectStorage, file),
    file,
  };
}

async function readStoredFile(objectStorage: ObjectStorage, file: FileAsset): Promise<Uint8Array> {
  const bytes = await objectStorage.getFileRange(file, {
    start: 0,
    end: file.sizeBytes - 1,
  });
  if (!bytes) throw new Error("Image reference file bytes are unavailable");
  return bytes;
}

async function artifactFile(
  db: Database,
  workspaceId: string,
  artifactId: string,
): Promise<FileAsset> {
  const artifact = await getGeneratedImageArtifact(db, workspaceId, artifactId);
  if (!artifact || artifact.status !== "ready") {
    throw new Error(`Generated image artifact not found or unavailable: ${artifactId}`);
  }
  return artifact.file;
}

function assertStoredFileMatches(
  file: FileAsset,
  image: Pick<ResolvedImageGenerationReference, "sizeBytes" | "sha256">,
): void {
  if (file.sizeBytes !== image.sizeBytes || file.sha256 !== image.sha256) {
    throw new Error("Image reference bytes do not match their durable file metadata");
  }
}
