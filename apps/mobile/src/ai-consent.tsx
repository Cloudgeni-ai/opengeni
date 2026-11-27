import type { OpenGeniNativeSessionController } from "@opengeni/react-native";
import { Button, fontStyle, useNativeTimelineTheme } from "@opengeni/react-native/timeline";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Linking, Modal, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAccount } from "@/account";
import {
  createAiConsentGate,
  onAiConsentRefused,
  type AiConsentDisclosure,
  type AiConsentGate,
  type AiConsentPrompt,
  type AiConsentSnapshot,
} from "@/ai-consent-gate";
import { AppThemeProvider } from "@/theme";

/*
 * The account's AI-provider permission (see ai-consent-gate.ts): one gate per
 * signed-in client, the question it asks drawn over whatever screen asked,
 * and the server's refusals (from any request) opening it again.
 */

/** Outside the provider (and in tests): nothing to ask. */
const OPEN_GATE: AiConsentGate = createAiConsentGate({
  read: async () => {
    throw new Error("No consent here");
  },
  grant: async () => {
    throw new Error("No consent here");
  },
  withdraw: async () => {
    throw new Error("No consent here");
  },
});

const AiConsentContext = createContext<AiConsentGate>(OPEN_GATE);

/** The signed-in account's gate: `ensure()` before a Send, call or dictation. */
export function useAiConsent(): AiConsentGate {
  return useContext(AiConsentContext);
}

export function useAiConsentSnapshot(gate: AiConsentGate): AiConsentSnapshot {
  return useSyncExternalStore(gate.subscribe, gate.snapshot, gate.snapshot);
}

/** Labs only: the screens below use this gate, and its question is drawn over them. */
export function AiConsentLabGate({ gate, children }: { gate: AiConsentGate; children: ReactNode }) {
  return (
    <AiConsentContext.Provider value={gate}>
      {children}
      <AiConsentQuestion gate={gate} />
    </AiConsentContext.Provider>
  );
}

/**
 * A conversation whose Send, Steer, alternate Send and answers to the agent's
 * questions wait for the person's permission first. Not now sends nothing
 * and leaves the draft (or the answer) where it was.
 */
export function useAiConsentGatedSession<
  T extends Pick<OpenGeniNativeSessionController, "composer" | "humanInput">,
>(controller: T): T {
  const gate = useAiConsent();
  const { composer, humanInput } = controller;
  const gatedComposer = useMemo(() => {
    const { send, steer, sendAlternate } = composer;
    const gated: typeof composer = {
      ...composer,
      send: async (text?: string) => (await gate.ensure()) && (await send(text)),
      steer: async (text?: string) => (await gate.ensure()) && (await steer(text)),
      ...(sendAlternate
        ? {
            sendAlternate: async (text?: string) =>
              (await gate.ensure()) && (await sendAlternate(text)),
          }
        : {}),
    };
    return gated;
  }, [composer, gate]);
  const gatedHumanInput = useMemo(() => {
    const { respond } = humanInput;
    const gated: typeof humanInput = {
      ...humanInput,
      respond: async (requestId, response) =>
        (await gate.ensure()) ? await respond(requestId, response) : null,
    };
    return gated;
  }, [gate, humanInput]);
  return useMemo(
    () => ({ ...controller, composer: gatedComposer, humanInput: gatedHumanInput }),
    [controller, gatedComposer, gatedHumanInput],
  );
}

export function AiConsentProvider({ children }: { children: ReactNode }) {
  const { client, account, status } = useAccount();
  const gate = useMemo(
    () =>
      createAiConsentGate({
        read: () => client.getAiProcessingConsent(),
        grant: (version) => client.grantAiProcessingConsent({ version }),
        withdraw: () => client.withdrawAiProcessingConsent(),
      }),
    [client],
  );
  useEffect(() => () => gate.close(), [gate]);
  const baseUrl = account?.baseUrl ?? null;
  useEffect(
    () =>
      baseUrl
        ? onAiConsentRefused((refusedAt) => {
            if (refusedAt === baseUrl) void gate.refused();
          })
        : undefined,
    [baseUrl, gate],
  );
  // Read ahead, so the first Send of someone who already allowed it never waits.
  useEffect(() => {
    if (status === "ready") void gate.refresh().catch(() => undefined);
  }, [gate, status]);
  return (
    <AiConsentContext.Provider value={gate}>
      {children}
      <AiConsentQuestion gate={gate} />
    </AiConsentContext.Provider>
  );
}

function AiConsentQuestion({ gate }: { gate: AiConsentGate }) {
  const { prompt } = useAiConsentSnapshot(gate);
  return (
    <Modal
      visible={prompt !== null}
      animationType="slide"
      presentationStyle="pageSheet"
      // Swiping the sheet away is Not now.
      onRequestClose={gate.dismiss}
    >
      <AppThemeProvider>
        {prompt ? (
          <AiConsentSheet prompt={prompt} onAllow={gate.allow} onNotNow={gate.dismiss} />
        ) : null}
      </AppThemeProvider>
    </Modal>
  );
}

/** The server's disclosure: its title, text, the providers it names and its privacy policy. */
export function AiConsentDisclosureText({
  disclosure,
  changed = false,
}: {
  disclosure: AiConsentDisclosure;
  changed?: boolean;
}) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  return (
    <View style={{ gap: 16 }}>
      <Text
        accessibilityRole="header"
        style={{
          ...fontStyle(theme, 600),
          fontSize: 24,
          lineHeight: 30,
          letterSpacing: -0.5,
          color: c.fg,
        }}
      >
        {disclosure.title}
      </Text>
      {changed ? (
        <Text
          accessibilityLiveRegion="polite"
          style={{ ...fontStyle(theme, 500), fontSize: 15, lineHeight: 21, color: c.fg }}
        >
          This changed since you opened it. Please read it again.
        </Text>
      ) : null}
      {disclosure.body
        .split(/\n\s*\n/u)
        .map((paragraph) => paragraph.trim())
        .filter(Boolean)
        .map((paragraph) => (
          <Text
            key={paragraph}
            style={{ ...fontStyle(theme), fontSize: 16, lineHeight: 24, color: c["fg-muted"] }}
          >
            {paragraph}
          </Text>
        ))}
      {disclosure.providers.length > 0 ? (
        <View
          style={{
            borderRadius: theme.radius.lg,
            borderWidth: 1,
            borderColor: c.border,
            backgroundColor: c["surface-1"],
            paddingHorizontal: 16,
            paddingVertical: 12,
            gap: 6,
          }}
        >
          <Text
            style={{
              ...fontStyle(theme, 500),
              fontSize: 13,
              lineHeight: 18,
              color: c["fg-subtle"],
            }}
          >
            Shared with
          </Text>
          {disclosure.providers.map((provider) => (
            <Text
              key={provider}
              style={{ ...fontStyle(theme, 500), fontSize: 16, lineHeight: 22, color: c.fg }}
            >
              {provider}
            </Text>
          ))}
        </View>
      ) : null}
      {disclosure.privacyUrl ? (
        <Pressable
          accessibilityRole="link"
          hitSlop={8}
          onPress={() => void Linking.openURL(disclosure.privacyUrl!).catch(() => undefined)}
          style={({ pressed }) => ({ alignSelf: "flex-start", opacity: pressed ? 0.6 : 1 })}
        >
          <Text
            style={{
              ...fontStyle(theme, 500),
              fontSize: 15,
              lineHeight: 22,
              color: c.fg,
              textDecorationLine: "underline",
            }}
          >
            Privacy policy
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** The question before the first Send, call or dictation: Allow, or Not now (which sends nothing). */
export function AiConsentSheet({
  prompt,
  onAllow,
  onNotNow,
}: {
  prompt: AiConsentPrompt;
  onAllow: () => void;
  onNotNow: () => void;
}) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 24, paddingTop: 32, paddingBottom: 24 }}
      >
        <AiConsentDisclosureText disclosure={prompt.disclosure} changed={prompt.changed} />
      </ScrollView>
      <View
        style={{
          paddingHorizontal: 24,
          paddingTop: 12,
          paddingBottom: Math.max(insets.bottom, 16) + 8,
          gap: 8,
          borderTopWidth: 1,
          borderTopColor: c.border,
        }}
      >
        {prompt.error ? (
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
            {prompt.error}
          </Text>
        ) : null}
        <Button
          variant="primary"
          size="form"
          label="Allow"
          busy={prompt.granting}
          onPress={onAllow}
          style={{ height: 44 }}
        />
        <Button
          variant="ghost"
          size="form"
          label="Not now"
          disabled={prompt.granting}
          onPress={onNotNow}
          style={{ height: 44 }}
        />
      </View>
    </View>
  );
}
