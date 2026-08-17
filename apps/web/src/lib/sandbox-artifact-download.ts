import {
  parseSandboxFileArtifactReceipt,
  type OpenGeniClient,
  type SandboxFileArtifactReceipt,
} from "@opengeni/sdk";

type SandboxArtifactClient = Pick<
  OpenGeniClient,
  "publishSandboxFileArtifact" | "downloadRetainedArtifact"
>;

export async function downloadSandboxFileArtifact(
  client: SandboxArtifactClient,
  workspaceId: string,
  sessionId: string,
  path: string,
  save: (receipt: SandboxFileArtifactReceipt, bytes: Uint8Array) => void = saveSandboxFileArtifact,
): Promise<SandboxFileArtifactReceipt> {
  const published = parseSandboxFileArtifactReceipt(
    await client.publishSandboxFileArtifact(workspaceId, sessionId, { path }),
    workspaceId,
  );
  if (!published) {
    throw new Error("Sandbox artifact publication returned an invalid receipt");
  }
  const download = await client.downloadRetainedArtifact(workspaceId, published.artifact);
  save(published, download.bytes);
  return published;
}

export function saveSandboxFileArtifact(
  receipt: SandboxFileArtifactReceipt,
  bytes: Uint8Array,
): void {
  const url = URL.createObjectURL(
    new Blob([Uint8Array.from(bytes)], { type: receipt.artifact.contentType }),
  );
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = receipt.filename;
    anchor.rel = "noopener";
    anchor.click();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
