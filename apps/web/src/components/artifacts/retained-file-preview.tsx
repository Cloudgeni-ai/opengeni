import { Component, lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import type { RetainedArtifactReference } from "@opengeni/sdk";
import { isRetainedImageContentType } from "@opengeni/react/artifacts";
import { useAppContext } from "@/context";
import { Button } from "@/components/ui/button";
import { InlineChatImage } from "./inline-chat-image";
import { DeferredChatMedia } from "./deferred-chat-media";
const PdfFilePreview = lazy(() => import("./pdf-file-preview"));

export function retainedPreviewKind(contentType: string) {
  if (isRetainedImageContentType(contentType)) return "image";
  if (["video/mp4", "video/webm", "video/ogg"].includes(contentType)) return "video";
  if (
    ["audio/mpeg", "audio/mp4", "audio/ogg", "audio/wav", "audio/webm", "audio/flac"].includes(
      contentType,
    )
  )
    return "audio";
  if (contentType === "application/pdf") return "pdf";
  return null;
}

/** The same authorized preview is used by the artifact page and chat. */
type PreviewProps = {
  workspaceId: string;
  artifact: RetainedArtifactReference;
  title: string;
};

export function RetainedFilePreview(props: PreviewProps) {
  const { accessKeyVersion } = useAppContext();
  if (!props.artifact.available) return <p role="status">Artifact unavailable.</p>;
  return (
    <RetainedFilePreviewBody
      key={JSON.stringify([props.workspaceId, accessKeyVersion, props.artifact])}
      {...props}
    />
  );
}

function RetainedFilePreviewBody({ workspaceId, artifact: initialArtifact, title }: PreviewProps) {
  // The parent remounts on receipt changes, not object allocation on a rerender.
  const [artifact] = useState(initialArtifact);
  const { client, accessKeyVersion } = useAppContext();
  const kind = retainedPreviewKind(artifact.contentType);
  const [retry, setRetry] = useState(0);
  const [failed, setFailed] = useState(false);
  const [source, setSource] = useState<{ key: string; client: typeof client; url: string } | null>(
    null,
  );
  const key = `${workspaceId}:${artifact.artifactId}:${artifact.sha256}:${accessKeyVersion}:${retry}`;
  useEffect(() => {
    setSource(null);
    setFailed(false);
    if (!kind || kind === "image") return;
    const controller = new AbortController();
    let objectUrl: string | undefined;
    void (async () => {
      // PDFs need an inline Blob rather than a storage URL with download disposition.
      const url =
        kind === "pdf"
          ? URL.createObjectURL(
              new Blob(
                [
                  (
                    await client.downloadRetainedArtifact(workspaceId, artifact, {
                      signal: controller.signal,
                    })
                  ).bytes as BlobPart,
                ],
                { type: "application/pdf" },
              ),
            )
          : artifact.kind === "generated_video"
            ? (
                await client.createVideoArtifactPlaybackSource(workspaceId, artifact.artifactId, {
                  signal: controller.signal,
                })
              ).url
            : (
                await client.createRetainedArtifactDownloadUrl(workspaceId, artifact, {
                  signal: controller.signal,
                })
              ).url;
      if (kind === "pdf") objectUrl = url;
      if (controller.signal.aborted) {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        return;
      }
      setSource({ key, client, url });
    })().catch(() => {
      if (!controller.signal.aborted) setFailed(true);
    });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [client, key, kind, workspaceId, artifact]);
  if (kind === "image")
    return (
      <InlineChatImage workspaceId={workspaceId} artifactId={artifact.artifactId} alt={title} />
    );
  if (!kind)
    return (
      <p className="p-4 text-sm text-fg-muted">
        Preview is not available for this file. Download it to open it.
      </p>
    );
  if (failed)
    return (
      <div role="status" className="p-4 text-sm">
        Preview could not be loaded. Use the artifact action to open the file.{" "}
        <Button variant="ghost" size="sm" onClick={() => setRetry((n) => n + 1)}>
          Retry preview
        </Button>
      </div>
    );
  if (!source || source.key !== key || source.client !== client)
    return (
      <p role="status" className="p-4 text-sm">
        Loading preview…
      </p>
    );
  if (kind === "video")
    return (
      <video
        key={source.url}
        src={source.url}
        controls
        playsInline
        preload="metadata"
        aria-label={title}
        onError={() => setFailed(true)}
        className="max-h-[480px] w-full rounded-md"
      />
    );
  if (kind === "audio")
    return (
      <audio
        key={source.url}
        src={source.url}
        controls
        preload="metadata"
        aria-label={title}
        onError={() => setFailed(true)}
        className="w-full"
      />
    );
  return (
    <PreviewErrorBoundary key={source.url}>
      <Suspense fallback={<p role="status">Loading PDF…</p>}>
        <PdfFilePreview key={source.url} url={source.url} title={title} />
      </Suspense>
    </PreviewErrorBoundary>
  );
}

class PreviewErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <p role="status">PDF preview unavailable. Download the file or reload to try again.</p>
    ) : (
      this.props.children
    );
  }
}

export function InlineChatArtifact({
  workspaceId,
  artifactId,
  alt,
}: {
  workspaceId: string;
  artifactId: string;
  alt: string;
}) {
  return (
    <DeferredChatMedia height={400} label={alt || "artifact"}>
      <div className="h-[400px] overflow-auto">
        <InlineArtifactBody
          key={`${workspaceId}:${artifactId}`}
          workspaceId={workspaceId}
          artifactId={artifactId}
          alt={alt}
        />
      </div>
    </DeferredChatMedia>
  );
}

function InlineArtifactBody({
  workspaceId,
  artifactId,
  alt,
}: {
  workspaceId: string;
  artifactId: string;
  alt: string;
}) {
  const { client, accessKeyVersion } = useAppContext();
  const [retry, setRetry] = useState(0);
  const [loaded, setLoaded] = useState<{
    client: typeof client;
    accessKeyVersion: number;
    artifact?: RetainedArtifactReference;
    error?: boolean;
  } | null>(null);
  useEffect(() => {
    let active = true;
    setLoaded(null);
    void client
      .getRetainedArtifact(workspaceId, artifactId)
      .then((artifact) => {
        if (active)
          setLoaded(
            artifact.available && artifact.artifactId === artifactId
              ? { client, accessKeyVersion, artifact }
              : { client, accessKeyVersion, error: true },
          );
      })
      .catch(() => {
        if (active) setLoaded({ client, accessKeyVersion, error: true });
      });
    return () => {
      active = false;
    };
  }, [client, accessKeyVersion, workspaceId, artifactId, retry]);
  const current =
    loaded?.client === client && loaded.accessKeyVersion === accessKeyVersion ? loaded : null;
  return (
    <div className="my-2 min-w-0">
      {!current ? (
        <p role="status">Loading artifact…</p>
      ) : current.artifact ? (
        <RetainedFilePreview
          workspaceId={workspaceId}
          artifact={current.artifact}
          title={alt || "Artifact"}
        />
      ) : (
        <p role="status">
          Artifact unavailable.{" "}
          <Button variant="ghost" size="sm" onClick={() => setRetry((n) => n + 1)}>
            Retry
          </Button>
        </p>
      )}
      <a
        href={`/workspaces/${workspaceId}/artifacts/files/${artifactId}`}
        className="text-sm underline"
      >
        Open {alt || "artifact"} in Artifacts
      </a>
    </div>
  );
}
