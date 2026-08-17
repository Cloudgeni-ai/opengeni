import type { SendMessageInput, SessionEvent, SteerMessageResult } from "@opengeni/sdk";
import {
  ChatComposer,
  MessageTimeline,
  OpenGeniProvider,
  SessionChrome,
  useComposer,
  useSessionEvents,
  type TimelineItem,
  type UserMessageItem,
  type UseTurnQueueResult,
} from "@opengeni/react";
import { useMemo } from "react";
import { createRoot } from "react-dom/client";

import { MockOpenGeniClient } from "./mock";
import "./styles.css";

const WORKSPACE_ID = "11111111-2222-4333-8444-555555555555";
const SESSION_ID = "99999999-9999-4999-8999-999999999999";
const params = new URLSearchParams(window.location.search);
const requestedDelay = Number(params.get("delayMs") ?? "0");
const delayMs = Number.isFinite(requestedDelay) ? Math.max(0, Math.min(10_000, requestedDelay)) : 0;
const fail =
  params.get("fail") === "send" || params.get("fail") === "steer" ? params.get("fail") : null;

class LatencyHarnessClient extends MockOpenGeniClient {
  override async sendMessage(
    workspaceId: string,
    sessionId: string,
    message: string | SendMessageInput,
  ): Promise<SessionEvent> {
    await waitForDelay();
    if (fail === "send") throw new Error("Harness rejected queued message");
    const accepted = await super.sendMessage(workspaceId, sessionId, message);
    if (typeof message !== "string" && message.clientEventId) {
      accepted.clientEventId = message.clientEventId;
    }
    return accepted;
  }

  override async steerMessage(
    workspaceId: string,
    sessionId: string,
    message: string | SendMessageInput,
  ): Promise<SteerMessageResult> {
    if (fail === "steer") {
      await waitForDelay();
      throw new Error("Harness rejected Steer request");
    }
    return await super.steerMessage(workspaceId, sessionId, message);
  }
}

const client = new LatencyHarnessClient();

function waitForDelay(): Promise<void> {
  return delayMs > 0
    ? new Promise<void>((resolve) => window.setTimeout(resolve, delayMs))
    : Promise.resolve();
}

const EMPTY_QUEUE: UseTurnQueueResult = {
  snapshot: null,
  queue: [],
  pendingInputs: [],
  pendingInputAttachment: null,
  activePersonalConnections: [],
  effectiveControl: null,
  stoppingPreviousAttempt: false,
  loading: false,
  error: null,
  refresh: async () => {},
  moveTurn: async () => false,
  editTurn: async () => null,
  steerTurn: async () => false,
  removeTurn: async () => false,
  pendingByTurn: {},
  mutationFor: () => null,
  mutating: false,
  mutationError: null,
  clearMutationError: () => {},
};

function ComposerLatencyHarness() {
  const sessionEvents = useSessionEvents(SESSION_ID);
  const composer = useComposer(SESSION_ID, {
    events: sessionEvents.events,
    draftPersistence: "disabled",
  });
  const optimisticMessages = useMemo(
    () => composer.optimisticMessages ?? [],
    [composer.optimisticMessages],
  );
  const retryOptimisticMessage = composer.retryOptimisticMessage;
  const removeOptimisticMessage = composer.removeOptimisticMessage;
  const timeline = useMemo<TimelineItem[]>(() => {
    const acceptedClientEventIds = new Set(
      sessionEvents.events
        .filter((event) => event.type === "user.message" && event.clientEventId)
        .map((event) => event.clientEventId as string),
    );
    const optimistic: UserMessageItem[] = optimisticMessages
      .filter((message) => !acceptedClientEventIds.has(message.clientEventId))
      .map((message) => ({
        kind: "user-message",
        id: `optimistic:${message.clientEventId}`,
        text: message.text,
        annotations: message.annotations.map((annotation, ordinal) => ({
          ...annotation,
          ordinal,
        })),
        resources: message.resources,
        tools: [],
        occurredAt: message.occurredAt,
        delivery: {
          state: message.state,
          ...(message.error ? { error: message.error } : {}),
          ...(message.state === "failed"
            ? {
                onRetry: () => retryOptimisticMessage?.(message.clientEventId),
                onRemove: () => removeOptimisticMessage?.(message.clientEventId),
              }
            : {}),
        },
      }));
    return [...sessionEvents.timeline, ...optimistic];
  }, [
    optimisticMessages,
    removeOptimisticMessage,
    retryOptimisticMessage,
    sessionEvents.events,
    sessionEvents.timeline,
  ]);

  const steeringPhase = composer.steering?.phase ?? "none";
  const userMessageCount = timeline.filter((item) => item.kind === "user-message").length;

  return (
    <main
      className="og-root flex min-h-dvh flex-col bg-og-bg text-og-fg"
      data-composer-latency-harness=""
      data-composer-sending={composer.sending ? "1" : "0"}
      data-composer-draft={composer.value}
      data-optimistic-count={optimisticMessages.length}
      data-optimistic-states={optimisticMessages.map((message) => message.state).join(",")}
      data-steering-phase={steeringPhase}
      data-event-count={sessionEvents.events.length}
      data-user-message-count={userMessageCount}
      data-error={composer.error?.message ?? ""}
    >
      <header className="border-b border-og-border px-4 py-3">
        <h1 className="text-og-sm font-semibold">Composer interaction latency</h1>
        <p className="mt-1 text-og-xs text-og-fg-subtle">
          Real production hook and surfaces · {delayMs}ms injected acceptance delay
        </p>
      </header>
      <MessageTimeline items={timeline} status="running" className="min-h-0 flex-1" />
      <div className="shrink-0 px-3 pb-2 sm:px-4">
        <SessionChrome queue={EMPTY_QUEUE} composer={composer} sessionStatus="running" />
      </div>
      <div className="shrink-0 border-t border-og-border px-3 py-3 sm:px-4">
        <ChatComposer composer={composer} placeholder="Message the agent" />
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <OpenGeniProvider client={client} workspaceId={WORKSPACE_ID}>
    <ComposerLatencyHarness />
  </OpenGeniProvider>,
);
