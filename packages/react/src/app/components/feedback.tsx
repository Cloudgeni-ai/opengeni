import { t } from "../lib/console-text";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
} from "react";
import {
  CameraIcon,
  ImagePlusIcon,
  MessageSquareIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  XIcon,
} from "lucide-react";
import type { OpenGeniClient } from "@opengeni/sdk";
import type { CreateFeedbackRequest, FeedbackContext, FeedbackSentiment } from "@opengeni/sdk";
import { Button } from "../../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../ui/dialog";
import { Label } from "../../ui/label";
import { Textarea } from "../../ui/textarea";
import { userErrorText } from "../../ui/api-error";
import {
  feedbackDialogCopy,
  feedbackSentimentLabel,
  feedbackSubmission,
} from "../../session-feedback-model";
import {
  FEEDBACK_SCREENSHOT_MAX_COUNT,
  captureScreen,
  prepareFeedbackImage,
  screenCaptureKind,
  untilGone,
  type FeedbackImage,
} from "../lib/feedback-capture";

type FeedbackClient = Pick<OpenGeniClient, "createFeedback" | "listOwnFeedback">;

/** Screenshots in a report: taking, adding, pasting and removing them. */
function useFeedbackImages() {
  const [images, setImages] = useState<FeedbackImage[]>([]);
  const imagesRef = useRef(images);
  imagesRef.current = images;
  useEffect(
    () => () => imagesRef.current.forEach((image) => URL.revokeObjectURL(image.previewUrl)),
    [],
  );
  const add = useCallback(async (blobs: ReadonlyArray<{ blob: Blob; name: string }>) => {
    const room = FEEDBACK_SCREENSHOT_MAX_COUNT - imagesRef.current.length;
    const prepared = await Promise.all(
      blobs.slice(0, Math.max(room, 0)).map(({ blob, name }) => prepareFeedbackImage(blob, name)),
    );
    const ready = prepared.filter((image): image is FeedbackImage => image !== null);
    setImages((current) => {
      const kept = [...current, ...ready].slice(0, FEEDBACK_SCREENSHOT_MAX_COUNT);
      ready
        .filter((image) => !kept.includes(image))
        .forEach((image) => URL.revokeObjectURL(image.previewUrl));
      return kept;
    });
    return ready.length === Math.min(blobs.length, Math.max(room, 0));
  }, []);
  const remove = useCallback((id: string) => {
    setImages((current) => {
      current
        .filter((image) => image.id === id)
        .forEach((image) => URL.revokeObjectURL(image.previewUrl));
      return current.filter((image) => image.id !== id);
    });
  }, []);
  const clear = useCallback(() => {
    setImages((current) => {
      current.forEach((image) => URL.revokeObjectURL(image.previewUrl));
      return [];
    });
  }, []);
  return { images, add, remove, clear };
}

export function FeedbackDialog(props: {
  client: FeedbackClient;
  workspaceId: string;
  sessionId?: string | undefined;
  turnId?: string | undefined;
  sentiment?: FeedbackSentiment | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmitted?: ((sentiment: FeedbackSentiment | undefined) => void) | undefined;
  /**
   * Facts about the app sent with the report (web or desktop, versions, page,
   * recent errors), read when it is sent. See webFeedbackContext.
   */
  reportContext?: (() => FeedbackContext) | undefined;
  /**
   * Let the person attach screenshots. The desktop app takes one of the page
   * as the dialog opens; browsers take one when asked, and every app can add
   * or paste an image.
   */
  screenshots?: boolean | undefined;
}) {
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [submissionError, setError] = useState<string | null>(null);
  const [imageNote, setImageNote] = useState<string | null>(null);
  // The dialog steps out of view while a screenshot is taken.
  const [capturing, setCapturing] = useState(false);
  const pending = useRef<CreateFeedbackRequest | null>(null);
  const submitting = useRef(false);
  const fieldId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const copy = feedbackDialogCopy(t, props);
  const { images, add, remove, clear } = useFeedbackImages();
  const captureKind = props.screenshots ? screenCaptureKind() : null;
  const full = images.length >= FEEDBACK_SCREENSHOT_MAX_COUNT;

  const takeScreenshot = useCallback(
    async (options: { waitFor: string }) => {
      setImageNote(null);
      setCapturing(true);
      try {
        await untilGone(options.waitFor);
        const shot = await captureScreen();
        if (shot.kind === "ok") {
          const added = await add([{ blob: shot.blob, name: "Screenshot" }]);
          if (!added)
            setImageNote("Couldn't use that screenshot. You can add or paste one instead.");
        } else if (shot.kind === "failed") {
          setImageNote("Couldn't take a screenshot. You can add or paste one instead.");
        }
      } finally {
        setCapturing(false);
      }
    },
    [add],
  );

  // The desktop app attaches a still of the page as the dialog opens, taken
  // once the menu that opened it is gone. It can be removed like any other.
  // A layout effect, so the dialog never shows before stepping aside.
  const opened = useRef(false);
  useLayoutEffect(() => {
    if (!props.open) {
      opened.current = false;
      return;
    }
    if (opened.current) return;
    opened.current = true;
    if (captureKind === "window" && images.length === 0)
      void takeScreenshot({ waitFor: '[role="menu"]' });
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- only as the dialog opens
  }, [props.open]);

  async function addFiles(files: ReadonlyArray<File>) {
    const pictures = files.filter((file) => file.type.startsWith("image/"));
    if (pictures.length === 0) return;
    setImageNote(null);
    const added = await add(pictures.map((file) => ({ blob: file, name: file.name || "Image" })));
    if (!added) setImageNote("Some images couldn't be added. Use PNG or JPEG, up to three.");
  }

  function onPaste(event: ClipboardEvent) {
    if (!props.screenshots || full) return;
    const files = Array.from(event.clipboardData.files).filter((file) =>
      file.type.startsWith("image/"),
    );
    if (files.length === 0) return;
    event.preventDefault();
    void addFiles(files);
  }

  async function submit() {
    if (submitting.current) return;
    pending.current = feedbackSubmission(
      {
        sessionId: props.sessionId,
        turnId: props.turnId,
        sentiment: props.sentiment,
        comment: comment || undefined,
        ...(props.reportContext ? { context: props.reportContext() } : {}),
        ...(images.length > 0 ? { screenshots: images.map((image) => image.upload) } : {}),
      },
      pending.current,
      () => crypto.randomUUID(),
    );
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      await props.client.createFeedback(props.workspaceId, pending.current!);
      pending.current = null;
      setComment("");
      clear();
      setImageNote(null);
      props.onSubmitted?.(props.sentiment);
      props.onOpenChange(false);
    } catch (error) {
      setError(`Couldn't send feedback. ${userErrorText(error, "Try again.")}`);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={props.open && !capturing}
      onOpenChange={(open) => {
        if (!busy && !capturing) props.onOpenChange(open);
      }}
    >
      <DialogContent onPaste={onPaste} data-feedback-dialog="">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>
        {props.sentiment ? (
          <p className="text-sm">{feedbackSentimentLabel(t, props.sentiment)}</p>
        ) : null}
        <div className="grid gap-2">
          <Label htmlFor={fieldId}>
            {props.sentiment ? "Comment (optional)" : "Your feedback"}
          </Label>
          <Textarea
            id={fieldId}
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            maxLength={4000}
            disabled={busy}
            rows={5}
          />
        </div>
        {props.screenshots ? (
          <div className="grid gap-2" data-feedback-screenshots="">
            {images.length > 0 ? (
              <ul aria-label="Screenshots" className="grid grid-cols-3 gap-2">
                {images.map((image, index) => (
                  <li
                    key={image.id}
                    className="relative overflow-hidden rounded-md border border-border bg-surface-2"
                  >
                    <img
                      src={image.previewUrl}
                      alt={`${image.name} ${index + 1}`}
                      className="aspect-video w-full object-cover object-top"
                    />
                    <Button
                      type="button"
                      variant="secondary"
                      size="icon-xs"
                      className="absolute top-1 right-1 rounded-full shadow-sm pointer-coarse:size-8"
                      aria-label={`Remove ${image.name.toLowerCase()} ${index + 1}`}
                      title="Remove"
                      disabled={busy}
                      onClick={() => remove(image.id)}
                    >
                      <XIcon />
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              {captureKind ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy || capturing || full}
                  onClick={() =>
                    void takeScreenshot({
                      waitFor: '[data-feedback-dialog], [data-slot="dialog-overlay"]',
                    })
                  }
                >
                  <CameraIcon />
                  Take screenshot
                </Button>
              ) : null}
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy || full}
                onClick={() => fileInput.current?.click()}
              >
                <ImagePlusIcon />
                Add image
              </Button>
              <input
                ref={fileInput}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(event) => {
                  const files = Array.from(event.target.files ?? []);
                  event.target.value = "";
                  void addFiles(files);
                }}
              />
              <span className="text-xs text-fg-muted">
                {full ? "Up to three images." : "You can also paste an image."}
              </span>
            </div>
            {imageNote ? (
              <p role="status" className="text-xs text-fg-muted">
                {imageNote}
              </p>
            ) : null}
          </div>
        ) : null}
        {submissionError ? (
          <p role="alert" className="text-sm text-destructive">
            {submissionError}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            onClick={() => void submit()}
            disabled={busy || capturing || (!props.sentiment && !comment.trim())}
          >
            {busy ? "Sending…" : "Send feedback"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function SessionFeedback(props: {
  client: FeedbackClient;
  workspaceId: string;
  sessionId: string;
  turnId?: string | undefined;
  compact?: boolean | undefined;
  savedSentiment?: FeedbackSentiment | null | undefined;
  onRated?: ((sentiment: FeedbackSentiment) => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<FeedbackSentiment>();
  const [saved, setSaved] = useState<FeedbackSentiment>();
  const [notice, setNotice] = useState("");
  const savedRevision = useRef(0);
  useEffect(() => {
    if (props.savedSentiment !== undefined) {
      setSaved(props.savedSentiment ?? undefined);
      return;
    }
    let current = true;
    const revision = savedRevision.current;
    void props.client
      .listOwnFeedback(props.workspaceId, {
        sessionId: props.sessionId,
        includeTurns: Boolean(props.turnId),
      })
      .then(({ feedback }) => {
        if (current && revision === savedRevision.current)
          setSaved(
            feedback.find(
              (item) => item.turnId === (props.turnId ?? null) && item.sentiment !== null,
            )?.sentiment ?? undefined,
          );
      })
      .catch(() => {
        /* Submission remains usable if prior feedback cannot load. */
      });
    return () => {
      current = false;
    };
  }, [props.client, props.workspaceId, props.sessionId, props.turnId, props.savedSentiment]);
  return (
    <div
      className={
        props.compact
          ? "inline-flex items-center gap-1.5"
          : "flex items-center gap-1 text-xs text-fg-muted"
      }
      role="group"
      aria-label={props.turnId ? "Reply feedback" : "Session feedback"}
    >
      <Button
        variant="ghost"
        size="icon"
        className={
          props.compact
            ? "size-7 rounded-sm text-fg-subtle opacity-0 group-hover/copy:opacity-100 group-focus-within/copy:opacity-100 pointer-coarse:size-11 pointer-coarse:opacity-70 aria-pressed:opacity-100 aria-pressed:bg-accent aria-pressed:text-foreground"
            : "pointer-coarse:min-h-11 pointer-coarse:min-w-11 aria-pressed:bg-accent aria-pressed:text-foreground"
        }
        title="Thumbs up"
        aria-label="Thumbs up"
        aria-pressed={saved === "positive"}
        onClick={() => {
          setChoice("positive");
          setOpen(true);
        }}
      >
        <ThumbsUpIcon className={props.compact ? "size-3.5" : "size-4"} />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className={
          props.compact
            ? "size-7 rounded-sm text-fg-subtle opacity-0 group-hover/copy:opacity-100 group-focus-within/copy:opacity-100 pointer-coarse:size-11 pointer-coarse:opacity-70 aria-pressed:opacity-100 aria-pressed:bg-accent aria-pressed:text-foreground"
            : "pointer-coarse:min-h-11 pointer-coarse:min-w-11 aria-pressed:bg-accent aria-pressed:text-foreground"
        }
        title="Thumbs down"
        aria-label="Thumbs down"
        aria-pressed={saved === "negative"}
        onClick={() => {
          setChoice("negative");
          setOpen(true);
        }}
      >
        <ThumbsDownIcon className={props.compact ? "size-3.5" : "size-4"} />
      </Button>
      <span role="status" className={props.compact ? "sr-only" : undefined}>
        {notice}
      </span>
      <FeedbackDialog
        {...props}
        open={open}
        onOpenChange={setOpen}
        sentiment={choice}
        onSubmitted={(value) => {
          savedRevision.current += 1;
          setSaved(value);
          if (value) props.onRated?.(value);
          setNotice("Thanks for your feedback");
        }}
      />
    </div>
  );
}

export { MessageSquareIcon as FeedbackIcon };
