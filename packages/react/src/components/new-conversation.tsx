import { OpenGeniApiError } from "@opengeni/sdk";
import { lazy, Suspense, useRef, type ComponentProps, type FormEvent } from "react";
import {
  useNewConversation,
  type NewConversationController,
  type UseNewConversationOptions,
} from "../hooks/use-new-conversation";
import { useRealtimeVoiceModels } from "../hooks/use-realtime-voice-models";
import { useErrorMessage } from "../lib/error-message";
import { useHostTheme } from "../lib/host-theme";
import { cn } from "../lib/cn";
import type { NewSessionRealtimeControl } from "../realtime/realtime-control";
import { ChatComposer } from "./chat-composer";
import { ModelPolicyPicker } from "./model-policy-picker";
import { useComposerTranscription, type SessionConversationProps } from "./session-conversation";
import { SessionProxyScope, type SessionProxyBaseUrl } from "./session-proxy-scope";

const LazyNewVoice = lazy(() => import("../realtime/embedded-new-voice"));

export type NewConversationLabels = {
  title: string;
  placeholder: string;
  send: string;
  unavailable: string;
  retry: string;
  pending: string;
  finishingUploads: string;
};
const DEFAULT_LABELS: NewConversationLabels = {
  title: "How can I help?",
  placeholder: "Ask anything…",
  send: "Send",
  unavailable: "New chats are not enabled for this product.",
  retry: "Retry",
  pending: "Creation is not confirmed. Retry checks the same request; your newer draft stays here.",
  finishingUploads: "Chat created. Finish or remove the remaining uploads to open it.",
};
type Presentation = {
  composerProps?: SessionConversationProps["composerProps"] | undefined;
  modelPickerProps?: SessionConversationProps["modelPickerProps"] | undefined;
  voiceInput?: boolean | undefined;
  realtimeVoiceProps?: SessionConversationProps["realtimeVoiceProps"] | undefined;
  labels?: Partial<NewConversationLabels> | undefined;
  theme?: SessionConversationProps["theme"] | undefined;
  surface?: SessionConversationProps["surface"] | undefined;
  height?: SessionConversationProps["height"] | undefined;
  className?: string | undefined;
};

export type NewConversationProps = UseNewConversationOptions & SessionProxyBaseUrl & Presentation;
export type NewConversationViewProps = Presentation & { creation: NewConversationController };

/** Standalone stock new-chat composer. OpenGeniChat uses this same implementation. */
export function NewConversation({ baseUrl, headers, fetch, ...props }: NewConversationProps) {
  if (baseUrl === undefined) return <NewConversationRuntime {...props} />;
  const { client, workspaceId, ...rest } = props;
  return (
    <SessionProxyScope
      baseUrl={baseUrl}
      headers={headers}
      fetch={fetch}
      client={client}
      workspaceId={workspaceId}
    >
      <NewConversationRuntime {...rest} />
    </SessionProxyScope>
  );
}
function NewConversationRuntime(props: NewConversationProps) {
  const creation = useNewConversation(props);
  return <NewConversationView {...props} creation={creation} />;
}

/** Presentation for a new-chat controller kept above host layout changes. */
export function NewConversationView({
  creation,
  labels: overrides,
  composerProps,
  modelPickerProps,
  voiceInput = true,
  realtimeVoiceProps,
  theme,
  surface,
  height = "100%",
  className,
}: NewConversationViewProps) {
  const labels = { ...DEFAULT_LABELS, ...overrides };
  const { composer, config, catalog, files, uploadsEnabled, available, error, pending } = creation;
  const formatError = useErrorMessage();
  const root = useRef<HTMLFormElement>(null);
  const hostTheme = useHostTheme(root, { theme, surface });
  const transcription = useComposerTranscription(
    creation.client,
    creation.workspaceId,
    voiceInput && available ? config.voiceInput : null,
  );
  const models = useRealtimeVoiceModels(
    creation.client,
    creation.workspaceId,
    creation.realtimeVoiceEnabled && available,
  );
  const voice = models.length ? (
    <Suspense fallback={null}>
      <LazyNewVoice
        client={
          creation.client as unknown as ComponentProps<typeof NewSessionRealtimeControl>["client"]
        }
        workspaceId={creation.workspaceId}
        codexConnected={realtimeVoiceProps?.codexConnected ?? false}
        modelMenu={realtimeVoiceProps?.modelMenu}
        disabled={
          composer.sending || pending !== null || creation.finishingUploads || files.hasUnresolved
        }
        onStart={creation.startRealtime}
      />
    </Suspense>
  ) : null;
  return (
    <form
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        void composer.send();
      }}
      ref={root}
      className={cn(
        "og-root mx-auto box-border flex w-full max-w-3xl flex-col gap-4 bg-og-bg p-3 text-og-base text-og-fg",
        className,
      )}
      style={{ ...hostTheme.style, height }}
      data-og-theme={hostTheme.attribute}
      data-og-host-theme=""
      data-og-new-chat-composer=""
    >
      <div aria-hidden className="min-h-0 flex-[2]" />
      {labels.title ? (
        <p className="text-center text-og-md font-medium text-og-fg">{labels.title}</p>
      ) : null}
      <ChatComposer
        {...composerProps}
        {...(transcription && composerProps?.transcription === undefined ? { transcription } : {})}
        composer={composer}
        attachments={uploadsEnabled ? files : undefined}
        disabled={!available || composerProps?.disabled}
        runControl="none"
        running={false}
        placeholder={overrides?.placeholder ?? composerProps?.placeholder ?? labels.placeholder}
        inputProps={{ "aria-label": labels.placeholder, ...composerProps?.inputProps }}
        messages={{ sendMessageAriaLabel: labels.send, ...composerProps?.messages }}
        actionsStart={
          voice ? (
            <>
              {composerProps?.actionsStart}
              {voice}
            </>
          ) : (
            composerProps?.actionsStart
          )
        }
        controlsStart={
          composerProps?.controlsStart ??
          (composer.policy ? (
            <ModelPolicyPicker
              groupPresentation={modelPickerProps?.groupPresentation}
              messages={modelPickerProps?.messages}
              rows={catalog.rows}
              model={composer.policy.model}
              effort={composer.policy.reasoningEffort}
              latencyMode={composer.policy.latencyMode}
              loading={catalog.loading}
              error={catalog.error?.message}
              disabled={composer.sending}
              menuSide="bottom"
              onOpenChange={(open) => {
                if (open) void catalog.refresh();
              }}
              onModelChange={composer.setModel!}
              onEffortChange={composer.setReasoningEffort!}
              onLatencyModeChange={composer.setLatencyMode!}
            />
          ) : undefined)
        }
        responsiveBasis={composerProps?.responsiveBasis ?? "container"}
      />
      {!available ? (
        <p className="text-center text-og-sm text-og-fg-muted" data-og-new-chat-unavailable="">
          {labels.unavailable}
        </p>
      ) : error ? (
        <p role="alert" className="text-center text-og-sm text-og-status-failed">
          {
            // A proxy without a createSession hook refuses the route itself
            // (older proxies also report no sessionCreation flag up front).
            error.cause instanceof OpenGeniApiError && error.cause.code === "route_not_allowed"
              ? labels.unavailable
              : formatError(error.cause)
          }
        </p>
      ) : null}
      {pending ? (
        <div className="text-center text-og-sm text-og-fg-muted">
          <p role="status">{labels.pending}</p>
          <button
            type="button"
            disabled={composer.sending}
            onClick={() => {
              void creation.retry();
            }}
            className="mt-2 rounded-og-sm border border-og-border px-3 py-1.5 text-og-fg hover:bg-og-hover disabled:opacity-50"
          >
            {labels.retry}
          </button>
        </div>
      ) : null}
      {creation.finishingUploads ? (
        <p role="status" className="text-center text-og-sm text-og-fg-muted">
          {labels.finishingUploads}
        </p>
      ) : null}
      <div aria-hidden className="min-h-0 flex-[3]" />
    </form>
  );
}
