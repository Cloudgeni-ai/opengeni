import {
  conversationTimeline,
  type AgentMessageItem,
  type UserMessageItem,
} from "@opengeni/react/session";
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { Icon } from "./icon";
import { withAlpha } from "./primitives";
import type { OpenGeniNativeSessionController } from "../use-native-session";
import { SessionComposer, type SessionComposerProps } from "./composer";
import { TurnFeedbackButtons, useTurnRatings, type TurnFeedbackTarget } from "./feedback";
import { Button } from "./controls";
import { ApprovalStrip, HumanInputCard } from "./decisions";
import { QueueDock } from "./queue-dock";
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
          "renderLeading" | "options" | "header" | "placeholder" | "onAttach"
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
}

export function NativeSessionScreen({
  controller,
  composer: composerSlots,
  trailing,
  topBar,
  bottomInset,
  keyboardBottomOffset,
  feedback,
  renderMessageActions: hostMessageActions,
  ...timelineProps
}: NativeSessionScreenProps) {
  const theme = useNativeTimelineTheme();
  const { composer, queue, humanInput, approvals, control, attachments } = controller;
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
        renderMessageActions={feedback || hostMessageActions ? renderMessageActions : undefined}
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
        header={
          <>
            {composerSlots?.header}
            <AttachmentChips attachments={attachments} />
          </>
        }
        above={
          <>
            <QueueDock queue={queue} />
            {approvals.length > 0 && status === "requires_action" ? (
              <ApprovalStrip
                approvals={approvals}
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
    return "OpenGeni couldn't be reached. Check your connection; this retries automatically.";
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
function AttachmentChips({
  attachments,
}: {
  attachments: OpenGeniNativeSessionController["attachments"];
}) {
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
