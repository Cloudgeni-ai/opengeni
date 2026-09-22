import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import type { RetainedArtifactReference } from "@opengeni/sdk";
import { LightboxProvider } from "@opengeni/react";
import {
  AlertTriangleIcon,
  ArrowLeftIcon,
  DownloadIcon,
  FileIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useAppContext } from "@/context";
import { ArtifactSessionPage } from "@/components/session/artifact-session-page";
import { RetainedFilePreview } from "@/components/artifacts/retained-file-preview";
import { ContentPage } from "@/components/ui/content-layout";
import { Button } from "@/components/ui/button";
import { CopyableMono, PageHeader } from "@/components/common";
import { saveRetainedArtifact } from "@/lib/retained-artifact-download";
import { retainedArtifactLoadErrorPresentation } from "@/lib/retained-artifact-load-error";

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
        fromSession={fromSession}
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
  fromSession,
}: {
  workspaceId: string;
  artifactId: string;
  fromSession?: string;
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
      if (artifact.kind === "generated_video") {
        const source = await client.createVideoArtifactPlaybackSource(workspaceId, artifactId);
        if (generation === downloads.generation) {
          const link = document.createElement("a");
          link.href = source.url;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          link.click();
        }
        return;
      }
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
        search={fromSession ? { fromSession } : {}}
        className="mb-5 flex min-h-10 items-center gap-2 text-sm text-fg-muted hover:text-fg"
      >
        <ArrowLeftIcon className="size-4" />
        All artifacts
      </Link>
      {!loaded ? <p role="status">Loading artifact…</p> : null}
      {loaded?.error ? (
        <RetainedArtifactLoadError
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
                {downloading
                  ? "Opening…"
                  : artifact.kind === "generated_video"
                    ? "Open video"
                    : "Download"}
              </Button>
            }
          />
          {downloadError ? (
            <p role="alert" className="mb-4 text-sm text-danger">
              {downloadError}
            </p>
          ) : null}
          <div className="min-h-48 rounded-lg bg-surface-2 p-4">
            <RetainedFilePreview
              workspaceId={workspaceId}
              artifact={artifact}
              title={filename}
              filename={loaded?.filename}
            />
          </div>
        </>
      ) : null}
    </ContentPage>
  );
}

function RetainedArtifactLoadError({ error, onRetry }: { error: Error; onRetry: () => void }) {
  const presentation = retainedArtifactLoadErrorPresentation(error);
  return (
    <div
      role="alert"
      aria-live="assertive"
      className="flex items-start gap-2 rounded-lg border border-status-failed/40 bg-status-failed/10 p-3 text-sm text-fg"
    >
      <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-status-failed" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{presentation.title}</div>
        <p className="mt-0.5 text-xs leading-4 text-fg-muted">{presentation.description}</p>
        {presentation.supportReference ? (
          <div className="mt-2 min-w-0">
            <div className="text-xs text-fg-subtle">Support reference</div>
            <CopyableMono value={presentation.supportReference} />
          </div>
        ) : null}
      </div>
      {presentation.retryable ? (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-status-failed/50 px-2 text-xs font-medium text-fg transition-colors hover:bg-status-failed/20"
        >
          <RefreshCwIcon className="size-3" />
          Retry
        </button>
      ) : null}
    </div>
  );
}
