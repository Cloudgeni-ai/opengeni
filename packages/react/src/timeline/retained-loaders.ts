import type { OpenGeniClient, RetainedArtifactReference } from "@opengeni/sdk";
import type {
  RetainedArtifactLoadOptions,
  RetainedArtifactLoader,
  RetainedScreenshotLoader,
  VideoArtifactPlaybackLoader,
} from "./registry";

/** SDK methods the workspace retained-artifact loader needs. */
export type RetainedArtifactLoaderClient = Pick<
  OpenGeniClient,
  "createRetainedArtifactDownloadUrl" | "downloadRetainedArtifact"
>;

/** SDK method the session retained-screenshot loader needs. */
export type RetainedScreenshotLoaderClient = Pick<OpenGeniClient, "downloadRetainedScreenshot">;

/** SDK method the generated-video playback loader needs. */
export type RetainedVideoLoaderClient = Pick<OpenGeniClient, "createVideoArtifactPlaybackSource">;

/**
 * Bind permanent retained-artifact retrieval (generated images, published
 * files) to one authenticated workspace, for `MessageTimeline`'s
 * `loadRetainedArtifact`. Images get a short-lived URL; files are assembled
 * from verified byte ranges unless the caller asks for a URL.
 */
export function createWorkspaceRetainedArtifactLoader(
  client: RetainedArtifactLoaderClient,
  workspaceId: string,
): RetainedArtifactLoader {
  return async (
    artifact: RetainedArtifactReference,
    signal: AbortSignal,
    options?: RetainedArtifactLoadOptions,
  ) => {
    if (artifact.kind === "file" && options?.prefer !== "url") {
      const download = await client.downloadRetainedArtifact(workspaceId, artifact, { signal });
      return download.bytes;
    }
    const download = await client.createRetainedArtifactDownloadUrl(workspaceId, artifact, {
      signal,
    });
    return { url: download.url, expiresAt: download.expiresAt };
  };
}

/**
 * Bind the authenticated screenshot downloader to one workspace and session,
 * for `MessageTimeline`'s `loadRetainedScreenshot`. Fetched metadata must match
 * the timeline receipt before bytes are handed to React; errors deliberately
 * contain no storage locator or content.
 */
export function createSessionRetainedScreenshotLoader(
  client: RetainedScreenshotLoaderClient,
  workspaceId: string,
  sessionId: string,
): RetainedScreenshotLoader {
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

/**
 * Bind expiring generated-video playback sources to one authenticated
 * workspace, for `MessageTimeline`'s `loadVideoArtifactPlayback`.
 */
export function createWorkspaceRetainedVideoLoader(
  client: RetainedVideoLoaderClient,
  workspaceId: string,
): VideoArtifactPlaybackLoader {
  return async (artifactId: string, signal: AbortSignal) =>
    await client.createVideoArtifactPlaybackSource(workspaceId, artifactId, { signal });
}
