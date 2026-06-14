// Console chrome around @opengeni/react's ChatComposer: draft file
// attachments (upload, chips, paste-to-attach) and the console's control
// strip. The textarea, send/stop controls, Enter handling, and draft/error
// state all come from the package.
import { ChatComposer, type ComposerState, type SlashCommandContext } from "@opengeni/react";
import { FileIcon, ImageIcon, ListPlusIcon, Loader2Icon, PaperclipIcon, XIcon, ZapIcon } from "lucide-react";
import {
  type ClipboardEvent,
  type ChangeEvent,
  type ReactNode,
  useCallback,
  useRef,
  useState,
} from "react";

import { Button } from "@/components/ui/button";
import { useAppContext } from "@/context";
import { formatBytes } from "@/lib/format";
import { deliveryModeExplanation } from "@/lib/queue";
import { cn } from "@/lib/utils";
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

/** Upload-and-track state for files attached to the next message (via the SDK's uploadFile). */
export function useDraftAttachments(workspaceId: string): DraftAttachmentsState {
  const { client } = useAppContext();
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
      void client.uploadFile(workspaceId, {
        filename: file.name || "file",
        contentType: file.type || "application/octet-stream",
        data: file,
      }).then((asset) => {
        setAttachments((current) => current.map((attachment) => attachment.id === id
          ? { ...attachment, status: "ready", file: asset, name: asset.filename, contentType: asset.contentType, sizeBytes: asset.sizeBytes }
          : attachment));
      }).catch((error) => {
        setAttachments((current) => current.map((attachment) => attachment.id === id
          ? { ...attachment, status: "failed", error: error instanceof Error ? error.message : String(error) }
          : attachment));
      });
    }
  }, [client, workspaceId]);

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
  fileUploadsEnabled: boolean;
  /** Console controls (model picker, tool toggles, ...) in the footer row. */
  controls?: ReactNode;
  /**
   * Show the queue-vs-steer delivery choice. Queue (default) stacks the
   * message behind the running turn; steer interrupts and injects it now.
   */
  showDeliveryMode?: boolean;
  /**
   * Enables the slash-command palette (type "/"): session/operator controls
   * (/goal, /clear, /compact, /help). Absent on surfaces with no live session
   * (e.g. the new-session screen), where the palette stays inert.
   */
  commandContext?: SlashCommandContext;
  /** Reset the local timeline view (the /clear-view command target). */
  onClearView?: () => void;
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
        onPaste={handlePaste}
        {...(props.commandContext ? { commandContext: props.commandContext } : {})}
        {...(props.onClearView ? { onClearView: props.onClearView } : {})}
        header={attachments.attachments.length > 0 ? (
          <AttachmentChips attachments={attachments.attachments} onRemove={attachments.removeAttachment} />
        ) : undefined}
        controlsStart={(
          <>
            {props.showDeliveryMode ? (
              <DeliveryModeToggle composer={composer} disabled={props.disabled} />
            ) : null}
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
      {props.showDeliveryMode && !props.disabled ? (
        <p
          data-testid="delivery-mode-hint"
          className={cn(
            "px-1.5 pt-1.5 text-[11px] leading-4",
            composer.mode === "steer" ? "text-amber-300/90" : "text-[color:var(--color-fg-subtle)]",
          )}
        >
          {deliveryModeExplanation(composer.mode, props.status ?? null)}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The compose-time queue-vs-steer choice. Queue is the calm default; steer is
 * visually loud (amber) because it interrupts whatever the agent is doing.
 */
function DeliveryModeToggle({ composer, disabled }: { composer: ComposerState; disabled?: boolean }) {
  return (
    <div
      role="radiogroup"
      aria-label="Delivery mode"
      className="flex h-8 shrink-0 items-center gap-0.5 rounded-full border border-[color:var(--color-border)] bg-[color:var(--color-bg)]/60 p-0.5"
    >
      <button
        type="button"
        role="radio"
        aria-checked={composer.mode === "queue"}
        disabled={disabled}
        onClick={() => composer.setMode("queue")}
        title="Queue (default): runs after the current turn finishes"
        className={cn(
          "inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-xs font-medium transition-colors",
          composer.mode === "queue"
            ? "bg-[color:var(--color-surface-2)] text-[color:var(--color-fg)]"
            : "text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)]",
        )}
      >
        <ListPlusIcon className="size-3.5" />
        Queue
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={composer.mode === "steer"}
        disabled={disabled}
        onClick={() => composer.setMode("steer")}
        title="Steer: interrupt the running turn and inject this message now"
        className={cn(
          "inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-xs font-medium transition-colors",
          composer.mode === "steer"
            ? "bg-amber-500/20 text-amber-200"
            : "text-[color:var(--color-fg-muted)] hover:text-amber-200",
        )}
      >
        <ZapIcon className="size-3.5" />
        Steer
      </button>
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
