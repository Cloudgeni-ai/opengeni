import type { GeneratedVideoReceipt, VideoArtifactPlaybackSource } from "@opengeni/sdk";
import { useEffect, useState } from "react";
import { cn } from "../lib/cn";
import type { VideoArtifactPlaybackLoader } from "../timeline";

export type GeneratedVideoPlayerProps = {
  receipt: GeneratedVideoReceipt;
  loadPlaybackSource: VideoArtifactPlaybackLoader;
  className?: string | undefined;
  label?: string | undefined;
};

type SourceState =
  | { kind: "loading" }
  | { kind: "ready"; source: VideoArtifactPlaybackSource }
  | { kind: "error"; message: string };

/** Native, Range-based playback. Video bytes never pass through React or the SDK heap. */
export function GeneratedVideoPlayer({
  receipt,
  loadPlaybackSource,
  className,
  label = "Generated video",
}: GeneratedVideoPlayerProps) {
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<SourceState>({ kind: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: "loading" });
    void loadPlaybackSource(receipt.artifact.artifactId, controller.signal).then(
      (source) => {
        if (!controller.signal.aborted) setState({ kind: "ready", source });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          kind: "error",
          message: error instanceof Error ? error.message : "Playback is unavailable.",
        });
      },
    );
    return () => controller.abort();
  }, [loadPlaybackSource, receipt.artifact.artifactId, retry]);

  if (state.kind === "loading") {
    return (
      <div
        aria-label={`Loading ${label.toLowerCase()}`}
        className={cn(
          "aspect-video w-full animate-pulse rounded-og-md bg-og-surface-2 motion-reduce:animate-none",
          className,
        )}
      />
    );
  }
  if (state.kind === "error") {
    return (
      <div
        role="status"
        className={cn(
          "rounded-og-md border border-og-status-failed/30 bg-og-status-failed/5 px-3 py-2 text-og-sm text-og-status-failed",
          className,
        )}
      >
        {state.message}
      </div>
    );
  }

  return (
    <video
      key={state.source.url}
      aria-label={label}
      className={cn(
        "max-h-[32rem] w-full rounded-og-md bg-black object-contain shadow-sm",
        className,
      )}
      controls
      playsInline
      preload="metadata"
      src={state.source.url}
      onError={() => {
        if (retry === 0) setRetry(1);
        else setState({ kind: "error", message: "Video playback failed." });
      }}
    />
  );
}
