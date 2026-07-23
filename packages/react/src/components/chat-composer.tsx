import type { ClientModel, EffectiveSessionControl } from "@opengeni/sdk";
import type { ClipboardEvent, ReactNode } from "react";
import type { SlashCommand } from "../commands/types";
import type { ComposerState } from "../hooks/use-composer";
import type { UseFileAttachmentsResult } from "../hooks/use-file-attachments";
import type { SlashCommandContext } from "../hooks/use-slash-commands";
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
  OPEN_WORKSTREAM_CONTROL_EVENT,
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
import {
  ComposerTranscriptionControl,
  type ComposerTranscriptionControlProps,
} from "./composer-transcription-control";

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
  /** App controls in the footer row, replacing the hint. */
  controlsStart?: ReactNode | undefined;
  /** Provider-neutral speech capability. Provider configuration stays in workspace settings. */
  transcription?: ComposerTranscriptionControlProps | undefined;
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
  controlsStart,
  transcription,
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
  const hasControls = Boolean(attachments || models || controlsStart || transcription);

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
            <Footer>
              {hasControls ? (
                <Controls>
                  <AttachButton />
                  {transcription ? <ComposerTranscriptionControl {...transcription} /> : null}
                  {models ? (
                    <ModelPicker models={models} value={selectedModel} onChange={onSelectModel} />
                  ) : null}
                  {controlsStart}
                </Controls>
              ) : (
                <Hint>{hint}</Hint>
              )}
              <Actions>
                <PauseButton />
                <SendButton />
              </Actions>
            </Footer>
          )}
        </Surface>
      </Frame>
      <Help />
      <Status />
    </Root>
  );
}
