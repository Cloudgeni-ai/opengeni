import type { SendMessageInput } from "@opengeni/sdk";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { projectPendingApprovals } from "../approvals";
import { conversationTimeline } from "../conversation-timeline";
import { useSessionStartupTimeline, type PendingPrompt } from "../lib/session-startup-timeline";
import { admissionRecheckControl } from "../session-admission-model";
import { useOpenGeni, type ClientOverride } from "../session-context";
import { useWorkspaceModelCatalog } from "./use-available-models";
import { useClientConfigFlags } from "./use-client-config-flags";
import { useComposer, type UseComposerOptions } from "./use-composer";
import { useFileAttachments } from "./use-file-attachments";
import { useHumanInputRequests } from "./use-human-input";
import { useSession } from "./use-session";
import { useSessionControl } from "./use-session-control";
import { useSessionEvents } from "./use-session-events";
import { useTurnQueue } from "./use-turn-queue";

export type UseSessionConversationOptions = ClientOverride & {
  /** Uploads remain subject to the client's capabilities. Defaults to true. */
  attachments?: boolean | undefined;
  /** Defaults to the client's model-selection offer. */
  modelPicker?: boolean | undefined;
  /**
   * Optional host context and notifications. The stock composer still owns
   * draft validation, annotations, retry identity, queueing and delivery.
   * File cleanup and upload blocking are composed with, not replaced by, these hooks.
   *
   * `busySend: "steer"` gives people one Send and nothing to learn: a message
   * sent while the agent works is read as soon as it can, with no Queue
   * choice beside Send and no Queue or Steer words (`offerQueue` brings the
   * Queue choice back).
   */
  composerOptions?:
    | Pick<
        UseComposerOptions,
        | "sendExtras"
        | "sendBlocked"
        | "onSubmitted"
        | "onSent"
        | "onDeliveryError"
        | "initialDraft"
        | "busySend"
        | "offerQueue"
      >
    | undefined;
  /**
   * The first prompt, when the host sent it before this conversation could
   * read it back (for example while the host's server creates the session).
   * The conversation shows it with the startup row from the first frame,
   * keeps them while the session id is still `null` and history loads, and
   * then hands over to the live timeline without a blank frame or a second
   * loading style. Read once per conversation; later changes are ignored.
   * While the id is `null` nothing can be sent, and the stock view disables
   * its composer; a custom layout should disable its composer too, since a
   * draft written then is not carried into the created session.
   */
  pendingPrompt?: PendingPrompt | null | undefined;
};

export type { PendingPrompt };

export type SessionConversationController = ReturnType<typeof useSessionConversation>;

/**
 * The complete conversation's state, independent of its layout. Mount once in
 * a stable host and pass the result to SessionConversationView, or compose the
 * stock timeline/chrome/composer around the same controller. Unmounting a view
 * does not dispose the stream, draft or uploads while this hook stays mounted.
 * The ordinary SessionConversation component uses this exact implementation.
 */
export function useSessionConversation(
  /** `null` while the host is still creating the session; pass `pendingPrompt` with it. */
  sessionId: string | null,
  options: UseSessionConversationOptions = {},
) {
  // Captured once: hosts often drop the prompt after the first render. It
  // belongs to the first conversation only (see `usePendingPrompt`).
  const [initialPrompt] = useState(() => options.pendingPrompt ?? null);
  const context = useOpenGeni(options);
  const scope = { client: context.client, workspaceId: context.workspaceId };
  const config = useClientConfigFlags(context.client);
  const showModelPicker = options.modelPicker ?? config.modelSelection;
  const catalog = useWorkspaceModelCatalog({ ...scope, enabled: showModelPicker });
  const feed = useSessionEvents(sessionId, scope);
  const pendingPrompt = usePendingPrompt(initialPrompt, sessionId, feed.initialHistoryReady);
  const eventOptions = { ...scope, events: feed.events };
  const detail = useSession(sessionId, eventOptions);
  const queue = useTurnQueue(sessionId, eventOptions);
  const human = useHumanInputRequests(sessionId, eventOptions);
  const control = useSessionControl(sessionId, scope);
  const approvals = useMemo(() => projectPendingApprovals(feed.events), [feed.events]);
  const files = useFileAttachments(scope);
  const clearFiles = files.clear;
  const attachmentSession = useRef(sessionId);
  useLayoutEffect(() => {
    if (attachmentSession.current === sessionId) return;
    const created = attachmentSession.current === null;
    attachmentSession.current = sessionId;
    // A session the host just created keeps what the person attached meanwhile.
    if (created) return;
    // Upload transport is workspace-scoped; these unsent cards belong to one
    // conversation. Retiring them also makes late settlements no-ops because
    // their local attachment identities no longer exist in the queue.
    clearFiles();
  }, [clearFiles, sessionId]);
  const uploadsEnabled = (options.attachments ?? true) && config.uploads;
  const status = feed.sessionStatus ?? detail.session?.status;
  const terminal = status === "cancelled";
  const importedArchive = detail.session?.importedArchive?.readOnly === true;
  const host = options.composerOptions;
  const resolveExtras = () =>
    typeof host?.sendExtras === "function" ? host.sendExtras() : host?.sendExtras;
  const releaseSentFiles = (input: SendMessageInput) =>
    files.removeReadyFiles(
      (input.resources ?? []).flatMap((resource) =>
        resource.kind === "file" ? [resource.fileId] : [],
      ),
    );
  const composer = useComposer(sessionId, {
    ...eventOptions,
    initialDraft: host?.initialDraft,
    busySend: host?.busySend,
    offerQueue: host?.offerQueue,
    effectiveControl: queue.effectiveControl ?? detail.session?.effectiveControl,
    // As in the console and the native screen: a turn that is still current
    // (running, recovering or waiting for capacity) means a Send waits.
    sendDestination: () =>
      queue.queue.length > 0 ||
      status === "running" ||
      (detail.session?.activeTurnId ?? null) !== null
        ? "queue"
        : "chat",
    sendExtras: () => {
      const extras = resolveExtras();
      return {
        ...extras,
        resources: [...(extras?.resources ?? []), ...(uploadsEnabled ? files.readyResources : [])],
      };
    },
    sendBlocked: () =>
      sessionId === null ||
      terminal ||
      importedArchive ||
      (uploadsEnabled && files.hasUnresolved) ||
      host?.sendBlocked?.() === true,
    onSubmitted: (text, input) => {
      releaseSentFiles(input);
      return host?.onSubmitted?.(text, input);
    },
    onSent: (text, input) => {
      releaseSentFiles(input);
      return host?.onSent?.(text, input);
    },
    onDeliveryError: host?.onDeliveryError,
  });
  const conversation = useMemo(
    () => conversationTimeline(feed.timeline, queue, composer),
    [feed.timeline, queue, composer],
  );
  // The same startup row as the web app's session page: from the accepted
  // prompt until the turn's own work row, one loading state, never a gap.
  // A session without control state yet shows no startup row rather than
  // guessing whether it is active.
  const session = detail.session;
  const sessionControl = session?.effectiveControl;
  const timeline = useSessionStartupTimeline(conversation, {
    session:
      session && sessionControl
        ? {
            ...session,
            effectiveControl: admissionRecheckControl(
              sessionControl,
              queue.effectiveControl,
              composer.effectiveControl,
            ),
          }
        : null,
    events: feed.events,
    optimisticMessages: composer.optimisticMessages,
    hasNewer: feed.hasNewer,
    queue: queue.snapshot,
    pendingPrompt,
    historyReady: sessionId !== null && feed.initialHistoryReady,
  });
  const error = detail.error ?? feed.error ?? human.error;
  const loadFailed = Boolean(feed.error) && !feed.initialHistoryReady;
  const retry = async () => {
    await Promise.all([
      ...(detail.error ? [detail.refresh()] : []),
      ...(human.error ? [human.refresh()] : []),
      ...(feed.error ? [feed.jumpToLatest()] : []),
    ]);
  };

  return {
    ...scope,
    sessionId,
    config,
    catalog,
    showModelPicker,
    feed,
    detail,
    queue,
    human,
    control,
    approvals,
    files,
    uploadsEnabled,
    composer,
    /** The same live application context for text and durable voice messages. */
    getModelContext: () => resolveExtras()?.modelContext,
    timeline,
    status,
    terminal,
    importedArchive,
    running: status === "running" || status === "recovering" || status === "waiting_capacity",
    error,
    loadFailed,
    retry,
  };
}

/**
 * The first prompt belongs to the conversation it was sent in: the session
 * that is still being created (`null`) and the id it then gets. It retires
 * once that session's history is readable, or when the conversation moves to
 * any other session, so no later session can show it.
 */
function usePendingPrompt(
  prompt: PendingPrompt | null,
  sessionId: string | null,
  historyReady: boolean,
): PendingPrompt | null {
  const owner = useRef<{ sessionId: string | null; retired: boolean }>({
    sessionId,
    retired: prompt === null,
  });
  const current = owner.current;
  if (!current.retired && current.sessionId !== sessionId) {
    if (current.sessionId === null) current.sessionId = sessionId;
    else current.retired = true;
  }
  if (!current.retired && sessionId !== null && historyReady) current.retired = true;
  return current.retired ? null : prompt;
}
