// Console chrome around @opengeni/react's ChatComposer: the console's control
// strip (delivery-mode toggle, model picker, tool toggles) plus the package's
// built-in file-attachment UI. File upload state, chips, paste-to-attach, and
// the send-gate now live in the package (useFileAttachments + ChatComposer's
// `attachments` prop); the console just wires them through.
import {
  ChatComposer,
  useFileAttachments,
  type ComposerState,
  type SlashCommandContext,
  type UseFileAttachmentsResult,
} from "@opengeni/react";
import { ListPlusIcon, ZapIcon } from "lucide-react";
import { type ReactNode } from "react";

import { deliveryModeExplanation } from "@/lib/queue";
import { cn } from "@/lib/utils";
import type { SessionStatus } from "@/types";

/**
 * Back-compat shim over the package's workspace-scoped {@link useFileAttachments}.
 * The new-session surface still calls this positionally; the session route uses
 * the package hook directly (the provider supplies the workspace there).
 */
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
  /** Console controls (model picker, tool toggles, ...) in the footer row. */
  controls?: ReactNode;
  /**
   * Show the queue-vs-steer delivery choice. Queue (default) stacks the
   * message behind the running turn; steer interrupts and injects it now.
   */
  showDeliveryMode?: boolean;
  /**
   * Enables the slash-command palette (type "/"): session/operator controls
   * (/goal, /clear, /compact, /help). Absent on surfaces with no live session
   * (e.g. the new-session screen), where the palette stays inert.
   */
  commandContext?: SlashCommandContext;
  /** Reset the local timeline view (the /clear-view command target). */
  onClearView?: () => void;
}) {
  const { composer, attachments } = props;

  return (
    <div className="w-full">
      <ChatComposer
        composer={composer}
        status={props.status}
        placeholder={props.placeholder}
        autoFocus={props.autoFocus}
        disabled={props.disabled}
        {...(props.fileUploadsEnabled ? { attachments } : {})}
        {...(props.commandContext ? { commandContext: props.commandContext } : {})}
        {...(props.onClearView ? { onClearView: props.onClearView } : {})}
        controlsStart={(
          <>
            {props.showDeliveryMode ? (
              <DeliveryModeToggle composer={composer} disabled={props.disabled} />
            ) : null}
            {props.controls}
          </>
        )}
      />
      {props.showDeliveryMode && !props.disabled ? (
        <p
          data-testid="delivery-mode-hint"
          className={cn(
            "px-1.5 pt-1.5 text-[11px] leading-4",
            composer.mode === "steer" ? "text-amber-300/90" : "text-[color:var(--color-fg-subtle)]",
          )}
        >
          {deliveryModeExplanation(composer.mode, props.status ?? null)}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The compose-time queue-vs-steer choice. Queue is the calm default; steer is
 * visually loud (amber) because it interrupts whatever the agent is doing.
 */
function DeliveryModeToggle({ composer, disabled }: { composer: ComposerState; disabled?: boolean }) {
  return (
    <div
      role="radiogroup"
      aria-label="Delivery mode"
      className="flex h-8 shrink-0 items-center gap-0.5 rounded-full border border-[color:var(--color-border)] bg-[color:var(--color-bg)]/60 p-0.5"
    >
      <button
        type="button"
        role="radio"
        aria-checked={composer.mode === "queue"}
        disabled={disabled}
        onClick={() => composer.setMode("queue")}
        title="Queue (default): runs after the current turn finishes"
        className={cn(
          "inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-xs font-medium transition-colors",
          composer.mode === "queue"
            ? "bg-[color:var(--color-surface-2)] text-[color:var(--color-fg)]"
            : "text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)]",
        )}
      >
        <ListPlusIcon className="size-3.5" />
        Queue
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={composer.mode === "steer"}
        disabled={disabled}
        onClick={() => composer.setMode("steer")}
        title="Steer: interrupt the running turn and inject this message now"
        className={cn(
          "inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-xs font-medium transition-colors",
          composer.mode === "steer"
            ? "bg-amber-500/20 text-amber-200"
            : "text-[color:var(--color-fg-muted)] hover:text-amber-200",
        )}
      >
        <ZapIcon className="size-3.5" />
        Steer
      </button>
    </div>
  );
}
