import {
  conversationTimeline,
  type AgentMessageItem,
  type UserMessageItem,
} from "@opengeni/react/session";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentRef,
  type ReactNode,
} from "react";
import { ActivityIndicator, Pressable, Text, View, type TextInput } from "react-native";
import {
  defaultChatComposerMessages,
  type ChatComposerMessages,
} from "@opengeni/react/composer-messages";
import { Icon } from "./icon";
import { withAlpha } from "./primitives";
import type { OpenGeniNativeSessionController } from "../use-native-session";
import type { NativeFileAttachmentsResult } from "../attachments";
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
import { SessionCommandsList, SessionSignals } from "./session-signals";
import type { ClientModel, OpenGeniClient, SessionBackgroundCommand } from "@opengeni/sdk";
import { MessageTimeline, type NativeMessageTimelineProps } from "./message-timeline";
import { fontStyle, useNativeTimelineTheme } from "./theme";

/* ----------------------------------------------------------------------------
   The web session page body at phone width: timeline (with the question card
   as its trailing state), the live approval strip and the composer, driven by
   the shared session controller. Navigation chrome belongs to the host.
   -------------------------------------------------------------------------- */

export interface NativeSessionScreenProps extends Omit<
  NativeMessageTimelineProps,
  "items" | "events" | "status" | "trailing"
> {
  controller: OpenGeniNativeSessionController;
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
  /** Reads the commands panel (the full client; omit to hide command details). */
  client?: OpenGeniClient | undefined;
  /** Model catalog for the agents panel rows. */
  models?: readonly ClientModel[] | undefined;
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
  client,
  models,
  renderMessageActions: hostMessageActions,
  ...timelineProps
}: NativeSessionScreenProps) {
  const theme = useNativeTimelineTheme();
  const { composer, queue, humanInput, approvals, control, attachments } = controller;
  const composerInput = useRef<ComponentRef<typeof TextInput>>(null);
  // The composer floats over the conversation; its occupied height insets the timeline.
  const [composerHeight, setComposerHeight] = useState(120);
  const items = useMemo(
    () => conversationTimeline(controller.timeline, queue, composer),
    [controller.timeline, queue, composer],
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
        {...timelineProps}
        hasOlder={controller.hasOlder}
        loadingOlder={controller.loadingOlder}
        onLoadOlder={controller.loadOlder}
        contentInsetBottom={composerHeight + 20}
        overlayInsetBottom={composerHeight}
        renderMessageActions={feedback || hostMessageActions ? renderMessageActions : undefined}
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
        status={status}
        emptyState={
          empty && failed ? (
            <LoadFailure
              message={loadFailureMessage(controller.error)}
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
            {waitingOnInput ? (
              <HumanInputCard
                requests={humanInput.requests}
                respondingRequestId={humanInput.respondingRequestId}
                error={humanInput.mutationError?.message}
                messages={humanInputMessages}
                onSubmit={(requestId, response) =>
                  humanInput.respond(requestId, response).then(() => undefined)
                }
              />
            ) : null}
            {trailing}
          </>
        }
      />
      <SessionComposer
        floating
        onHeightChange={(height) => setComposerHeight(Math.round(height))}
        onActionFeedback={composerSlots?.onActionFeedback}
        value={composer.value}
        onChangeText={composer.setValue}
        onSend={() => void composer.send()}
        canSend={composer.canSend && !busy}
        sending={composer.sending}
        running={controller.runActive}
        paused={paused}
        pauseBusy={composer.pausing || composer.resuming}
        onPause={() => void composer.pause()}
        onResume={() => void composer.resume()}
        onAttach={composerSlots?.onAttach ?? (() => void attachments.pickImages())}
        renderLeading={composerSlots?.renderLeading}
        options={composerSlots?.options}
        placeholder={composerSlots?.placeholder}
        bottomInset={bottomInset}
        keyboardBottomOffset={keyboardBottomOffset}
        inputRef={composerInput}
        messages={composerSlots?.messages}
        voice={composerSlots?.voice}
        below={
          composer.draftConflict ? (
            <DraftConflictStrip
              messages={composerSlots?.messages}
              onResolve={(choice) => void composer.resolveDraftConflict(choice)}
            />
          ) : null
        }
        header={
          <>
            {composerSlots?.header}
            <AttachmentChips attachments={attachments} />
          </>
        }
        above={
          <>
            <QueueDock
              queue={queue}
              composer={composer}
              onComposerFocus={() => composerInput.current?.focus()}
              leading={
                <SessionSignals
                  goal={controller.goal}
                  agents={controller.lineage.lineage?.children ?? []}
                  commandsCount={controller.session.session?.backgroundCommandActivity?.count ?? 0}
                  onOpenSession={timelineProps.onOpenSession}
                  models={models}
                  readOnly={status === "failed" || status === "cancelled"}
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
              }
            />
            {approvals.length > 0 && status === "requires_action" ? (
              <ApprovalStrip
                approvals={approvals}
                messages={approvalMessages}
                onDecide={(id, decision) =>
                  (decision === "approve" ? control.approve(id) : control.reject(id)).then(
                    () => undefined,
                  )
                }
              />
            ) : null}
          </>
        }
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
function loadFailureMessage(error: Error | null): string | undefined {
  if (!error) return undefined;
  if (
    error.name === "TypeError" ||
    /fetch failed|network request failed|could not connect|offline|timed out/i.test(error.message)
  ) {
    return "Couldn't connect. Check your connection; this retries automatically.";
  }
  return error.message;
}

function LoadFailure({ message, onRetry }: { message?: string | undefined; onRetry: () => void }) {
  const theme = useNativeTimelineTheme();
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 10, padding: 24 }}>
      <Icon name="circle-alert" size={20} color={theme.colors["status-failed"]} />
      <Text style={{ ...fontStyle(theme, 500), fontSize: 15, color: theme.colors.fg }}>
        Couldn't load this session
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
      <Button label="Retry" onPress={onRetry} />
    </View>
  );
}

/** Composer attachment chips: name, upload state, tap to retry a failure, remove. */
export function AttachmentChips({ attachments }: { attachments: NativeFileAttachmentsResult }) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  if (attachments.attachments.length === 0) return null;
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
      {attachments.attachments.map((item) => {
        const failed = item.status === "failed";
        const busy = item.status === "uploading" || item.status === "preparing";
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
              accessibilityLabel={failed ? `Retry ${item.name}` : item.name}
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
                {failed ? " · tap to retry" : ""}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Remove ${item.name}`}
              onPress={() => attachments.remove(item.id)}
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
  const c = theme.colors;
  const messages = { ...defaultChatComposerMessages, ...props.messages };
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
  client: OpenGeniClient;
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
