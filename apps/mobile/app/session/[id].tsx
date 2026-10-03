import { compactModelPill } from "@opengeni/react/model-policy";
import { useOpenGeniNativeSession } from "@opengeni/react-native";
import {
  ComposerPill,
  ModelMark,
  NativeSessionScreen,
  SessionStatusBadge,
  useNativeTimelineTheme,
} from "@opengeni/react-native/timeline";
import { createWebMarkdownRenderer } from "@opengeni/react-native/timeline/markdown";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAccount } from "@/account";
import { copyText } from "@/clipboard";
import { AppThemeProvider } from "@/theme";

const renderMarkdown = createWebMarkdownRenderer({ onCopy: (text) => void copyText(text) });

export default function SessionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { client, models, workspaceId } = useAccount();
  if (!workspaceId || !id) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <Text>No workspace selected</Text>
      </View>
    );
  }
  return (
    <AppThemeProvider>
      <LiveSession client={client} models={models} sessionId={id} workspaceId={workspaceId} />
    </AppThemeProvider>
  );
}

function LiveSession(props: {
  client: ReturnType<typeof useAccount>["client"];
  models: ReturnType<typeof useAccount>["models"];
  sessionId: string;
  workspaceId: string;
}) {
  const theme = useNativeTimelineTheme();
  const insets = useSafeAreaInsets();
  const controller = useOpenGeniNativeSession({
    client: props.client,
    sessionId: props.sessionId,
    workspaceId: props.workspaceId,
  });
  const session = controller.session.session;
  const feedback = useMemo(
    () => ({ client: props.client, workspaceId: props.workspaceId, sessionId: props.sessionId }),
    [props.client, props.workspaceId, props.sessionId],
  );
  // The web composer's phone-width pill: compact model name, effort when it is a choice.
  const pill = session?.model
    ? compactModelPill(props.models, session.model, session.reasoningEffort)
    : null;
  const status = controller.sessionStatus;
  const paused = controller.queue.effectiveControl?.state === "paused";
  // Web header: the status badge beside the title (a paused workstream says so).
  const headerRight = useCallback(
    () =>
      status ? (
        <AppThemeProvider>
          <SessionStatusBadge
            status={paused ? "queued" : status}
            label={paused ? "Paused" : undefined}
          />
        </AppThemeProvider>
      ) : null,
    [paused, status],
  );
  return (
    <>
      <Stack.Screen
        options={{
          title: session?.title ?? "",
          headerRight,
          headerStyle: { backgroundColor: theme.colors.bg },
          headerTintColor: theme.colors.fg,
          headerShadowVisible: false,
        }}
      />
      <NativeSessionScreen
        controller={controller}
        renderMarkdown={renderMarkdown}
        onCopy={(text) => void copyText(text)}
        onOpenSession={(sessionId) => router.push(`/session/${sessionId}`)}
        bottomInset={insets.bottom}
        feedback={feedback}
        composer={{
          options: pill ? (
            <ComposerPill
              label={pill.effort ? `${pill.name} · ${pill.effort}` : pill.name}
              leading={<ModelMark model={session?.model ?? ""} size={14} color={theme.colors.fg} />}
            />
          ) : null,
        }}
      />
    </>
  );
}
