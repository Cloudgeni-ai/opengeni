import type { RetainedArtifactReference } from "@opengeni/sdk";
import type { OpenGeniCoreClient } from "@opengeni/sdk/core";

type RetainedArtifactClient = Pick<OpenGeniCoreClient, "createRetainedArtifactDownloadUrl">;

/** Bind permanent retained-artifact retrieval to one authenticated workspace. */
export function createWorkspaceRetainedArtifactLoader(
  client: RetainedArtifactClient,
  workspaceId: string,
) {
  return async (artifact: RetainedArtifactReference, signal: AbortSignal) => {
    const download = await client.createRetainedArtifactDownloadUrl(workspaceId, artifact, {
      signal,
    });
    return { url: download.url };
  };
}
