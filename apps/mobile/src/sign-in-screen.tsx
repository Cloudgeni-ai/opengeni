import { Button, fontStyle, useNativeTimelineTheme } from "@opengeni/react-native/timeline";
import { useEffect, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { DEFAULT_SERVER_URL, useAccount } from "@/account";
import { normalizeServerUrl, serverLabel, type StoredAccount } from "@/account-store";
import { signInSwitchChoices, type SignInSwitchChoice } from "@/account-switching";
import { BrandMark } from "@/brand-mark";
import { InitialTile } from "@/ui";

/**
 * Sign in, or add another account: the deployment's own web sign-in opens in
 * the system auth browser, so every web method (password, Google, GitHub,
 * passkeys, SSO) works and the password never touches the app.
 *
 * `target` is an account to sign in to again. Shown full screen (no Cancel),
 * the screen also lists the device's other accounts, so the person can always
 * go back to one they are signed in to.
 *
 * When the target's saved sign-in exists but couldn't be read (a locked or
 * failing keychain), it is not signed out: the screen says so and offers to
 * try again first, with signing in again as the fallback.
 */
export function SignInScreen({
  target,
  onDone,
  onCancel,
}: {
  target?: StoredAccount | null;
  onDone?: () => void;
  onCancel?: () => void;
}) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const insets = useSafeAreaInsets();
  const {
    account,
    accounts,
    previousAccountId,
    unreadable,
    addAccount,
    switchAccount,
    retrySignIn,
  } = useAccount();
  const expired =
    target ?? (account && (account.signedOut || unreadable.has(account.id)) ? account : null);
  const cantRead = Boolean(expired && !expired.signedOut && unreadable.has(expired.id));
  const choices = onCancel
    ? []
    : signInSwitchChoices(accounts, account?.id ?? null, previousAccountId);
  const [server, setServer] = useState(expired?.baseUrl ?? DEFAULT_SERVER_URL);
  const [editingServer, setEditingServer] = useState(false);
  // The action in progress, so its own button shows it.
  const [running, setRunning] = useState<"signIn" | "retry" | null>(null);
  const busy = running !== null;
  const [problem, setProblem] = useState<string | null>(null);
  // A successful sign-in replaces this screen before the flow settles.
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const start = async () => {
    const baseUrl = normalizeServerUrl(server);
    if (!baseUrl) {
      setProblem("Enter the address you open Opengeni at, like app.opengeni.ai.");
      return;
    }
    setRunning("signIn");
    setProblem(null);
    try {
      const result = await addAccount(baseUrl);
      if (result.kind === "signedIn") onDone?.();
      else if (result.kind === "failed" && mounted.current) setProblem(result.message);
    } finally {
      if (mounted.current) setRunning(null);
    }
  };

  const retry = async () => {
    if (!expired) return;
    setRunning("retry");
    setProblem(null);
    try {
      const outcome = await retrySignIn(expired.id);
      if (outcome === "ready") onDone?.();
      else if (outcome === "unreadable" && mounted.current) setProblem("Still couldn't read it.");
    } finally {
      if (mounted.current) setRunning(null);
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
            {cantRead
              ? "Couldn't read your sign-in"
              : expired
                ? "Sign in again"
                : onCancel
                  ? "Add an account"
                  : "Sign in to Opengeni"}
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
            {!expired
              ? "Continue in your browser with any sign-in you use on the web."
              : cantRead
                ? `This device couldn't read the saved sign-in for ${expired.email} on ${serverLabel(expired.baseUrl)}.`
                : expired.signedOut
                  ? `${expired.email} was signed out on ${serverLabel(expired.baseUrl)}.`
                  : `Sign in to ${expired.email} on ${serverLabel(expired.baseUrl)}.`}
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
          {cantRead ? (
            <>
              <Button
                variant="primary"
                size="form"
                label="Try again"
                busy={running === "retry"}
                disabled={busy}
                onPress={() => void retry()}
                style={{ height: 44 }}
              />
              <Button
                variant="ghost"
                size="form"
                label={running === "signIn" ? "Waiting for the browser…" : "Sign in again"}
                disabled={busy}
                onPress={() => void start()}
              />
            </>
          ) : (
            <Button
              variant="primary"
              size="form"
              label={busy ? "Waiting for the browser…" : "Continue with web sign-in"}
              busy={busy}
              disabled={busy}
              onPress={() => void start()}
              style={{ height: 44 }}
            />
          )}
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

        {editingServer || cantRead ? null : (
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

        {choices.length > 0 ? (
          <SwitchAccountList choices={choices} onPick={switchAccount} disabled={busy} />
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/** The other accounts on this device, one tap each: signed in goes straight in. */
function SwitchAccountList({
  choices,
  onPick,
  disabled,
}: {
  choices: SignInSwitchChoice[];
  onPick(id: string): void;
  disabled: boolean;
}) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  return (
    <View style={{ marginTop: 40 }}>
      <Text
        accessibilityRole="header"
        style={{
          ...fontStyle(theme, 500),
          fontSize: 13,
          lineHeight: 18,
          color: c["fg-subtle"],
          marginBottom: 8,
          paddingHorizontal: 4,
        }}
      >
        Switch account
      </Text>
      <View
        style={{
          borderRadius: theme.radius.lg,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: c.border,
          backgroundColor: c["surface-1"],
          overflow: "hidden",
        }}
      >
        {choices.map(({ account, signedIn }, index) => {
          const status = signedIn ? "Signed in" : "Signed out";
          return (
            <Pressable
              key={account.id}
              accessibilityRole="button"
              accessibilityLabel={`Switch to ${account.email} on ${serverLabel(account.baseUrl)}, ${status.toLowerCase()}`}
              accessibilityState={{ disabled }}
              disabled={disabled}
              onPress={() => onPick(account.id)}
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: 12,
                minHeight: 56,
                paddingHorizontal: 12,
                paddingVertical: 8,
                borderTopWidth: index === 0 ? 0 : StyleSheet.hairlineWidth,
                borderTopColor: c.border,
                backgroundColor: pressed ? c.hover : "transparent",
                opacity: disabled ? 0.5 : 1,
              })}
            >
              <InitialTile label={account.email} size={32} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text
                  numberOfLines={1}
                  style={{ ...fontStyle(theme, 500), fontSize: 15, lineHeight: 20, color: c.fg }}
                >
                  {account.email}
                </Text>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  <View
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: 3,
                      backgroundColor: signedIn ? c["status-idle"] : c["fg-subtle"],
                    }}
                  />
                  <Text
                    numberOfLines={1}
                    style={{
                      ...fontStyle(theme),
                      fontSize: 13,
                      lineHeight: 18,
                      color: signedIn ? c["fg-muted"] : c["fg-subtle"],
                      flexShrink: 1,
                    }}
                  >
                    {status} · {serverLabel(account.baseUrl)}
                  </Text>
                </View>
              </View>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
