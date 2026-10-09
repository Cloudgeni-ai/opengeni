import type { SendMessageInput } from "@opengeni/sdk";
import { useMemo } from "react";
import { projectPendingApprovals } from "../approvals";
import { conversationTimeline } from "../conversation-timeline";
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
   */
  composerOptions?:
    | Pick<
        UseComposerOptions,
        "sendExtras" | "sendBlocked" | "onSubmitted" | "onSent" | "onDeliveryError"
      >
    | undefined;
};

export type SessionConversationController = ReturnType<typeof useSessionConversation>;

/**
 * The complete conversation's state, independent of its layout. Mount once in
 * a stable host and pass the result to SessionConversationView, or compose the
 * stock timeline/chrome/composer around the same controller. Unmounting a view
 * does not dispose the stream, draft or uploads while this hook stays mounted.
 * The ordinary SessionConversation component uses this exact implementation.
 */
export function useSessionConversation(
  sessionId: string,
  options: UseSessionConversationOptions = {},
) {
  const context = useOpenGeni(options);
  const scope = { client: context.client, workspaceId: context.workspaceId };
  const config = useClientConfigFlags(context.client);
  const showModelPicker = options.modelPicker ?? config.modelSelection;
  const catalog = useWorkspaceModelCatalog({ ...scope, enabled: showModelPicker });
  const feed = useSessionEvents(sessionId, scope);
  const eventOptions = { ...scope, events: feed.events };
  const detail = useSession(sessionId, eventOptions);
  const queue = useTurnQueue(sessionId, eventOptions);
  const human = useHumanInputRequests(sessionId, eventOptions);
  const control = useSessionControl(sessionId, scope);
  const approvals = useMemo(() => projectPendingApprovals(feed.events), [feed.events]);
  const files = useFileAttachments(scope);
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
    effectiveControl: queue.effectiveControl ?? detail.session?.effectiveControl,
    sendDestination: () => (queue.queue.length > 0 || status === "running" ? "queue" : "chat"),
    sendExtras: () => {
      const extras = resolveExtras();
      return {
        ...extras,
        resources: [...(extras?.resources ?? []), ...(uploadsEnabled ? files.readyResources : [])],
      };
    },
    sendBlocked: () =>
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
  const timeline = useMemo(
    () => conversationTimeline(feed.timeline, queue, composer),
    [feed.timeline, queue, composer],
  );
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
