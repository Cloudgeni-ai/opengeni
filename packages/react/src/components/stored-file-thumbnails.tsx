import type { FileAsset, ResourceRef } from "@opengeni/sdk";
import { ImageIcon } from "lucide-react";
import { useContext } from "react";
import { cn } from "../lib/cn";
import { useOpenGeniText } from "../messages/runtime";
import { OpenGeniContext } from "../session-context";
import {
  isStoredImage,
  useStoredFilePreview,
  useStoredFiles,
  type StoredFileSource,
} from "../stored-file-preview";
import { useLightboxOptional } from "../timeline/screenshot-lightbox";

/**
 * The images attached to a message that is not in the timeline yet (a queued
 * message), as small pictures loaded from the server. Other files stay in the
 * row's resource count, so a row without images keeps its height. Shows
 * nothing until the files resolve, or without a client.
 */
export function StoredFileThumbnails({
  workspaceId,
  sessionId,
  resources,
  className,
}: {
  workspaceId: string;
  sessionId?: string | null | undefined;
  resources: readonly ResourceRef[];
  className?: string | undefined;
}) {
  const context = useContext(OpenGeniContext);
  const source: StoredFileSource | null = context
    ? { client: context.client, workspaceId, sessionId }
    : null;
  const fileIds = resources.flatMap((resource) =>
    resource.kind === "file" ? [resource.fileId] : [],
  );
  const { files, ready } = useStoredFiles(source, fileIds);
  if (!source || !ready) return null;
  const shown = fileIds.flatMap((fileId, index) => {
    const file = files.get(fileId);
    return file && isStoredImage(file) ? [{ file, key: `${index}:${fileId}` }] : [];
  });
  if (shown.length === 0) return null;
  return (
    <div className={cn("flex min-w-0 flex-wrap gap-1.5", className)} data-stored-file-thumbnails="">
      {shown.map(({ file, key }) => (
        <StoredImageThumbnail key={key} source={source} file={file} />
      ))}
    </div>
  );
}

function StoredImageThumbnail({ source, file }: { source: StoredFileSource; file: FileAsset }) {
  const t = useOpenGeniText();
  const lightbox = useLightboxOptional();
  const preview = useStoredFilePreview(source, file);
  const frame =
    "flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-og-md border border-og-border bg-og-surface-2";
  if (!preview.url) {
    return (
      <span className={cn(frame, !preview.failed && "animate-pulse")} title={file.filename}>
        <ImageIcon aria-hidden="true" className="size-4 text-og-fg-muted" />
        <span className="sr-only">{file.filename}</span>
      </span>
    );
  }
  const image = (
    <img
      src={preview.url}
      alt={file.filename}
      onError={preview.onError}
      className="h-full w-full object-cover"
    />
  );
  if (!lightbox) {
    return (
      <span className={frame} title={file.filename}>
        {image}
      </span>
    );
  }
  const url = preview.url;
  return (
    <button
      type="button"
      className={cn(
        frame,
        "outline-hidden hover:opacity-80 focus-visible:ring-2 focus-visible:ring-og-accent",
      )}
      title={file.filename}
      aria-label={t("composerMessages.previewName", { name: file.filename })}
      onClick={(event) =>
        lightbox.open(
          url,
          file.filename,
          event.currentTarget,
          t("composerMessages.attachmentPreview"),
          file.filename,
          {
            download: t("composerMessages.downloadName", { name: file.filename }),
            close: t("composerMessages.close"),
          },
        )
      }
    >
      {image}
    </button>
  );
}
