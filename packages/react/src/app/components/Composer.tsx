// Console chrome around the shared chat composer. While the agent works, Send
// follows the workspace's choice (queue or steer) and the other choice sits
// beside it (also Cmd/Ctrl+Enter), so there is no per-message mode to track.
import { ChatComposer } from "../../components/chat-composer";
import {
  useFileAttachments,
  type UseFileAttachmentsResult,
} from "../../hooks/use-file-attachments";
import type { ChatComposerMessages } from "../../components/composer";
import type { ComposerState } from "../../hooks/use-composer";
import type { SlashCommandContext } from "../../hooks/use-slash-commands";
import type { ComposerQueuedRecall } from "../../hooks/use-queued-prompt-recall";
import { resolveWorkspaceVoiceInputEnabled } from "@opengeni/sdk/browser";
import type { EffectiveSessionControl } from "@opengeni/sdk";
import { useRef, type ReactNode } from "react";
import { useAppContext } from "../app-context";
import { useAppShotTarget } from "./desktop/app-shots";
import { MessageContextPills } from "./message-context-pills";
import { ComposerUsageNotice } from "./usage/usage-entry";

export function useDraftAttachments(
  workspaceId: string,
  scope: "workspace" | "personal" = "workspace",
): UseFileAttachmentsResult {
  return useFileAttachments({ workspaceId, scope });
}

export function ConsoleComposer(props: {
  workspaceId: string;
  composer: ComposerState;
  attachments: UseFileAttachmentsResult;
  effectiveControl?: EffectiveSessionControl | null | undefined;
  queuedAheadCount?: number | undefined;
  canControlWorkspace?: boolean | undefined;
  controlLinks?:
    | {
        workspaceHref?: string | undefined;
        sessionHref?: ((sessionId: string) => string) | undefined;
      }
    | undefined;
  placeholder?: string | undefined;
  autoFocus?: boolean | undefined;
  disabled?: boolean | undefined;
  fileUploadsEnabled: boolean;
  /** Rendered before attach (mobile “+” lives here). */
  controlsLeading?: ReactNode | undefined;
  /** Session setup controls rendered above the message input. */
  header?: ReactNode | undefined;
  controls?: ReactNode | undefined;
  actions?: ReactNode | undefined;
  commandContext?: SlashCommandContext | undefined;
  onClearView?: (() => void) | undefined;
  /** Route-specific composer copy, including an exact disabled-send explanation. */
  messages?: Partial<ChatComposerMessages> | undefined;
  /** Soft-hide dictate while realtime voice is active. */
  transcriptionSuppressed?: boolean | undefined;
  /** Re-read the near/at-limit usage line when this changes (for example the session status). */
  usageRefreshKey?: unknown | undefined;
  /** Up in an empty composer pulls the latest waiting prompt back for editing. */
  queuedRecall?: ComposerQueuedRecall | undefined;
  /** Work this session started is running, or a wake is pending; keeps Pause available while it is idle. */
  running?: boolean | undefined;
}) {
  const context = useAppContext();
  const workspace = context.workspaces.find((candidate) => candidate.id === props.workspaceId);
  const voiceInputEnabled = resolveWorkspaceVoiceInputEnabled(workspace?.settings) ?? true;
  // In the desktop app, the app-shot shortcut attaches the captured window here.
  const regionRef = useRef<HTMLDivElement>(null);
  useAppShotTarget(props.fileUploadsEnabled ? props.attachments : null, regionRef);
  return (
    <div ref={regionRef} className="contents">
      <ChatComposer
        responsiveBasis="container"
        composer={props.composer}
        effectiveControl={props.effectiveControl}
        queuedAheadCount={props.queuedAheadCount}
        queuedRecall={props.queuedRecall}
        running={props.running === true}
        canControlWorkspace={props.canControlWorkspace}
        controlLinks={props.controlLinks}
        placeholder={props.placeholder}
        autoFocus={props.autoFocus}
        disabled={props.disabled}
        messages={props.messages}
        {...(props.fileUploadsEnabled ? { attachments: props.attachments } : {})}
        {...(props.commandContext ? { commandContext: props.commandContext } : {})}
        {...(props.onClearView ? { onClearView: props.onClearView } : {})}
        {...(props.controlsLeading ? { controlsLeading: props.controlsLeading } : {})}
        header={
          <>
            <ComposerUsageNotice
              workspaceId={props.workspaceId}
              refreshKey={props.usageRefreshKey}
            />
            {props.header}
            <MessageContextPills />
          </>
        }
        // The actions menu owns attachments when supplied.
        attachButtonClassName={props.controlsLeading ? "hidden" : undefined}
        controlsStart={props.controls}
        actionsStart={props.actions}
        transcriptionSuppressed={props.transcriptionSuppressed === true}
        {...(context.clientConfig.voiceInput?.available
          ? {
              transcription: {
                client: context.client,
                workspaceId: props.workspaceId,
                capability: context.clientConfig.voiceInput,
                workspaceEnabled: voiceInputEnabled,
              },
            }
          : {})}
      />
    </div>
  );
}
