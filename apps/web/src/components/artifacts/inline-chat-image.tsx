import { useEffect, useMemo, useState } from "react";
import type { RetainedArtifactReference } from "@opengeni/sdk";
import { isRetainedImageContentType, useRetainedImageObjectUrl } from "@opengeni/react/artifacts";
import { useLightboxOptional } from "@opengeni/react";
import { useAppContext } from "@/context";
import { createWorkspaceRetainedArtifactLoader } from "@/lib/retained-artifact-loader";
import { Button } from "@/components/ui/button";
import { Link } from "@tanstack/react-router";

export function InlineChatImage({
  workspaceId,
  artifactId,
  alt,
  thumbnail = false,
  showArtifactLink = false,
  fromSession,
}: {
  workspaceId: string;
  artifactId: string;
  alt: string;
  /** Non-interactive image for a surrounding catalog link; no nested controls. */
  thumbnail?: boolean;
  showArtifactLink?: boolean;
  fromSession?: string;
}) {
  const { client, accessKeyVersion } = useAppContext();
  const [loaded, setLoaded] = useState<{
    client: typeof client;
    workspaceId: string;
    accessKeyVersion: number;
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
          !isRetainedImageContentType(artifact.contentType)
        ) {
          setError(true);
          return;
        }
        setLoaded({ client, workspaceId, accessKeyVersion, artifact });
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [client, workspaceId, accessKeyVersion, artifactId, retry]);
  const load = useMemo(
    () => createWorkspaceRetainedArtifactLoader(client, workspaceId),
    [client, workspaceId],
  );
  if (error)
    return (
      <span role="status" className="max-w-full break-words p-2 text-sm">
        {alt || "Image"} unavailable.{" "}
        {!thumbnail ? (
          <Button variant="ghost" size="sm" onClick={() => setRetry((v) => v + 1)}>
            Retry
          </Button>
        ) : null}
      </span>
    );
  if (
    !loaded ||
    loaded.client !== client ||
    loaded.workspaceId !== workspaceId ||
    loaded.accessKeyVersion !== accessKeyVersion ||
    loaded.artifact.artifactId !== artifactId
  )
    return (
      <span role="status" className="p-2 text-xs text-fg-subtle">
        Loading image…
      </span>
    );
  return (
    <>
      <LoadedImage
        key={`${workspaceId}:${artifactId}:${retry}`}
        artifact={loaded.artifact}
        load={load}
        alt={alt}
        thumbnail={thumbnail}
        onRetry={() => setRetry((v) => v + 1)}
      />
      {showArtifactLink && !thumbnail ? (
        <Link
          to="/workspaces/$workspaceId/artifacts/files/$artifactId"
          params={{ workspaceId, artifactId }}
          search={fromSession ? { fromSession } : {}}
          className="mt-1 inline-flex min-h-9 items-center text-xs text-fg-muted underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Open in Artifacts
        </Link>
      ) : null}
    </>
  );
}
function LoadedImage({
  artifact,
  load,
  alt,
  onRetry,
  thumbnail,
}: {
  artifact: RetainedArtifactReference;
  load: ReturnType<typeof createWorkspaceRetainedArtifactLoader>;
  alt: string;
  onRetry: () => void;
  thumbnail: boolean;
}) {
  const state = useRetainedImageObjectUrl(artifact, load);
  const lightbox = useLightboxOptional();
  const [failed, setFailed] = useState(false);
  if (state.kind === "loading")
    return (
      <span role="status" className="p-2 text-xs text-fg-subtle">
        Loading image…
      </span>
    );
  if (state.kind !== "ready" || failed)
    return (
      <span role="status" className="max-w-full break-words p-2 text-sm">
        {alt || "Image"} unavailable.{" "}
        {!thumbnail ? (
          <Button variant="ghost" size="sm" onClick={onRetry}>
            Retry
          </Button>
        ) : null}
      </span>
    );
  const image = (
    <img
      src={state.url}
      alt={alt}
      loading="lazy"
      className={
        thumbnail
          ? "h-full w-full object-contain"
          : "my-3 max-h-[70dvh] max-w-full rounded-md object-contain"
      }
      onError={() => setFailed(true)}
    />
  );
  return lightbox && !thumbnail ? (
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
