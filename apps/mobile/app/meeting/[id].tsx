import type { Recording, RecordingSpeaker, RecordingTrack } from "@opengeni/contracts";
import {
  formatClock,
  formatDuration,
  groupTranscriptTurns,
  meetingPhase,
  speakerDisplayName,
  speakerIsNamed,
  transcriptErrorText,
  useRecording,
  useRecordingModels,
  useRecordingPeople,
  useTranscript,
  versionSummary,
  type TranscriptTurn,
} from "@opengeni/react/recordings";
import {
  BottomSheet,
  Button,
  fontStyle,
  Icon,
  IconButton,
  useNativeTimelineTheme,
} from "@opengeni/react-native/timeline";
import * as Haptics from "expo-haptics";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAccount } from "@/account";
import { isCapturing, meetingDateLabel, useMeetingRecorder, WorkspaceGate } from "@/meetings";
import { NativeMenu, type MenuAction } from "@/native-menu";
import { AppThemeProvider } from "@/theme";

export default function MeetingScreen() {
  return (
    <AppThemeProvider>
      <WorkspaceGate title="Meeting">
        {(workspaceId) => <Meeting workspaceId={workspaceId} />}
      </WorkspaceGate>
    </AppThemeProvider>
  );
}

type Sheet = { kind: "title" } | { kind: "speaker"; label: string } | null;

/* One meeting: what it is, where its transcript is, and the transcript read
   as turns. Speakers are named by tapping them. */
function Meeting({ workspaceId }: { workspaceId: string }) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { client } = useAccount();
  const scope = { client, workspaceId };
  const meeting = useRecording(id ?? null, scope);
  const recording = meeting.recording;
  const phase = recording ? meetingPhase(recording) : null;
  const ready = phase?.kind === "ready";
  const transcript = useTranscript(ready ? recording!.id : null, {
    ...scope,
    refreshKey: recording?.transcript?.id,
  });
  const models = useRecordingModels({ ...scope, enabled: ready });
  const version = recording?.transcript ?? null;
  const modelName = version
    ? (models.models.find(
        (candidate) =>
          candidate.providerId === version.providerId && candidate.model === version.model,
      )?.name ?? null)
    : null;
  const recorder = useMeetingRecorder();
  const capturingHere = isCapturing(recorder) && recorder?.recordingId === recording?.id;
  const [sheet, setSheet] = useState<Sheet>(null);
  const [pulling, setPulling] = useState(false);
  const tracks = recording?.tracks ?? [];
  const turns = useMemo(() => groupTranscriptTurns(transcript.segments), [transcript.segments]);

  const actions: MenuAction[] = recording
    ? [
        { id: "rename", title: "Rename", image: symbol("pencil") },
        {
          id: "visibility",
          title: recording.visibility === "private" ? "Share with workspace" : "Make private",
          image: symbol(recording.visibility === "private" ? "person.2" : "lock"),
        },
        ...(phase?.kind === "ready" || phase?.kind === "failed"
          ? [{ id: "rerun", title: "Transcribe again", image: symbol("arrow.clockwise") }]
          : []),
        {
          id: "delete",
          title: "Delete meeting",
          image: symbol("trash"),
          attributes: { destructive: true, ...(capturingHere ? { disabled: true } : {}) },
        },
      ]
    : [];

  const onAction = (action: string) => {
    if (!recording) return;
    if (action === "rename") setSheet({ kind: "title" });
    if (action === "visibility") {
      const next = recording.visibility === "private" ? "workspace" : "private";
      void meeting
        .update({ visibility: next })
        .catch(() => Alert.alert("Couldn't change who can see it", "Try again in a moment."));
    }
    if (action === "rerun") {
      Alert.alert(
        "Transcribe again?",
        "A new transcript is made from the full audio. The current one stays until it's ready, and speaker names carry over.",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Transcribe",
            onPress: () =>
              void meeting
                .rerun()
                .catch(() =>
                  Alert.alert("Couldn't start a new transcript", "Try again in a moment."),
                ),
          },
        ],
      );
    }
    if (action === "delete") {
      Alert.alert(
        "Delete this meeting?",
        "Its audio, transcripts and speaker names are deleted for everyone who can see it. This can't be undone.",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Delete",
            style: "destructive",
            onPress: () => {
              void meeting
                .remove()
                .then(() => {
                  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                  router.back();
                })
                .catch(() => Alert.alert("Couldn't delete the meeting", "Try again in a moment."));
            },
          },
        ],
      );
    }
  };
  // Android's header menu: rebuilt only when its items change; the handler is read live.
  const onActionRef = useRef(onAction);
  onActionRef.current = onAction;
  const actionsKey = actions.map((action) => `${action.id}:${action.title}`).join("|");
  const menuButton = useCallback(
    () => (
      <NativeMenu
        actions={actions}
        onPressAction={({ nativeEvent }) => onActionRef.current(nativeEvent.event)}
      >
        <IconButton icon="ellipsis" accessibilityLabel="Meeting actions" />
      </NativeMenu>
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [actionsKey],
  );

  return (
    <>
      <Stack.Screen
        options={{
          title: "",
          headerStyle: { backgroundColor: c.bg },
          headerTintColor: c.fg,
          headerShadowVisible: false,
          ...(recording
            ? Platform.OS === "ios"
              ? {
                  unstable_headerRightItems: () => [
                    {
                      type: "menu" as const,
                      label: "Meeting actions",
                      accessibilityLabel: "Meeting actions",
                      icon: { type: "sfSymbol" as const, name: "ellipsis" },
                      menu: {
                        items: actions.map((action) => ({
                          type: "action" as const,
                          label: action.title,
                          ...(typeof action.image === "string"
                            ? { icon: { type: "sfSymbol" as const, name: action.image } }
                            : {}),
                          ...(action.attributes?.destructive ? { destructive: true } : {}),
                          ...(action.attributes?.disabled ? { disabled: true } : {}),
                          onPress: () => onAction(action.id ?? action.title),
                        })),
                      },
                    },
                  ],
                }
              : {
                  headerRight: menuButton,
                }
            : {}),
        }}
      />
      <ScrollView
        style={{ flex: 1, backgroundColor: c.bg }}
        refreshControl={
          <RefreshControl
            refreshing={pulling}
            onRefresh={() => {
              setPulling(true);
              void Promise.all([meeting.refresh(), ready ? transcript.refresh() : null]).finally(
                () => setPulling(false),
              );
            }}
          />
        }
        contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: insets.bottom + 40 }}
      >
        {!recording ? (
          meeting.error ? (
            <Text
              style={{ ...fontStyle(theme), fontSize: 15, color: c["fg-muted"], marginTop: 24 }}
            >
              This meeting couldn't load. It may have been deleted, or you may not have access.
            </Text>
          ) : (
            <ActivityIndicator style={{ marginTop: 32 }} color={c["fg-muted"]} />
          )
        ) : (
          <>
            <Pressable
              accessibilityRole="button"
              accessibilityHint="Rename"
              onPress={() => setSheet({ kind: "title" })}
            >
              <Text
                accessibilityRole="header"
                style={{ ...fontStyle(theme, 600), fontSize: 24, lineHeight: 30, color: c.fg }}
              >
                {recording.title || "Untitled meeting"}
              </Text>
            </Pressable>
            <MetaLine recording={recording} />
            {capturingHere ? (
              <PhaseNote
                spinning={false}
                text="Recording now. The transcript starts when you stop."
              />
            ) : phase?.kind === "uploading" ? (
              <PhaseNote
                spinning
                text="Waiting for the rest of the audio. It uploads from the device that recorded it."
              />
            ) : phase?.kind === "transcribing" ? (
              <PhaseNote
                spinning
                text="Transcribing. This takes a minute or two for an hour of audio."
              />
            ) : phase?.kind === "failed" ? (
              <PhaseNote
                tone="danger"
                text={transcriptErrorText(phase.version?.errorCode ?? null)}
              />
            ) : phase?.kind === "no_transcript" ? (
              <PhaseNote text="No transcript yet." />
            ) : null}
            {ready && recording.transcript ? (
              <>
                <TranscriptFacts
                  recording={recording}
                  modelName={modelName}
                  speakers={transcript.speakers}
                  onSpeaker={(label) => setSheet({ kind: "speaker", label })}
                />
                {transcript.loading && turns.length === 0 ? (
                  <ActivityIndicator style={{ marginTop: 24 }} color={c["fg-muted"]} />
                ) : turns.length === 0 ? (
                  <Text
                    style={{
                      ...fontStyle(theme),
                      fontSize: 15,
                      color: c["fg-muted"],
                      marginTop: 20,
                    }}
                  >
                    No speech was found in this recording.
                  </Text>
                ) : (
                  <View style={{ marginTop: 8 }}>
                    {turns.map((turn) => (
                      <Turn
                        key={turn.key}
                        turn={turn}
                        speakers={transcript.speakers}
                        tracks={tracks}
                        onSpeaker={(label) => setSheet({ kind: "speaker", label })}
                      />
                    ))}
                  </View>
                )}
              </>
            ) : null}
          </>
        )}
      </ScrollView>
      {recording ? (
        <>
          <TitleSheet
            open={sheet?.kind === "title"}
            title={recording.title}
            onClose={() => setSheet(null)}
            onSave={async (title) => {
              await meeting.update({ title });
              setSheet(null);
            }}
          />
          <SpeakerSheet
            label={sheet?.kind === "speaker" ? sheet.label : null}
            speakers={transcript.speakers}
            tracks={tracks}
            scope={scope}
            onClose={() => setSheet(null)}
            onName={async (label, name) => {
              await transcript.nameSpeaker(label, name);
              setSheet(null);
            }}
          />
        </>
      ) : null}
    </>
  );
}

function MetaLine({ recording }: { recording: Recording }) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const facts = [
    meetingDateLabel(recording.startedAt),
    recording.durationMilliseconds ? formatDuration(recording.durationMilliseconds) : null,
    recording.visibility === "private" ? "Only you" : "Workspace",
  ].filter(Boolean);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 6 }}>
      <Icon
        name={recording.visibility === "private" ? "lock" : "globe"}
        size={12}
        color={c["fg-subtle"]}
      />
      <Text style={{ ...fontStyle(theme), fontSize: 14, color: c["fg-muted"] }}>
        {facts.join(" · ")}
      </Text>
    </View>
  );
}

function PhaseNote(props: { text: string; spinning?: boolean; tone?: "danger" }) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        marginTop: 20,
        padding: 14,
        borderRadius: theme.radius.md,
        borderWidth: 1,
        borderColor: props.tone === "danger" ? c.danger : c.border,
        backgroundColor: c["surface-1"],
      }}
    >
      {props.spinning ? <ActivityIndicator size="small" color={c["fg-muted"]} /> : null}
      <Text
        style={{
          ...fontStyle(theme),
          flex: 1,
          fontSize: 14,
          lineHeight: 20,
          color: props.tone === "danger" ? c.fg : c["fg-muted"],
        }}
      >
        {props.text}
      </Text>
    </View>
  );
}

/* The model and languages, and the speakers as chips: tap one to name it. */
function TranscriptFacts(props: {
  recording: Recording;
  modelName: string | null;
  speakers: RecordingSpeaker[];
  onSpeaker: (label: string) => void;
}) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const version = props.recording.transcript!;
  return (
    <View style={{ marginTop: 20, gap: 10 }}>
      <Text style={{ ...fontStyle(theme), fontSize: 13, color: c["fg-subtle"] }}>
        {versionSummary(version, props.modelName).join(" · ")}
      </Text>
      {props.speakers.length > 0 ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {props.speakers.map((speaker) => {
            const name = speakerDisplayName(speaker.label, props.speakers, props.recording.tracks);
            const named = speakerIsNamed(speaker.label, props.speakers);
            return (
              <Pressable
                key={speaker.label}
                accessibilityRole="button"
                accessibilityLabel={named ? `${name}. Change name` : `${name}. Name this speaker`}
                onPress={() => props.onSpeaker(speaker.label)}
                style={({ pressed }) => ({
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 6,
                  height: 32,
                  paddingHorizontal: 12,
                  borderRadius: 16,
                  borderWidth: 1,
                  borderStyle: named ? "solid" : "dashed",
                  borderColor: named ? c.border : c["border-strong"],
                  backgroundColor: pressed ? c.hover : c["surface-1"],
                })}
              >
                <Icon name="user-round" size={13} color={c["fg-muted"]} />
                <Text style={{ ...fontStyle(theme, 500), fontSize: 13, color: c.fg }}>{name}</Text>
                {!named ? <Icon name="pencil" size={11} color={c["fg-subtle"]} /> : null}
              </Pressable>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

function Turn(props: {
  turn: TranscriptTurn;
  speakers: RecordingSpeaker[];
  tracks: RecordingTrack[];
  onSpeaker: (label: string) => void;
}) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const { turn } = props;
  const name = speakerDisplayName(turn.speakerLabel, props.speakers, props.tracks);
  return (
    <View style={{ marginTop: 18 }}>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${name}. Name this speaker`}
          disabled={!turn.speakerLabel}
          onPress={() => turn.speakerLabel && props.onSpeaker(turn.speakerLabel)}
          hitSlop={8}
        >
          <Text style={{ ...fontStyle(theme, 600), fontSize: 14, color: c.fg }}>{name}</Text>
        </Pressable>
        <Text
          style={{
            ...fontStyle(theme),
            fontSize: 12,
            color: c["fg-subtle"],
            fontVariant: ["tabular-nums"],
          }}
        >
          {formatClock(turn.startMilliseconds)}
        </Text>
      </View>
      <Text
        selectable
        style={{ ...fontStyle(theme), fontSize: 16, lineHeight: 24, color: c.fg, marginTop: 4 }}
      >
        {turn.segments.map((segment) => segment.text.trim()).join(" ")}
      </Text>
    </View>
  );
}

function SheetTitle({ children }: { children: string }) {
  const theme = useNativeTimelineTheme();
  return (
    <Text
      accessibilityRole="header"
      style={{ ...fontStyle(theme, 600), fontSize: 17, color: theme.colors.fg, marginBottom: 12 }}
    >
      {children}
    </Text>
  );
}

function SheetInput(props: {
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
  accessibilityLabel: string;
  onSubmit: () => void;
  /** A person's name: capitalize each word and don't autocorrect it. */
  personName?: boolean;
}) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  return (
    <TextInput
      accessibilityLabel={props.accessibilityLabel}
      value={props.value}
      onChangeText={props.onChangeText}
      placeholder={props.placeholder}
      placeholderTextColor={c["fg-subtle"]}
      autoFocus
      {...(props.personName ? { autoCapitalize: "words" as const, autoCorrect: false } : {})}
      returnKeyType="done"
      onSubmitEditing={props.onSubmit}
      style={{
        ...fontStyle(theme),
        height: 44,
        paddingHorizontal: 12,
        fontSize: 16,
        color: c.fg,
        borderRadius: theme.radius.md,
        borderWidth: 1,
        borderColor: c.border,
        backgroundColor: c.bg,
      }}
    />
  );
}

function TitleSheet(props: {
  open: boolean;
  title: string;
  onClose: () => void;
  onSave: (title: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(props.title);
  const [saving, setSaving] = useState(false);
  const [opened, setOpened] = useState(false);
  if (props.open !== opened) {
    setOpened(props.open);
    if (props.open) setDraft(props.title);
  }
  const save = () => {
    const title = draft.trim();
    if (!title || saving) return;
    setSaving(true);
    void props
      .onSave(title)
      .catch(() => Alert.alert("Couldn't rename the meeting", "Try again in a moment."))
      .finally(() => setSaving(false));
  };
  return (
    <BottomSheet open={props.open} onClose={props.onClose} accessibilityLabel="Rename meeting">
      <View style={{ paddingHorizontal: 20, paddingBottom: 12 }}>
        <SheetTitle>Rename meeting</SheetTitle>
        <SheetInput
          accessibilityLabel="Meeting title"
          value={draft}
          onChangeText={setDraft}
          placeholder="Meeting title"
          onSubmit={save}
        />
        <Button
          label="Save"
          variant="primary"
          size="form"
          busy={saving}
          disabled={!draft.trim()}
          onPress={save}
          style={{ marginTop: 12 }}
        />
      </View>
    </BottomSheet>
  );
}

/* Name a speaker after someone in the people directory, or with a plain name. */
function SpeakerSheet(props: {
  label: string | null;
  speakers: RecordingSpeaker[];
  tracks: RecordingTrack[];
  scope: { client: object; workspaceId: string };
  onClose: () => void;
  onName: (label: string, name: { personId: string } | { name: string } | null) => Promise<void>;
}) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const open = props.label !== null;
  const people = useRecordingPeople({ ...props.scope, enabled: open });
  const [shownFor, setShownFor] = useState<string | null>(null);
  if (props.label !== shownFor) {
    setShownFor(props.label);
    setDraft("");
  }
  const label = props.label;
  const current = label ? props.speakers.find((speaker) => speaker.label === label) : undefined;
  const named = label ? speakerIsNamed(label, props.speakers) : false;
  const query = draft.trim().toLowerCase();
  const matches = people.people
    .filter((person) => !query || person.displayName.toLowerCase().includes(query))
    .slice(0, 8);
  const exact = people.people.some((person) => person.displayName.toLowerCase() === query);
  const apply = (name: { personId: string } | { name: string } | null) => {
    if (!label || saving) return;
    setSaving(true);
    void Haptics.selectionAsync();
    void props
      .onName(label, name)
      .catch(() => Alert.alert("Couldn't name the speaker", "Try again in a moment."))
      .finally(() => setSaving(false));
  };
  return (
    <BottomSheet open={open} onClose={props.onClose} accessibilityLabel="Name speaker">
      <View style={{ paddingHorizontal: 20, paddingBottom: 12 }}>
        <SheetTitle>
          {label
            ? named
              ? `Rename ${speakerDisplayName(label, props.speakers, props.tracks)}`
              : `Who is ${speakerDisplayName(label, props.speakers, props.tracks)}?`
            : "Name speaker"}
        </SheetTitle>
        <SheetInput
          accessibilityLabel="Speaker name"
          value={draft}
          onChangeText={setDraft}
          placeholder="Search people or type a name"
          personName
          onSubmit={() => {
            const name = draft.trim();
            if (!name) return;
            const person = people.people.find(
              (candidate) => candidate.displayName.toLowerCase() === name.toLowerCase(),
            );
            apply(person ? { personId: person.id } : { name });
          }}
        />
        <View style={{ marginTop: 8 }}>
          {matches.map((person) => (
            <Pressable
              key={person.id}
              accessibilityRole="button"
              onPress={() => apply({ personId: person.id })}
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: 10,
                minHeight: 44,
                paddingHorizontal: 4,
                borderRadius: theme.radius.sm,
                backgroundColor: pressed ? c.hover : "transparent",
              })}
            >
              <Icon name="user-round" size={15} color={c["fg-muted"]} />
              <Text style={{ ...fontStyle(theme), flex: 1, fontSize: 15, color: c.fg }}>
                {person.displayName}
              </Text>
              {current?.personId === person.id ? (
                <Icon name="check" size={15} color={c.fg} />
              ) : null}
            </Pressable>
          ))}
          {query && !exact ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => apply({ name: draft.trim() })}
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: 10,
                minHeight: 44,
                paddingHorizontal: 4,
                borderRadius: theme.radius.sm,
                backgroundColor: pressed ? c.hover : "transparent",
              })}
            >
              <Icon name="pencil" size={15} color={c["fg-muted"]} />
              <Text style={{ ...fontStyle(theme), flex: 1, fontSize: 15, color: c.fg }}>
                Use “{draft.trim()}”
              </Text>
            </Pressable>
          ) : null}
        </View>
        {named ? (
          <Button
            label="Clear name"
            variant="ghost"
            onPress={() => apply(null)}
            style={{ marginTop: 8, alignSelf: "flex-start" }}
          />
        ) : null}
        {saving ? <ActivityIndicator style={{ marginTop: 8 }} color={c["fg-muted"]} /> : null}
      </View>
    </BottomSheet>
  );
}

/** An SF Symbol name for a menu item's image (Android draws no image). */
function symbol(name: string): MenuAction["image"] {
  return name as MenuAction["image"];
}
