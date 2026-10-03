import { compactModelPill } from "@opengeni/react/model-policy";
import { useOpenGeniNativeSession } from "@opengeni/react-native";
import {
  ComposerPill,
  NativeSessionScreen,
  useNativeTimelineTheme,
} from "@opengeni/react-native/timeline";
import { createWebMarkdownRenderer } from "@opengeni/react-native/timeline/markdown";
import { Stack, router, useLocalSearchParams } from "expo-router";
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
  // The web composer's phone-width pill: compact model name, effort when it is a choice.
  const pill = session?.model
    ? compactModelPill(props.models, session.model, session.reasoningEffort)
    : null;
  return (
    <>
      <Stack.Screen
        options={{
          title: session?.title ?? "",
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
        composer={{
          options: pill ? (
            <ComposerPill label={pill.effort ? `${pill.name} · ${pill.effort}` : pill.name} />
          ) : null,
        }}
      />
    </>
  );
}
