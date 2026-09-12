import { useEffect, useMemo, useState } from "react";
import type { RetainedArtifactReference } from "@opengeni/sdk";
import { useRetainedImageObjectUrl } from "@opengeni/react/artifacts";
import { useLightboxOptional } from "@opengeni/react";
import { useAppContext } from "@/context";
import { createWorkspaceRetainedArtifactLoader } from "@/lib/retained-artifact-loader";
import { Button } from "@/components/ui/button";

export function InlineChatImage({
  workspaceId,
  artifactId,
  alt,
}: {
  workspaceId: string;
  artifactId: string;
  alt: string;
}) {
  const { client } = useAppContext();
  const [loaded, setLoaded] = useState<{
    client: typeof client;
    workspaceId: string;
    artifact: RetainedArtifactReference;
  } | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setLoaded(null);
    setError(false);
    void client
      .getRetainedArtifact(workspaceId, artifactId)
      .then((artifact) => {
        if (!active) return;
        if (
          !artifact.available ||
          artifact.artifactId !== artifactId ||
          !/^image\/(png|jpeg|gif|webp|avif|svg\+xml)$/.test(artifact.contentType)
        ) {
          setError(true);
          return;
        }
        setLoaded({ client, workspaceId, artifact });
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [client, workspaceId, artifactId, retry]);
  const load = useMemo(
    () => createWorkspaceRetainedArtifactLoader(client, workspaceId),
    [client, workspaceId],
  );
  if (error)
    return (
      <span role="status">
        {alt || "Image"} unavailable.{" "}
        <Button variant="ghost" size="sm" onClick={() => setRetry((v) => v + 1)}>
          Retry
        </Button>
      </span>
    );
  if (
    !loaded ||
    loaded.client !== client ||
    loaded.workspaceId !== workspaceId ||
    loaded.artifact.artifactId !== artifactId
  )
    return <span role="status">Loading image…</span>;
  return (
    <LoadedImage
      key={`${artifactId}:${retry}`}
      artifact={loaded.artifact}
      load={load}
      alt={alt}
      onRetry={() => setRetry((v) => v + 1)}
    />
  );
}
function LoadedImage({
  artifact,
  load,
  alt,
  onRetry,
}: {
  artifact: RetainedArtifactReference;
  load: ReturnType<typeof createWorkspaceRetainedArtifactLoader>;
  alt: string;
  onRetry: () => void;
}) {
  const state = useRetainedImageObjectUrl(artifact, load);
  const lightbox = useLightboxOptional();
  const [failed, setFailed] = useState(false);
  if (state.kind === "loading") return <span role="status">Loading image…</span>;
  if (state.kind !== "ready" || failed)
    return (
      <span role="status">
        {alt || "Image"} unavailable.{" "}
        <Button variant="ghost" size="sm" onClick={onRetry}>
          Retry
        </Button>
      </span>
    );
  const image = (
    <img
      src={state.url}
      alt={alt}
      loading="lazy"
      className="my-3 max-w-full rounded-md"
      onError={() => setFailed(true)}
    />
  );
  return lightbox ? (
    <button
      type="button"
      aria-label={`Expand ${alt || "image"}`}
      className="block max-w-full cursor-zoom-in rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
      onClick={(event) => lightbox.open(state.url, alt, event.currentTarget, "Image")}
    >
      {image}
    </button>
  ) : (
    image
  );
}
