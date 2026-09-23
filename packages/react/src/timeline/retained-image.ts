import { useEffect, useRef, useState } from "react";
import type { RetainedArtifactReference } from "@opengeni/sdk";
import type { ToolRendererProps } from "./registry";
type RetainedImageState =
  | { kind: "loading" }
  | { kind: "ready"; url: string }
  | { kind: "unavailable"; label: string }
  | { kind: "error"; message: string };

/** Shared browser preview allowlist; other published files remain downloads. */
export function isRetainedImageContentType(contentType: string): boolean {
  return [
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/avif",
    "image/svg+xml",
  ].includes(contentType);
}

export function useRetainedImageObjectUrl(
  artifact: RetainedArtifactReference,
  load: ToolRendererProps["loadRetainedArtifact"],
): RetainedImageState {
  const [state, setState] = useState<RetainedImageState>({ kind: "loading" });
  // Function outputs are commonly serialized JSON. Parsing them creates a new
  // object on every render, so depend on the immutable wire value rather than
  // object identity; otherwise the loader can refetch after its own setState.
  const artifactValue = retainedArtifactValue(artifact);
  const stableArtifactRef = useRef({ value: artifactValue, artifact });
  if (stableArtifactRef.current.value !== artifactValue) {
    stableArtifactRef.current = { value: artifactValue, artifact };
  }
  const stableArtifact = stableArtifactRef.current.artifact;
  useEffect(() => {
    if (!load) {
      setState({ kind: "unavailable", label: "retrieval is not configured" });
      return;
    }
    const controller = new AbortController();
    let objectUrl: string | null = null;
    setState({ kind: "loading" });
    void load(stableArtifact, controller.signal)
      .then((source) => {
        if (controller.signal.aborted) return;
        if (!source) {
          setState({ kind: "unavailable", label: "bytes are unavailable" });
          return;
        }
        if (!(source instanceof Uint8Array)) {
          if (!source.url.trim()) {
            setState({ kind: "unavailable", label: "URL is unavailable" });
            return;
          }
          setState({ kind: "ready", url: source.url });
          return;
        }
        objectUrl = URL.createObjectURL(
          new Blob([source as unknown as BlobPart], { type: stableArtifact.contentType }),
        );
        setState({ kind: "ready", url: objectUrl });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const status =
          error && typeof error === "object" && "status" in error
            ? Number((error as { status?: unknown }).status)
            : null;
        setState(
          status === 404
            ? { kind: "unavailable", label: "deleted" }
            : status === 410
              ? { kind: "unavailable", label: "expired or unavailable" }
              : { kind: "error", message: "retrieval failed" },
        );
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [stableArtifact, load]);
  return state;
}

function retainedArtifactValue(artifact: RetainedArtifactReference): string {
  return [
    artifact.artifactId,
    artifact.kind,
    artifact.contentType,
    artifact.originalBytes,
    artifact.sha256,
    artifact.retainedAt,
    artifact.dimensions?.width ?? "",
    artifact.dimensions?.height ?? "",
    artifact.retention.policy,
    artifact.retention.expiresAt ?? "",
    artifact.retrieval.method,
    artifact.retrieval.path,
    artifact.retrieval.acceptRanges,
    artifact.retrieval.maxRangeBytes,
  ].join("\0");
}
