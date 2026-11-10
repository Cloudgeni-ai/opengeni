import type { FileAsset } from "@opengeni/sdk";
import {
  AppWindowIcon,
  FileIcon,
  ImageIcon,
  LoaderCircleIcon,
  RotateCwIcon,
  XIcon,
} from "lucide-react";
import {
  cloneElement,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import type { ChatComposerMessages } from "../composer-messages";
import type { FileAttachment, UseFileAttachmentsResult } from "../hooks/use-file-attachments";
import { cn } from "../lib/cn";
import { useOpenGeniText } from "../messages/runtime";
import { useLightboxOptional } from "../timeline/screenshot-lightbox";
import type { OpenGeniLinkResolution } from "./open-geni-links";

/** A native `title` tip; nothing when there is no tip text. */
export function ComposerTip({
  tip,
  children,
}: {
  tip: string;
  children: ReactElement<{ title?: string }>;
}) {
  if (!tip) return children;
  return cloneElement(children, { title: tip });
}

/** The `Image N` a chip shows when its image has a tag in the text. */
export function ImageTagLabel({ children }: { children: ReactNode }) {
  return (
    <span data-image-tag="" className="shrink-0 font-medium text-og-fg tabular-nums">
      {children}
    </span>
  );
}

/** A file already stored on the server, shown as a ready attachment chip. */
export function storedFileAttachment(
  id: string,
  file: FileAsset,
): FileAttachment & { file: FileAsset } {
  return {
    id,
    name: file.filename,
    contentType: file.contentType,
    sizeBytes: file.sizeBytes,
    status: "ready",
    file,
    ...(file.appShot ? { appShot: file.appShot } : {}),
  };
}

export type AttachmentChipMessages = Pick<
  ChatComposerMessages,
  | "uploading"
  | "uploadFailed"
  | "previewAttachment"
  | "previewUnavailable"
  | "attachmentPreviewLabel"
  | "downloadAttachment"
  | "closeAttachmentPreview"
  | "retryAttachment"
  | "retryUpload"
  | "removeAttachment"
  | "formatBytes"
>;

const noRetainedPreview = () => undefined;

/**
 * Attached files as compact chips: an image's thumbnail opens it larger, and
 * a file shows its name and size. With `onRemove` they are the composer's
 * editable attachments (upload progress, retry, remove). Without it they are
 * read-only, as on a sent message: the whole chip opens the image, or opens
 * the file through `openFile`.
 */
export function AttachmentChips({
  attachments,
  messages,
  disabled = false,
  onRemove,
  onRetry,
  onRetainPreview = noRetainedPreview,
  onLoadPreview,
  openFile,
  imageNumbers,
  className,
}: {
  attachments: readonly FileAttachment[];
  messages: AttachmentChipMessages;
  disabled?: boolean | undefined;
  /** Without it the chips are read-only. */
  onRemove?: ((id: string) => void) | undefined;
  onRetry?: ((id: string) => void) | undefined;
  onRetainPreview?: UseFileAttachmentsResult["retainPreview"] | undefined;
  onLoadPreview: UseFileAttachmentsResult["loadPreview"];
  /** How a read-only chip that is not a previewable image opens; nothing leaves it inert. */
  openFile?:
    | ((attachment: FileAttachment) => OpenGeniLinkResolution | null | undefined)
    | undefined;
  /** With image tags on, the number each image's tag in the text carries. */
  imageNumbers?: ReadonlyMap<string, number> | undefined;
  className?: string | undefined;
}) {
  const t = useOpenGeniText();
  const lightbox = useLightboxOptional();
  const previewRequest = useRef<AbortController | null>(null);
  const [previewLoadingId, setPreviewLoadingId] = useState<string | null>(null);
  const [previewErrorId, setPreviewErrorId] = useState<string | null>(null);
  const [opening, setOpening] = useState<{ id: string; failed: boolean } | null>(null);
  // Thumbnails always show: an uploaded image without a live local preview (a
  // restored draft, a revoked or broken object URL) loads its stored copy.
  const [storedThumbs, setStoredThumbs] = useState<Record<string, string>>({});
  const [brokenLocal, setBrokenLocal] = useState<ReadonlySet<string>>(() => new Set());
  const thumbRequests = useRef<Map<string, AbortController>>(new Map());
  const localPreview = (attachment: UseFileAttachmentsResult["attachments"][number]) =>
    attachment.previewUrl && !brokenLocal.has(attachment.id) ? attachment.previewUrl : undefined;

  useEffect(() => {
    if (!onLoadPreview) return;
    for (const attachment of attachments) {
      const id = attachment.id;
      if (
        attachment.status !== "ready" ||
        !attachment.file ||
        !attachment.contentType.startsWith("image/") ||
        (attachment.previewUrl && !brokenLocal.has(id)) ||
        storedThumbs[id] ||
        thumbRequests.current.has(id)
      ) {
        continue;
      }
      const controller = new AbortController();
      thumbRequests.current.set(id, controller);
      void onLoadPreview(id, controller.signal)
        .then((url) => {
          if (url && !controller.signal.aborted) {
            setStoredThumbs((current) => ({ ...current, [id]: url }));
          }
        })
        .catch(() => undefined)
        .finally(() => {
          if (thumbRequests.current.get(id) === controller) thumbRequests.current.delete(id);
        });
    }
  }, [attachments, brokenLocal, onLoadPreview, storedThumbs]);
  useEffect(() => {
    const requests = thumbRequests.current;
    return () => {
      for (const controller of requests.values()) controller.abort();
      requests.clear();
    };
  }, []);

  useEffect(() => () => previewRequest.current?.abort(), [onLoadPreview]);

  async function openPreview(
    attachment: UseFileAttachmentsResult["attachments"][number],
    source: HTMLButtonElement,
    canLoadPreview: boolean,
  ) {
    previewRequest.current?.abort();
    const attachmentId = attachment.id;
    const local = localPreview(attachment);
    const releaseSource = local ? onRetainPreview(attachmentId) : undefined;
    let src = local ?? storedThumbs[attachmentId];
    // An unretained local URL may already be revoked: prefer the stored copy.
    if (!releaseSource && canLoadPreview) src = storedThumbs[attachmentId];
    if (!src && canLoadPreview) {
      const controller = new AbortController();
      previewRequest.current = controller;
      setPreviewLoadingId(attachmentId);
      setPreviewErrorId(null);
      try {
        src = await onLoadPreview!(attachmentId, controller.signal);
        if (controller.signal.aborted) return;
        if (!src) {
          setPreviewErrorId(attachmentId);
          return;
        }
      } catch {
        if (!controller.signal.aborted) setPreviewErrorId(attachmentId);
        return;
      } finally {
        if (previewRequest.current === controller) {
          setPreviewLoadingId(null);
        }
      }
    }
    lightbox!.open(
      src!,
      attachment.name,
      source,
      messages.attachmentPreviewLabel,
      attachment.name,
      {
        download: messages.downloadAttachment(attachment.name),
        close: messages.closeAttachmentPreview,
      },
      releaseSource,
    );
  }

  function runOpen(attachmentId: string, open: () => void | Promise<void>) {
    if (opening?.id === attachmentId && !opening.failed) return;
    setOpening({ id: attachmentId, failed: false });
    void Promise.resolve()
      .then(open)
      .then(
        () => setOpening((current) => (current?.id === attachmentId ? null : current)),
        () =>
          setOpening((current) =>
            current?.id === attachmentId ? { id: attachmentId, failed: true } : current,
          ),
      );
  }

  const readOnly = !onRemove;

  return (
    // Compact chips extend their touch targets beyond their visible borders.
    // Keep neighboring rows and columns outside those expanded hit areas.
    <div className={cn("flex flex-wrap gap-1.5 pointer-coarse:gap-2.5", className)}>
      {attachments.map((attachment) => {
        const failed = attachment.status === "failed";
        const secureContextRequired = attachment.errorCode === "secure_context_required";
        const previewFailed = previewErrorId === attachment.id;
        const previewLoading = previewLoadingId === attachment.id;
        const local = localPreview(attachment);
        const thumb = local ?? storedThumbs[attachment.id];
        // A local object URL that fails (revoked, unreadable) falls back to the stored copy.
        const onThumbError = local
          ? () =>
              setBrokenLocal((current) =>
                current.has(attachment.id) ? current : new Set(current).add(attachment.id),
              )
          : undefined;
        const canLoadPreview = Boolean(
          lightbox &&
          onLoadPreview &&
          attachment.status === "ready" &&
          attachment.file &&
          attachment.contentType.startsWith("image/"),
        );
        const previewable = Boolean(lightbox && (thumb || canLoadPreview));
        // A read-only chip is one control: an image opens larger, a file opens.
        const resolution = readOnly && !previewable ? openFile?.(attachment) : undefined;
        const fileOpening = opening?.id === attachment.id && !opening.failed;
        const openFailed = opening?.id === attachment.id && opening.failed;
        // A sent file that can no longer be read (deleted, or not shared with this reader).
        const unavailable = readOnly && attachment.status === "ready" && !attachment.file;
        const appShot = attachment.appShot;
        const statusText = previewFailed
          ? (messages.previewUnavailable ?? t("composer.previewUnavailable"))
          : openFailed
            ? t("composerMessages.openFailed")
            : attachment.status === "uploading"
              ? messages.uploading
              : failed
                ? attachment.error || messages.uploadFailed
                : appShot
                  ? t("composer.appShotSummary", { app: appShot.app })
                  : unavailable
                    ? t("composerMessages.unavailable")
                    : messages.formatBytes(attachment.sizeBytes);
        // An app-shot reads as the window it shows: its title first, then the
        // app, with a wider thumbnail so the window is recognizable.
        const displayName = appShot ? appShot.title.trim() || appShot.app : attachment.name;
        // A plain file reads on one line (thumbnail, name, size) so it costs the
        // conversation as little height as possible; states that need words
        // (failures, app-shots) keep their two-line layout.
        const compact = !appShot && !failed && !previewFailed && !openFailed;
        const imageNumber = imageNumbers?.get(attachment.id);
        const thumbSize = appShot ? "h-10 w-16" : compact ? "size-6" : "size-8";
        const chipClass = cn(
          "flex min-w-0 items-center gap-2 rounded-og-md border text-left text-og-sm",
          compact ? cn("py-1 pl-1", readOnly ? "pr-2" : "pr-1") : "px-2 py-1.5",
          // A captured window arrives from outside the page: let it settle in.
          appShot && "animate-og-enter",
          failed
            ? cn(
                "border-og-status-failed/40 bg-og-status-failed/10",
                secureContextRequired
                  ? "max-w-full items-start sm:max-w-[32rem]"
                  : appShot
                    ? "max-w-[320px]"
                    : "max-w-[240px]",
              )
            : cn("border-og-border bg-og-surface-2", appShot ? "max-w-[320px]" : "max-w-[240px]"),
        );
        const interactiveClass =
          "cursor-pointer outline-hidden transition-colors hover:bg-og-surface-3 focus-visible:ring-2 focus-visible:ring-og-accent disabled:cursor-wait pointer-coarse:min-h-11";
        const thumbImage = (
          <img
            src={thumb}
            alt=""
            onError={onThumbError}
            className={cn(
              "h-full w-full object-cover",
              !readOnly && "transition-opacity hover:opacity-80",
              appShot && "object-top",
              compact && "rounded",
            )}
          />
        );
        const pendingIcon = (
          <LoaderCircleIcon className="size-4 animate-og-spin text-og-fg-muted" />
        );
        const leading =
          readOnly && previewable ? (
            <span
              className={cn(
                thumbSize,
                "shrink-0 overflow-hidden rounded",
                appShot && "border border-og-border bg-og-surface-1",
                !thumb && "flex items-center justify-center",
              )}
            >
              {thumb ? (
                thumbImage
              ) : previewLoading ? (
                pendingIcon
              ) : (
                <ImageIcon className="size-4 text-og-fg-muted" />
              )}
            </span>
          ) : previewable ? (
            <button
              type="button"
              className={cn(
                thumbSize,
                "shrink-0 overflow-hidden rounded outline-hidden focus-visible:ring-2 focus-visible:ring-og-accent",
                // The slim chip's 24px preview keeps a 44px touch target; the
                // hit area grows over the name, never the remove button.
                compact &&
                  "relative overflow-visible pointer-coarse:before:absolute pointer-coarse:before:-inset-y-2.5 pointer-coarse:before:-left-2.5 pointer-coarse:before:-right-2.5 pointer-coarse:before:content-['']",
                appShot && "border border-og-border bg-og-surface-1",
                !thumb && "flex items-center justify-center disabled:cursor-wait",
              )}
              aria-label={messages.previewAttachment(displayName)}
              aria-busy={previewLoading || undefined}
              disabled={previewLoading}
              onClick={(event) => void openPreview(attachment, event.currentTarget, canLoadPreview)}
            >
              {thumb ? (
                thumbImage
              ) : previewLoading ? (
                pendingIcon
              ) : (
                <ImageIcon className="size-4 text-og-fg-muted" />
              )}
            </button>
          ) : thumb ? (
            <img
              src={thumb}
              alt=""
              onError={onThumbError}
              className={cn(thumbSize, "shrink-0 rounded object-cover", appShot && "object-top")}
            />
          ) : fileOpening ? (
            <LoaderCircleIcon className="size-4 shrink-0 animate-og-spin text-og-fg-muted" />
          ) : attachment.contentType.startsWith("image/") ? (
            <ImageIcon className="size-4 shrink-0 text-og-fg-muted" />
          ) : (
            <FileIcon className="size-4 shrink-0 text-og-fg-muted" />
          );
        const content = (
          <>
            {leading}
            {compact ? (
              <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                {imageNumber !== undefined ? (
                  <ImageTagLabel>{t("composer.imageTag", { number: imageNumber })}</ImageTagLabel>
                ) : null}
                <span
                  className={cn(
                    "truncate",
                    imageNumber === undefined ? "font-medium text-og-fg" : "text-og-fg-muted",
                  )}
                >
                  {displayName}
                </span>
                <span className="shrink-0 text-og-xs text-og-fg-subtle tabular-nums">
                  {statusText}
                </span>
              </span>
            ) : (
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-baseline gap-1.5">
                  {imageNumber !== undefined ? (
                    <ImageTagLabel>{t("composer.imageTag", { number: imageNumber })}</ImageTagLabel>
                  ) : null}
                  <span className="block min-w-0 truncate font-medium text-og-fg">
                    {displayName}
                  </span>
                </span>
                {appShot && !failed && !previewFailed && attachment.status !== "uploading" ? (
                  <ComposerTip
                    tip={
                      appShot.text?.trim()
                        ? t("composer.appShotTextIncluded")
                        : t("composer.appShotNoText")
                    }
                  >
                    <span className="flex min-w-0 items-center gap-1 text-og-xs text-og-fg-subtle">
                      <AppWindowIcon aria-hidden className="size-3 shrink-0" />
                      <span className="truncate">{statusText}</span>
                    </span>
                  </ComposerTip>
                ) : secureContextRequired ? (
                  <span className="block break-words text-og-xs leading-4 text-og-status-failed">
                    {statusText}
                  </span>
                ) : failed || previewFailed || openFailed ? (
                  <ComposerTip tip={statusText}>
                    <span className="block truncate text-og-xs text-og-status-failed">
                      {statusText}
                    </span>
                  </ComposerTip>
                ) : (
                  <span className="block truncate text-og-xs text-og-fg-subtle">{statusText}</span>
                )}
              </span>
            )}
            {attachment.status === "uploading" ? (
              <LoaderCircleIcon className="size-3.5 shrink-0 animate-og-spin" />
            ) : null}
            {failed && !secureContextRequired && onRetry ? (
              <ComposerTip tip={messages.retryUpload}>
                <button
                  type="button"
                  onClick={() => onRetry(attachment.id)}
                  disabled={disabled}
                  className="shrink-0 rounded-og-xs p-1 text-og-fg-muted hover:bg-og-surface-1 hover:text-og-fg disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:size-10"
                  aria-label={messages.retryAttachment(displayName)}
                >
                  <RotateCwIcon className="size-3.5" />
                </button>
              </ComposerTip>
            ) : null}
            {onRemove ? (
              <button
                type="button"
                onClick={() => onRemove(attachment.id)}
                disabled={disabled}
                className={cn(
                  "shrink-0 rounded-og-xs p-1 text-og-fg-muted hover:bg-og-surface-1 hover:text-og-fg disabled:cursor-not-allowed disabled:opacity-50",
                  // The slim chip keeps a 44px touch target with an invisible hit area.
                  compact
                    ? "relative pointer-coarse:p-1.5 pointer-coarse:before:absolute pointer-coarse:before:-inset-2.5 pointer-coarse:before:content-['']"
                    : "pointer-coarse:size-10",
                )}
                aria-label={messages.removeAttachment(displayName)}
              >
                <XIcon className="size-3.5" />
              </button>
            ) : null}
          </>
        );
        if (readOnly && previewable) {
          return (
            <button
              key={attachment.id}
              type="button"
              data-app-shot={appShot ? "" : undefined}
              className={cn(chipClass, interactiveClass)}
              aria-label={messages.previewAttachment(displayName)}
              aria-busy={previewLoading || undefined}
              disabled={previewLoading}
              onClick={(event) => void openPreview(attachment, event.currentTarget, canLoadPreview)}
            >
              {content}
            </button>
          );
        }
        if (resolution?.href) {
          const navigate = resolution.open;
          return (
            <a
              key={attachment.id}
              href={resolution.href}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(chipClass, interactiveClass)}
              aria-label={t("composerMessages.openName", { name: displayName })}
              onClick={(event) => {
                // An in-app page: a plain click stays in this view; modified
                // clicks keep the browser's own new-tab handling.
                if (
                  !navigate ||
                  event.defaultPrevented ||
                  event.button !== 0 ||
                  event.metaKey ||
                  event.ctrlKey ||
                  event.shiftKey ||
                  event.altKey
                )
                  return;
                event.preventDefault();
                navigate();
              }}
            >
              {content}
            </a>
          );
        }
        if (resolution?.open) {
          const open = resolution.open;
          return (
            <button
              key={attachment.id}
              type="button"
              className={cn(chipClass, interactiveClass)}
              aria-label={t("composerMessages.openName", { name: displayName })}
              aria-busy={fileOpening || undefined}
              disabled={fileOpening}
              onClick={() => runOpen(attachment.id, open)}
            >
              {content}
            </button>
          );
        }
        return (
          <div key={attachment.id} data-app-shot={appShot ? "" : undefined} className={chipClass}>
            {content}
          </div>
        );
      })}
    </div>
  );
}
