import { useNativeTimelineTheme } from "@opengeni/react-native/timeline";
import { Stack } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, Linking, View } from "react-native";
import { useAiConsent, useAiConsentSnapshot } from "@/ai-consent";
import type { AiConsentGate } from "@/ai-consent-gate";
import { aiProvidersSections } from "@/ai-consent-settings";
import { SettingsList } from "@/settings-list";
import { AppThemeProvider } from "@/theme";

export default function AiProvidersScreen() {
  return (
    <AppThemeProvider>
      <AiProviders />
    </AppThemeProvider>
  );
}

function failureText(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "Couldn't reach Opengeni. Check your connection and try again.";
}

function useConsentActions(gate: AiConsentGate) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (caught) {
      setError(failureText(caught));
    } finally {
      setBusy(false);
    }
  }, []);
  const allow = () =>
    void run(async () => {
      // The text changed while it was open: the new text is on screen now.
      if (!(await gate.grantShown())) {
        setError("What's shared has changed. Read the new text, then allow it.");
      }
    });
  const withdraw = () =>
    Alert.alert(
      "Withdraw permission?",
      "Opengeni won't send your messages, calls or recordings to AI providers until you allow it again.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Withdraw",
          style: "destructive",
          onPress: () => void run(() => gate.withdraw()),
        },
      ],
    );
  const openPrivacyPolicy = (url: string) => void Linking.openURL(url);
  return { allow, withdraw, openPrivacyPolicy, busy, error };
}

/** The AI-provider permission, from Settings: what's shared, with whom, and the choice. */
function AiProviders() {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const gate = useAiConsent();
  const snapshot = useAiConsentSnapshot(gate);
  const actions = useConsentActions(gate);
  const [loadError, setLoadError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setLoadError(null);
      await gate.refresh();
    } catch (caught) {
      setLoadError(failureText(caught));
    }
  }, [gate]);
  useEffect(() => {
    void load();
  }, [load]);
  const header = (
    <Stack.Screen
      options={{
        title: "AI providers",
        headerTintColor: c.fg,
        headerShadowVisible: false,
        headerStyle: { backgroundColor: c.bg },
      }}
    />
  );
  if (snapshot.supported === false) {
    return (
      <>
        {header}
        <SettingsList
          sections={[]}
          empty={{
            title: "Nothing to allow",
            description:
              "This Opengeni server doesn't ask for permission to share with AI providers.",
            symbol: "checkmark.shield",
          }}
        />
      </>
    );
  }
  if (!snapshot.status) {
    return (
      <>
        {header}
        {loadError ? (
          <SettingsList
            sections={[
              {
                id: "error",
                footer: loadError,
                rows: [
                  {
                    kind: "action",
                    id: "retry",
                    title: "Try again",
                    symbol: "arrow.clockwise",
                    onPress: () => void load(),
                  },
                ],
              },
            ]}
          />
        ) : (
          <View
            style={{
              flex: 1,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: c.bg,
            }}
          >
            <ActivityIndicator />
          </View>
        )}
      </>
    );
  }
  return (
    <>
      {header}
      <SettingsList sections={aiProvidersSections(snapshot.status, actions)} onRefresh={load} />
    </>
  );
}
