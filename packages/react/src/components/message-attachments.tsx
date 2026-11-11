import type { ResourceRef } from "@opengeni/sdk";
import { useContext, useMemo, useRef } from "react";
import { defaultChatComposerMessages } from "../composer-messages";
import type { FileAttachment } from "../hooks/use-file-attachments";
import { cn } from "../lib/cn";
import { useOpenGeniText } from "../messages/runtime";
import { readStoredFilePreviewUrl, useStoredFiles } from "../stored-file-preview";
import { ArtifactLinkScopeContext } from "./artifact-link-scope";
import { AttachmentChips, storedFileAttachment } from "./attachment-chips";
import {
  chainLinkResolvers,
  sessionLinkResolver,
  useOpenGeniLinkResolver,
} from "./open-geni-links";

/**
 * The files sent with a user message, shown the way they looked in the
 * composer before sending: an image as a thumbnail that opens larger, any
 * other file as a named chip that opens it like an `artifact:` link in a
 * reply would (the host's link resolver first, otherwise a download). Files
 * are read through the timeline's `artifactScope`; one that can't be read
 * stays as a chip saying it is unavailable, so the message never looks as if
 * nothing was attached.
 */
export function MessageAttachments({
  resources,
  className,
}: {
  resources: readonly ResourceRef[];
  className?: string | undefined;
}) {
  const t = useOpenGeniText();
  const scope = useContext(ArtifactLinkScopeContext);
  const hostLinks = useOpenGeniLinkResolver();
  const client = scope?.client;
  const workspaceId = scope?.workspaceId;
  const sessionId = scope?.sessionId;
  const source = useMemo(
    () => (client && workspaceId ? { client, workspaceId, sessionId } : null),
    [client, workspaceId, sessionId],
  );
  const files = resources.flatMap((resource, index) =>
    resource.kind === "file"
      ? [{ id: `${index}:${resource.fileId}`, fileId: resource.fileId }]
      : [],
  );
  const stored = useStoredFiles(
    source,
    files.map((file) => file.fileId),
  );
  const fileIdByIdRef = useRef(new Map<string, string>());
  fileIdByIdRef.current = new Map(files.map((file) => [file.id, file.fileId]));
  // Stable across renders: the chips abort an open preview when it changes.
  const loadPreview = useMemo(
    () =>
      source && typeof source.client.createFileDownloadUrl === "function"
        ? async (id: string) => {
            const fileId = fileIdByIdRef.current.get(id);
            return fileId ? await readStoredFilePreviewUrl(source, fileId) : undefined;
          }
        : undefined,
    [source],
  );
  const links = useMemo(
    () =>
      chainLinkResolvers(
        hostLinks,
        client && workspaceId && sessionId
          ? sessionLinkResolver(t, { client, workspaceId, sessionId })
          : null,
      ),
    [client, hostLinks, sessionId, t, workspaceId],
  );
  const messages = useMemo(() => defaultChatComposerMessages(t), [t]);
  if (files.length === 0) return null;
  const frame = cn("flex max-w-full flex-wrap gap-1.5", className);
  if (!stored.ready) {
    return (
      <div className={frame} data-og-message-attachments="" aria-busy="true">
        {files.map((file) => (
          <span
            key={file.id}
            className="h-8 w-36 animate-pulse rounded-og-md border border-og-border bg-og-surface-2"
          />
        ))}
      </div>
    );
  }
  const attachments = files.map(({ id, fileId }): FileAttachment => {
    const file = stored.files.get(fileId);
    if (file) return storedFileAttachment(id, file);
    // Deleted, or not shared with this reader: say so instead of hiding it.
    return {
      id,
      name: messages.restoredFile(fileId),
      contentType: "application/octet-stream",
      sizeBytes: 0,
      status: "ready",
    };
  });
  return (
    <div data-og-message-attachments="" className="max-w-full">
      <AttachmentChips
        className={className}
        attachments={attachments}
        messages={messages}
        onLoadPreview={loadPreview}
        openFile={(attachment) =>
          attachment.file
            ? links?.({
                kind: "file",
                fileId: attachment.file.id,
                workspaceId: workspaceId ?? null,
              })
            : null
        }
      />
    </div>
  );
}
