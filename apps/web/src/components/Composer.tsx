// Console chrome around the shared chat composer. Enter queues; Cmd/Ctrl+Enter
// steers, so there is no persistent delivery-mode switch to get out of sync.
import {
  ChatComposer,
  useFileAttachments,
  type ComposerState,
  type SlashCommandContext,
  type UseFileAttachmentsResult,
} from "@opengeni/react";
import { type ReactNode } from "react";

import type { SessionStatus } from "@/types";

export function useDraftAttachments(workspaceId: string): UseFileAttachmentsResult {
  return useFileAttachments({ workspaceId });
}

export function ConsoleComposer(props: {
  composer: ComposerState;
  attachments: UseFileAttachmentsResult;
  status?: SessionStatus | null;
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
      status={props.status}
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
