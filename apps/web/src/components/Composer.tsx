// Console chrome around @opengeni/react's ChatComposer: draft file
// attachments (upload, chips, paste-to-attach) and the console's control
// strip. The textarea, send/stop controls, Enter handling, and draft/error
// state all come from the package.
import { ChatComposer, type ComposerState } from "@opengeni/react";
import { FileIcon, ImageIcon, Loader2Icon, PaperclipIcon, XIcon } from "lucide-react";
import {
  type ClipboardEvent,
  type ChangeEvent,
  type ReactNode,
  useCallback,
  useRef,
  useState,
} from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { uploadFileAsset } from "@/api";
import type { FileAsset, ResourceRef, SessionStatus } from "@/types";

type DraftAttachment = {
  id: string;
  name: string;
  contentType: string;
  sizeBytes: number;
  status: "uploading" | "ready" | "failed";
  file?: FileAsset;
  previewUrl?: string;
  error?: string;
};

export type DraftAttachmentsState = {
  attachments: DraftAttachment[];
  /** File resources for every attachment that finished uploading. */
  readyResources: ResourceRef[];
  uploading: boolean;
  enqueueFiles: (files: Iterable<File>) => void;
  removeAttachment: (id: string) => void;
  clear: () => void;
};

/** Upload-and-track state for files attached to the next message. */
export function useDraftAttachments(workspaceId: string): DraftAttachmentsState {
  const [attachments, setAttachments] = useState<DraftAttachment[]>([]);

  const enqueueFiles = useCallback((files: Iterable<File>) => {
    for (const file of files) {
      const id = crypto.randomUUID();
      const previewUrl = file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined;
      setAttachments((current) => [...current, {
        id,
        name: file.name || "image",
        contentType: file.type || "application/octet-stream",
        sizeBytes: file.size,
        status: "uploading",
        ...(previewUrl ? { previewUrl } : {}),
      }]);
      void uploadFileAsset(workspaceId, file).then((asset) => {
        setAttachments((current) => current.map((attachment) => attachment.id === id
          ? { ...attachment, status: "ready", file: asset, name: asset.filename, contentType: asset.contentType, sizeBytes: asset.sizeBytes }
          : attachment));
      }).catch((error) => {
        setAttachments((current) => current.map((attachment) => attachment.id === id
          ? { ...attachment, status: "failed", error: error instanceof Error ? error.message : String(error) }
          : attachment));
      });
    }
  }, [workspaceId]);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((current) => {
      const removed = current.find((attachment) => attachment.id === id);
      if (removed?.previewUrl) {
        URL.revokeObjectURL(removed.previewUrl);
      }
      return current.filter((attachment) => attachment.id !== id);
    });
  }, []);

  const clear = useCallback(() => {
    setAttachments((current) => {
      for (const attachment of current) {
        if (attachment.previewUrl) {
          URL.revokeObjectURL(attachment.previewUrl);
        }
      }
      return [];
    });
  }, []);

  return {
    attachments,
    readyResources: attachments.flatMap((attachment): ResourceRef[] => attachment.status === "ready" && attachment.file
      ? [{ kind: "file", fileId: attachment.file.id }]
      : []),
    uploading: attachments.some((attachment) => attachment.status === "uploading"),
    enqueueFiles,
    removeAttachment,
    clear,
  };
}

export function ConsoleComposer(props: {
  composer: ComposerState;
  attachments: DraftAttachmentsState;
  status?: SessionStatus | null;
  placeholder?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  hint?: string;
  fileUploadsEnabled: boolean;
  /** Console controls (model picker, tool toggles, ...) in the footer row. */
  controls?: ReactNode;
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const { composer, attachments } = props;
  // Block sends while attachments are still uploading so a message never
  // departs without the files the user attached to it. `send` is gated too:
  // Enter-to-send calls it directly, without consulting `canSend`.
  const gatedComposer: ComposerState = attachments.uploading
    ? { ...composer, canSend: false, send: async () => false }
    : composer;

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    if (event.target.files) {
      attachments.enqueueFiles(event.target.files);
    }
    event.target.value = "";
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    if (!props.fileUploadsEnabled) {
      return;
    }
    const files = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
    if (files.length > 0) {
      attachments.enqueueFiles(files);
    }
  }

  return (
    <div className="w-full">
      <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileChange} />
      <ChatComposer
        composer={gatedComposer}
        status={props.status}
        placeholder={props.placeholder}
        autoFocus={props.autoFocus}
        disabled={props.disabled}
        hint={props.hint}
        onPaste={handlePaste}
        header={attachments.attachments.length > 0 ? (
          <AttachmentChips attachments={attachments.attachments} onRemove={attachments.removeAttachment} />
        ) : undefined}
        controlsStart={(
          <>
            {props.controls}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8 rounded-md"
              disabled={props.disabled || !props.fileUploadsEnabled}
              onClick={() => fileInputRef.current?.click()}
              aria-label={props.fileUploadsEnabled ? "Attach files" : "File uploads unavailable"}
              title={props.fileUploadsEnabled ? "Attach files" : "File uploads are not configured"}
            >
              <PaperclipIcon className="size-4" />
            </Button>
          </>
        )}
      />
    </div>
  );
}

function AttachmentChips({ attachments, onRemove }: {
  attachments: DraftAttachment[];
  onRemove: (id: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2 border-b border-[color:var(--color-border)] px-3 py-2">
      {attachments.map((attachment) => (
        <div
          key={attachment.id}
          className={cn(
            "flex min-w-0 max-w-[240px] items-center gap-2 rounded-md border px-2 py-1.5",
            "border-[color:var(--color-border)] bg-[color:var(--color-surface-2)] text-xs",
          )}
        >
          {attachment.previewUrl ? (
            <img src={attachment.previewUrl} alt="" className="size-8 shrink-0 rounded object-cover" />
          ) : attachment.contentType.startsWith("image/") ? (
            <ImageIcon className="size-4 shrink-0 text-[color:var(--color-fg-muted)]" />
          ) : (
            <FileIcon className="size-4 shrink-0 text-[color:var(--color-fg-muted)]" />
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium text-[color:var(--color-fg)]">{attachment.name}</div>
            <div className={cn(
              "truncate text-[11px]",
              attachment.status === "failed" ? "text-[color:var(--color-danger)]" : "text-[color:var(--color-fg-subtle)]",
            )}
            >
              {attachment.status === "uploading" ? "Uploading" : attachment.status === "failed" ? "Upload failed" : formatBytes(attachment.sizeBytes)}
            </div>
          </div>
          {attachment.status === "uploading" ? <Loader2Icon className="size-3.5 shrink-0 animate-spin" /> : null}
          <button
            type="button"
            onClick={() => onRemove(attachment.id)}
            className="shrink-0 rounded p-1 text-[color:var(--color-fg-muted)] hover:bg-[color:var(--color-surface)] hover:text-[color:var(--color-fg)]"
            aria-label={`Remove ${attachment.name}`}
          >
            <XIcon className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB"] as const;
  let value = bytes / 1024;
  for (const unit of units) {
    if (value < 1024 || unit === "GB") {
      return `${value.toFixed(value < 10 ? 1 : 0)} ${unit}`;
    }
    value /= 1024;
  }
  return `${bytes} B`;
}
