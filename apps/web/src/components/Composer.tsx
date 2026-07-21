// Console chrome around the shared chat composer. Enter queues; Cmd/Ctrl+Enter
// steers, so there is no persistent delivery-mode switch to get out of sync.
import {
  ChatComposer,
  useFileAttachments,
  type ComposerState,
  type SlashCommandContext,
  type UseFileAttachmentsResult,
} from "@opengeni/react";
import type { EffectiveSessionControl } from "@opengeni/sdk";
import { type ReactNode } from "react";

export function useDraftAttachments(workspaceId: string): UseFileAttachmentsResult {
  return useFileAttachments({ workspaceId });
}

export function ConsoleComposer(props: {
  composer: ComposerState;
  attachments: UseFileAttachmentsResult;
  effectiveControl?: EffectiveSessionControl | null;
  queuedAheadCount?: number;
  canControlWorkspace?: boolean;
  controlLinks?: {
    workspaceHref?: string;
    sessionHref?: (sessionId: string) => string;
  };
  placeholder?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  fileUploadsEnabled: boolean;
  controls?: ReactNode;
  commandContext?: SlashCommandContext;
  onClearView?: () => void;
}) {
  return (
    <ChatComposer
      composer={props.composer}
      effectiveControl={props.effectiveControl}
      queuedAheadCount={props.queuedAheadCount}
      canControlWorkspace={props.canControlWorkspace}
      controlLinks={props.controlLinks}
      placeholder={props.placeholder}
      autoFocus={props.autoFocus}
      disabled={props.disabled}
      {...(props.fileUploadsEnabled ? { attachments: props.attachments } : {})}
      {...(props.commandContext ? { commandContext: props.commandContext } : {})}
      {...(props.onClearView ? { onClearView: props.onClearView } : {})}
      controlsStart={props.controls}
    />
  );
}
