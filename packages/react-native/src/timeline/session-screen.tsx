import { conversationTimeline } from "@opengeni/react/session";
import { useMemo, type ReactNode } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { Icon } from "./icon";
import { withAlpha } from "./primitives";
import type { OpenGeniNativeSessionController } from "../use-native-session";
import { SessionComposer, type SessionComposerProps } from "./composer";
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
}

export function NativeSessionScreen({
  controller,
  composer: composerSlots,
  trailing,
  topBar,
  bottomInset,
  keyboardBottomOffset,
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
  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.bg }}>
      {topBar}
      <MessageTimeline
        {...timelineProps}
        items={items}
        status={status}
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
