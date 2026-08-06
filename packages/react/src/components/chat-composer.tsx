import type { ClientModel, EffectiveSessionControl } from "@opengeni/sdk";
import { LayoutGroup, motion } from "motion/react";
import { lazy, Suspense, type ClipboardEvent, type ReactNode } from "react";
import type { SlashCommand } from "../commands/types";
import type { ComposerState } from "../hooks/use-composer";
import type { UseFileAttachmentsResult } from "../hooks/use-file-attachments";
import type { SlashCommandContext } from "../hooks/use-slash-commands";
import { OPEN_WORKSTREAM_CONTROL_EVENT } from "../workstream-control-event";
import {
  Actions,
  AttachButton,
  Attachments,
  CommandPalette,
  Confirmation,
  Controls,
  Footer,
  Frame,
  Help,
  Hint,
  Input,
  ModelPicker,
  PauseButton,
  PausedState,
  RestoredResources,
  Root,
  SendButton,
  Status,
  Surface,
  useChatComposerController,
  type ChatComposerMessages,
  type ComposerControlLinks,
} from "./composer";
import type { ComposerTranscriptionControlProps } from "./composer-transcription-control";

const LazyComposerTranscriptionControl = lazy(async () => {
  const module = await import("./composer-transcription-control");
  return { default: module.ComposerTranscriptionControl };
});

export { OPEN_WORKSTREAM_CONTROL_EVENT };

export type ChatComposerProps = {
  composer: ComposerState;
  /** Canonical workstream control, separate from lifecycle status. */
  effectiveControl?: EffectiveSessionControl | null | undefined;
  /** Waiting prompts already ahead of a normal Send. */
  queuedAheadCount?: number | undefined;
  /** Whether broader Workspace Resume is authorized for this viewer. */
  canControlWorkspace?: boolean | undefined;
  /** Optional host routes used to navigate from effective Pause blockers. */
  controlLinks?: ComposerControlLinks | undefined;
  placeholder?: string | undefined;
  disabled?: boolean | undefined;
  autoFocus?: boolean | undefined;
  /** Replaces the default keyboard hint under the field. */
  hint?: string | undefined;
  /** App controls ahead of attach (e.g. mobile “+” overflow). */
  controlsLeading?: ReactNode | undefined;
  /** App controls in the footer row, replacing the hint. */
  controlsStart?: ReactNode | undefined;
  /** App actions beside Pause/Send, ordered before the built-in actions. */
  actionsStart?: ReactNode | undefined;
  /** Extra classes for the built-in attach control (e.g. `max-sm:hidden`). */
  attachButtonClassName?: string | undefined;
  /** Provider-neutral speech capability. Provider configuration stays in workspace settings. */
  transcription?: ComposerTranscriptionControlProps | undefined;
  /** Extra classes on the transcription control. */
  transcriptionClassName?: string | undefined;
  /** Soft-hide dictate while realtime voice is active (animated collapse). */
  transcriptionSuppressed?: boolean | undefined;
  /** Content rendered above the textarea, inside the field chrome. */
  header?: ReactNode | undefined;
  /** Paste hook composed with the attachment paste path. */
  onPaste?: ((event: ClipboardEvent<HTMLTextAreaElement>) => void) | undefined;
  /** Opt-in file attachment state, typically from `useFileAttachments`. */
  attachments?: UseFileAttachmentsResult | undefined;
  /** Opt-in model picker choices. */
  models?: ClientModel[] | undefined;
  selectedModel?: string | undefined;
  onSelectModel?: ((modelId: string) => void) | undefined;
  className?: string | undefined;
  commands?: readonly SlashCommand[] | undefined;
  commandContext?: SlashCommandContext | undefined;
  onClearView?: (() => void) | undefined;
  /** Partial overrides for all composer-owned visible and accessible copy. */
  messages?: Partial<ChatComposerMessages> | undefined;
};

/**
 * Batteries-included chat composer. This preset is assembled exclusively from
 * the public controller and compound primitives exported by the composer
 * subpath, so custom and default layouts share one behavioral implementation.
 */
export function ChatComposer({
  composer,
  effectiveControl,
  queuedAheadCount,
  canControlWorkspace,
  controlLinks,
  placeholder,
  disabled,
  autoFocus,
  hint,
  controlsLeading,
  controlsStart,
  actionsStart,
  attachButtonClassName,
  transcription,
  transcriptionClassName,
  transcriptionSuppressed = false,
  header,
  onPaste,
  attachments,
  models,
  selectedModel,
  onSelectModel,
  className,
  commands,
  commandContext,
  onClearView,
  messages,
}: ChatComposerProps) {
  const controller = useChatComposerController({
    delivery: composer,
    draft: composer,
    control: composer,
    effectiveControl,
    queuedAheadCount,
    canControlWorkspace,
    controlLinks,
    disabled,
    attachments,
    commands,
    commandContext,
    onClearView,
    onPaste,
    messages,
  });
  const hasControls = Boolean(
    attachments || models || controlsLeading || controlsStart || transcription,
  );
  const stackActions = hasControls && Boolean(actionsStart);

  return (
    <Root controller={controller} className={className}>
      <Frame>
        <CommandPalette />
        <Surface>
          <PausedState />
          <RestoredResources />
          <Attachments />
          {header}
          <Input placeholder={placeholder} autoFocus={autoFocus} />
          {controller.confirmState ? (
            <Confirmation />
          ) : (
            <Footer className={stackActions ? "max-sm:flex-nowrap sm:flex-wrap" : undefined}>
              <LayoutGroup id="og-composer-footer">
                {hasControls ? (
                  <Controls
                    className={stackActions ? "min-w-0 max-sm:flex-1 sm:w-auto" : undefined}
                  >
                    {controlsLeading}
                    <AttachButton className={attachButtonClassName} />
                    {transcription ? (
                      <Suspense fallback={null}>
                        <LazyComposerTranscriptionControl
                          {...transcription}
                          suppressed={transcriptionSuppressed}
                          className={[transcription.className, transcriptionClassName]
                            .filter(Boolean)
                            .join(" ")}
                        />
                      </Suspense>
                    ) : null}
                    {models ? (
                      <motion.span
                        layout
                        transition={{ duration: 0.36, ease: [0.22, 1, 0.36, 1] }}
                        className="inline-flex min-w-0"
                      >
                        <ModelPicker
                          models={models}
                          value={selectedModel}
                          onChange={onSelectModel}
                        />
                      </motion.span>
                    ) : null}
                    {controlsStart ? (
                      <motion.span
                        layout
                        transition={{ duration: 0.36, ease: [0.22, 1, 0.36, 1] }}
                        className="inline-flex min-w-0 items-center gap-1.5"
                      >
                        {controlsStart}
                      </motion.span>
                    ) : null}
                  </Controls>
                ) : (
                  <Hint>{hint}</Hint>
                )}
                <Actions
                  className={stackActions ? "max-sm:shrink-0 sm:w-auto sm:justify-end" : undefined}
                >
                  {actionsStart}
                  <PauseButton />
                  <SendButton />
                </Actions>
              </LayoutGroup>
            </Footer>
          )}
        </Surface>
      </Frame>
      <Help />
      <Status />
    </Root>
  );
}
