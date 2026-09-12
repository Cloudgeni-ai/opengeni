import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import type { RetainedArtifactReference } from "@opengeni/sdk";
import { LightboxProvider } from "@opengeni/react";
import { isRetainedImageContentType } from "@opengeni/react/artifacts";
import { ArrowLeftIcon, DownloadIcon, FileIcon } from "lucide-react";
import { useAppContext } from "@/context";
import { ArtifactSessionPage } from "@/components/session/artifact-session-page";
import { InlineChatImage } from "@/components/artifacts/inline-chat-image";
import { ContentPage } from "@/components/ui/content-layout";
import { Button } from "@/components/ui/button";
import { LoadErrorState, PageHeader } from "@/components/common";
import { saveRetainedArtifact } from "@/lib/retained-artifact-download";

export function RetainedArtifactRoute({
  workspaceId,
  artifactId,
  fromSession,
  embedded = false,
}: {
  workspaceId: string;
  artifactId: string;
  fromSession?: string;
  embedded?: boolean;
}) {
  const viewer = (
    <LightboxProvider>
      <RetainedArtifactDetail
        key={`${workspaceId}:${artifactId}`}
        workspaceId={workspaceId}
        artifactId={artifactId}
      />
    </LightboxProvider>
  );
  return embedded ? (
    viewer
  ) : (
    <ArtifactSessionPage workspaceId={workspaceId} fromSession={fromSession}>
      {viewer}
    </ArtifactSessionPage>
  );
}

function RetainedArtifactDetail({
  workspaceId,
  artifactId,
}: {
  workspaceId: string;
  artifactId: string;
}) {
  const { client, accessKeyVersion } = useAppContext();
  const key = `${workspaceId}:${artifactId}:${accessKeyVersion}`;
  const [state, setState] = useState<{
    key: string;
    client: typeof client;
    artifact?: RetainedArtifactReference;
    filename?: string;
    error?: Error;
  } | null>(null);
  const [retry, setRetry] = useState(0);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const downloads = useRef({ generation: 0 }).current;
  useEffect(() => {
    let current = true;
    setState(null);
    setDownloading(false);
    setDownloadError(null);
    void Promise.all([
      client.getRetainedArtifact(workspaceId, artifactId),
      client.getFile(workspaceId, artifactId).catch(() => null),
    ])
      .then(([artifact, file]) => {
        if (!current) return;
        if (!artifact.available || artifact.artifactId !== artifactId)
          throw new Error("This artifact is no longer available.");
        setState({
          key,
          client,
          artifact,
          filename:
            file?.id === artifactId && file.workspaceId === workspaceId ? file.filename : undefined,
        });
      })
      .catch((error: unknown) => {
        if (current)
          setState({
            key,
            client,
            error: error instanceof Error ? error : new Error("Artifact could not be loaded."),
          });
      });
    return () => {
      current = false;
      downloads.generation++;
    };
  }, [key, client, workspaceId, artifactId, retry, downloads]);
  const loaded = state?.key === key && state.client === client ? state : null;
  const artifact = loaded?.artifact;
  const filename =
    loaded?.filename || (artifact?.contentType.startsWith("image/") ? "Image" : "Artifact");
  const download = async () => {
    if (!artifact || downloading) return;
    setDownloading(true);
    setDownloadError(null);
    const generation = ++downloads.generation;
    try {
      const result = await client.downloadRetainedArtifact(workspaceId, artifact);
      if (generation === downloads.generation)
        saveRetainedArtifact(artifact, result.bytes, filename);
    } catch (error) {
      if (generation === downloads.generation)
        setDownloadError(error instanceof Error ? error.message : "Download failed. Try again.");
    } finally {
      if (generation === downloads.generation) setDownloading(false);
    }
  };
  return (
    <ContentPage width="standard">
      <Link
        to="/workspaces/$workspaceId/artifacts"
        params={{ workspaceId }}
        className="mb-5 flex min-h-10 items-center gap-2 text-sm text-fg-muted hover:text-fg"
      >
        <ArrowLeftIcon className="size-4" />
        All artifacts
      </Link>
      {!loaded ? <p role="status">Loading artifact…</p> : null}
      {loaded?.error ? (
        <LoadErrorState
          title="Artifact unavailable"
          error={loaded.error}
          onRetry={() => setRetry((value) => value + 1)}
        />
      ) : null}
      {artifact ? (
        <>
          <PageHeader
            icon={<FileIcon className="size-4" />}
            title={filename}
            description={artifact.contentType}
            actions={
              <Button variant="outline" onClick={() => void download()} disabled={downloading}>
                <DownloadIcon className="mr-2 size-4" />
                {downloading ? "Downloading…" : "Download"}
              </Button>
            }
          />
          {downloadError ? (
            <p role="alert" className="mb-4 text-sm text-danger">
              {downloadError}
            </p>
          ) : null}
          {isRetainedImageContentType(artifact.contentType) ? (
            <div className="flex min-h-48 justify-center rounded-lg bg-surface-2 p-4">
              <InlineChatImage workspaceId={workspaceId} artifactId={artifactId} alt={filename} />
            </div>
          ) : (
            <div className="flex min-h-48 flex-col items-center justify-center gap-3 rounded-lg bg-surface-2 px-6 text-center">
              <FileIcon className="size-8 text-fg-subtle" />
              <p className="text-sm text-fg-muted">
                Preview is not available for this file. Download it to open it.
              </p>
            </div>
          )}
        </>
      ) : null}
    </ContentPage>
  );
}
