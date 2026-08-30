import { MicIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { lazy, Suspense, useCallback, useState, type MouseEvent, type ReactElement } from "react";
import { cn } from "../lib/cn";
import { useChatComposer } from "./composer";
import type {
  ComposerTranscriptionControlImplementationProps,
  ComposerTranscriptionControlProps,
} from "./composer-transcription-control-implementation";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

export type {
  ComposerTranscriptionControlProps,
  ComposerTranscriptionMessages,
} from "./composer-transcription-control-implementation";

const LazyComposerTranscriptionControl = lazy(async () => {
  const module = await import("./composer-transcription-control-implementation");
  return { default: module.ComposerTranscriptionControlImplementation };
});

function Tip({ tip, children }: { tip: string; children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="top">{tip}</TooltipContent>
    </Tooltip>
  );
}

function LoadingComposerTranscriptionControl({
  capability = null,
  workspaceEnabled = false,
  messages,
  className,
  createRecordingStore,
  suppressed = false,
  composer,
  onStart,
}: ComposerTranscriptionControlProps &
  Pick<ComposerTranscriptionControlImplementationProps, "composer"> & {
    onStart: () => void;
  }) {
  const storageAvailable =
    Boolean(createRecordingStore) || typeof globalThis.indexedDB !== "undefined";
  const unavailableMessage = composer.disabled
    ? (messages?.unavailableDisabled ??
      "Voice input is unavailable while the composer is disabled.")
    : !capability?.available || !workspaceEnabled
      ? (messages?.unavailable ?? "Voice input is unavailable for this workspace.")
      : !storageAvailable
        ? (messages?.errorStorageUnavailable ??
          "Voice input stopped because audio could not be saved safely.")
        : null;
  const idleLabel = unavailableMessage ?? messages?.start ?? "Start voice input";

  function start(event: MouseEvent<HTMLButtonElement>) {
    if (unavailableMessage) {
      event.preventDefault();
      return;
    }
    onStart();
  }

  return (
    <AnimatePresence initial={false}>
      {suppressed ? null : (
        <motion.span
          key="composer-dictate"
          initial={{ opacity: 0, width: 0 }}
          animate={{ opacity: 1, width: "auto" }}
          exit={{ opacity: 0, width: 0 }}
          transition={{ duration: 0.36, ease: [0.22, 1, 0.36, 1] }}
          className={cn("inline-flex min-w-0 overflow-hidden", className)}
          data-transcription-status="idle"
        >
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <Tip tip={idleLabel}>
              <motion.button
                type="button"
                data-og-composer-dictate
                initial={{ opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.96 }}
                transition={{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }}
                onClick={start}
                aria-label={idleLabel}
                aria-pressed={false}
                aria-disabled={unavailableMessage !== null}
                className={cn(
                  "inline-flex size-8 shrink-0 items-center justify-center rounded-og-md pointer-coarse:size-11",
                  "text-og-fg-muted transition-colors duration-150 motion-reduce:transition-none",
                  unavailableMessage
                    ? "cursor-not-allowed opacity-45"
                    : "hover:bg-og-surface-2 hover:text-og-fg",
                )}
              >
                <MicIcon className="size-4" />
              </motion.button>
            </Tip>
            <span className="sr-only" role="status" aria-live="polite">
              {unavailableMessage}
            </span>
          </span>
        </motion.span>
      )}
    </AnimatePresence>
  );
}

/** One provider-neutral microphone control for the nearest editable composer. */
export function ComposerTranscriptionControl(props: ComposerTranscriptionControlProps) {
  const composer = useChatComposer();
  const [startOnMount, setStartOnMount] = useState(false);
  const requestStart = useCallback(() => setStartOnMount(true), []);
  const consumeStart = useCallback(() => setStartOnMount(false), []);

  return (
    <Suspense
      fallback={
        <LoadingComposerTranscriptionControl
          {...props}
          composer={composer}
          onStart={requestStart}
        />
      }
    >
      <LazyComposerTranscriptionControl
        {...props}
        composer={composer}
        startOnMount={startOnMount}
        onStartOnMountConsumed={consumeStart}
      />
    </Suspense>
  );
}
