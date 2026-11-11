/**
 * Set up a spoken phrase of the person's own ("Hey Opengeni") that starts a
 * call: iOS runs the app's call shortcut as a Siri request when they say it.
 * With `command` it is a voice command's phrase ("Hey Research"), which calls
 * that command's chat.
 */
import { WakePhraseGuide } from "@opengeni/react-native";
import { useNativeTimelineTheme } from "@opengeni/react-native/timeline";
import { Stack, useLocalSearchParams } from "expo-router";
import { View } from "react-native";
import { copyText } from "@/clipboard";
import { AppThemeProvider } from "@/theme";
import { useVoiceCommands } from "@/voice-commands";
import { callAssistantName, voiceCommandRequest } from "@/wake-phrase";

export default function WakePhraseScreen() {
  return (
    <AppThemeProvider>
      <Stack.Screen options={{ title: "" }} />
      <WakePhrase />
    </AppThemeProvider>
  );
}

function WakePhrase() {
  const theme = useNativeTimelineTheme();
  const { command: commandId } = useLocalSearchParams<{ command?: string }>();
  const command = useVoiceCommands().find((each) => each.id === commandId);
  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.bg }}>
      {command ? (
        <WakePhraseGuide
          assistantName={command.name}
          request={voiceCommandRequest(command.name)}
          copyText={copyText}
        />
      ) : (
        <WakePhraseGuide assistantName={callAssistantName()} copyText={copyText} />
      )}
    </View>
  );
}
