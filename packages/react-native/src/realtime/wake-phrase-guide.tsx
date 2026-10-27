import { useEffect, useRef, useState } from "react";
import { Linking, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { fontStyle, useNativeTimelineTheme } from "../timeline/theme";
import { useOpenGeniText } from "@opengeni/react/messages";

/**
 * Whether this phone can start a call by a spoken phrase of the person's own:
 * iOS 18 and later run a Siri request when they say a phrase they taught it
 * (Settings › Accessibility › Vocal Shortcuts). Apps cannot create those
 * phrases themselves, so {@link WakePhraseGuide} walks the person through it.
 */
export function wakePhraseSetupAvailable(): boolean {
  if (Platform.OS !== "ios") return false;
  const major = Number.parseInt(String(Platform.Version), 10);
  return Number.isFinite(major) && major >= 18;
}

export interface WakePhraseGuideProps {
  /** The agent's spoken name, as Siri knows the app's call shortcut (for example the app name). */
  assistantName: string;
  /**
   * The Siri request that starts a call; it must match one of the app's call
   * shortcut phrases. Defaults to "Talk to <assistantName>".
   */
  request?: string | undefined;
  /** The phrase suggested to say. Defaults to "Hey <assistantName>". */
  phrase?: string | undefined;
  /** Puts text on the clipboard (the app's clipboard module, such as expo-clipboard). */
  copyText(text: string): void | Promise<void>;
  /** Opens Settings; defaults to this app's page there, the closest public link. */
  openSettings?: (() => void | Promise<void>) | undefined;
}

/**
 * Step-by-step setup for a custom spoken phrase ("Hey <agent>") that starts a
 * call: copy the Siri request, open Settings, add it as a Vocal Shortcut and
 * train the phrase. Render it as the body of a screen or sheet.
 */
export function WakePhraseGuide(props: WakePhraseGuideProps) {
  const t = useOpenGeniText();
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const name = props.assistantName;
  const request = props.request ?? t("native.realtime.wakePhrase.defaultRequest", { name });
  const phrase = props.phrase ?? t("native.realtime.wakePhrase.defaultPhrase", { name });
  const [copied, setCopied] = useState<"request" | "phrase" | null>(null);
  const reset = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (reset.current && clearTimeout(reset.current)), []);

  const copy = async (which: "request" | "phrase") => {
    await props.copyText(which === "request" ? request : phrase);
    setCopied(which);
    if (reset.current) clearTimeout(reset.current);
    reset.current = setTimeout(() => setCopied(null), 2000);
  };
  const copyAndOpen = async () => {
    await copy("request");
    await (props.openSettings ? props.openSettings() : Linking.openSettings());
  };

  const body = { ...fontStyle(theme, 400), color: c.fg, fontSize: theme.size.md, lineHeight: 23 };
  const muted = { ...fontStyle(theme, 400), color: c["fg-muted"], fontSize: theme.size.base };

  const quote = (text: string, which: "request" | "phrase") => (
    <View
      style={{
        marginTop: 10,
        flexDirection: "row",
        alignItems: "center",
        borderRadius: theme.radius.md,
        borderWidth: 1,
        borderColor: c.border,
        paddingLeft: 14,
        minHeight: 48,
      }}
    >
      <Text selectable style={[body, fontStyle(theme, 600), { flex: 1 }]}>
        {text}
      </Text>
      <Pressable
        accessibilityLabel={t("native.realtime.wakePhrase.copyLabel", { text })}
        accessibilityRole="button"
        hitSlop={8}
        onPress={() => void copy(which)}
        style={{ minHeight: 48, justifyContent: "center", paddingHorizontal: 14 }}
      >
        <Text style={[muted, fontStyle(theme, 600), { color: c.accent }]}>
          {copied === which
            ? t("native.realtime.wakePhrase.copied")
            : t("native.realtime.wakePhrase.copy")}
        </Text>
      </Pressable>
    </View>
  );

  const step = (index: number, children: React.ReactNode) => (
    <View key={index} style={{ flexDirection: "row", gap: 14, marginTop: 22 }}>
      <View
        style={{
          width: 28,
          height: 28,
          borderRadius: 14,
          backgroundColor: c.hover,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text style={[muted, fontStyle(theme, 600), { color: c.fg }]}>{index}</Text>
      </View>
      <View style={{ flex: 1, paddingTop: 2 }}>{children}</View>
    </View>
  );

  return (
    <ScrollView
      contentContainerStyle={{ padding: 20, paddingBottom: 40 }}
      contentInsetAdjustmentBehavior="automatic"
    >
      <Text style={[body, fontStyle(theme, 700), { fontSize: theme.size.md + 8, lineHeight: 30 }]}>
        {t("native.realtime.wakePhrase.title", { phrase })}
      </Text>
      <Text style={[muted, { marginTop: 8, lineHeight: 21 }]}>
        {t("native.realtime.wakePhrase.intro", { name })}
      </Text>
      {step(1, <Text style={body}>{t("native.realtime.wakePhrase.stepOpen")}</Text>)}
      {step(
        2,
        <>
          <Text style={body}>{t("native.realtime.wakePhrase.stepRequest")}</Text>
          {quote(request, "request")}
        </>,
      )}
      {step(
        3,
        <>
          <Text style={body}>{t("native.realtime.wakePhrase.stepPhrase")}</Text>
          {quote(phrase, "phrase")}
        </>,
      )}
      <Pressable
        accessibilityRole="button"
        onPress={() => void copyAndOpen()}
        style={({ pressed }) => ({
          marginTop: 30,
          minHeight: 50,
          borderRadius: theme.radius.full,
          backgroundColor: c.fg,
          opacity: pressed ? 0.8 : 1,
          alignItems: "center",
          justifyContent: "center",
          paddingHorizontal: 20,
        })}
      >
        <Text style={[body, fontStyle(theme, 600), { color: c.bg }]}>
          {t("native.realtime.wakePhrase.copyAndOpenSettings")}
        </Text>
      </Pressable>
      <Text style={[muted, { marginTop: 18, lineHeight: 20 }]}>
        {t("native.realtime.wakePhrase.footnote", { request })}
      </Text>
    </ScrollView>
  );
}
