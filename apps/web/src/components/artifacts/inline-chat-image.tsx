import { useEffect, useMemo, useState } from "react";
import type { RetainedArtifactMetadata, RetainedArtifactReference } from "@opengeni/sdk";
import { isRetainedImageContentType, useRetainedImageObjectUrl } from "@opengeni/react/artifacts";
import { createWorkspaceRetainedArtifactLoader, useLightboxOptional } from "@opengeni/react";
import { useAppContext } from "@/context";
import { Button } from "@/components/ui/button";
import { Link } from "@tanstack/react-router";
import { DeferredChatMedia } from "@opengeni/react/artifacts";
import {
  cachedRetainedArtifactLoader,
  cachedRetainedMetadata,
  retainedImageCache,
  retainedImageScope,
} from "./retained-image-cache";

const CHAT_IMAGE_HEIGHT = 360;

type InlineChatImageProps = {
  workspaceId: string;
  artifactId: string;
  alt: string;
  /** Non-interactive image for a surrounding catalog link; no nested controls. */
  thumbnail?: boolean;
  /** Full artifact viewer uses the page width instead of the fixed chat slot. */
  viewer?: boolean;
  showArtifactLink?: boolean;
  fromSession?: string;
};

export function InlineChatImage(props: InlineChatImageProps) {
  if (props.thumbnail || props.viewer) return <InlineChatImageBody {...props} />;
  return (
    <DeferredChatMedia
      key={`${props.workspaceId}:${props.artifactId}`}
      height={CHAT_IMAGE_HEIGHT}
      label={props.alt || "image"}
    >
      {/* Metadata must not change the height reserved before viewport entry. */}
      <div
        className="flex w-full min-w-0 flex-col overflow-hidden rounded-md"
        style={{ height: CHAT_IMAGE_HEIGHT }}
      >
        <InlineChatImageBody {...props} />
      </div>
    </DeferredChatMedia>
  );
}

function InlineChatImageBody({
  workspaceId,
  artifactId,
  alt,
  thumbnail = false,
  viewer = false,
  showArtifactLink = false,
  fromSession,
}: InlineChatImageProps) {
  const { client, accessKeyVersion } = useAppContext();
  const cache = retainedImageCache(client);
  const scope = retainedImageScope(accessKeyVersion, workspaceId, artifactId);
  // A remount (tab switch, search, scroll) starts from what this page already has.
  const [loaded, setLoaded] = useState<{
    client: typeof client;
    workspaceId: string;
    accessKeyVersion: number;
    artifact: RetainedArtifactReference;
  } | null>(() => {
    const artifact = cache.peek<RetainedArtifactMetadata>(`${scope}meta`);
    return artifact && usableImage(artifact, artifactId)
      ? { client, workspaceId, accessKeyVersion, artifact }
      : null;
  });
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setError(false);
    void cachedRetainedMetadata(retainedImageCache(client), scope, () =>
      client.getRetainedArtifact(workspaceId, artifactId),
    )
      .then((artifact) => {
        if (!active) return;
        if (!usableImage(artifact, artifactId)) {
          setError(true);
          return;
        }
        setLoaded((current) =>
          current?.artifact === artifact &&
          current.client === client &&
          current.workspaceId === workspaceId &&
          current.accessKeyVersion === accessKeyVersion
            ? current
            : { client, workspaceId, accessKeyVersion, artifact },
        );
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [client, workspaceId, accessKeyVersion, artifactId, scope, retry]);
  const load = useMemo(
    () =>
      cachedRetainedArtifactLoader(
        retainedImageCache(client),
        accessKeyVersion,
        workspaceId,
        createWorkspaceRetainedArtifactLoader(client, workspaceId),
      ),
    [client, workspaceId, accessKeyVersion],
  );
  // Retry means "fetch again": never answer it from the cache.
  const retryFresh = () => {
    cache.forget(scope);
    setLoaded(null);
    setRetry((v) => v + 1);
  };
  if (error)
    return (
      <span role="status" className="max-w-full break-words p-2 text-sm">
        {alt || "Image"} unavailable.{" "}
        {!thumbnail ? (
          <Button variant="ghost" size="sm" onClick={retryFresh}>
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
  const image = (
    <LoadedImage
      key={`${workspaceId}:${artifactId}:${retry}`}
      artifact={loaded.artifact}
      load={load}
      alt={alt}
      thumbnail={thumbnail}
      viewer={viewer}
      onRetry={retryFresh}
    />
  );
  return (
    <>
      {thumbnail ? (
        image
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center">{image}</div>
      )}
      {showArtifactLink && !thumbnail ? (
        <Link
          to="/workspaces/$workspaceId/artifacts/files/$artifactId"
          params={{ workspaceId, artifactId }}
          search={fromSession ? { fromSession } : {}}
          className="mt-1 inline-flex min-h-9 shrink-0 items-center text-xs text-fg-muted underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Open in Artifacts
        </Link>
      ) : null}
    </>
  );
}

function usableImage(
  artifact: RetainedArtifactMetadata,
  artifactId: string,
): artifact is RetainedArtifactReference {
  return (
    artifact.available &&
    artifact.artifactId === artifactId &&
    isRetainedImageContentType(artifact.contentType)
  );
}

function LoadedImage({
  artifact,
  load,
  alt,
  onRetry,
  thumbnail,
  viewer,
}: {
  artifact: RetainedArtifactReference;
  load: ReturnType<typeof createWorkspaceRetainedArtifactLoader>;
  alt: string;
  onRetry: () => void;
  thumbnail: boolean;
  viewer: boolean;
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
      width={artifact.dimensions?.width}
      height={artifact.dimensions?.height}
      className={
        thumbnail
          ? "h-full w-full object-contain"
          : viewer
            ? "block h-auto max-h-[calc(100dvh-12rem)] w-full min-w-0 rounded-md object-contain"
            : "h-full w-full min-w-0 rounded-md object-contain"
      }
      onError={() => setFailed(true)}
    />
  );
  return lightbox && !thumbnail ? (
    <button
      type="button"
      aria-label={`Expand ${alt || "image"}`}
      className={`block w-full min-w-0 cursor-zoom-in rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-2 focus-visible:ring-offset-bg ${viewer ? "" : "h-full"}`}
      onClick={(event) => lightbox.open(state.url, alt, event.currentTarget, "Image")}
    >
      {image}
    </button>
  ) : (
    image
  );
}
