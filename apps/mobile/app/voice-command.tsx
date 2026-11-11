/**
 * A voice command for one chat: a short name the person says ("Call Research
 * in Opengeni" to Siri) that starts a call straight into that chat. Opened
 * from a chat's ⋯ menu to make one, and from Settings › Calls to rename or
 * remove it.
 */
import { wakePhraseSetupAvailable } from "@opengeni/react-native";
import { Icon, fontStyle, useNativeTimelineTheme } from "@opengeni/react-native/timeline";
import * as Haptics from "expo-haptics";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { sharedCallAdapter } from "@/call";
import { AppThemeProvider } from "@/theme";
import {
  VOICE_COMMAND_NAME_MAX,
  normalizeVoiceCommandName,
  suggestedVoiceCommandName,
  voiceCommandForSession,
  voiceCommandNameMessage,
  voiceCommandNameProblem,
} from "@/voice-command-model";
import {
  createVoiceCommand,
  removeVoiceCommand,
  renameVoiceCommand,
  useVoiceCommands,
} from "@/voice-commands";
import { callAssistantName, voiceCommandRequest } from "@/wake-phrase";

export default function VoiceCommandScreen() {
  return (
    <AppThemeProvider>
      <Stack.Screen options={{ headerShown: false }} />
      <VoiceCommandSheet />
    </AppThemeProvider>
  );
}

type Params = {
  /** An existing command (from Settings). */
  command?: string;
  /** The chat to make one for (from its ⋯ menu). */
  workspace?: string;
  session?: string;
  title?: string;
  agent?: string;
};

function VoiceCommandSheet() {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const params = useLocalSearchParams<Params>();
  const commands = useVoiceCommands();
  const appName = callAssistantName();
  const command =
    commands.find((each) => each.id === params.command) ??
    (params.workspace && params.session
      ? voiceCommandForSession(commands, params.workspace, params.session)
      : null);
  const chatTitle = command?.chatTitle ?? params.title ?? "";
  const [draft, setDraft] = useState(
    () =>
      command?.name ??
      suggestedVoiceCommandName({ agentName: params.agent, title: params.title, appName }),
  );
  // Problems show once the person has typed, never on a fresh suggestion.
  const [edited, setEdited] = useState(false);

  const name = normalizeVoiceCommandName(draft);
  const problem = voiceCommandNameProblem(draft, commands, {
    appName,
    exceptId: command?.id,
  });
  const spoken = name || command?.name || "…";
  const renamed = Boolean(command && name !== command.name);
  const canSave = !problem && (!command || renamed);
  const ios = Platform.OS === "ios";

  const close = () => {
    if (router.canGoBack()) router.back();
  };

  const create = () => {
    if (problem || !params.workspace || !params.session) {
      setEdited(true);
      return;
    }
    const made = createVoiceCommand({
      workspaceId: params.workspace,
      sessionId: params.session,
      name,
      chatTitle,
    });
    if (!made) {
      Alert.alert("Sign in first", "Voice commands belong to the account you're signed in to.");
      return;
    }
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setDraft(made.name);
    setEdited(false);
  };

  // Done keeps a valid rename; a name that can't be used asks first.
  const done = () => {
    if (!command || !renamed) return close();
    if (problem) {
      setEdited(true);
      Alert.alert(voiceCommandNameMessage(problem, appName), `“${command.name}” stays as it is.`, [
        { text: "Keep editing", style: "cancel" },
        { text: "Discard change", style: "destructive", onPress: close },
      ]);
      return;
    }
    renameVoiceCommand(command.id, name);
    void Haptics.selectionAsync();
    close();
  };

  const remove = () => {
    if (!command) return;
    Alert.alert(
      `Remove “${command.name}”?`,
      ios
        ? `Siri stops calling this chat by name. A “Hey ${command.name}” shortcut you set up stops working too.`
        : "Its launcher and home screen shortcuts stop working.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => {
            removeVoiceCommand(command.id);
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            close();
          },
        },
      ],
    );
  };

  const pin = () => {
    if (!command) return;
    const adapter = sharedCallAdapter();
    if (!adapter?.pinCallCommand) return;
    const { id, workspaceId, sessionId, name: spokenName } = command;
    void adapter.pinCallCommand({ id, workspaceId, sessionId, name: spokenName }).then(
      (asked) => {
        if (!asked) {
          Alert.alert(
            "Your home screen doesn't take shortcuts",
            "Long-press the app icon to find this chat's shortcut instead.",
          );
        }
      },
      () => Alert.alert("Couldn't add the shortcut", "Try again in a moment."),
    );
  };

  const label = { ...fontStyle(theme), fontSize: 17, lineHeight: 22 };
  const strong = { ...fontStyle(theme, 600) };
  const body = { ...fontStyle(theme), fontSize: 15, lineHeight: 20, color: c.fg };
  const note = { ...fontStyle(theme), fontSize: 13, lineHeight: 18, color: c["fg-muted"] };
  const card = {
    borderRadius: theme.radius.lg,
    backgroundColor: c["surface-1"],
    borderWidth: 1,
    borderColor: c.border,
  };
  const showProblem = problem && (edited || command) && problem !== "empty" ? problem : null;
  const showEmpty = problem === "empty" && edited;

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: c.bg }}
      behavior={ios ? "padding" : undefined}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingHorizontal: 16,
          paddingTop: 14,
          paddingBottom: 10,
        }}
      >
        <View style={{ minWidth: 64, alignItems: "flex-start" }}>
          {command ? null : (
            <Pressable
              accessibilityRole="button"
              hitSlop={12}
              onPress={close}
              testID="voice-command-cancel"
            >
              <Text style={{ ...label, color: c.fg }}>Cancel</Text>
            </Pressable>
          )}
        </View>
        <Text accessibilityRole="header" style={{ ...label, ...strong, color: c.fg }}>
          Voice command
        </Text>
        <View style={{ minWidth: 64, alignItems: "flex-end" }}>
          {command ? (
            <Pressable
              accessibilityRole="button"
              hitSlop={12}
              onPress={done}
              testID="voice-command-done"
            >
              <Text style={{ ...label, ...strong, color: c.fg }}>Done</Text>
            </Pressable>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: !canSave }}
              disabled={!canSave}
              hitSlop={12}
              onPress={create}
              testID="voice-command-create"
            >
              <Text style={{ ...label, ...strong, color: canSave ? c.fg : c["fg-subtle"] }}>
                Create
              </Text>
            </Pressable>
          )}
        </View>
      </View>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 40, gap: 20 }}
      >
        {command?.missing ? (
          <View
            style={{
              ...card,
              flexDirection: "row",
              gap: 10,
              padding: 14,
              borderColor: c.danger,
            }}
            testID="voice-command-missing"
          >
            <Icon name="triangle-alert" size={18} color={c.danger} />
            <Text style={{ ...body, flex: 1 }}>
              {`The chat “${chatTitle || command.name}” was deleted, so “${command.name}” no longer starts a call. Remove the command, or make a new one from another chat.`}
            </Text>
          </View>
        ) : null}

        {command?.missing ? null : (
          <View style={{ gap: 8 }}>
            <Text style={{ ...note, ...fontStyle(theme, 500) }}>What you'll say</Text>
            <TextInput
              accessibilityLabel="Voice command name"
              autoCapitalize="words"
              autoCorrect={false}
              autoFocus={!command}
              maxLength={VOICE_COMMAND_NAME_MAX}
              onChangeText={(value) => {
                setDraft(value);
                setEdited(true);
              }}
              onSubmitEditing={command ? done : create}
              placeholder="Research"
              placeholderTextColor={c["fg-subtle"]}
              returnKeyType="done"
              style={{
                ...fontStyle(theme),
                paddingHorizontal: 12,
                paddingVertical: 12,
                borderRadius: theme.radius.md,
                borderWidth: 1,
                borderColor: showProblem || showEmpty ? c.danger : c.border,
                backgroundColor: c["surface-1"],
                fontSize: 17,
                lineHeight: 22,
                color: c.fg,
              }}
              testID="voice-command-name"
              value={draft}
            />
            <Text
              style={{ ...note, color: showProblem || showEmpty ? c.danger : c["fg-muted"] }}
              testID="voice-command-name-hint"
            >
              {showProblem
                ? voiceCommandNameMessage(showProblem, appName)
                : showEmpty
                  ? voiceCommandNameMessage("empty", appName)
                  : "A short name you can say the same way every time."}
            </Text>
          </View>
        )}

        {command?.missing ? null : (
          <View style={{ ...card, padding: 16, gap: 10 }} testID="voice-command-usage">
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Icon name="audio-lines" size={18} color={c["fg-muted"]} />
              <Text style={{ ...note, ...fontStyle(theme, 500) }}>
                {ios
                  ? command
                    ? "Say to Siri"
                    : "Then say to Siri"
                  : command
                    ? "On your home screen"
                    : "Then, on your home screen"}
              </Text>
            </View>
            {ios ? (
              <Text
                style={{ ...fontStyle(theme, 600), fontSize: 22, lineHeight: 28, color: c.fg }}
                testID="voice-command-phrase"
              >
                {`“${voiceCommandRequest(spoken)}”`}
              </Text>
            ) : (
              <Text style={{ ...body, ...fontStyle(theme, 500) }}>
                {`Touch and hold the ${appName} icon, then tap “${spoken}”.`}
              </Text>
            )}
            <Text style={note}>
              {`The call goes straight into “${chatTitle || spoken}”. It works only while your phone is unlocked, so nobody else can reach your agent with it.`}
            </Text>
          </View>
        )}

        {command && !command.missing ? (
          <View style={{ ...card, overflow: "hidden" }}>
            {ios && wakePhraseSetupAvailable() ? (
              <ActionRow
                icon="mic"
                title={`Set up “Hey ${command.name}”`}
                subtitle="Skip “Siri” and just say the name."
                onPress={() =>
                  router.push(`/wake-phrase?command=${encodeURIComponent(command.id)}`)
                }
                testID="voice-command-wake-phrase"
              />
            ) : null}
            {!ios && sharedCallAdapter()?.pinCallCommand ? (
              <ActionRow
                icon="smartphone"
                title="Add to home screen"
                subtitle="One tap calls this chat."
                onPress={pin}
                testID="voice-command-pin"
              />
            ) : null}
          </View>
        ) : null}

        {command ? (
          <Pressable
            accessibilityRole="button"
            onPress={remove}
            style={({ pressed }) => ({
              ...card,
              paddingVertical: 14,
              alignItems: "center",
              opacity: pressed ? 0.6 : 1,
            })}
            testID="voice-command-remove"
          >
            <Text style={{ ...body, ...fontStyle(theme, 500), color: c.danger }}>
              Remove voice command
            </Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function ActionRow(props: {
  icon: "mic" | "smartphone";
  title: string;
  subtitle: string;
  onPress: () => void;
  testID: string;
}) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={props.onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        paddingHorizontal: 16,
        paddingVertical: 14,
        backgroundColor: pressed ? c.hover : "transparent",
      })}
      testID={props.testID}
    >
      <Icon name={props.icon} size={20} color={c.fg} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ ...fontStyle(theme, 500), fontSize: 16, lineHeight: 21, color: c.fg }}>
          {props.title}
        </Text>
        <Text style={{ ...fontStyle(theme), fontSize: 13, lineHeight: 18, color: c["fg-muted"] }}>
          {props.subtitle}
        </Text>
      </View>
      <Icon name="chevron-right" size={18} color={c["fg-subtle"]} />
    </Pressable>
  );
}
