import { createHash } from "node:crypto";
import {
  assertEditableArtifactRequestHash,
  decodeEditableArtifactMutationIntent,
  hashEditableArtifactMutationIntentBytes,
} from "@opengeni/contracts/editable-artifacts";

import { EditableArtifactRequestHashMismatchError } from "./errors";
import type { EditableArtifactMutationIntentCodecPort } from "./ports";
import {
  assertBoundedArtifactTitle,
  editableArtifactRequestHash,
  type CreateEditableArtifactRequest,
  type ImportEditableArtifactRequest,
  type EditableArtifactRequestHash,
} from "./types";

const CREATE_HASH_DOMAIN = new TextEncoder().encode("OpenGeni editable artifact create\0v1\0");
const IMPORT_HASH_DOMAIN = new TextEncoder().encode("OpenGeni editable artifact import\0v1\0");

/** Canonical identity of caller-controlled create semantics only. */
export function hashEditableArtifactCreateRequest(
  request: Pick<CreateEditableArtifactRequest, "modality" | "title">,
): EditableArtifactRequestHash {
  if (
    request.modality !== "spreadsheet" &&
    request.modality !== "presentation" &&
    request.modality !== "document"
  ) {
    throw new TypeError("Unknown editable artifact modality");
  }
  assertBoundedArtifactTitle(request.title);
  const digest = createHash("sha256");
  digest.update(CREATE_HASH_DOMAIN);
  updateLengthFramedUtf8(digest, request.modality);
  updateLengthFramedUtf8(digest, request.title);
  return editableArtifactRequestHash(`sha256:${digest.digest("hex")}`);
}

/** Canonical identity of one retained Office import and its verified snapshot facts. */
export function hashEditableArtifactImportRequest(
  request: Omit<ImportEditableArtifactRequest, "idempotencyKey">,
): EditableArtifactRequestHash {
  assertImportRequestShape(request);
  const digest = createHash("sha256");
  digest.update(IMPORT_HASH_DOMAIN);
  updateLengthFramedUtf8(digest, request.modality);
  updateLengthFramedUtf8(digest, request.title);
  updateLengthFramedUtf8(digest, request.originalImport.fileId);
  updateLengthFramedUtf8(digest, String(request.originalImport.byteSize));
  updateLengthFramedUtf8(digest, request.originalImport.contentHash);
  updateLengthFramedUtf8(digest, request.originalImport.mimeType);
  updateLengthFramedUtf8(digest, String(request.snapshot.byteSize));
  updateLengthFramedUtf8(digest, request.snapshot.contentHash);
  updateLengthFramedUtf8(digest, request.snapshot.stateHash);
  updateLengthFramedUtf8(digest, String(request.snapshot.modelSchemaVersion));
  updateLengthFramedUtf8(digest, request.snapshot.kernelVersion);
  if (request.snapshot.modality === "spreadsheet") {
    updateLengthFramedUtf8(digest, String(request.snapshot.operationProtocolVersion));
    updateLengthFramedUtf8(digest, String(request.snapshot.crdtStateVersion));
    updateLengthFramedUtf8(digest, String(request.snapshot.coveredCausalFrontier.length));
    for (const entry of request.snapshot.coveredCausalFrontier) {
      updateLengthFramedUtf8(digest, entry.replicaId);
      updateLengthFramedUtf8(digest, String(entry.counter));
    }
  } else {
    updateLengthFramedUtf8(digest, String(request.snapshot.nativeRevision));
  }
  return editableArtifactRequestHash(`sha256:${digest.digest("hex")}`);
}

function assertImportRequestShape(
  request: Omit<ImportEditableArtifactRequest, "idempotencyKey">,
): void {
  if (
    request.modality !== "spreadsheet" &&
    request.modality !== "presentation" &&
    request.modality !== "document"
  ) {
    throw new TypeError("Unknown editable artifact modality");
  }
  assertBoundedArtifactTitle(request.title);
  if (request.snapshot.modality !== request.modality) {
    throw new TypeError("Imported snapshot modality does not match the Office source");
  }
  const expectedMimeType =
    request.modality === "spreadsheet"
      ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      : request.modality === "document"
        ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        : "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  if (
    request.originalImport.mimeType !== expectedMimeType ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      request.originalImport.fileId,
    ) ||
    !Number.isSafeInteger(request.originalImport.byteSize) ||
    request.originalImport.byteSize <= 0
  ) {
    throw new TypeError("Imported Office source facts are malformed");
  }
}

function updateLengthFramedUtf8(digest: ReturnType<typeof createHash>, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.byteLength);
  digest.update(length);
  digest.update(bytes);
}

/** Production adapter over the one shared OGATX001 canonical wire codec. */
export class OgatxEditableArtifactMutationIntentCodec implements EditableArtifactMutationIntentCodecPort {
  async decodeAndVerify(
    input: Parameters<EditableArtifactMutationIntentCodecPort["decodeAndVerify"]>[0],
  ): ReturnType<EditableArtifactMutationIntentCodecPort["decodeAndVerify"]> {
    const intentBytes = input.intentBytes.slice();
    const requestHash = assertEditableArtifactRequestHash(input.requestHash);
    // Shared hashing parses first, so malformed/noncanonical bytes never gain
    // an application request identity. Decode returns an independently owned
    // command block; this adapter never re-encodes or JSON-canonicalizes.
    const actualHash = hashEditableArtifactMutationIntentBytes(intentBytes);
    if (actualHash !== requestHash) {
      throw new EditableArtifactRequestHashMismatchError();
    }
    return decodeEditableArtifactMutationIntent(intentBytes);
  }
}

export const ogatxEditableArtifactMutationIntentCodec =
  new OgatxEditableArtifactMutationIntentCodec();
