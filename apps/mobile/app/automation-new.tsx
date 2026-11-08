/**
 * A new automation, the web's "Create with Opengeni" on the phone: say what
 * should happen and how often, and a chat finds the repositories, secrets
 * and integrations it needs and creates it, asking only for what it can't
 * find. The full form stays on the web.
 */
import { automationAgentOpeningMessage, viewerTimeZone } from "@opengeni/react/automation-model";
import { fontStyle, useNativeTimelineTheme } from "@opengeni/react-native/timeline";
import { Stack, router } from "expo-router";
import { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { useAccount } from "@/account";
import { rememberPendingPrompt } from "@/pending-prompt";
import { rememberSessionRow } from "@/session-list-cache";
import { AppThemeProvider } from "@/theme";

const REQUEST_MAX = 4000;

export default function NewAutomationScreen() {
  return (
    <AppThemeProvider>
      <Stack.Screen options={{ headerShown: false }} />
      <NewAutomation />
    </AppThemeProvider>
  );
}

function NewAutomation() {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const { client, workspaceId } = useAccount();
  const [request, setRequest] = useState("");
  const [starting, setStarting] = useState(false);

  const close = () => {
    if (router.canGoBack()) router.back();
  };

  const cancel = () => {
    if (starting) return;
    if (!request.trim()) {
      close();
      return;
    }
    Alert.alert("Discard this automation?", undefined, [
      { text: "Keep writing", style: "cancel" },
      { text: "Discard", style: "destructive", onPress: close },
    ]);
  };

  const start = async () => {
    const text = request.trim();
    if (!workspaceId || !text || starting) return;
    setStarting(true);
    const sentAt = new Date().toISOString();
    try {
      const message = automationAgentOpeningMessage(text, viewerTimeZone());
      const created = await client.createSession(workspaceId, { initialMessage: message });
      rememberPendingPrompt(client, workspaceId, created.id, { text: message, sentAt });
      rememberSessionRow(created, { created: true });
      // The sheet gives way to the chat, with Automations underneath.
      router.replace(`/session/${created.id}`);
    } catch (error) {
      setStarting(false);
      Alert.alert(
        "Couldn't start the chat",
        error instanceof Error ? error.message : "Try again in a moment.",
      );
    }
  };

  const canStart = Boolean(request.trim()) && !starting && Boolean(workspaceId);
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
          disabled={starting}
          hitSlop={12}
          onPress={cancel}
          testID="automation-new-cancel"
        >
          <Text style={{ ...label, color: starting ? c["fg-subtle"] : c.fg }}>Cancel</Text>
        </Pressable>
        <Text
          accessibilityRole="header"
          style={{ ...label, ...fontStyle(theme, 600), color: c.fg }}
        >
          New automation
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: !canStart, busy: starting }}
          disabled={!canStart}
          hitSlop={12}
          onPress={() => void start()}
          testID="automation-new-start"
        >
          {starting ? (
            <ActivityIndicator />
          ) : (
            <Text
              style={{
                ...label,
                ...fontStyle(theme, 600),
                color: canStart ? c.fg : c["fg-subtle"],
              }}
            >
              Start chat
            </Text>
          )}
        </Pressable>
      </View>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32, gap: 12 }}
      >
        <Text style={{ ...fontStyle(theme, 500), fontSize: 15, lineHeight: 20, color: c.fg }}>
          What should happen, and how often?
        </Text>
        <TextInput
          accessibilityLabel="What should happen, and how often?"
          autoFocus
          editable={!starting}
          maxLength={REQUEST_MAX}
          multiline
          onChangeText={setRequest}
          placeholder="Every weekday morning, summarize new Sentry errors and post them to #eng"
          placeholderTextColor={c["fg-subtle"]}
          style={{
            ...fontStyle(theme),
            minHeight: 120,
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
          testID="automation-new-request"
          value={request}
        />
        <Text style={note}>
          A chat finds the repositories, secrets and integrations it needs and creates the
          automation. It asks you only for what it can't find.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
