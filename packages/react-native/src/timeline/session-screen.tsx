import { NativeTimelineMessagesProvider, type NativeTimelineMessages } from "./messages";
import type { ChatClient } from "@opengeni/sdk";
import {
  approvalsDecidable,
  conversationTimeline,
  personalMachineCopy,
  sessionAdmissionApprovedElsewhereCopy,
  sessionAdmissionCopy,
  sessionAdmissionMachineAccessCopy,
  timelineLivePause,
  useSessionStart,
  useSessionStartupTimeline,
  type PendingPrompt,
  type AgentMessageItem,
  type AuthNeededItem,
  type StoredFileSource,
  type UserMessageItem,
} from "@opengeni/react/session";
import { machineDisplayName } from "@opengeni/react/sandbox-label-model";
import { resolveAgentSignals, type AgentSignals } from "@opengeni/react/session-agents-model";
import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ErrorInfo,
  type ComponentRef,
  type ReactNode,
} from "react";
import { ActivityIndicator, Alert, Pressable, Text, View, type TextInput } from "react-native";
import { annotationHasNote } from "@opengeni/react/timeline-model";
import {
  defaultChatComposerMessages,
  type ChatComposerMessages,
} from "@opengeni/react/composer-messages";
import { Icon } from "./icon";
import { withAlpha } from "./primitives";
import type { OpenGeniNativeSessionController } from "../use-native-session";
import type { NativeFileAttachmentsResult } from "../attachments";
import {
  StoredFileImage,
  useNativeComposerAttachments,
  type NativeComposerAttachment,
} from "../stored-file-image";
import { SessionComposer, type SessionComposerProps } from "./composer";
import { TurnFeedbackButtons, useTurnRatings, type TurnFeedbackTarget } from "./feedback";
import { Button } from "./controls";
import {
  ApprovalStrip,
  HumanInputCard,
  type ApprovalStripProps,
  type HumanInputCardProps,
} from "./decisions";
import { NativeMessageAttachments } from "./message-attachments";
import { QueueDock } from "./queue-dock";
import {
  AnnotationsChip,
  AnnotationsSheet,
  type AnnotationReveal,
  type NativeAnnotationLike,
} from "./annotations";
import { SessionCommandsList, SessionSignals } from "./session-signals";
import type {
  ClientModel,
  OpenGeniClient,
  ResourceRef,
  ChatSession as Session,
  SessionBackgroundCommand,
} from "@opengeni/sdk";
import { MessageTimeline, type NativeMessageTimelineProps } from "./message-timeline";
import { useNativeInChatConnect, type NativeInChatConnectOptions } from "./in-chat-connect";
import { fontStyle, useNativeTimelineTheme } from "./theme";
import { useNativeTimelineMessages } from "./messages";
import { SingleSendWording, useOpenGeniText } from "@opengeni/react/messages";
import {
  InteractiveAnswerProvider,
  type InteractiveAnswerStore,
} from "@opengeni/react/interactive-answer-model";

/* ----------------------------------------------------------------------------
   The web session page body at phone width: timeline (with the question card
   as its trailing state), the live approval strip and the composer, driven by
   the shared session controller. Navigation chrome belongs to the host.
   -------------------------------------------------------------------------- */

export interface NativeSessionScreenProps extends Omit<
  NativeMessageTimelineProps,
  "items" | "events" | "status" | "trailing"
> {
  controller: OpenGeniNativeSessionController<ChatClient>;
  /** The submitted first message, until its durable history is available. */
  pendingPrompt?: PendingPrompt | null | undefined;
  /** Composer slots (products add their own actions/options here). */
  composer?:
    | Partial<
        Pick<
          SessionComposerProps,
          | "renderLeading"
          | "options"
          | "header"
          | "placeholder"
          | "onAttach"
          | "messages"
          | "onActionFeedback"
          | "voice"
          | "call"
        >
      >
    | undefined;
  /** Extra content after the question card (host recovery, banners). */
  trailing?: ReactNode;
  /** Fixed host chrome above the timeline, inside the keyboard-avoiding area. */
  topBar?: ReactNode;
  bottomInset?: number | undefined;
  /** Distance from this screen's bottom edge to the window bottom (e.g. a tab bar). */
  keyboardBottomOffset?: number | undefined;
  /** Reply feedback (thumbs beside Copy), as the web timeline offers it. */
  feedback?: TurnFeedbackTarget | undefined;
  /** Translations for the question card (the shared human-input catalog). */
  humanInputMessages?: HumanInputCardProps["messages"];
  /** Translations for the approval strip. */
  approvalMessages?: ApprovalStripProps["messages"];
  /**
   * The review each pending approval shows, as the web `ApprovalSurface`'s
   * `loadReview`: the server's (`client.getToolActionReview`) or the host's
   * own plain title and consequence instead of the tool's raw arguments.
   * With `client`, an approval this resolves `null` for shows the server's
   * saved review. See `ApprovalStrip`'s `loadReview`.
   */
  loadReview?: ApprovalStripProps["loadReview"];
  /** Reads the commands panel (the full client; omit to hide command details). */
  client?: ChatClient<OpenGeniClient> | undefined;
  /**
   * Let people finish an agent's "connect your account" request in the chat,
   * with the web conversation's cards: sign-in opens the system sign-in
   * browser and comes back to the app, keys go into the secure field, and the
   * agent continues once setup is done. Needs `client`; omit to show the
   * request as a row.
   */
  inChatConnect?: NativeInChatConnectOptions | undefined;
  /** Model catalog for the agents panel rows. */
  models?: readonly ClientModel[] | undefined;
  /**
   * Show how the agent works behind the scenes: above the composer, the goal,
   * agents and commands chips; on each turn row, the live step and step
   * facets. Defaults to true. Set `false` for end users to whom a paused
   * goal, a count of helper agents, a running command or a tool step means
   * nothing: turn rows then read only "Working · 8s" / "Worked for 8s".
   * Or hide only some of them, for example `{ goal: false }` to drop the goal
   * chip and keep helper agents and turn-row detail (see the web
   * `AgentSignalOptions`). Queued messages, approvals and the agent's
   * questions always show.
   */
  agentSignals?: AgentSignals | undefined;
  /** Translations for the strings the native surfaces draw (merged over any provider above). */
  timelineMessages?: Partial<NativeTimelineMessages> | undefined;
  /**
   * Draw the composer yourself. Receives exactly the props the shared
   * `SessionComposer` would get (queue dock, approvals and attachment chips
   * included), so a host can restyle it or render its own native composer.
   * A floating composer must report its height through `onHeightChange`.
   */
  renderComposer?: ((props: SessionComposerProps) => ReactNode) | undefined;
  /**
   * Where interactive answers (`opengeni-ui`) remember picks, filters and
   * whether a pick was sent, for example AsyncStorage. Without it they are
   * remembered until the app closes.
   */
  answerStore?: InteractiveAnswerStore | undefined;
}

export function NativeSessionScreen({
  controller,
  composer: composerSlots,
  trailing,
  topBar,
  bottomInset,
  keyboardBottomOffset,
  feedback,
  humanInputMessages,
  approvalMessages,
  loadReview,
  client,
  inChatConnect,
  models,
  agentSignals,
  timelineMessages,
  renderComposer,
  renderMessageActions: hostMessageActions,
  answerStore,
  ...timelineProps
}: NativeSessionScreenProps) {
  const status = controller.sessionStatus;
  // One Send (`busySend: "steer"` without `offerQueue`): waiting messages,
  // not a queue, and no Steer to learn.
  return (
    <SingleSendWording enabled={controller.composer.singleSend === true}>
      <InteractiveAnswerProvider
        // A pick goes out as the person's next message, through the ordinary Send.
        send={controller.composer.send}
        scope={controller.sessionId}
        store={answerStore}
        // Like the web: a cancelled or archived chat can't take another message.
        readOnly={status === "cancelled" || controller.archived}
      >
        <NativeTimelineMessagesProvider messages={timelineMessages}>
          <SessionScreenBoundary sessionId={controller.sessionId}>
            <SessionScreenBody
              controller={controller}
              composer={composerSlots}
              trailing={trailing}
              topBar={topBar}
              bottomInset={bottomInset}
              keyboardBottomOffset={keyboardBottomOffset}
              feedback={feedback}
              humanInputMessages={humanInputMessages}
              approvalMessages={approvalMessages}
              loadReview={loadReview}
              client={client}
              inChatConnect={inChatConnect}
              models={models}
              agentSignals={agentSignals}
              renderComposer={renderComposer}
              renderMessageActions={hostMessageActions}
              {...timelineProps}
            />
          </SessionScreenBoundary>
        </NativeTimelineMessagesProvider>
      </InteractiveAnswerProvider>
    </SingleSendWording>
  );
}

/**
 * One chat must never take the app down. In a release build React Native
 * turns an uncaught render error into a fatal crash, so a failure while
 * drawing this conversation shows the load-failure state with Try again
 * instead, and the rest of the app keeps working.
 */
class SessionScreenBoundary extends Component<
  { sessionId: string; children: ReactNode },
  { error: Error | null; sessionId: string }
> {
  override state: { error: Error | null; sessionId: string } = {
    error: null,
    sessionId: this.props.sessionId,
  };

  static getDerivedStateFromError(error: unknown): { error: Error } {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  static getDerivedStateFromProps(
    props: { sessionId: string },
    state: { error: Error | null; sessionId: string },
  ): { error: Error | null; sessionId: string } | null {
    // Another chat starts clean.
    return props.sessionId === state.sessionId ? null : { error: null, sessionId: props.sessionId };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Opengeni session screen failed to render", error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <LoadFailure
        message={this.state.error.message}
        onRetry={() => this.setState({ error: null })}
      />
    );
  }
}

function SessionScreenBody({
  controller,
  pendingPrompt,
  composer: composerSlots,
  trailing,
  topBar,
  bottomInset,
  keyboardBottomOffset,
  feedback,
  humanInputMessages,
  approvalMessages,
  loadReview,
  client,
  inChatConnect,
  models,
  agentSignals,
  renderComposer,
  renderMessageActions: hostMessageActions,
  ...timelineProps
}: Omit<NativeSessionScreenProps, "timelineMessages" | "answerStore">) {
  const theme = useNativeTimelineTheme();
  const t = useOpenGeniText();
  const m = useNativeTimelineMessages();
  const signals = resolveAgentSignals(agentSignals);
  const { composer, queue, humanInput, approvals, control, attachments } = controller;
  // With the full client, each approval card reads the server's saved review
  // of its action after any review of the host's own: a Code Mode request
  // carries no inline arguments, so without it the card can't say what it does.
  const reviewWorkspaceId = controller.workspaceId;
  const reviewSessionId = controller.sessionId;
  const approvalReviews = useMemo<ApprovalStripProps["loadReview"]>(() => {
    if (!client) return loadReview;
    const saved = (approval: { id: string }) =>
      client.getToolActionReview(reviewWorkspaceId, reviewSessionId, approval.id);
    return loadReview
      ? async (approval) => (await loadReview(approval)) ?? (await saved(approval))
      : saved;
  }, [loadReview, client, reviewWorkspaceId, reviewSessionId]);
  const composerInput = useRef<ComponentRef<typeof TextInput>>(null);
  const annotationReveal = useRef<AnnotationReveal | null>(null);
  const draftAnnotations = composer.annotations ?? [];
  const annotationsIncomplete = draftAnnotations.some(
    (annotation) => annotation.note.trim().length === 0,
  );
  const reviewTargetId = composer.annotationReviewTargetId ?? null;
  const [reviewOpen, setReviewOpen] = useState(false);
  // A new quote, a marker tap or a send with an empty note opens its note.
  useEffect(() => {
    if (reviewTargetId) setReviewOpen(true);
  }, [reviewTargetId]);
  const closeReview = useCallback(() => {
    setReviewOpen(false);
    composer.clearAnnotationReviewTarget?.();
  }, [composer]);
  const [queuedReview, setQueuedReview] = useState<readonly NativeAnnotationLike[] | null>(null);
  // Each send brings the conversation back to its latest row.
  const [followLatestSignal, setFollowLatestSignal] = useState(0);
  const followLatest = useCallback(() => setFollowLatestSignal((value) => value + 1), []);
  // The composer floats over the conversation; its occupied height insets the timeline.
  const [composerHeight, setComposerHeight] = useState(120);
  const conversation = useMemo(
    () => conversationTimeline(controller.timeline, queue, composer),
    [controller.timeline, queue, composer],
  );
  const items = useSessionStartupTimeline(conversation, {
    session: controller.session.session,
    events: controller.events,
    optimisticMessages: composer.optimisticMessages,
    hasNewer: false,
    queue: queue.snapshot,
    pendingPrompt,
    historyReady: controller.initialHistoryReady ?? !controller.initialLoading,
  });
  const stockAuthNeeded = useNativeInChatConnect({
    client,
    workspaceId: controller.workspaceId,
    sessionId: controller.sessionId,
    items,
    options: inChatConnect,
  });
  const hostAuthNeeded = timelineProps.renderAuthNeeded;
  const renderAuthNeeded = useCallback(
    (item: AuthNeededItem) => hostAuthNeeded?.(item) ?? stockAuthNeeded?.(item),
    [hostAuthNeeded, stockAuthNeeded],
  );
  const status = controller.sessionStatus;
  const paused = queue.effectiveControl?.state === "paused";
  const waitingOnInput = humanInput.requests.length > 0 && status === "requires_action";
  const busy = composer.sending || composer.pausing || composer.resuming;
  const { ratings, rate } = useTurnRatings(feedback);
  const failed = controller.connectionState === "error";
  useAutoRecover(
    failed && controller.active,
    controller.connectionState === "live",
    controller.refresh,
  );
  const empty = items.length === 0;
  // Web order beside Copy: reply feedback, then host actions (fork, share…).
  const renderMessageActions = useCallback(
    (item: AgentMessageItem | UserMessageItem) => {
      const host = hostMessageActions?.(item);
      if (!feedback || item.kind !== "agent-message" || item.streaming || !item.turnId) return host;
      const turnId = item.turnId;
      return (
        <>
          <TurnFeedbackButtons
            target={feedback}
            turnId={turnId}
            saved={ratings[turnId]}
            onRated={(sentiment) => rate(turnId, sentiment)}
          />
          {host}
        </>
      );
    },
    [feedback, hostMessageActions, rate, ratings],
  );
  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.bg }}>
      {topBar}
      <MessageTimeline
        onAnnotate={composer.addAnnotation}
        draftAnnotations={composer.annotations}
        onDraftAnnotationSelect={composer.requestAnnotationReview}
        annotationRevealRef={annotationReveal}
        followLatestSignal={followLatestSignal}
        {...timelineProps}
        agentSignals={agentSignals}
        hasOlder={controller.hasOlder}
        loadingOlder={controller.loadingOlder}
        onLoadOlder={controller.loadOlder}
        contentInsetBottom={composerHeight + 20}
        overlayInsetBottom={composerHeight}
        renderMessageActions={feedback || hostMessageActions ? renderMessageActions : undefined}
        renderAuthNeeded={renderAuthNeeded}
        renderUserAttachments={
          timelineProps.renderUserAttachments ??
          (client
            ? (item) => (
                <NativeMessageAttachments
                  client={client}
                  workspaceId={controller.workspaceId}
                  sessionId={controller.sessionId}
                  resources={item.resources}
                />
              )
            : undefined)
        }
        items={items}
        events={controller.events}
        status={status}
        pause={timelineLivePause(
          queue.effectiveControl ?? controller.session.session?.effectiveControl,
        )}
        emptyState={
          empty && failed ? (
            <LoadFailure
              message={loadFailureMessage(controller.error, m.connectionFailed)}
              onRetry={() => void controller.refresh()}
            />
          ) : empty && controller.initialLoading ? (
            <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 8 }}>
              <ActivityIndicator color={theme.colors["fg-muted"]} />
            </View>
          ) : (
            timelineProps.emptyState
          )
        }
        trailing={
          <>
            {controller.admissionBlocked && !paused && controller.session.session ? (
              <StuckCard
                session={controller.session.session}
                client={controller.client}
                workspaceId={controller.workspaceId}
                busy={composer.resuming || control.controlling}
                onSessionChanged={async () => {
                  await Promise.all([controller.session.refresh(), queue.refresh()]);
                }}
              />
            ) : null}
            {waitingOnInput ? (
              <HumanInputCard
                requests={humanInput.requests}
                respondingRequestId={humanInput.respondingRequestId}
                error={humanInput.mutationError?.message}
                messages={humanInputMessages}
                renderMarkdown={timelineProps.renderMarkdown}
                onSubmit={(requestId, response) =>
                  humanInput.respond(requestId, response).then(() => undefined)
                }
              />
            ) : null}
            {trailing}
          </>
        }
      />
      {(renderComposer ?? renderSharedComposer)({
        floating: true,
        onHeightChange: (height) => setComposerHeight(Math.round(height)),
        onActionFeedback: composerSlots?.onActionFeedback,
        value: composer.value,
        onChangeText: composer.setValue,
        // A quote without its note cannot be sent: Send opens that note instead
        // of staying disabled with no reason given.
        onSend: () => {
          if (annotationsIncomplete) composer.requestAnnotationReview?.();
          else {
            followLatest();
            void composer.send();
          }
        },
        // The other choice beside Send while the agent works: Queue when
        // Send steers, Steer when Send queues.
        alternateSend: composer.alternateSend ?? null,
        ...(composer.sendAlternate
          ? {
              onAlternateSend: () => {
                if (annotationsIncomplete) {
                  composer.requestAnnotationReview?.();
                  return;
                }
                followLatest();
                void composer.sendAlternate?.();
              },
            }
          : {}),
        canSend: (composer.canSend || (annotationsIncomplete && !composer.sending)) && !busy,
        sending: composer.sending,
        running: controller.runActive,
        paused: paused,
        pauseBusy: composer.pausing || composer.resuming,
        onPause: () => void composer.pause(),
        onResume: () => void composer.resume(),
        onAttach: composerSlots?.onAttach ?? (() => void attachments.pickImages()),
        onPasteImages: (files) => void attachments.addFiles(files),
        renderLeading: composerSlots?.renderLeading,
        options: composerSlots?.options,
        placeholder: composerSlots?.placeholder,
        bottomInset: bottomInset,
        keyboardBottomOffset: keyboardBottomOffset,
        inputRef: composerInput,
        messages: composerSlots?.messages,
        voice: composerSlots?.voice,
        call: composerSlots?.call,
        below: composer.draftConflict ? (
          <DraftConflictStrip
            messages={composerSlots?.messages}
            onResolve={(choice) => void composer.resolveDraftConflict(choice)}
          />
        ) : null,
        header: (
          <>
            {composerSlots?.header}
            <AttachmentChips
              attachments={attachments}
              restoredResources={composer.restoredResources}
              onRemoveRestoredResource={composer.removeRestoredResource}
              fileSource={composer.fileSource}
            />
            {draftAnnotations.length > 0 && composer.removeAnnotation ? (
              <View style={{ paddingHorizontal: 12, paddingTop: 10 }}>
                <AnnotationsChip
                  annotations={draftAnnotations}
                  onPress={() => composer.requestAnnotationReview?.()}
                  onClear={() => {
                    const removeAll = () => {
                      for (const annotation of draftAnnotations) {
                        composer.removeAnnotation?.(annotation.id);
                      }
                    };
                    // Bare quotes go at once; written notes are worth one confirm,
                    // since the × sits right beside the chip.
                    if (!draftAnnotations.some((item) => annotationHasNote(item.note))) {
                      removeAll();
                      return;
                    }
                    Alert.alert(
                      t("native.timeline.annotations.removeAllTitle", {
                        count: draftAnnotations.length,
                      }),
                      t("native.timeline.annotations.removeAllMessage", {
                        count: draftAnnotations.filter((item) => annotationHasNote(item.note))
                          .length,
                      }),
                      [
                        { text: t("native.timeline.annotations.cancel"), style: "cancel" },
                        {
                          text: t("native.timeline.annotations.removeAllConfirm"),
                          style: "destructive",
                          onPress: removeAll,
                        },
                      ],
                    );
                  }}
                />
              </View>
            ) : null}
          </>
        ),
        above: (
          <>
            <QueueDock
              queue={queue}
              composer={composer}
              singleSend={composer.singleSend === true}
              fileSource={composer.fileSource ?? attachments.fileSource}
              onComposerFocus={() => composerInput.current?.focus()}
              onReviewAnnotations={setQueuedReview}
              leading={
                signals.goal || signals.agents || signals.commands ? (
                  <SessionSignals
                    goal={signals.goal ? controller.goal : null}
                    agents={signals.agents ? (controller.lineage.lineage?.children ?? []) : []}
                    commandsCount={
                      signals.commands
                        ? (controller.session.session?.backgroundCommandActivity?.count ?? 0)
                        : 0
                    }
                    onOpenSession={timelineProps.onOpenSession}
                    models={models}
                    readOnly={status === "failed" || status === "cancelled" || controller.archived}
                    renderCommands={() =>
                      client ? (
                        <NativeSessionCommands
                          client={client}
                          workspaceId={controller.workspaceId}
                          sessionId={controller.sessionId}
                        />
                      ) : null
                    }
                  />
                ) : null
              }
            />
            {/* The pause's other approvals stay up while a decision resumes the turn. */}
            {approvals.length > 0 && approvalsDecidable(status) ? (
              <ApprovalStrip
                approvals={approvals}
                messages={approvalMessages}
                loadReview={approvalReviews}
                onDecide={(id, decision, answer) =>
                  (decision === "approve"
                    ? control.approve(id, undefined, answer)
                    : control.reject(id)
                  ).then(() => undefined)
                }
              />
            ) : null}
          </>
        ),
      })}
      <AnnotationsSheet
        open={reviewOpen}
        onClose={closeReview}
        annotations={draftAnnotations}
        editable={Boolean(composer.updateAnnotation)}
        focusId={reviewTargetId}
        onFocusConsumed={composer.clearAnnotationReviewTarget}
        onUpdate={composer.updateAnnotation}
        onRemove={composer.removeAnnotation}
        onReveal={(source, quote) => annotationReveal.current?.(source, quote) ?? false}
        onCommit={() => {
          closeReview();
          setTimeout(() => composerInput.current?.focus(), 250);
        }}
      />
      <AnnotationsSheet
        open={queuedReview !== null}
        onClose={() => setQueuedReview(null)}
        annotations={queuedReview ?? []}
        editable={false}
        onReveal={(source, quote) => annotationReveal.current?.(source, quote) ?? false}
      />
    </View>
  );
}

/**
 * A failed session stream retries with backoff (1s doubling to 30s) while the
 * screen is active, so a transient API outage recovers without a relaunch.
 */
function useAutoRecover(failed: boolean, live: boolean, refresh: () => Promise<void>) {
  const delay = useRef(1_000);
  useEffect(() => {
    // Only a live stream ends the outage; a retry briefly clears the error.
    if (live) delay.current = 1_000;
  }, [live]);
  useEffect(() => {
    if (!failed) return;
    const timer = setTimeout(() => {
      delay.current = Math.min(delay.current * 2, 30_000);
      void refresh();
    }, delay.current);
    return () => clearTimeout(timer);
  }, [failed, refresh]);
}

/** Transport failures read as a connection problem, never as a native stack. */
function loadFailureMessage(error: Error | null, connectionFailed: string): string | undefined {
  if (!error) return undefined;
  if (
    error.name === "TypeError" ||
    /fetch failed|network request failed|could not connect|offline|timed out/i.test(error.message)
  ) {
    return connectionFailed;
  }
  return error.message;
}

function LoadFailure({ message, onRetry }: { message?: string | undefined; onRetry: () => void }) {
  const theme = useNativeTimelineTheme();
  const m = useNativeTimelineMessages();
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 10, padding: 24 }}>
      <Icon name="circle-alert" size={20} color={theme.colors["status-failed"]} />
      <Text style={{ ...fontStyle(theme, 500), fontSize: 15, color: theme.colors.fg }}>
        {m.loadFailedTitle}
      </Text>
      {message ? (
        <Text
          style={{
            ...fontStyle(theme),
            fontSize: 13,
            lineHeight: 18,
            color: theme.colors["fg-muted"],
            textAlign: "center",
          }}
        >
          {message}
        </Text>
      ) : null}
      <Button label={m.retry} onPress={onRetry} />
    </View>
  );
}

/**
 * The runtime could not start this session's next step. It says what is
 * blocking it plainly; the kept work starts by itself once that is fixed. The
 * machine's owner can allow it here, and an unknown failure offers Try again.
 */
function StuckCard({
  session,
  client,
  workspaceId,
  busy,
  onSessionChanged,
}: {
  session: Session;
  client: OpenGeniNativeSessionController<ChatClient>["client"];
  workspaceId: string;
  busy: boolean;
  onSessionChanged: () => Promise<void>;
}) {
  const theme = useNativeTimelineTheme();
  const m = useNativeTimelineMessages();
  const t = useOpenGeniText();
  // The same state as the web notice: why the saved message didn't start, the
  // machines this person may move the chat to, and the one action that fixes it.
  const start = useSessionStart({ session, onSessionChanged, client, workspaceId });
  const [failed, setFailed] = useState(false);
  // The recheck is one fenced Resume outside the session control runner, so
  // the card holds its own pending state: busy while it runs, and a second tap
  // before the first settles sends nothing (as the web notice does).
  const [rechecking, setRechecking] = useState(false);
  const recheckPending = useRef(false);
  const [moving, setMoving] = useState<string | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const c = theme.colors;
  const reason = start.reason;
  const machine =
    start.needsDifferentMachine && start.machineAccess
      ? personalMachineCopy(t, start.machineAccess, { queued: true })
      : null;
  // The person's own saved message was approved for another of their
  // machines: name it and offer to run it there; a recheck can't help here.
  const approvedTarget = start.approvedMachines[0] ?? null;
  const approved =
    !machine && start.approvedElsewhere && start.machineAccess
      ? sessionAdmissionApprovedElsewhereCopy(t, start.machineAccess, approvedTarget)
      : null;
  const runOnApprovedMachine = start.runOnApprovedMachine;
  // The web notice's words for the known refusal; the native stuck copy when
  // the block is only known from its status event. Most refusals start by
  // themselves once fixed, so they offer no button; the machine's owner gets
  // Allow for this chat, and only an unknown failure gets Try again.
  const paused = session.effectiveControl.state === "paused";
  const copy = reason
    ? start.needsMachineAccess && start.machineAccess
      ? sessionAdmissionMachineAccessCopy(t, start.machineAccess, {
          canAllowHere: start.allowMachine !== undefined,
          paused,
          shared: session.tenancy?.visibility === "workspace",
        })
      : sessionAdmissionCopy(t, reason)
    : null;
  const allowing = start.needsMachineAccess && start.machineAccess?.isOwner === true;
  const actionLabel = !copy
    ? paused
      ? null
      : m.stuckRetry
    : allowing
      ? start.allowMachine
        ? copy.action
        : null
      : copy.action && !paused
        ? copy.action
        : null;
  const runAction = allowing ? start.allowMachine : start.recheck;
  const tone =
    approved || (copy && (copy.action === null || allowing))
      ? c["status-waiting"]
      : c["status-failed"];
  const textStyle = { ...fontStyle(theme), fontSize: 14, lineHeight: 20, color: c["fg-muted"] };
  return (
    <View
      accessibilityRole="summary"
      style={{
        gap: 10,
        padding: 14,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: withAlpha(tone, 0.3),
        backgroundColor: withAlpha(tone, 0.08),
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Icon name={approved ? "clock-3" : "circle-alert"} size={16} color={tone} />
        <Text style={{ ...fontStyle(theme, 600), fontSize: 15, color: c.fg, flexShrink: 1 }}>
          {machine
            ? t("sessionAdmission.needsDifferentMachineTitle")
            : (approved?.title ?? copy?.title ?? m.stuckTitle)}
        </Text>
      </View>
      {approved ? (
        <>
          <Text style={textStyle}>{approved.body}</Text>
          <Text style={textStyle}>{approved.next}</Text>
          {session.effectiveControl.state === "paused" ? (
            <Text style={textStyle}>{t("sessionAdmission.pausedNote")}</Text>
          ) : approved.action && approvedTarget && runOnApprovedMachine ? (
            <Button
              label={rechecking ? t("sessionAdmission.moving") : approved.action}
              variant="primary"
              busy={busy || rechecking}
              disabled={busy || rechecking}
              style={{ alignSelf: "flex-start" }}
              onPress={() => {
                if (recheckPending.current) return;
                recheckPending.current = true;
                setRechecking(true);
                setFailed(false);
                setMoveError(null);
                runOnApprovedMachine(approvedTarget.sandboxId)
                  .then(setMoveError, () => setFailed(true))
                  .finally(() => {
                    recheckPending.current = false;
                    setRechecking(false);
                  });
              }}
            />
          ) : null}
          {moveError ? (
            <Text
              accessibilityLiveRegion="polite"
              style={{ ...fontStyle(theme), fontSize: 13, color: c["status-failed"] }}
            >
              {start.machineChoiceError || moveError}
            </Text>
          ) : null}
        </>
      ) : machine ? (
        <>
          <Text style={textStyle}>{machine.explanation}</Text>
          <Text style={textStyle}>{machine.next}</Text>
          {start.canChooseMachine ? (
            <View
              style={{ gap: 6 }}
              accessibilityLabel={t("sessionAdmission.chooseAMachineForThisChat")}
            >
              {start.machineChoices.length === 0 ? (
                <Text style={textStyle}>{t("sessionAdmission.noMachineChoices")}</Text>
              ) : (
                start.machineChoices.map((choice) => (
                  <Button
                    key={choice.sandboxId}
                    label={
                      moving === choice.sandboxId
                        ? t("sessionAdmission.moving")
                        : machineDisplayName(t, choice)
                    }
                    busy={moving === choice.sandboxId}
                    disabled={busy || moving !== null}
                    style={{ alignSelf: "stretch" }}
                    onPress={() => {
                      setMoving(choice.sandboxId);
                      setMoveError(null);
                      start
                        .chooseMachine(choice)
                        .then(setMoveError, () =>
                          setMoveError(t("sessionAdmission.machineChangeFailed")),
                        )
                        .finally(() => setMoving(null));
                    }}
                  />
                ))
              )}
              <Text style={{ ...textStyle, fontSize: 13 }}>
                {t("sessionAdmission.savedMessageMachineNote")}
              </Text>
            </View>
          ) : null}
          {moveError ? (
            <Text
              accessibilityLiveRegion="polite"
              style={{ ...fontStyle(theme), fontSize: 13, color: c["status-failed"] }}
            >
              {start.machineChoiceError || moveError}
            </Text>
          ) : null}
        </>
      ) : copy ? (
        <>
          <Text style={textStyle}>{copy.body}</Text>
          <Text style={textStyle}>{copy.next}</Text>
          {/* The owner's own words already say it starts once resumed. */}
          {paused && !allowing ? (
            <Text style={textStyle}>{t("sessionAdmission.pausedNote")}</Text>
          ) : null}
        </>
      ) : (
        <Text style={textStyle}>{m.stuckBody}</Text>
      )}
      {failed ? (
        <Text
          accessibilityLiveRegion="polite"
          style={{
            ...fontStyle(theme),
            fontSize: 13,
            color: c["status-failed"],
          }}
        >
          {allowing ? t("sessionAdmission.allowFailed") : m.stuckRetryFailed}
        </Text>
      ) : null}
      {machine || approved || actionLabel === null || !runAction ? null : (
        <Button
          label={actionLabel}
          variant="primary"
          busy={busy || rechecking}
          disabled={busy || rechecking}
          style={{ alignSelf: "flex-start" }}
          onPress={() => {
            if (recheckPending.current) return;
            recheckPending.current = true;
            setRechecking(true);
            setFailed(false);
            runAction()
              .catch(() => setFailed(true))
              .finally(() => {
                recheckPending.current = false;
                setRechecking(false);
              });
          }}
        />
      )}
    </View>
  );
}

/**
 * Composer attachment chips: name, upload state, tap to retry a failure,
 * remove. Images show as pictures, loaded from the server when there is no
 * local photo (a restored draft, another device). `restoredResources` are
 * files restored into the composer from a saved draft.
 */
export function AttachmentChips({
  attachments,
  restoredResources,
  onRemoveRestoredResource,
  fileSource,
}: {
  attachments: NativeFileAttachmentsResult;
  restoredResources?: readonly ResourceRef[] | undefined;
  onRemoveRestoredResource?: ((index: number) => void) | undefined;
  /** Where stored files are read from; defaults to the attachments' own chat. */
  fileSource?: StoredFileSource | undefined;
}) {
  const t = useOpenGeniText();
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const source = fileSource ?? attachments.fileSource;
  const items = useNativeComposerAttachments(
    source,
    attachments.attachments,
    onRemoveRestoredResource ? restoredResources : undefined,
  );
  const remove = (item: NativeComposerAttachment) =>
    item.restoredIndex === undefined
      ? attachments.remove(item.id)
      : onRemoveRestoredResource?.(item.restoredIndex);
  if (items.length === 0) return null;
  return (
    <View
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        gap: 6,
        paddingHorizontal: 12,
        paddingTop: 10,
      }}
    >
      {items.map((item) => {
        const failed = item.status === "failed";
        const busy = item.status === "uploading" || item.status === "preparing";
        if (item.kind === "image" && (item.previewUri || item.file)) {
          // Photos show as photos, as on the web: a thumbnail with its state on top.
          return (
            <View key={item.id} style={{ width: 56, height: 56 }}>
              <Pressable
                accessibilityRole={failed ? "button" : "image"}
                accessibilityLabel={
                  failed
                    ? t("native.timeline.sessionScreen.retryName", { name: item.name })
                    : item.name
                }
                disabled={!failed}
                onPress={() => void attachments.retry(item.id)}
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: theme.radius.md,
                  overflow: "hidden",
                  borderWidth: 1,
                  borderColor: failed ? withAlpha(c["status-failed"], 0.6) : c.border,
                  backgroundColor: c["surface-2"],
                }}
              >
                <StoredFileImage
                  source={source}
                  file={item.file}
                  localUri={item.previewUri}
                  style={{ width: "100%", height: "100%" }}
                  fallback={
                    <View
                      style={{
                        flex: 1,
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <Icon name="image" size={18} color={c["fg-subtle"]} />
                    </View>
                  }
                />
                {busy || failed ? (
                  <View
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      right: 0,
                      bottom: 0,
                      alignItems: "center",
                      justifyContent: "center",
                      backgroundColor: failed
                        ? withAlpha(c["status-failed"], 0.35)
                        : "rgba(0,0,0,0.35)",
                    }}
                  >
                    {busy ? (
                      <ActivityIndicator size="small" color="#FFFFFF" />
                    ) : (
                      <Icon name="rotate-ccw" size={16} color="#FFFFFF" />
                    )}
                  </View>
                ) : null}
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("native.timeline.sessionScreen.removeName", {
                  name: item.name,
                })}
                onPress={() => remove(item)}
                hitSlop={8}
                style={{
                  position: "absolute",
                  top: -6,
                  right: -6,
                  width: 20,
                  height: 20,
                  borderRadius: 10,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: c.fg,
                  borderWidth: 1.5,
                  borderColor: c["surface-1"],
                }}
              >
                <Icon name="x" size={10} color={c.bg} />
              </Pressable>
            </View>
          );
        }
        return (
          <View
            key={item.id}
            style={{
              flexDirection: "row",
              alignItems: "center",
              borderRadius: theme.radius.sm,
              borderWidth: 1,
              borderColor: failed ? withAlpha(c["status-failed"], 0.4) : c.border,
              paddingLeft: 8,
              backgroundColor: c["surface-2"],
            }}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                failed
                  ? t("native.timeline.sessionScreen.retryName", { name: item.name })
                  : item.name
              }
              disabled={!failed}
              onPress={() => void attachments.retry(item.id)}
              style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 4 }}
            >
              {busy ? <ActivityIndicator size="small" color={c["fg-subtle"]} /> : null}
              <Text
                numberOfLines={1}
                style={{
                  ...fontStyle(theme),
                  maxWidth: 160,
                  fontSize: theme.size.xs,
                  color: failed ? c["status-failed"] : c["fg-muted"],
                }}
              >
                {item.name}
                {failed ? t("native.timeline.sessionScreen.tapToRetrySuffix") : ""}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("native.timeline.sessionScreen.removeName", {
                name: item.name,
              })}
              onPress={() => remove(item)}
              hitSlop={6}
              style={{ width: 28, height: 28, alignItems: "center", justifyContent: "center" }}
            >
              <Icon name="x" size={12} color={c["fg-subtle"]} />
            </Pressable>
          </View>
        );
      })}
    </View>
  );
}

/** The web composer's draft-conflict line: keep this device's draft or take the other. */
function DraftConflictStrip(props: {
  messages?: Partial<ChatComposerMessages> | undefined;
  onResolve: (choice: "keep_mine" | "use_remote") => void;
}) {
  const theme = useNativeTimelineTheme();
  const t = useOpenGeniText();
  const c = theme.colors;
  const messages = { ...defaultChatComposerMessages(t), ...props.messages };
  const text = { ...fontStyle(theme), fontSize: theme.size.xs, color: c["status-failed"] };
  return (
    <View
      accessibilityRole="alert"
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 8,
        paddingHorizontal: 16,
        paddingTop: 12,
      }}
    >
      <Text style={{ ...text, flexGrow: 1, flexShrink: 1, flexBasis: 180 }}>
        {messages.draftConflict}
      </Text>
      <Pressable
        accessibilityRole="button"
        hitSlop={10}
        onPress={() => props.onResolve("use_remote")}
      >
        <Text style={{ ...text, textDecorationLine: "underline" }}>{messages.useOtherDraft}</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        hitSlop={10}
        onPress={() => props.onResolve("keep_mine")}
      >
        <Text
          style={{
            ...text,
            ...fontStyle(theme, 500),
            color: c["status-failed"],
            textDecorationLine: "underline",
          }}
        >
          {messages.keepMine}
        </Text>
      </Pressable>
    </View>
  );
}

/** Polls the session's commands only while the panel is open, as web does. */
function NativeSessionCommands(props: {
  client: ChatClient<OpenGeniClient>;
  workspaceId: string;
  sessionId: string;
}) {
  const { client, workspaceId, sessionId } = props;
  const [commands, setCommands] = useState<SessionBackgroundCommand[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const load = useCallback(async () => {
    try {
      const response = await client.listSessionBackgroundCommands(workspaceId, sessionId);
      setCommands(response.commands);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error(String(cause)));
    } finally {
      setLoading(false);
    }
  }, [client, sessionId, workspaceId]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 3_000);
    return () => clearInterval(timer);
  }, [load]);
  const cancel = useCallback(
    async (commandId: string) => {
      await client.cancelSessionBackgroundCommand(workspaceId, sessionId, commandId);
      await load();
    },
    [client, load, sessionId, workspaceId],
  );
  return <SessionCommandsList commands={{ commands, loading, error, cancel }} />;
}

function renderSharedComposer(props: SessionComposerProps): ReactNode {
  return <SessionComposer {...props} />;
}
