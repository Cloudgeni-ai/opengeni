import type { Recording, RecordingSpeaker, RecordingTrack } from "@opengeni/contracts";
import { useOpenGeniText } from "@opengeni/react/messages";
import {
  formatClock,
  formatDuration,
  groupTranscriptTurns,
  meetingHereStatus,
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
import { useMemo, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { BottomSheet, Button, fontStyle, Icon, useNativeTimelineTheme } from "../timeline";
import { meetingDateLabel } from "./phone-text";
import { isCapturing, useMeetingRecorder } from "./recorder";

export type MeetingActionId = "rename" | "visibility" | "rerun" | "delete";

/** One item for the screen's actions menu, which the host draws in its own header. */
export type MeetingAction = {
  id: MeetingActionId;
  title: string;
  /** An SF Symbol name, for an iOS menu. */
  systemImage: string;
  destructive?: boolean;
  disabled?: boolean;
};

export type UseMeetingViewOptions = {
  /** The SDK client. The `OpenGeniProvider`'s client otherwise. */
  client?: object;
  /** The workspace the meetings are in. The `OpenGeniProvider`'s workspace otherwise. */
  workspaceId?: string;
  recordingId: string | null;
  /** After the meeting is deleted, for example to go back. */
  onDeleted?: () => void;
  /** Host facts under the title, such as what the meeting belongs to. */
  details?: ReactNode;
  /** Space below the transcript, such as the bottom safe-area inset. */
  bottomInset?: number;
};

export type MeetingView = {
  recording: Recording | null;
  /** The actions menu's items, empty until the meeting loads. */
  actions: MeetingAction[];
  /** Run one of {@link actions}, from the host's menu. */
  runAction: (id: MeetingActionId) => void;
  /** The screen's body: title, status, speakers and transcript, and its sheets. */
  content: ReactNode;
};

type Sheet = { kind: "title" } | { kind: "speaker"; label: string } | null;

/**
 * One meeting: what it is, where its transcript is, and the transcript read as
 * turns. Speakers are named by tapping them. Reads the client and workspace from
 * the options or an `OpenGeniProvider`. The host renders `content` and puts `actions` in
 * its header's menu.
 */
export function useMeetingView({
  client,
  workspaceId,
  recordingId,
  onDeleted,
  details,
  bottomInset = 0,
}: UseMeetingViewOptions): MeetingView {
  const msg = useOpenGeniText();
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const scope = { ...(client ? { client } : {}), ...(workspaceId ? { workspaceId } : {}) };
  const meeting = useRecording(recordingId, scope);
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
  // Stopped on this phone, its last audio is on its way: that reads as Transcribing.
  const transcribingHere =
    recording?.state === "capturing" &&
    meetingHereStatus(recorder, recording.id) === "transcribing";
  const [sheet, setSheet] = useState<Sheet>(null);
  const [pulling, setPulling] = useState(false);
  const tracks = recording?.tracks ?? [];
  const turns = useMemo(() => groupTranscriptTurns(transcript.segments), [transcript.segments]);
  const tryAgain = msg("native.meetings.meetingView.tryAgainInAMoment");

  const actions: MeetingAction[] = recording
    ? [
        { id: "rename", title: msg("meetings.detailPage.rename"), systemImage: "pencil" },
        {
          id: "visibility",
          title:
            recording.visibility === "private"
              ? msg("native.meetings.meetingView.shareWithWorkspace")
              : msg("native.meetings.meetingView.makePrivate"),
          systemImage: recording.visibility === "private" ? "person.2" : "lock",
        },
        ...(phase?.kind === "ready" || phase?.kind === "failed"
          ? [
              {
                id: "rerun" as const,
                title: msg("meetings.detailPage.transcribeAgain"),
                systemImage: "arrow.clockwise",
              },
            ]
          : []),
        {
          id: "delete",
          title: msg("meetings.detailPage.deleteMeeting"),
          systemImage: "trash",
          destructive: true,
          ...(capturingHere ? { disabled: true } : {}),
        },
      ]
    : [];

  const runAction = (id: MeetingActionId) => {
    if (!recording) return;
    if (id === "rename") setSheet({ kind: "title" });
    if (id === "visibility") {
      const next = recording.visibility === "private" ? "workspace" : "private";
      void meeting
        .update({ visibility: next })
        .catch(() => Alert.alert(msg("meetings.detailPage.couldnTChangeWhoCan"), tryAgain));
    }
    if (id === "rerun") {
      Alert.alert(
        msg("native.meetings.meetingView.transcribeAgainQuestion"),
        msg("native.meetings.meetingView.aNewTranscriptIsMadeFromTheFullAudio"),
        [
          { text: msg("meetings.recorderPanel.cancel"), style: "cancel" },
          {
            text: msg("meetings.detailPage.transcribe"),
            onPress: () =>
              void meeting
                .rerun()
                .catch(() =>
                  Alert.alert(msg("meetings.detailPage.couldnTStartTranscribing"), tryAgain),
                ),
          },
        ],
      );
    }
    if (id === "delete") {
      Alert.alert(
        msg("meetings.deleteDialog.deleteMeeting"),
        msg("meetings.deleteDialog.thisDeletesTheAudioEvery"),
        [
          { text: msg("meetings.recorderPanel.cancel"), style: "cancel" },
          {
            text: msg("native.meetings.meetingView.delete"),
            style: "destructive",
            onPress: () => {
              void meeting
                .remove()
                .then(() => onDeleted?.())
                .catch(() =>
                  Alert.alert(msg("meetings.deleteDialog.couldnTDeleteThisMeeting"), tryAgain),
                );
            },
          },
        ],
      );
    }
  };

  const content = (
    <>
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
        contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: bottomInset + 40 }}
      >
        {!recording ? (
          meeting.error ? (
            <Text
              style={{ ...fontStyle(theme), fontSize: 15, color: c["fg-muted"], marginTop: 24 }}
            >
              {msg("native.meetings.meetingView.thisMeetingCouldntLoad")}
            </Text>
          ) : (
            <ActivityIndicator style={{ marginTop: 32 }} color={c["fg-muted"]} />
          )
        ) : (
          <>
            <Pressable
              accessibilityRole="button"
              accessibilityHint={msg("meetings.detailPage.rename")}
              onPress={() => setSheet({ kind: "title" })}
            >
              <Text
                accessibilityRole="header"
                style={{ ...fontStyle(theme, 600), fontSize: 24, lineHeight: 30, color: c.fg }}
              >
                {recording.title || msg("native.meetings.meetingsList.untitledMeeting")}
              </Text>
            </Pressable>
            <MetaLine recording={recording} />
            {details ? <View style={{ marginTop: 10 }}>{details}</View> : null}
            {capturingHere ? (
              <PhaseNote
                text={msg("native.meetings.meetingView.recordingNowTheTranscriptStarts")}
              />
            ) : phase?.kind === "uploading" && !transcribingHere ? (
              <PhaseNote
                spinning
                text={msg("native.meetings.meetingView.waitingForTheRestOfTheAudio")}
              />
            ) : phase?.kind === "transcribing" || transcribingHere ? (
              <PhaseNote spinning text={msg("native.meetings.meetingView.transcribingThisTakes")} />
            ) : phase?.kind === "failed" ? (
              <PhaseNote
                tone="danger"
                text={transcriptErrorText(phase.version?.errorCode ?? null, msg)}
              />
            ) : phase?.kind === "no_transcript" ? (
              <PhaseNote text={msg("meetings.detailPage.noTranscriptYet")} />
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
                    {msg("meetings.detailPage.noSpeechWasFoundIn")}
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

  return { recording, actions, runAction, content };
}

function MetaLine({ recording }: { recording: Recording }) {
  const msg = useOpenGeniText();
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const facts = [
    meetingDateLabel(msg, recording.startedAt),
    recording.durationMilliseconds ? formatDuration(recording.durationMilliseconds, msg) : null,
    recording.visibility === "private"
      ? msg("meetings.detailPage.onlyMe")
      : msg("meetings.detailPage.workspace"),
  ].filter(Boolean);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 6 }}>
      <Icon
        name={recording.visibility === "private" ? "lock" : "globe"}
        size={12}
        color={c["fg-subtle"]}
      />
      <Text style={{ ...fontStyle(theme), fontSize: 14, color: c["fg-muted"], flexShrink: 1 }}>
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
  const msg = useOpenGeniText();
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const version = props.recording.transcript!;
  return (
    <View style={{ marginTop: 20, gap: 10 }}>
      <Text style={{ ...fontStyle(theme), fontSize: 13, color: c["fg-subtle"] }}>
        {versionSummary(version, props.modelName, msg.locale).join(" · ")}
      </Text>
      {props.speakers.length > 0 ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {props.speakers.map((speaker) => {
            const name = speakerDisplayName(
              speaker.label,
              props.speakers,
              props.recording.tracks,
              msg,
            );
            const named = speakerIsNamed(speaker.label, props.speakers);
            return (
              <Pressable
                key={speaker.label}
                accessibilityRole="button"
                accessibilityLabel={
                  named
                    ? msg("meetings.detailPage.nameChangeWhoThisIs", { name })
                    : msg("meetings.detailPage.nameNameThisSpeaker", { name })
                }
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
  const msg = useOpenGeniText();
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const { turn } = props;
  const name = speakerDisplayName(turn.speakerLabel, props.speakers, props.tracks, msg);
  return (
    <View style={{ marginTop: 18 }}>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={msg("meetings.detailPage.nameNameThisSpeaker", { name })}
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
        minHeight: 44,
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
  const msg = useOpenGeniText();
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
      .catch(() =>
        Alert.alert(
          msg("meetings.detailPage.couldnTRenameThisMeeting2"),
          msg("native.meetings.meetingView.tryAgainInAMoment"),
        ),
      )
      .finally(() => setSaving(false));
  };
  return (
    <BottomSheet
      open={props.open}
      onClose={props.onClose}
      accessibilityLabel={msg("meetings.detailPage.renameMeeting")}
    >
      <View style={{ paddingHorizontal: 20, paddingBottom: 12 }}>
        <SheetTitle>{msg("meetings.detailPage.renameMeeting")}</SheetTitle>
        <SheetInput
          accessibilityLabel={msg("meetings.recorderPanel.meetingTitle")}
          value={draft}
          onChangeText={setDraft}
          placeholder={msg("meetings.recorderPanel.meetingTitle")}
          onSubmit={save}
        />
        <Button
          label={msg("meetings.detailPage.save")}
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
  scope: { client?: object; workspaceId?: string };
  onClose: () => void;
  onName: (label: string, name: { personId: string } | { name: string } | null) => Promise<void>;
}) {
  const msg = useOpenGeniText();
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
  const displayName = label ? speakerDisplayName(label, props.speakers, props.tracks, msg) : "";
  const query = draft.trim().toLowerCase();
  const matches = people.people
    .filter((person) => !query || person.displayName.toLowerCase().includes(query))
    .slice(0, 8);
  const exact = people.people.some((person) => person.displayName.toLowerCase() === query);
  const apply = (name: { personId: string } | { name: string } | null) => {
    if (!label || saving) return;
    setSaving(true);
    void props
      .onName(label, name)
      .catch(() =>
        Alert.alert(
          msg("meetings.detailPage.couldnTNameThisSpeaker"),
          msg("native.meetings.meetingView.tryAgainInAMoment"),
        ),
      )
      .finally(() => setSaving(false));
  };
  return (
    <BottomSheet
      open={open}
      onClose={props.onClose}
      accessibilityLabel={msg("native.meetings.meetingView.nameSpeaker")}
    >
      <View style={{ paddingHorizontal: 20, paddingBottom: 12 }}>
        <SheetTitle>
          {label
            ? named
              ? msg("native.meetings.meetingView.renameName", { name: displayName })
              : msg("meetings.transcript.whoIsDisplayname", { displayName })
            : msg("native.meetings.meetingView.nameSpeaker")}
        </SheetTitle>
        <SheetInput
          accessibilityLabel={msg("native.meetings.meetingView.speakerName")}
          value={draft}
          onChangeText={setDraft}
          placeholder={msg("native.meetings.meetingView.searchPeopleOrTypeAName")}
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
                {msg("native.meetings.meetingView.useName", { name: draft.trim() })}
              </Text>
            </Pressable>
          ) : null}
        </View>
        {named ? (
          <Button
            label={msg("meetings.transcript.removeName")}
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
