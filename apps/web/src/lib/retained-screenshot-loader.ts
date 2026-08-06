import type { OpenGeniCoreClient } from "@opengeni/sdk/core";
import type { RetainedArtifactReference } from "@opengeni/sdk";

type RetainedScreenshotClient = Pick<OpenGeniCoreClient, "downloadRetainedScreenshot">;

/**
 * Bind the authenticated SDK downloader to one routed workspace/session.
 * Fetched metadata must still match the closed timeline receipt before bytes
 * are handed to React; errors deliberately contain no storage locator/content.
 */
export function createSessionRetainedScreenshotLoader(
  client: RetainedScreenshotClient,
  workspaceId: string,
  sessionId: string,
) {
  return async (artifact: RetainedArtifactReference, signal: AbortSignal) => {
    const download = await client.downloadRetainedScreenshot(
      workspaceId,
      sessionId,
      artifact.artifactId,
      { signal },
    );
    if (!download.metadata.available || !download.bytes) return null;
    if (
      download.metadata.artifactId !== artifact.artifactId ||
      download.metadata.kind !== artifact.kind ||
      download.metadata.contentType !== artifact.contentType ||
      download.metadata.originalBytes !== artifact.originalBytes ||
      download.metadata.sha256 !== artifact.sha256 ||
      download.metadata.dimensions?.width !== artifact.dimensions?.width ||
      download.metadata.dimensions?.height !== artifact.dimensions?.height
    ) {
      throw new Error("Retained screenshot receipt verification failed");
    }
    return download.bytes;
  };
}
