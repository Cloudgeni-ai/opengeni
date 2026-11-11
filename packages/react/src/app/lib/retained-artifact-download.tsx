import type { RetainedArtifactReference } from "@opengeni/sdk";

/** Saves retained bytes only. No sandbox session or publication is involved. */
export function saveRetainedArtifact(
  artifact: RetainedArtifactReference,
  bytes: Uint8Array,
  filename: string,
) {
  const url = URL.createObjectURL(
    new Blob([Uint8Array.from(bytes)], { type: artifact.contentType }),
  );
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = "noopener";
    anchor.click();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
