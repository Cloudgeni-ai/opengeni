/**
 * Set up a spoken phrase of the person's own ("Hey Opengeni") that starts a
 * call: iOS runs the app's call shortcut as a Siri request when they say it.
 */
import { WakePhraseGuide } from "@opengeni/react-native";
import { useNativeTimelineTheme } from "@opengeni/react-native/timeline";
import { Stack } from "expo-router";
import { View } from "react-native";
import { copyText } from "@/clipboard";
import { AppThemeProvider } from "@/theme";
import { callAssistantName } from "@/wake-phrase";

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
  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.bg }}>
      <WakePhraseGuide assistantName={callAssistantName()} copyText={copyText} />
    </View>
  );
}
