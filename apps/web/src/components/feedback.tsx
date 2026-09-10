import { useEffect, useId, useRef, useState } from "react";
import { MessageSquareIcon, ThumbsDownIcon, ThumbsUpIcon } from "lucide-react";
import type { OpenGeniClient } from "@opengeni/sdk";
import type { CreateFeedbackRequest, FeedbackSentiment } from "@opengeni/sdk";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

type FeedbackClient = Pick<OpenGeniClient, "createFeedback" | "listOwnFeedback">;

export function FeedbackDialog(props: {
  client: FeedbackClient;
  workspaceId: string;
  sessionId?: string;
  turnId?: string;
  sentiment?: FeedbackSentiment;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmitted?: (sentiment: FeedbackSentiment | undefined) => void;
}) {
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [submissionError, setError] = useState<string | null>(null);
  const pending = useRef<CreateFeedbackRequest | null>(null);
  const submitting = useRef(false);
  const fieldId = useId();
  async function submit() {
    if (submitting.current) return;
    const payload = {
      sessionId: props.sessionId,
      turnId: props.turnId,
      sentiment: props.sentiment,
      comment: comment || undefined,
    };
    const previous = pending.current;
    if (
      !previous ||
      previous.sessionId !== payload.sessionId ||
      previous.turnId !== payload.turnId ||
      previous.sentiment !== payload.sentiment ||
      previous.comment !== payload.comment
    ) {
      pending.current = { ...payload, idempotencyKey: crypto.randomUUID() };
    }
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      await props.client.createFeedback(props.workspaceId, pending.current!);
      pending.current = null;
      setComment("");
      props.onSubmitted?.(props.sentiment);
      props.onOpenChange(false);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not send feedback. Try again.");
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!busy) props.onOpenChange(open);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {props.turnId
              ? "Rate this reply"
              : props.sessionId
                ? "Rate this session"
                : "Send feedback"}
          </DialogTitle>
          <DialogDescription>
            {props.sessionId
              ? "Share what worked or what could be better."
              : "Tell us what could make OpenGeni better."}
          </DialogDescription>
        </DialogHeader>
        {props.sentiment ? (
          <p className="text-sm">{props.sentiment === "positive" ? "Thumbs up" : "Thumbs down"}</p>
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
        {submissionError ? (
          <p role="alert" className="text-sm text-destructive">
            {submissionError}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            onClick={() => void submit()}
            disabled={busy || (!props.sentiment && !comment.trim())}
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
  turnId?: string;
  compact?: boolean;
  savedSentiment?: FeedbackSentiment | null;
  onRated?: (sentiment: FeedbackSentiment) => void;
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
