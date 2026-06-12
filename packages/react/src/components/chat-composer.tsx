import type { SessionStatus } from "@opengeni/sdk";
import { ArrowUpIcon, LoaderCircleIcon, SquareIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useRef, type ClipboardEvent, type KeyboardEvent, type ReactNode } from "react";
import type { ComposerState } from "../hooks/use-composer";
import { shouldSubmitOnKey } from "../hooks/use-composer";
import { cn } from "../lib/cn";

export type ChatComposerProps = {
  composer: ComposerState;
  /** Current session status; shows the stop control while a turn runs. */
  status?: SessionStatus | null | undefined;
  placeholder?: string | undefined;
  disabled?: boolean | undefined;
  autoFocus?: boolean | undefined;
  /** Replaces the default keyboard hint under the field. */
  hint?: string | undefined;
  /** App controls (model picker, attach button, ...) in the footer row, replacing the hint. */
  controlsStart?: ReactNode | undefined;
  /** Content rendered above the textarea, inside the field chrome (e.g. attachment chips). */
  header?: ReactNode | undefined;
  /** Paste hook on the textarea (e.g. paste-image-to-attach). */
  onPaste?: ((event: ClipboardEvent<HTMLTextAreaElement>) => void) | undefined;
  className?: string | undefined;
};

const ACTIVE_STATUSES: ReadonlySet<SessionStatus> = new Set(["queued", "running"]);

/**
 * The chat composer — the only human-to-agent input surface. Plain chat in,
 * everything else is the agent's job. Enter sends, Shift+Enter breaks the
 * line, and the stop control appears while a turn is running (sending while
 * running is legitimate steering, so send stays available too).
 */
export function ChatComposer({ composer, status, placeholder, disabled, autoFocus, hint, controlsStart, header, onPaste, className }: ChatComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const active = status != null && ACTIVE_STATUSES.has(status);

  const resize = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 220)}px`;
  }, []);

  useEffect(() => {
    resize();
  }, [composer.value, resize]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (shouldSubmitOnKey(event)) {
      event.preventDefault();
      void composer.send();
    }
  };

  return (
    <div className={cn("og-root", className)}>
      <div
        className={cn(
          "rounded-og-lg border border-og-border bg-og-surface-1 shadow-og-sm",
          "transition-[border-color,box-shadow] duration-200",
          "focus-within:border-og-accent/60 focus-within:shadow-og-glow",
        )}
      >
        {header}
        <textarea
          ref={textareaRef}
          rows={1}
          value={composer.value}
          onChange={(event) => composer.setValue(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder={placeholder ?? "Message the agent…"}
          disabled={disabled}
          autoFocus={autoFocus}
          aria-label="Message the agent"
          className={cn(
            "block w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-[15px] leading-6",
            "text-og-fg placeholder:text-og-fg-subtle focus:outline-none",
            "disabled:cursor-not-allowed disabled:opacity-60",
          )}
        />
        <div className="flex items-center justify-between gap-2 px-2.5 pb-2.5 pt-1">
          {controlsStart ? (
            <span className="flex min-w-0 items-center gap-1.5">{controlsStart}</span>
          ) : (
            <span className="px-1.5 text-[11px] text-og-fg-subtle max-sm:hidden">
              {hint ?? "Enter to send · Shift+Enter for a new line"}
            </span>
          )}
          <span className="flex items-center gap-1.5">
            <AnimatePresence initial={false}>
              {active ? (
                <motion.button
                  key="stop"
                  type="button"
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.8 }}
                  transition={{ duration: 0.15, ease: "easeOut" }}
                  onClick={() => void composer.interrupt()}
                  disabled={composer.interrupting}
                  aria-label="Stop the current turn"
                  title="Stop the current turn"
                  className={cn(
                    "inline-flex size-8 items-center justify-center rounded-og-md border border-og-border",
                    "bg-og-surface-2 text-og-fg-muted transition-colors duration-150",
                    "hover:border-og-status-failed/50 hover:text-og-status-failed",
                    "disabled:opacity-50",
                  )}
                >
                  {composer.interrupting ? (
                    <LoaderCircleIcon className="size-3.5 animate-og-spin" />
                  ) : (
                    <SquareIcon className="size-3 fill-current" />
                  )}
                </motion.button>
              ) : null}
            </AnimatePresence>
            <button
              type="button"
              onClick={() => void composer.send()}
              disabled={!composer.canSend || disabled === true}
              aria-label="Send message"
              className={cn(
                "inline-flex size-8 items-center justify-center rounded-og-md",
                "bg-og-accent text-og-accent-fg shadow-og-sm",
                "transition-[background-color,transform,opacity] duration-150 ease-og-spring",
                "hover:bg-og-accent-strong active:scale-95",
                "disabled:cursor-not-allowed disabled:bg-og-surface-3 disabled:text-og-fg-subtle disabled:shadow-none",
              )}
            >
              {composer.sending ? <LoaderCircleIcon className="size-4 animate-og-spin" /> : <ArrowUpIcon className="size-4" />}
            </button>
          </span>
        </div>
      </div>
      <AnimatePresence>
        {composer.error ? (
          <motion.p
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden px-1 pt-1.5 text-xs text-og-status-failed"
            role="alert"
          >
            {composer.error.message || "Sending failed — your draft is still here. Try again."}
          </motion.p>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
