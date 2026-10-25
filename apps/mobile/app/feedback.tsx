/**
 * Send feedback: what the person writes, the screenshot of the screen they were
 * on (shown so they can remove it) and a plain note of what else goes with it.
 * Send saves the report on the device first, so it is never lost offline.
 */
import { fontStyle, useNativeTimelineTheme } from "@opengeni/react-native/timeline";
import * as Crypto from "expo-crypto";
import * as Haptics from "expo-haptics";
import { Stack, router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { useAccount } from "@/account";
import { collectFeedbackContext } from "@/feedback/context";
import { feedbackDraftStore, useFeedbackDraft } from "@/feedback/draft";
import { feedbackOutbox, readFeedbackImage } from "@/feedback/outbox";
import { AppThemeProvider } from "@/theme";

/** How long Send waits for the server before saying the report will go out later. */
const SEND_WAIT_MS = 8000;
const COMMENT_MAX = 4000;

export default function FeedbackScreen() {
  return (
    <AppThemeProvider>
      <Stack.Screen options={{ headerShown: false, presentation: "modal" }} />
      <Feedback />
    </AppThemeProvider>
  );
}

function Feedback() {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const draft = useFeedbackDraft();
  const { account, workspaceId } = useAccount();
  const [comment, setComment] = useState("");
  const [sending, setSending] = useState(false);
  const sent = useRef(false);

  // The draft ends with this screen, however it is closed (Cancel, Send or a swipe down).
  useEffect(() => () => feedbackDraftStore.close(), []);

  const close = () => {
    if (router.canGoBack()) router.back();
  };

  const cancel = () => {
    if (sending) return;
    if (!comment.trim()) {
      close();
      return;
    }
    Alert.alert("Discard this feedback?", undefined, [
      { text: "Keep writing", style: "cancel" },
      { text: "Discard", style: "destructive", onPress: close },
    ]);
  };

  const send = async () => {
    const text = comment.trim();
    if (!draft || !account || !workspaceId || !text || sending || sent.current) return;
    setSending(true);
    try {
      const screenshots = [];
      for (const image of draft.images) {
        const base64 = await readFeedbackImage(image.uri);
        if (base64) screenshots.push({ contentType: image.contentType, base64 });
      }
      const delivery = feedbackOutbox.submit(account.id, workspaceId, {
        idempotencyKey: Crypto.randomUUID(),
        comment: text.slice(0, COMMENT_MAX),
        context: collectFeedbackContext({ trigger: draft.trigger, screen: draft.screen }),
        ...(screenshots.length ? { screenshots } : {}),
      });
      // The report is on the device once submit has written it; waiting past that is optional.
      const outcome = await Promise.race([
        delivery.then((result) => (result.pending === 0 ? "sent" : "queued")),
        new Promise<"queued">((resolve) => setTimeout(() => resolve("queued"), SEND_WAIT_MS)),
      ]);
      sent.current = true;
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
        () => undefined,
      );
      close();
      Alert.alert(
        "Thanks for the feedback",
        outcome === "sent"
          ? "It's on its way."
          : "It's saved on this phone and will be sent as soon as there's a connection.",
      );
    } catch {
      setSending(false);
      Alert.alert("Couldn't save your feedback", "Try sending it again.");
    }
  };

  const canSend = Boolean(comment.trim()) && !sending && Boolean(draft);
  const images = draft?.images ?? [];
  const label = { ...fontStyle(theme), fontSize: 17, lineHeight: 22 };
  const note = { ...fontStyle(theme), fontSize: 13, lineHeight: 18, color: c["fg-muted"] };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: c.bg }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingHorizontal: 16,
          paddingTop: 14,
          paddingBottom: 10,
        }}
      >
        <Pressable
          accessibilityRole="button"
          disabled={sending}
          hitSlop={12}
          onPress={cancel}
          testID="feedback-cancel"
        >
          <Text style={{ ...label, color: sending ? c["fg-subtle"] : c.fg }}>Cancel</Text>
        </Pressable>
        <Text
          accessibilityRole="header"
          style={{ ...label, ...fontStyle(theme, 600), color: c.fg }}
        >
          Send feedback
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: !canSend, busy: sending }}
          disabled={!canSend}
          hitSlop={12}
          onPress={() => void send()}
          testID="feedback-send"
        >
          {sending ? (
            <ActivityIndicator />
          ) : (
            <Text
              style={{ ...label, ...fontStyle(theme, 600), color: canSend ? c.fg : c["fg-subtle"] }}
            >
              Send
            </Text>
          )}
        </Pressable>
      </View>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32, gap: 20 }}
      >
        <TextInput
          accessibilityLabel="Your feedback"
          autoFocus
          editable={!sending}
          maxLength={COMMENT_MAX}
          multiline
          onChangeText={setComment}
          placeholder="What happened, or what would make this better?"
          placeholderTextColor={c["fg-subtle"]}
          style={{
            ...fontStyle(theme),
            minHeight: 140,
            padding: 12,
            borderRadius: theme.radius.md,
            borderWidth: 1,
            borderColor: c.border,
            backgroundColor: c["surface-1"],
            fontSize: 16,
            lineHeight: 22,
            color: c.fg,
            textAlignVertical: "top",
          }}
          testID="feedback-comment"
          value={comment}
        />
        {images.length > 0 ? (
          <View style={{ gap: 8 }}>
            <Text style={note}>Screenshot</Text>
            <View style={{ flexDirection: "row", gap: 12 }}>
              {images.map((image) => (
                <View key={image.key}>
                  <Image
                    accessibilityLabel="Screenshot of the screen you were on"
                    source={{ uri: image.uri }}
                    style={{
                      width: 96,
                      height: Math.round((96 * image.height) / Math.max(image.width, 1)),
                      borderRadius: theme.radius.md,
                      borderWidth: 1,
                      borderColor: c.border,
                    }}
                  />
                  <Pressable
                    accessibilityLabel="Remove screenshot"
                    accessibilityRole="button"
                    disabled={sending}
                    hitSlop={10}
                    onPress={() => feedbackDraftStore.removeImage(image.key)}
                    style={{
                      position: "absolute",
                      top: -8,
                      right: -8,
                      width: 24,
                      height: 24,
                      borderRadius: 12,
                      alignItems: "center",
                      justifyContent: "center",
                      backgroundColor: c.fg,
                    }}
                    testID="feedback-remove-screenshot"
                  >
                    <Text style={{ ...fontStyle(theme, 600), color: c.bg, fontSize: 13 }}>✕</Text>
                  </Pressable>
                </View>
              ))}
            </View>
          </View>
        ) : null}
        <Text style={note}>
          {images.length > 0 ? "Sent with the screenshot: " : "Sent with your feedback: "}
          the screen you were on, the app version, your phone model and system version, and recent
          errors.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
