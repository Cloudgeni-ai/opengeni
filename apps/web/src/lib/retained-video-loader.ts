import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";

type RetainedVideoClient = Pick<OpenGeniBrowserClient, "createVideoArtifactPlaybackSource">;

/** Bind expiring generated-video playback sources to one authenticated workspace. */
export function createWorkspaceRetainedVideoLoader(
  client: RetainedVideoClient,
  workspaceId: string,
) {
  return async (artifactId: string, signal: AbortSignal) =>
    await client.createVideoArtifactPlaybackSource(workspaceId, artifactId, { signal });
}
