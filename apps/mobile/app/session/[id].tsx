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
  const { client, workspaceId } = useAccount();
  if (!workspaceId || !id) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <Text>No workspace selected</Text>
      </View>
    );
  }
  return (
    <AppThemeProvider>
      <LiveSession client={client} sessionId={id} workspaceId={workspaceId} />
    </AppThemeProvider>
  );
}

function LiveSession(props: {
  client: ReturnType<typeof useAccount>["client"];
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
  const model = typeof session?.metadata?.model === "string" ? session.metadata.model : null;
  const effort =
    typeof session?.metadata?.reasoningEffort === "string"
      ? session.metadata.reasoningEffort
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
          options: model ? (
            <ComposerPill label={`${model.split("/").pop()}${effort ? ` · ${effort}` : ""}`} />
          ) : null,
        }}
      />
    </>
  );
}
