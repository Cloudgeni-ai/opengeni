import { useRef, type CSSProperties } from "react";
import { useOpenGeni, type ClientOverride } from "../session-context";
import { useWorkspaceModelCatalog } from "../hooks/use-available-models";
import { ModelPolicyPicker } from "./model-policy-picker";
import { useSessionEvents } from "../hooks/use-session-events";
import { useSession } from "../hooks/use-session";
import { useTurnQueue } from "../hooks/use-turn-queue";
import { useComposer } from "../hooks/use-composer";
import { useHumanInputRequests } from "../hooks/use-human-input";
import { ChatComposer, type ChatComposerProps } from "./chat-composer";
import { QueueSurface } from "./queue-surface";
import { HumanInputSurface } from "./human-input-surface";
import { MessageTimeline } from "./message-timeline";
import { conversationTimeline } from "../conversation-timeline";
import { cn } from "../lib/cn";

export type SessionConversationProps = ClientOverride & {
  sessionId: string;
  className?: string;
  /** Defaults to filling the host. The host owns available height. */
  height?: CSSProperties["height"];
  /** Presentation/custom controls only; queue and delivery wiring stay owned here. */
  composerProps?: Omit<ChatComposerProps, "composer" | "effectiveControl" | "queuedAheadCount">;
};

/** Complete existing-session conversation. Uses the provider's normal SDK client
 * (including Site clients), one shared event feed, and authoritative queue state. */
export function SessionConversation(props: SessionConversationProps) {
  return <Conversation key={`${props.workspaceId ?? ""}:${props.sessionId}`} {...props} />;
}

function Conversation({
  sessionId,
  client,
  workspaceId,
  className,
  height = "100%",
  composerProps,
}: SessionConversationProps) {
  const scope = { client, workspaceId };
  const context = useOpenGeni(scope);
  const catalog = useWorkspaceModelCatalog({
    client: context.client,
    workspaceId: context.workspaceId,
  });
  const feed = useSessionEvents(sessionId, scope);
  const options = { ...scope, events: feed.events };
  const detail = useSession(sessionId, options);
  const queue = useTurnQueue(sessionId, options);
  const human = useHumanInputRequests(sessionId, options);
  const status = feed.sessionStatus ?? detail.session?.status;
  const terminal = status === "cancelled";
  const composer = useComposer(sessionId, {
    ...options,
    effectiveControl: queue.effectiveControl ?? detail.session?.effectiveControl,
    sendDestination: () => (queue.queue.length > 0 || status === "running" ? "queue" : "chat"),
  });
  const region = useRef<HTMLDivElement>(null);
  const error = detail.error ?? feed.error ?? human.error;
  return (
    <div
      className={cn(
        "og-root flex min-h-0 min-w-0 flex-col gap-2 overflow-hidden bg-og-bg text-og-fg",
        className,
      )}
      ref={region}
      style={{ height }}
      data-og-conversation=""
    >
      {error && <p role="alert">{error.message}</p>}
      <MessageTimeline
        className="min-h-0 flex-1"
        items={conversationTimeline(feed.timeline, queue, composer)}
        status={status}
        hasOlder={feed.hasOlder}
        loadingOlder={feed.loadingOlder}
        onLoadOlder={feed.loadOlder}
        hasNewer={feed.hasNewer}
        loadingNewer={feed.loadingNewer}
        onLoadNewer={() => {
          void feed.loadNewer();
        }}
        onJumpToStart={async () => {
          await feed.loadOldest();
        }}
        loadingOldest={feed.loadingOldest}
        onJumpToLatest={feed.jumpToLatest}
        onAnnotate={composer.addAnnotation}
      />
      <div className="min-h-0 max-h-[40%] shrink-0 overflow-y-auto" data-og-conversation-inputs="">
        <HumanInputSurface
          requests={human.requests}
          onSubmit={async (id, response) => {
            await human.respond(id, response);
          }}
          respondingRequestId={human.respondingRequestId}
          error={human.mutationError?.message}
          autoFocus={false}
        />
        {terminal ? (
          <QueueSurface queue={queue} readOnly />
        ) : (
          <QueueSurface
            queue={queue}
            composer={composer}
            onRequestComposerFocus={() =>
              region.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus()
            }
          />
        )}
      </div>
      <div className="shrink-0" data-og-conversation-composer="">
        <ChatComposer
          {...composerProps}
          composer={composer}
          disabled={terminal || composerProps?.disabled}
          controlsStart={
            composerProps?.controlsStart ??
            (composer.policy && (
              <ModelPolicyPicker
                rows={catalog.rows}
                model={composer.policy.model}
                effort={composer.policy.reasoningEffort}
                latencyMode={composer.policy.latencyMode}
                loading={catalog.loading}
                error={catalog.error?.message}
                disabled={terminal}
                sessionKey={sessionId}
                onModelChange={(model) => composer.setModel?.(model)}
                onEffortChange={(effort) => composer.setReasoningEffort?.(effort)}
                onLatencyModeChange={(mode) => composer.setLatencyMode?.(mode)}
              />
            ))
          }
          responsiveBasis={composerProps?.responsiveBasis ?? "container"}
          effectiveControl={
            composer.effectiveControl ?? queue.effectiveControl ?? detail.session?.effectiveControl
          }
          queuedAheadCount={queue.queue.length}
        />
      </div>
    </div>
  );
}
