import type { RetainedArtifactReference } from "@opengeni/sdk";

import { saveBlob } from "./save-blob";

/** Saves retained bytes only. No sandbox session or publication is involved. */
export function saveRetainedArtifact(
  artifact: RetainedArtifactReference,
  bytes: Uint8Array,
  filename: string,
) {
  saveBlob(new Blob([Uint8Array.from(bytes)], { type: artifact.contentType }), filename);
}
