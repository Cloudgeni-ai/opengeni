// Console chrome around the shared chat composer. While the agent works, Send
// follows the workspace's choice (queue or steer) and the other choice sits
// beside it (also Cmd/Ctrl+Enter), so there is no per-message mode to track.
import {
  ChatComposer,
  useFileAttachments,
  type ChatComposerMessages,
  type ComposerState,
  type SlashCommandContext,
  type UseFileAttachmentsResult,
} from "@opengeni/react";
import { resolveWorkspaceVoiceInputEnabled } from "@opengeni/sdk/browser";
import type { EffectiveSessionControl } from "@opengeni/sdk";
import { useRef, type ReactNode } from "react";
import { useAppContext } from "@/context";
import { useAppShotTarget } from "@/components/desktop/app-shots";
import { ComposerUsageNotice } from "@/components/usage/usage-entry";

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
  /** Rendered before attach (mobile “+” lives here). */
  controlsLeading?: ReactNode;
  /** Session setup controls rendered above the message input. */
  header?: ReactNode;
  controls?: ReactNode;
  actions?: ReactNode;
  commandContext?: SlashCommandContext;
  onClearView?: () => void;
  /** Route-specific composer copy, including an exact disabled-send explanation. */
  messages?: Partial<ChatComposerMessages>;
  /** Soft-hide dictate while realtime voice is active. */
  transcriptionSuppressed?: boolean;
  /** Re-read the near/at-limit usage line when this changes (for example the session status). */
  usageRefreshKey?: unknown;
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
