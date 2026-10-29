// A new chat created by the view around it (the Site view creates it as the
// Site's own), drawn with the regular chat's composer: the same attachments
// (button, paste and a drop anywhere on it), dictation, voice and model chip.
// The creation state is the shared new-chat controller behind the stock
// NewConversation, so retries and uploads behave the same everywhere.
import type { FormEvent } from "react";

import {
  NewConversationStatus,
  useNewConversationVoice,
} from "../../../components/new-conversation";
import {
  useNewConversation,
  type UseNewConversationOptions,
} from "../../../hooks/use-new-conversation";
import { useAppContext } from "../../app-context";
import { ConsoleComposer } from "../Composer";
import { ModelPicker } from "../pickers";
import { ChatViewportFileDropTarget } from "./chat-viewport-file-drop-target";

export type ConsoleNewConversationProps = Pick<
  UseNewConversationOptions,
  "createSession" | "onCreated" | "enabled" | "scopeKey"
> & {
  workspaceId: string;
  /** The line above the composer, such as what to ask about. */
  title: string;
  placeholder?: string | undefined;
  className?: string | undefined;
};

export function ConsoleNewConversation(props: ConsoleNewConversationProps) {
  const context = useAppContext();
  const creation = useNewConversation({
    workspaceId: props.workspaceId,
    createSession: props.createSession,
    onCreated: props.onCreated,
    enabled: props.enabled,
    scopeKey: props.scopeKey,
    modelPicker: true,
  });
  const { composer, catalog, files, uploadsEnabled, available } = creation;
  // Voice offers what the console's new-chat page offers: the split model
  // menu, with Codex voice when a ready Codex subscription is connected.
  const codexConnected = catalog.rows.some(
    (row) =>
      row.provider === "codex-subscription" && row.catalog.credentialReadiness.status === "ready",
  );
  const voice = useNewConversationVoice(creation, { codexConnected, modelMenu: "split" });
  return (
    <ChatViewportFileDropTarget
      data-workspace-scroll-owner="self-managed"
      enabled={available && uploadsEnabled}
      onFiles={files.addFiles}
      className={props.className}
    >
      <form
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          void composer.send();
        }}
        className="mx-auto flex h-full w-full max-w-3xl flex-col gap-4"
        data-og-new-chat-composer=""
      >
        <div aria-hidden className="min-h-0 flex-[2]" />
        <p className="text-center text-base font-medium text-fg">{props.title}</p>
        <ConsoleComposer
          workspaceId={props.workspaceId}
          composer={composer}
          attachments={files}
          fileUploadsEnabled={uploadsEnabled}
          disabled={!available}
          placeholder={props.placeholder}
          actions={voice}
          controls={
            composer.policy ? (
              <ModelPicker
                rows={catalog.rows}
                model={composer.policy.model}
                effort={composer.policy.reasoningEffort}
                latencyMode={composer.policy.latencyMode}
                loading={catalog.loading}
                error={catalog.error?.message}
                disabled={composer.sending}
                menuSide="bottom"
                hasImageAttachments={files.attachments.some(
                  (file) => file.status !== "failed" && file.contentType.startsWith("image/"),
                )}
                connectModelsHref={`/workspaces/${encodeURIComponent(props.workspaceId)}/settings?section=models`}
                claudeSubscriptionAvailable={
                  context.clientConfig.claudeSubscriptionEnabled === true
                }
                onOpenChange={(open) => {
                  if (open) void catalog.refresh();
                }}
                onModelChange={(model) => composer.setModel?.(model)}
                onEffortChange={(effort) => composer.setReasoningEffort?.(effort)}
                onLatencyModeChange={(mode) => composer.setLatencyMode?.(mode)}
              />
            ) : undefined
          }
        />
        <NewConversationStatus creation={creation} />
        <div aria-hidden className="min-h-0 flex-[3]" />
      </form>
    </ChatViewportFileDropTarget>
  );
}
