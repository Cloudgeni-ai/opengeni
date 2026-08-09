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
  type EditableArtifactRequestHash,
} from "./types";

const CREATE_HASH_DOMAIN = new TextEncoder().encode("OpenGeni editable artifact create\0v1\0");

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
