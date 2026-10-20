import { useEffect, useMemo, useRef, useState } from "react";
import type { FileAsset, RetainedArtifactReference } from "@opengeni/sdk";
import { LightboxProvider, createWorkspaceRetainedArtifactLoader } from "@opengeni/react";
import { PatchApplyCommand, isPatchFilename } from "@opengeni/react/artifacts";
import { DownloadIcon, LockKeyholeIcon, Maximize2Icon, RefreshCwIcon } from "lucide-react";
import { useAppContext } from "@/context";
import { ArtifactSessionPage } from "@/components/session/artifact-session-page";
import { ArtifactFullView } from "@/components/artifacts/artifact-full-view";
import {
  RetainedFilePreview,
  retainedPreviewKind,
} from "@/components/artifacts/retained-file-preview";
import { ContentPage } from "@/components/ui/content-layout";
import { Button } from "@/components/ui/button";
import { CopyableMono } from "@/components/common";
import { DetailPage, DetailPageHeader } from "@/components/ui/detail-page";
import { Notice } from "@/components/ui/notice";
import { RowButton } from "@/components/ui/page-actions";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ARTIFACT_DETAIL_FRAME,
  ArtifactKindTile,
  useArtifactsBackLink,
  useArtifactFullView,
} from "@/components/artifacts/artifact-page-chrome";
import { userErrorText } from "@/lib/api-error";
import { saveRetainedArtifact } from "@/lib/retained-artifact-download";
import {
  isPrivateFileLoadError,
  retainedArtifactLoadErrorPresentation,
} from "@/lib/retained-artifact-load-error";
import { FILE_AUDIENCE_COPY, useArtifactAudience } from "@/components/artifacts/site-audience";
import { isPersonalWorkspace } from "@/lib/managed-self-context";
import { hasWorkspacePermission } from "@/lib/permissions";
import { invalidateArtifactCatalog } from "@/lib/use-artifact-catalog";

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
        embedded={embedded}
      />
    </LightboxProvider>
  );
  return embedded ? (
    viewer
  ) : (
    <ArtifactSessionPage
      workspaceId={workspaceId}
      artifactId={artifactId}
      fromSession={fromSession}
    >
      {viewer}
    </ArtifactSessionPage>
  );
}

function RetainedArtifactDetail({
  workspaceId,
  artifactId,
  fromSession,
  embedded,
}: {
  workspaceId: string;
  artifactId: string;
  fromSession?: string;
  embedded: boolean;
}) {
  const context = useAppContext();
  const { client, accessKeyVersion } = context;
  const back = useArtifactsBackLink(workspaceId, fromSession);
  const [fullView, setFullView] = useArtifactFullView();
  const key = `${workspaceId}:${artifactId}:${accessKeyVersion}`;
  const [state, setState] = useState<{
    key: string;
    client: typeof client;
    artifact?: RetainedArtifactReference;
    filename?: string;
    /** The workspace file behind it, when there is one: who can open it. */
    file?: FileAsset;
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
        const own = file?.id === artifactId && file.workspaceId === workspaceId ? file : undefined;
        setState({
          key,
          client,
          artifact,
          filename: own?.filename,
          ...(own ? { file: own } : {}),
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
  // Only a file with something to look at has a full view; the rest open on
  // their page, where Download is.
  const expandable =
    !embedded &&
    artifact !== undefined &&
    retainedPreviewKind(artifact.contentType, loaded?.filename) !== null;
  const workspace = context.workspaces.find((candidate) => candidate.id === workspaceId) ?? null;
  // A Personal workspace has nobody to share with, so there is no audience.
  // Session screenshots and saved tool output stay with their chat.
  const file = loaded?.file;
  const showAudience =
    file !== undefined &&
    file.scope !== undefined &&
    artifact?.kind !== "computer_screenshot" &&
    artifact?.kind !== "browser_screenshot" &&
    artifact?.kind !== "tool_result" &&
    !isPersonalWorkspace(workspace, context.managedSelfContext);
  const audience = useArtifactAudience({
    client,
    workspaceId,
    workspaceName: workspace?.name ?? "this workspace",
    title: filename,
    visibility: file?.scope === "personal" ? "private" : "workspace",
    ownedByCurrentUser: Boolean(
      showAudience &&
      file?.ownerSubjectId &&
      file.ownerSubjectId === context.accessContext.subjectId &&
      hasWorkspacePermission(context.accessContext, workspaceId, "files:upload"),
    ),
    copy: FILE_AUDIENCE_COPY,
    update: async (visibility) => {
      const response = await client.updateFileVisibility(workspaceId, artifactId, { visibility });
      setState((current) => (current?.key === key ? { ...current, file: response.file } : current));
      invalidateArtifactCatalog(client, workspaceId);
    },
  });
  const patchLoader = useMemo(
    () => createWorkspaceRetainedArtifactLoader(client, workspaceId),
    [client, workspaceId],
  );
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
      if (generation === downloads.generation) setDownloadError(userErrorText(error, "Try again."));
    } finally {
      if (generation === downloads.generation) setDownloading(false);
    }
  };
  const downloadButton = artifact ? (
    <RowButton onClick={() => void download()} disabled={downloading}>
      <DownloadIcon aria-hidden="true" />
      {downloading ? "Opening…" : artifact.kind === "generated_video" ? "Open video" : "Download"}
    </RowButton>
  ) : null;
  const downloadNotice =
    artifact && downloadError ? (
      <Notice
        tone="failed"
        live="assertive"
        className="mt-6"
        title={
          artifact.kind === "generated_video"
            ? "Couldn't open the video"
            : "Couldn't download the file"
        }
      >
        {downloadError}
      </Notice>
    ) : null;
  const preview = artifact ? (
    <RetainedFilePreview
      workspaceId={workspaceId}
      artifact={artifact}
      title={filename}
      filename={loaded?.filename}
      workbenchTextPreview={embedded}
      fullSize
    />
  ) : null;
  const header = artifact ? (
    <DetailPageHeader
      leading={
        <ArtifactKindTile kind={artifact.contentType.startsWith("image/") ? "image" : "file"} />
      }
      title={filename}
      chips={showAudience ? audience.chip : null}
      meta={[
        fileTypeLabel(artifact.contentType, loaded?.filename),
        formatBytes(artifact.originalBytes),
      ]}
      actions={
        <>
          {showAudience ? audience.shareButton : null}
          {expandable ? (
            <RowButton onClick={() => setFullView(true)}>
              <Maximize2Icon aria-hidden="true" />
              Full screen
            </RowButton>
          ) : null}
          {downloadButton}
        </>
      }
    />
  ) : null;
  if (expandable && fullView)
    return (
      <ArtifactFullView title={filename} onBack={() => setFullView(false)} actions={downloadButton}>
        {downloadNotice ? <div className="mb-4 [&>*]:mt-0">{downloadNotice}</div> : null}
        {preview}
      </ArtifactFullView>
    );
  return (
    <ContentPage width="standard" className={ARTIFACT_DETAIL_FRAME}>
      <DetailPage back={embedded ? undefined : back}>
        {!loaded ? (
          <>
            <div className="flex items-start gap-4" aria-busy="true">
              <Skeleton className="size-10 rounded-[10px]" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-6 w-64 max-w-full" />
                <Skeleton className="h-4 w-40 max-w-full" />
              </div>
            </div>
            <p role="status" className="sr-only">
              Loading artifact…
            </p>
          </>
        ) : null}
        {loaded?.error ? (
          <RetainedArtifactLoadError
            error={loaded.error}
            onRetry={() => setRetry((value) => value + 1)}
          />
        ) : null}
        {artifact ? (
          <>
            {header}
            {downloadNotice}
            {artifact.kind === "file" && loaded?.filename && isPatchFilename(loaded.filename) ? (
              <div className="mt-6">
                <PatchApplyCommand
                  artifact={artifact}
                  filename={loaded.filename}
                  load={patchLoader}
                />
              </div>
            ) : null}
            <div className="mt-6 min-h-48 min-w-0 rounded-[14px] bg-surface-2 p-4 max-sm:p-2">
              {preview}
            </div>
          </>
        ) : null}
        {showAudience ? audience.dialog : null}
      </DetailPage>
    </ContentPage>
  );
}

/** "PNG", "PDF", "CSV": the file's type as a person names it, never a MIME string. */
function fileTypeLabel(contentType: string, filename?: string): string {
  const extension = filename?.match(/\.([A-Za-z0-9]{1,5})$/)?.[1];
  const subtype = contentType.split(";")[0]?.split("/")[1] ?? "";
  const word = extension ?? (/^[a-z0-9]{1,5}$/i.test(subtype) ? subtype : "");
  const kind = contentType.startsWith("image/")
    ? "image"
    : contentType.startsWith("video/")
      ? "video"
      : "file";
  return word
    ? `${word.toUpperCase()} ${kind}`
    : kind === "file"
      ? "File"
      : kind === "image"
        ? "Image"
        : "Video";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function RetainedArtifactLoadError({ error, onRetry }: { error: Error; onRetry: () => void }) {
  const presentation = retainedArtifactLoadErrorPresentation(error);
  // Someone else's Only me file is not a failure: it is private, and its
  // owner can share it. Nothing about the file itself is shown.
  const privateFile = isPrivateFileLoadError(error);
  return (
    <Notice
      tone={privateFile ? "info" : "failed"}
      live={privateFile ? "polite" : "assertive"}
      {...(privateFile ? { icon: <LockKeyholeIcon className="size-4" aria-hidden /> } : {})}
      title={presentation.title}
      actionLayout="responsive"
      action={
        presentation.retryable ? (
          <Button type="button" size="sm" variant="outline" onClick={onRetry}>
            <RefreshCwIcon aria-hidden="true" />
            Retry
          </Button>
        ) : undefined
      }
    >
      <p>{presentation.description}</p>
      {presentation.supportReference ? (
        <div className="mt-2 min-w-0">
          <div className="text-xs text-fg-subtle">Support reference</div>
          <CopyableMono value={presentation.supportReference} />
        </div>
      ) : null}
    </Notice>
  );
}
