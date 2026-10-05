import { Button, fontStyle, useNativeTimelineTheme } from "@opengeni/react-native/timeline";
import { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { DEFAULT_SERVER_URL, useAccount } from "@/account";
import { normalizeServerUrl, serverLabel } from "@/account-store";
import { BrandMark } from "@/brand-mark";

/**
 * Sign in, or add another account: the deployment's own web sign-in opens in
 * the system auth browser, so every web method (password, Google, GitHub,
 * passkeys, SSO) works and the password never touches the app.
 */
export function SignInScreen({ onDone, onCancel }: { onDone?: () => void; onCancel?: () => void }) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const insets = useSafeAreaInsets();
  const { account, addAccount } = useAccount();
  const expired = account?.signedOut ? account : null;
  const [server, setServer] = useState(expired?.baseUrl ?? DEFAULT_SERVER_URL);
  const [editingServer, setEditingServer] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const start = async () => {
    const baseUrl = normalizeServerUrl(server);
    if (!baseUrl) {
      setProblem("Enter the address you open Opengeni at, like app.opengeni.ai.");
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const result = await addAccount(baseUrl);
      if (result.kind === "signedIn") onDone?.();
      else if (result.kind === "failed") setProblem(result.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: c.bg }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          flexGrow: 1,
          justifyContent: "center",
          paddingHorizontal: 24,
          paddingTop: insets.top + 24,
          paddingBottom: insets.bottom + 24,
        }}
      >
        <View style={{ alignItems: "center" }}>
          <BrandMark width={44} color={c.fg} />
          <Text
            accessibilityRole="header"
            style={{
              ...fontStyle(theme, 600),
              fontSize: 24,
              lineHeight: 32,
              letterSpacing: -0.6,
              color: c.fg,
              marginTop: 24,
              textAlign: "center",
            }}
          >
            {expired ? "Sign in again" : onCancel ? "Add an account" : "Sign in to Opengeni"}
          </Text>
          <Text
            style={{
              ...fontStyle(theme),
              fontSize: 15,
              lineHeight: 22,
              color: c["fg-muted"],
              marginTop: 8,
              textAlign: "center",
              maxWidth: 320,
            }}
          >
            {expired
              ? `${expired.email} was signed out on ${serverLabel(expired.baseUrl)}.`
              : "Continue in your browser with any sign-in you use on the web."}
          </Text>
        </View>

        <View style={{ marginTop: 32, gap: 12 }}>
          {editingServer ? (
            <TextInput
              accessibilityLabel="Server address"
              value={server}
              onChangeText={setServer}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              returnKeyType="go"
              onSubmitEditing={() => void start()}
              placeholder="app.opengeni.ai"
              placeholderTextColor={c["fg-subtle"]}
              style={{
                ...fontStyle(theme),
                height: 44,
                paddingHorizontal: 12,
                borderRadius: theme.radius.md,
                borderWidth: 1,
                borderColor: c.border,
                backgroundColor: c["surface-1"],
                fontSize: 15,
                color: c.fg,
              }}
            />
          ) : null}
          <Button
            variant="primary"
            size="form"
            label={busy ? "Waiting for the browser…" : "Continue with web sign-in"}
            busy={busy}
            disabled={busy}
            onPress={() => void start()}
            style={{ height: 44 }}
          />
          {onCancel ? (
            <Button variant="ghost" size="form" label="Cancel" onPress={onCancel} />
          ) : null}
          {problem ? (
            <Text
              accessibilityLiveRegion="polite"
              style={{
                ...fontStyle(theme),
                fontSize: 13,
                lineHeight: 18,
                color: c["status-failed"],
                textAlign: "center",
              }}
            >
              {problem}
            </Text>
          ) : null}
        </View>

        {editingServer ? null : (
          <Text
            accessibilityRole="button"
            onPress={() => setEditingServer(true)}
            style={{
              ...fontStyle(theme),
              fontSize: 13,
              lineHeight: 18,
              color: c["fg-subtle"],
              textAlign: "center",
              marginTop: 24,
            }}
          >
            {serverLabel(normalizeServerUrl(server) ?? server)} · Change server
          </Text>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
