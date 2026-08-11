import { useMemo } from "react";
import type { VideoArtifactPlaybackLoader } from "../timeline";
import { useOpenGeni, type ClientOverride } from "../session-context";

/**
 * Bind the current public SDK client/workspace to MessageTimeline's renewable
 * video-source boundary. Proxy hosts may omit the method until they support
 * retained video; the failure remains local to the player instead of loading
 * any video bytes through React.
 */
export function useVideoArtifactPlaybackLoader(
  options: ClientOverride = {},
): VideoArtifactPlaybackLoader {
  const { client, workspaceId } = useOpenGeni(options);
  return useMemo(
    () => async (artifactId: string, signal?: AbortSignal) => {
      if (typeof client.createVideoArtifactPlaybackSource !== "function") {
        throw new Error("This OpenGeni host does not expose retained-video playback.");
      }
      return await client.createVideoArtifactPlaybackSource(
        workspaceId,
        artifactId,
        signal ? { signal } : {},
      );
    },
    [client, workspaceId],
  );
}
