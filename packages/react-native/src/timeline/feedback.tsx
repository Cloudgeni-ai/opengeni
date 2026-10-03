import type { FeedbackSentiment } from "@opengeni/sdk";
import {
  feedbackDialogCopy,
  feedbackSentimentLabel,
  feedbackSubmission,
  loadSessionFeedback,
  turnRatingsFromFeedback,
  type FeedbackClient,
} from "@opengeni/react/session-feedback-model";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
} from "react-native";
import { Button } from "./controls";
import { Icon } from "./icon";
import { fontStyle, useNativeTimelineTheme } from "./theme";

/* ----------------------------------------------------------------------------
   Reply feedback, as the web timeline offers it beside Copy: thumbs up/down
   on a finished agent reply, an optional comment in a sheet, and the saved
   rating shown as pressed. The read, ratings and retry-safe submission are
   the shared session-feedback model.
   -------------------------------------------------------------------------- */

export interface TurnFeedbackTarget {
  client: FeedbackClient;
  workspaceId: string;
  sessionId: string;
}

/** Saved reply ratings for a session, loaded once with recovery. */
export function useTurnRatings(target: TurnFeedbackTarget | null | undefined) {
  const [ratings, setRatings] = useState<Record<string, FeedbackSentiment>>({});
  const client = target?.client;
  const workspaceId = target?.workspaceId;
  const sessionId = target?.sessionId;
  useEffect(() => {
    setRatings({});
    if (!client || !workspaceId || !sessionId) return;
    return loadSessionFeedback(client, workspaceId, sessionId, ({ feedback }) => {
      const loaded = turnRatingsFromFeedback(feedback);
      // Ratings given in this view win over the (older) loaded snapshot.
      setRatings((saved) => ({ ...loaded, ...saved }));
    });
  }, [client, workspaceId, sessionId]);
  const rate = useCallback((turnId: string, sentiment: FeedbackSentiment) => {
    setRatings((saved) => ({ ...saved, [turnId]: sentiment }));
  }, []);
  return { ratings, rate };
}

export function TurnFeedbackButtons(props: {
  target: TurnFeedbackTarget;
  turnId: string;
  saved: FeedbackSentiment | undefined;
  onRated: (sentiment: FeedbackSentiment) => void;
}) {
  const [choice, setChoice] = useState<FeedbackSentiment | null>(null);
  return (
    <>
      <Thumb
        sentiment="positive"
        pressed={props.saved === "positive"}
        onPress={() => setChoice("positive")}
      />
      <Thumb
        sentiment="negative"
        pressed={props.saved === "negative"}
        onPress={() => setChoice("negative")}
      />
      <FeedbackSheet
        target={props.target}
        turnId={props.turnId}
        sentiment={choice}
        onClose={() => setChoice(null)}
        onSubmitted={(sentiment) => {
          props.onRated(sentiment);
          setChoice(null);
        }}
      />
    </>
  );
}

function Thumb(props: { sentiment: FeedbackSentiment; pressed: boolean; onPress: () => void }) {
  const theme = useNativeTimelineTheme();
  const label = feedbackSentimentLabel(props.sentiment);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: props.pressed }}
      onPress={props.onPress}
      style={({ pressed }) => ({
        width: 44,
        height: 44,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: theme.radius.sm,
        backgroundColor: props.pressed || pressed ? theme.colors["surface-2"] : "transparent",
      })}
    >
      <Icon
        name={props.sentiment === "positive" ? "thumbs-up" : "thumbs-down"}
        size={14}
        color={props.pressed ? theme.colors.fg : theme.colors["fg-subtle"]}
      />
    </Pressable>
  );
}

/** The web feedback dialog as a native page sheet. */
export function FeedbackSheet(props: {
  target: TurnFeedbackTarget;
  turnId?: string | undefined;
  sentiment: FeedbackSentiment | null;
  onClose: () => void;
  onSubmitted: (sentiment: FeedbackSentiment) => void;
}) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<ReturnType<typeof feedbackSubmission> | null>(null);
  const copy = feedbackDialogCopy({ sessionId: props.target.sessionId, turnId: props.turnId });
  const open = props.sentiment !== null;
  const close = () => {
    if (busy) return;
    setError(null);
    props.onClose();
  };
  const submit = async () => {
    if (busy || !props.sentiment) return;
    pending.current = feedbackSubmission(
      {
        sessionId: props.target.sessionId,
        turnId: props.turnId,
        sentiment: props.sentiment,
        comment: comment || undefined,
      },
      pending.current,
      () => globalThis.crypto.randomUUID(),
    );
    setBusy(true);
    setError(null);
    try {
      await props.target.client.createFeedback(props.target.workspaceId, pending.current);
      pending.current = null;
      setComment("");
      props.onSubmitted(props.sentiment);
    } catch (caught) {
      const detail =
        caught instanceof Error && caught.message ? ` ${caught.message}` : " Try again.";
      setError(`Couldn't send feedback.${detail}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      visible={open}
      animationType="slide"
      presentationStyle={Platform.OS === "ios" ? "pageSheet" : undefined}
      transparent={Platform.OS !== "ios"}
      onRequestClose={close}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={{
          flex: 1,
          justifyContent: Platform.OS === "ios" ? "flex-start" : "flex-end",
          backgroundColor: Platform.OS === "ios" ? c.bg : "rgba(0, 0, 0, 0.4)",
        }}
      >
        <View
          style={{
            backgroundColor: c.bg,
            padding: 20,
            gap: 12,
            borderTopLeftRadius: Platform.OS === "ios" ? 0 : theme.radius.xl,
            borderTopRightRadius: Platform.OS === "ios" ? 0 : theme.radius.xl,
          }}
        >
          <Text
            accessibilityRole="header"
            style={{ ...fontStyle(theme, 600), fontSize: 17, color: c.fg }}
          >
            {copy.title}
          </Text>
          <Text style={{ ...fontStyle(theme), fontSize: 14, lineHeight: 20, color: c["fg-muted"] }}>
            {copy.description}
          </Text>
          {props.sentiment ? (
            <Text style={{ ...fontStyle(theme), fontSize: 14, color: c.fg }}>
              {feedbackSentimentLabel(props.sentiment)}
            </Text>
          ) : null}
          <Text style={{ ...fontStyle(theme, 500), fontSize: 13, color: c.fg }}>
            Comment (optional)
          </Text>
          <TextInput
            accessibilityLabel="Comment (optional)"
            value={comment}
            onChangeText={setComment}
            maxLength={4000}
            editable={!busy}
            multiline
            style={{
              ...fontStyle(theme),
              minHeight: 110,
              fontSize: 16,
              lineHeight: 22,
              color: c.fg,
              textAlignVertical: "top",
              padding: 12,
              borderRadius: theme.radius.md,
              borderWidth: 1,
              borderColor: c.border,
              backgroundColor: c["surface-1"],
            }}
          />
          {error ? (
            <Text
              accessibilityRole="alert"
              style={{ ...fontStyle(theme), fontSize: 13, color: c["status-failed"] }}
            >
              {error}
            </Text>
          ) : null}
          <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
            <Button label="Cancel" variant="ghost" onPress={close} disabled={busy} />
            <Button
              label={busy ? "Sending…" : "Send feedback"}
              variant="primary"
              onPress={() => void submit()}
              disabled={busy}
              busy={busy}
            />
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
