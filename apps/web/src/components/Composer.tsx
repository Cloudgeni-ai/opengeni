import { ArrowUpIcon, FileIcon, ImageIcon, Loader2Icon, PaperclipIcon, XIcon } from "lucide-react";
import {
  type ClipboardEvent,
  type ChangeEvent,
  forwardRef,
  type ReactNode,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { uploadFileAsset } from "@/api";
import type { FileAsset, ResourceRef, TurnSubmission } from "@/types";

export interface ComposerHandle {
  focus: () => void;
  clear: () => void;
}

interface ComposerProps {
  workspaceId: string;
  placeholder?: string;
  submitLabel?: string;
  disabled?: boolean;
  disabledHint?: string;
  submitDisabled?: boolean;
  pending?: boolean;
  autoFocus?: boolean;
  examples?: ReadonlyArray<string>;
  controlsStart?: ReactNode;
  controlsBeforeSubmit?: ReactNode;
  submitAction?: ReactNode;
  fileUploadsEnabled?: boolean;
  onSubmit: (submission: TurnSubmission) => void;
}

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

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  {
    placeholder = "Ask the agent to...",
    submitLabel = "Send",
    disabled = false,
    disabledHint,
    submitDisabled = false,
    pending = false,
    autoFocus = false,
    examples,
    controlsStart,
    controlsBeforeSubmit,
    submitAction,
    fileUploadsEnabled = true,
    workspaceId,
    onSubmit,
  },
  handleRef,
) {
  const [value, setValue] = useState("");
  const [attachments, setAttachments] = useState<DraftAttachment[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useImperativeHandle(handleRef, () => ({
    focus: () => textareaRef.current?.focus(),
    clear: () => {
      setValue("");
      clearAttachments();
    },
  }));

  const trimmed = value.trim();
  const hasUploadingAttachments = attachments.some((attachment) => attachment.status === "uploading");
  const readyResources = attachments.flatMap((attachment): ResourceRef[] => attachment.status === "ready" && attachment.file
    ? [{ kind: "file", fileId: attachment.file.id }]
    : []);
  const canSubmit = trimmed.length > 0 && !disabled && !submitDisabled && !pending && !hasUploadingAttachments;

  function submit() {
    if (!canSubmit) return;
    onSubmit({ text: trimmed, resources: readyResources });
    setValue("");
    clearAttachments();
  }

  function clearAttachments() {
    for (const attachment of attachments) {
      if (attachment.previewUrl) {
        URL.revokeObjectURL(attachment.previewUrl);
      }
    }
    setAttachments([]);
  }

  function removeAttachment(id: string) {
    setAttachments((current) => {
      const removed = current.find((attachment) => attachment.id === id);
      if (removed?.previewUrl) {
        URL.revokeObjectURL(removed.previewUrl);
      }
      return current.filter((attachment) => attachment.id !== id);
    });
  }

  function enqueueFiles(files: Iterable<File>) {
    if (!fileUploadsEnabled) {
      return;
    }
    for (const file of files) {
      const id = crypto.randomUUID();
      const previewUrl = file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined;
      setAttachments((current) => [...current, {
        id,
        name: file.name || "image",
        contentType: file.type || "application/octet-stream",
        sizeBytes: file.size,
        status: "uploading",
        previewUrl,
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
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    if (event.target.files) {
      enqueueFiles(event.target.files);
    }
    event.target.value = "";
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    if (!fileUploadsEnabled) {
      return;
    }
    const files = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
    if (files.length > 0) {
      enqueueFiles(files);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
      return;
    }
    if (event.key === "Escape" && value.length > 0) {
      event.preventDefault();
      setValue("");
    }
  }

  return (
    <div className="w-full">
      <div
        className={cn(
          "group relative rounded-xl border bg-[color:var(--color-surface)]",
          "border-[color:var(--color-border)] transition-colors",
          "focus-within:border-[color:var(--color-border-strong)]",
          disabled && "opacity-70",
        )}
      >
        {attachments.length > 0 ? (
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
                  onClick={() => removeAttachment(attachment.id)}
                  className="shrink-0 rounded p-1 text-[color:var(--color-fg-muted)] hover:bg-[color:var(--color-surface)] hover:text-[color:var(--color-fg)]"
                  aria-label={`Remove ${attachment.name}`}
                >
                  <XIcon className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
        ) : null}
        <Textarea
          ref={textareaRef}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={placeholder}
          disabled={disabled}
          autoFocus={autoFocus}
          rows={2}
          aria-label="Prompt"
          className={cn(
            "min-h-[64px] max-h-[220px] resize-none border-0 bg-transparent",
            "px-4 pt-3 pb-12 text-[15px] leading-relaxed shadow-none",
            "focus-visible:border-0 focus-visible:ring-0",
            "placeholder:text-[color:var(--color-fg-subtle)]",
          )}
        />
        <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileChange} />
        <div className="pointer-events-none absolute inset-x-2 bottom-2 flex items-center justify-between gap-2">
          <div className="pointer-events-auto flex min-w-0 items-center gap-1.5 pl-1 text-[11px] text-[color:var(--color-fg-subtle)]">
            {disabledHint ? (
              <span className="truncate">{disabledHint}</span>
            ) : controlsStart ? (
              controlsStart
            ) : null}
          </div>
          <div className="pointer-events-auto flex shrink-0 items-center gap-1.5">
            {controlsBeforeSubmit}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8 rounded-md"
              disabled={disabled || pending || !fileUploadsEnabled}
              onClick={() => fileInputRef.current?.click()}
              aria-label={fileUploadsEnabled ? "Attach files" : "File uploads unavailable"}
              title={fileUploadsEnabled ? "Attach files" : "File uploads are not configured"}
            >
              <PaperclipIcon className="size-4" />
            </Button>
            {submitAction ?? (
              <Button
                type="button"
                onClick={submit}
                disabled={!canSubmit}
                aria-label={submitLabel}
                size="sm"
                className={cn(
                  "h-8 gap-1.5 rounded-md px-3",
                  "bg-[color:var(--color-brand-strong)] text-[color:var(--color-brand-fg)]",
                  "hover:bg-[color:var(--color-brand)]",
                )}
              >
                <ArrowUpIcon className="size-3.5" />
                <span className="text-xs font-medium">{submitLabel}</span>
              </Button>
            )}
          </div>
        </div>
      </div>
      {examples && examples.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {examples.map((example) => (
            <button
              key={example}
              type="button"
              onClick={() => {
                setValue(example);
                textareaRef.current?.focus();
              }}
              disabled={disabled || pending}
              className={cn(
                "max-w-full truncate rounded-full border px-3 py-1 text-left text-xs",
                "border-[color:var(--color-border)] bg-[color:var(--color-surface-2)]/60",
                "text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)]",
                "hover:border-[color:var(--color-border-strong)] hover:bg-[color:var(--color-surface-2)]",
                "transition-colors disabled:cursor-not-allowed disabled:opacity-60",
              )}
            >
              {example}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
});

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
