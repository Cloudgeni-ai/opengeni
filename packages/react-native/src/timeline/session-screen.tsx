import { conversationTimeline } from "@opengeni/react/session";
import { useMemo, type ReactNode } from "react";
import { KeyboardAvoidingView, Platform, Text, View } from "react-native";
import type { OpenGeniNativeSessionController } from "../use-native-session";
import { SessionComposer, type SessionComposerProps } from "./composer";
import { ApprovalStrip, HumanInputCard } from "./decisions";
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
  bottomInset?: number | undefined;
  keyboardVerticalOffset?: number | undefined;
}

export function NativeSessionScreen({
  controller,
  composer: composerSlots,
  trailing,
  bottomInset,
  keyboardVerticalOffset,
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
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: theme.colors.bg }}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      keyboardVerticalOffset={keyboardVerticalOffset ?? 0}
    >
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
        header={
          <>
            {composerSlots?.header}
            {attachments.attachments.length > 0 ? (
              <View
                style={{
                  flexDirection: "row",
                  flexWrap: "wrap",
                  gap: 6,
                  paddingHorizontal: 12,
                  paddingTop: 10,
                }}
              >
                {attachments.attachments.map((item) => (
                  <View
                    key={item.id}
                    style={{
                      borderRadius: theme.radius.sm,
                      borderWidth: 1,
                      borderColor: theme.colors.border,
                      paddingHorizontal: 8,
                      paddingVertical: 4,
                      backgroundColor: theme.colors["surface-2"],
                    }}
                  >
                    <Text
                      numberOfLines={1}
                      style={{
                        ...fontStyle(theme),
                        maxWidth: 160,
                        fontSize: theme.size.xs,
                        color: theme.colors["fg-muted"],
                      }}
                    >
                      {item.name}
                      {item.status === "uploading" || item.status === "preparing"
                        ? " · uploading"
                        : item.status === "failed"
                          ? " · failed"
                          : ""}
                    </Text>
                  </View>
                ))}
              </View>
            ) : null}
          </>
        }
        above={
          approvals.length > 0 && status === "requires_action" ? (
            <ApprovalStrip
              approvals={approvals}
              onDecide={(id, decision) =>
                (decision === "approve" ? control.approve(id) : control.reject(id)).then(
                  () => undefined,
                )
              }
            />
          ) : null
        }
      />
    </KeyboardAvoidingView>
  );
}
