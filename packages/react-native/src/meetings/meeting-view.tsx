import type {
  Recording,
  RecordingPerson,
  RecordingSpeaker,
  RecordingTrack,
} from "@opengeni/contracts";
import { useOpenGeniText } from "@opengeni/react/messages";
import {
  formatClock,
  formatDuration,
  groupTranscriptTurns,
  meetingHereStatus,
  meetingPhase,
  meetingTitle,
  speakerDisplayName,
  speakerIsNamed,
  transcribingText,
  transcriptErrorText,
  useRecording,
  useRecordingModels,
  useRecordingPeople,
  useTranscript,
  versionSummary,
  type RecordingsClientOverride,
  type TranscriptTurn,
} from "@opengeni/react/recordings";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
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
  /** A recordings client to use instead of one over the SDK client, such as a host proxy or a preview. */
  recordings?: RecordingsClientOverride["recordings"];
  recordingId: string | null;
  /** After the meeting is deleted, for example to go back. */
  onDeleted?: () => void;
  /** Host facts under the title, such as what the meeting belongs to. */
  details?: ReactNode;
  /**
   * Extra space below the transcript, such as Android's bottom safe-area inset. On
   * iOS the transcript already keeps clear of the bars and the home indicator,
   * including a translucent header drawn over it.
   */
  bottomInset?: number;
  /**
   * Who is reading. Naming a speaker then offers "It's me", and naming
   * yourself offers to remember your voice so later meetings suggest you.
   */
  viewer?: { subjectId: string; name?: string | null } | null;
  /**
   * Whether the workspace recognizes people by voice. True offers to remember
   * voices and to confirm names suggested from them; false says, the first
   * time someone is named, that names aren't suggested later. Leave it out
   * when unknown.
   */
  voiceRecognition?: boolean;
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

/** A note over the bottom of the screen after naming a speaker. */
type VoiceNote =
  /** Remember this person's voice? Waits for an answer. */
  | { kind: "offer"; person: RecordingPerson; self: boolean }
  /** Names aren't suggested later: the workspace doesn't recognize voices. */
  | { kind: "off" }
  | { kind: "done"; text: string }
  /** A suggested name was turned down; Undo names them again. */
  | { kind: "dismissed"; label: string; personId: string };

/** How long a note that needs no answer stays. */
const NOTE_MILLISECONDS = 6_000;

/**
 * One meeting: what it is, where its transcript is, and the transcript read as
 * turns. Speakers are named by tapping them. Reads the client and workspace from
 * the options or an `OpenGeniProvider`. The host renders `content` and puts `actions` in
 * its header's menu.
 */
export function useMeetingView({
  client,
  workspaceId,
  recordings,
  recordingId,
  onDeleted,
  details,
  bottomInset = 0,
  viewer,
  voiceRecognition,
}: UseMeetingViewOptions): MeetingView {
  const msg = useOpenGeniText();
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const insets = useSafeAreaInsets();
  const scope = {
    ...(client ? { client } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(recordings ? { recordings } : {}),
  };
  const meeting = useRecording(recordingId, scope);
  const recording = meeting.recording;
  const phase = recording ? meetingPhase(recording) : null;
  const ready = phase?.kind === "ready";
  const transcript = useTranscript(ready ? recording!.id : null, {
    ...scope,
    refreshKey: recording?.transcript?.id,
  });
  // A failed transcript names its model too, to say which provider it needs.
  const models = useRecordingModels({ ...scope, enabled: ready || phase?.kind === "failed" });
  const version = recording?.transcript ?? null;
  const modelName = version
    ? (models.models.find(
        (candidate) =>
          candidate.providerId === version.providerId && candidate.model === version.model,
      )?.name ?? null)
    : null;
  const failedVersion = phase?.kind === "failed" ? (phase.version ?? null) : null;
  const failedModel = failedVersion
    ? (models.models.find(
        (candidate) =>
          candidate.providerId === failedVersion.providerId &&
          candidate.model === failedVersion.model,
      ) ?? null)
    : null;
  const recorder = useMeetingRecorder();
  const capturingHere = isCapturing(recorder) && recorder?.recordingId === recording?.id;
  // Stopped on this phone, its last audio is on its way: that reads as Transcribing.
  const here = recording?.state === "capturing" ? meetingHereStatus(recorder, recording.id) : null;
  const transcribingHere = here === "transcribing";
  const [sheet, setSheet] = useState<Sheet>(null);
  const [pulling, setPulling] = useState(false);
  const tracks = recording?.tracks ?? [];
  const turns = useMemo(() => groupTranscriptTurns(transcript.segments), [transcript.segments]);
  const tryAgain = msg("native.meetings.meetingView.tryAgainInAMoment");
  const viewerSubjectId = viewer?.subjectId ?? null;
  const people = useRecordingPeople({ ...scope, enabled: sheet?.kind === "speaker" });
  const [note, setNote] = useState<VoiceNote | null>(null);
  const [remembering, setRemembering] = useState(false);
  // Each person's voice is offered once on this screen, and "off" said once.
  const offeredVoices = useRef(new Set<string>());
  const toldOff = useRef(false);
  useEffect(() => {
    if (!note || note.kind === "offer") return;
    const timer = setTimeout(
      () => setNote((current) => (current === note ? null : current)),
      NOTE_MILLISECONDS,
    );
    return () => clearTimeout(timer);
  }, [note]);

  const isSelf = (person: RecordingPerson) =>
    viewerSubjectId !== null && person.memberSubjectId === viewerSubjectId;
  // A name teaches nothing until the person's voice may be remembered, so
  // naming someone offers it once. Another member decides for themselves.
  const afterNaming = (person: RecordingPerson | null) => {
    if (voiceRecognition === false) {
      if (!toldOff.current) {
        toldOff.current = true;
        setNote({ kind: "off" });
      }
      return;
    }
    if (!voiceRecognition || !person || person.voice || offeredVoices.current.has(person.id)) {
      return;
    }
    const self = isSelf(person);
    if (person.memberSubjectId && !self) return;
    offeredVoices.current.add(person.id);
    setNote({ kind: "offer", person, self });
  };
  const nameAs = async (label: string, person: RecordingPerson) => {
    await transcript.nameSpeaker(label, { personId: person.id });
    setSheet(null);
    afterNaming(person);
  };
  const rememberVoice = (person: RecordingPerson, after?: () => void) => {
    const self = isSelf(person);
    const remember = (consent: "self" | "attested") => {
      setRemembering(true);
      void people
        .rememberVoice(person.id, consent)
        .then(
          () => {
            after?.();
            setNote({
              kind: "done",
              text: self
                ? msg("meetings.detailPage.yourVoiceWillBeRemembered")
                : msg("meetings.detailPage.displaynameSVoiceWillBe", {
                    displayName: person.displayName,
                  }),
            });
          },
          () =>
            Alert.alert(
              self
                ? msg("meetings.detailPage.couldnTRememberYourVoice")
                : msg("meetings.detailPage.couldnTRememberThisVoice"),
              tryAgain,
            ),
        )
        .finally(() => setRemembering(false));
    };
    if (self) {
      remember("self");
      return;
    }
    // Someone from outside the workspace: only with their agreement.
    Alert.alert(
      msg("meetings.detailPage.rememberValueSVoice", { value: person.displayName }),
      msg("meetings.detailPage.onlyDoThisIfValue", { value: person.displayName }),
      [
        { text: msg("meetings.recorderPanel.cancel"), style: "cancel" },
        {
          text: msg("meetings.detailPage.theyAgreedRemember"),
          onPress: () => remember("attested"),
        },
      ],
    );
  };
  const speakerActions: SpeakerSheetActions = {
    pick: async (label, person) => await nameAs(label, person),
    confirm: async (label, personId) => {
      // A suggestion comes from a remembered voice, so there is nothing to offer.
      await transcript.nameSpeaker(label, { personId });
      setSheet(null);
    },
    add: async (label, displayName) => {
      // A new name joins the people directory, so their voice can be remembered too.
      const person = await people.create({ displayName });
      await nameAs(label, person);
    },
    nameSelf: viewer
      ? async (label) => {
          // The server returns the reader's existing entry if the list hasn't loaded yet.
          const me =
            people.people.find((person) => person.memberSubjectId === viewer.subjectId) ??
            (await people.create({
              displayName: viewer.name?.trim() || msg("meetings.detailPage.me"),
              memberSubjectId: viewer.subjectId,
            }));
          await nameAs(label, me);
        }
      : null,
    clear: async (label) => {
      await transcript.nameSpeaker(label, null);
      setSheet(null);
    },
    reject: async (label) => {
      const personId = transcript.speakers.find((speaker) => speaker.label === label)?.personId;
      await transcript.rejectSuggestion(label);
      setSheet(null);
      if (personId) setNote({ kind: "dismissed", label, personId });
    },
    remember: voiceRecognition ? (person) => rememberVoice(person, () => setSheet(null)) : null,
    forget: voiceRecognition
      ? async (person) => {
          await people.forgetVoice(person.id);
          // Forgetting also takes back the names it suggested in this meeting.
          await transcript.refresh();
          setSheet(null);
          setNote({
            kind: "done",
            text: isSelf(person)
              ? msg("meetings.detailPage.yourVoiceIsForgotten")
              : msg("meetings.detailPage.displaynameSVoiceIsForgotten", {
                  displayName: person.displayName,
                }),
          });
        }
      : null,
  };

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
    <View style={{ flex: 1 }}>
      <ScrollView
        style={{ flex: 1, backgroundColor: c.bg }}
        contentInsetAdjustmentBehavior="automatic"
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
                {meetingTitle(recording, msg)}
              </Text>
            </Pressable>
            <MetaLine recording={recording} />
            {details ? <View style={{ marginTop: 10 }}>{details}</View> : null}
            {here === "recording" || here === "paused" ? (
              <PhaseNote
                text={msg("native.meetings.meetingView.recordingNowTheTranscriptStarts")}
              />
            ) : phase?.kind === "uploading" && !transcribingHere ? (
              <PhaseNote
                spinning
                text={msg("native.meetings.meetingView.waitingForTheRestOfTheAudio")}
              />
            ) : phase?.kind === "transcribing" || transcribingHere ? (
              <PhaseNote spinning text={transcribingText(recording.durationMilliseconds, msg)} />
            ) : phase?.kind === "failed" ? (
              <PhaseNote
                tone="danger"
                text={transcriptErrorText(
                  phase.version?.errorCode ?? null,
                  msg,
                  failedModel
                    ? {
                        modelName: failedModel.name,
                        providerName: failedModel.providerName,
                        funding: failedModel.funding,
                        pinned: models.pinned,
                      }
                    : null,
                )}
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
            people={people.people}
            viewerSubjectId={viewerSubjectId}
            onClose={() => setSheet(null)}
            actions={speakerActions}
          />
        </>
      ) : null}
      {note ? (
        <VoiceNoteCard
          note={note}
          bottom={Math.max(bottomInset, insets.bottom) + 12}
          remembering={remembering}
          onRemember={(person) => rememberVoice(person)}
          onUndo={(label, personId) => {
            setNote(null);
            void transcript
              .nameSpeaker(label, { personId })
              .catch(() =>
                Alert.alert(msg("meetings.detailPage.couldnTNameThisSpeaker"), tryAgain),
              );
          }}
          onDismiss={() => setNote(null)}
        />
      ) : null}
    </View>
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
            // A name suggested from a voice is dashed like an unnamed one until confirmed.
            const suggested = speaker.source === "suggested" && Boolean(speaker.personId);
            return (
              <Pressable
                key={speaker.label}
                accessibilityRole="button"
                accessibilityLabel={
                  suggested
                    ? msg("meetings.detailPage.nameSuggestedFromTheirVoice", { name })
                    : named
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
                  borderStyle: named && !suggested ? "solid" : "dashed",
                  borderColor: named && !suggested ? c.border : c["border-strong"],
                  backgroundColor: pressed ? c.hover : c["surface-1"],
                })}
              >
                <Icon name="user-round" size={13} color={c["fg-muted"]} />
                <Text style={{ ...fontStyle(theme, 500), fontSize: 13, color: c.fg }}>{name}</Text>
                {suggested ? (
                  <Text style={{ ...fontStyle(theme), fontSize: 12, color: c["fg-muted"] }}>?</Text>
                ) : !named ? (
                  <Icon name="pencil" size={11} color={c["fg-subtle"]} />
                ) : null}
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
  const speaker = props.speakers.find((candidate) => candidate.label === turn.speakerLabel);
  const suggested = speaker?.source === "suggested" && Boolean(speaker.personId);
  return (
    <View style={{ marginTop: 18 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            suggested
              ? msg("meetings.detailPage.nameSuggestedFromTheirVoice", { name })
              : turn.speakerLabel && speakerIsNamed(turn.speakerLabel, props.speakers)
                ? msg("meetings.detailPage.nameChangeWhoThisIs", { name })
                : msg("meetings.detailPage.nameNameThisSpeaker", { name })
          }
          disabled={!turn.speakerLabel}
          onPress={() => turn.speakerLabel && props.onSpeaker(turn.speakerLabel)}
          hitSlop={8}
          style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
        >
          <Text style={{ ...fontStyle(theme, 600), fontSize: 14, color: c.fg }}>{name}</Text>
          {suggested ? (
            <View
              style={{
                paddingHorizontal: 6,
                borderRadius: 8,
                borderWidth: 1,
                borderStyle: "dashed",
                borderColor: c["border-strong"],
              }}
            >
              <Text
                style={{ ...fontStyle(theme), fontSize: 11, lineHeight: 16, color: c["fg-muted"] }}
              >
                {msg("meetings.transcript.suggested")}
              </Text>
            </View>
          ) : null}
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
  /** Open the keyboard at once (the default). */
  autoFocus?: boolean;
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
      autoFocus={props.autoFocus ?? true}
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

type SpeakerSheetActions = {
  /** Name the speaker after someone in the people directory. */
  pick: (label: string, person: RecordingPerson) => Promise<void>;
  /** Confirm the name suggested from the speaker's voice. */
  confirm: (label: string, personId: string) => Promise<void>;
  /** Add someone new to the people directory and name the speaker after them. */
  add: (label: string, displayName: string) => Promise<void>;
  /** "It's me". Null without a reader. */
  nameSelf: ((label: string) => Promise<void>) | null;
  clear: (label: string) => Promise<void>;
  /** Turn down a name suggested from a voice. */
  reject: (label: string) => Promise<void>;
  /** Null when the workspace doesn't recognize people by voice. */
  remember: ((person: RecordingPerson) => void) | null;
  forget: ((person: RecordingPerson) => Promise<void>) | null;
};

/*
 * "Who is Speaker 2?": me, someone in the people directory, or someone new. A
 * name suggested from a voice is confirmed or turned down here, and a named
 * person's voice remembered or forgotten.
 */
function SpeakerSheet(props: {
  label: string | null;
  speakers: RecordingSpeaker[];
  tracks: RecordingTrack[];
  people: RecordingPerson[];
  viewerSubjectId: string | null;
  onClose: () => void;
  actions: SpeakerSheetActions;
}) {
  const msg = useOpenGeniText();
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [shownFor, setShownFor] = useState<string | null>(null);
  if (props.label !== shownFor) {
    setShownFor(props.label);
    setDraft("");
  }
  const { label, actions, people, viewerSubjectId } = props;
  const current = label ? props.speakers.find((speaker) => speaker.label === label) : undefined;
  const named = label ? speakerIsNamed(label, props.speakers) : false;
  const suggested = current?.source === "suggested" && current.personId ? current : null;
  const displayName = label ? speakerDisplayName(label, props.speakers, props.tracks, msg) : "";
  const isMe = (person: RecordingPerson) =>
    viewerSubjectId !== null && person.memberSubjectId === viewerSubjectId;
  const currentPerson = current?.personId
    ? (people.find((person) => person.id === current.personId) ?? null)
    : null;
  const query = draft.trim().toLowerCase();
  // Until a search, the reader is "It's me" and a suggested person is the question above.
  const matches = people
    .filter((person) =>
      query
        ? person.displayName.toLowerCase().includes(query)
        : !(actions.nameSelf && isMe(person)) && person.id !== suggested?.personId,
    )
    .slice(0, 8);
  const exact = people.some((person) => person.displayName.toLowerCase() === query);
  const tryAgain = msg("native.meetings.meetingView.tryAgainInAMoment");
  const run = (failure: string, work: (label: string) => Promise<void>) => {
    if (!label || saving) return;
    setSaving(true);
    void work(label)
      .catch(() => Alert.alert(failure, tryAgain))
      .finally(() => setSaving(false));
  };
  const naming = msg("meetings.detailPage.couldnTNameThisSpeaker");
  const submit = () => {
    const name = draft.trim();
    if (!name) return;
    const person = people.find(
      (candidate) => candidate.displayName.toLowerCase() === name.toLowerCase(),
    );
    run(naming, (at) => (person ? actions.pick(at, person) : actions.add(at, name)));
  };
  const self = currentPerson ? isMe(currentPerson) : false;
  // Until the directory says who a named speaker is, it might already be me.
  const offerSelf = Boolean(actions.nameSelf) && !self && !(current?.personId && !currentPerson);
  // Members decide about their own voice, so another member's offers nothing.
  const voicePerson =
    !suggested && currentPerson && (self || !currentPerson.memberSubjectId) ? currentPerson : null;
  const { remember, forget } = actions;
  const muted = { ...fontStyle(theme), fontSize: 13, lineHeight: 18, color: c["fg-muted"] };
  return (
    <BottomSheet
      open={label !== null}
      onClose={props.onClose}
      accessibilityLabel={msg("native.meetings.meetingView.nameSpeaker")}
    >
      <ScrollView
        keyboardShouldPersistTaps="handled"
        style={{ flexGrow: 0 }}
        contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 12 }}
      >
        {suggested ? (
          <>
            <SheetTitle>{msg("meetings.transcript.isThisDisplayname", { displayName })}</SheetTitle>
            <Text style={{ ...muted, marginTop: -8, marginBottom: 4 }}>
              {suggested.confidence === null
                ? msg("meetings.transcript.suggestedBecauseTheVoiceSounds2")
                : msg("meetings.transcript.suggestedBecauseTheVoiceSounds", {
                    suggestionMatch: msg("meetings.transcript.valueMatch", {
                      value: Math.round(Math.max(0, Math.min(1, suggested.confidence)) * 100),
                    }),
                  })}
            </Text>
            <SheetRow
              icon="check"
              label={msg("meetings.transcript.yesItSDisplayname", { displayName })}
              strong
              onPress={() =>
                run(msg("meetings.transcript.couldnTConfirmThisName"), (at) =>
                  actions.confirm(at, suggested.personId!),
                )
              }
            />
            <SheetRow
              icon="x"
              label={msg("meetings.transcript.noLeaveUnnamed")}
              onPress={() => run(msg("meetings.transcript.couldnTTurnDownThis"), actions.reject)}
            />
            <Text style={{ ...muted, marginTop: 16, marginBottom: 8 }}>
              {msg("meetings.transcript.orPickWhoItIs")}
            </Text>
          </>
        ) : (
          <SheetTitle>
            {label
              ? named
                ? msg("native.meetings.meetingView.renameName", { name: displayName })
                : msg("meetings.transcript.whoIsDisplayname", { displayName })
              : msg("native.meetings.meetingView.nameSpeaker")}
          </SheetTitle>
        )}
        <SheetInput
          accessibilityLabel={msg("native.meetings.meetingView.speakerName")}
          value={draft}
          onChangeText={setDraft}
          placeholder={msg("native.meetings.meetingView.searchPeopleOrTypeAName")}
          personName
          // A suggestion is answered with a tap; the keyboard would cover it.
          autoFocus={!suggested}
          onSubmit={submit}
        />
        <View style={{ marginTop: 8 }}>
          {offerSelf && !query ? (
            <SheetRow
              icon="user-round"
              label={msg("meetings.transcript.itSMe")}
              strong
              onPress={() => run(naming, actions.nameSelf!)}
            />
          ) : null}
          {matches.map((person) => (
            <SheetRow
              key={person.id}
              icon="user-round"
              label={person.displayName}
              checked={current?.personId === person.id && !suggested}
              onPress={() => run(naming, (at) => actions.pick(at, person))}
            />
          ))}
          {query && !exact ? (
            <SheetRow
              icon="pencil"
              label={msg("native.meetings.meetingView.useName", { name: draft.trim() })}
              onPress={submit}
            />
          ) : null}
          {named && !suggested ? (
            <SheetRow
              icon="x"
              label={msg("meetings.transcript.removeName")}
              onPress={() => run(msg("meetings.transcript.couldnTClearThisName"), actions.clear)}
            />
          ) : null}
        </View>
        {voicePerson && remember && forget ? (
          <View
            style={{
              marginTop: 12,
              paddingTop: 12,
              borderTopWidth: 1,
              borderTopColor: c.border,
            }}
          >
            <Text style={muted}>
              {voicePerson.voice
                ? msg("meetings.transcript.usedToSuggestNamesIn")
                : self
                  ? msg("meetings.detailPage.rememberYourVoiceAndLater")
                  : msg("meetings.detailPage.rememberTheirVoiceAndLater")}
            </Text>
            {voicePerson.voice ? (
              <SheetRow
                icon="audio-lines"
                label={
                  self
                    ? msg("meetings.transcript.forgetMyVoice")
                    : msg("meetings.transcript.forgetDisplaynameSVoice", {
                        displayName: voicePerson.displayName,
                      })
                }
                onPress={() =>
                  run(msg("meetings.transcript.couldnTForgetThisVoice"), () => forget(voicePerson))
                }
              />
            ) : (
              <SheetRow
                icon="audio-lines"
                label={
                  self
                    ? msg("meetings.transcript.rememberMyVoice")
                    : msg("meetings.transcript.rememberDisplaynameSVoice", {
                        displayName: voicePerson.displayName,
                      })
                }
                onPress={() => remember(voicePerson)}
              />
            )}
          </View>
        ) : null}
        {saving ? <ActivityIndicator style={{ marginTop: 8 }} color={c["fg-muted"]} /> : null}
      </ScrollView>
    </BottomSheet>
  );
}

function SheetRow(props: {
  icon: "check" | "x" | "user-round" | "pencil" | "audio-lines";
  label: string;
  onPress: () => void;
  /** A check at the end: the speaker is named after this person. */
  checked?: boolean;
  /** The row answers the sheet's question. */
  strong?: boolean;
}) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={props.checked ? { selected: true } : {}}
      onPress={props.onPress}
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
      <Icon name={props.icon} size={15} color={props.strong ? c.fg : c["fg-muted"]} />
      <Text
        style={{
          ...fontStyle(theme, props.strong ? 500 : 400),
          flex: 1,
          fontSize: 15,
          color: c.fg,
        }}
      >
        {props.label}
      </Text>
      {props.checked ? <Icon name="check" size={15} color={c.fg} /> : null}
    </Pressable>
  );
}

/*
 * After naming someone: "Named you. Remember my voice?", what changed, or Undo.
 * Floats over the bottom of the screen; only an offer waits to be answered.
 */
function VoiceNoteCard(props: {
  note: VoiceNote;
  bottom: number;
  remembering: boolean;
  onRemember: (person: RecordingPerson) => void;
  onUndo: (label: string, personId: string) => void;
  onDismiss: () => void;
}) {
  const msg = useOpenGeniText();
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const { note } = props;
  const title =
    note.kind === "offer"
      ? note.self
        ? msg("meetings.detailPage.namedYou")
        : msg("meetings.detailPage.namedDisplayname", { displayName: note.person.displayName })
      : note.kind === "off"
        ? msg("meetings.detailPage.namesArenTSuggestedIn")
        : note.kind === "dismissed"
          ? msg("meetings.detailPage.suggestionDismissed")
          : note.text;
  const body =
    note.kind === "offer"
      ? note.self
        ? msg("meetings.detailPage.rememberYourVoiceAndLater")
        : msg("meetings.detailPage.rememberTheirVoiceAndLater")
      : note.kind === "off"
        ? msg("meetings.detailPage.voiceRecognitionIsOffIn")
        : note.kind === "dismissed"
          ? msg("meetings.detailPage.thisSpeakerIsUnnamedAgain")
          : null;
  useEffect(() => {
    AccessibilityInfo.announceForAccessibility(body ? `${title}. ${body}` : title);
  }, [title, body]);
  return (
    <View
      pointerEvents="box-none"
      style={{ position: "absolute", left: 12, right: 12, bottom: props.bottom }}
    >
      <View
        accessibilityLabel={body ? `${title}. ${body}` : title}
        style={{
          padding: 14,
          borderRadius: theme.radius.lg,
          borderWidth: 1,
          borderColor: c.border,
          backgroundColor: c.bg,
          shadowColor: "#000",
          shadowOpacity: 0.12,
          shadowRadius: 16,
          shadowOffset: { width: 0, height: 4 },
          elevation: 8,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 10 }}>
          <View style={{ paddingTop: 2 }}>
            <Icon
              name={note.kind === "done" ? "check" : "audio-lines"}
              size={16}
              color={c["fg-muted"]}
            />
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={{ ...fontStyle(theme, 600), fontSize: 15, lineHeight: 20, color: c.fg }}>
              {title}
            </Text>
            {body ? (
              <Text
                style={{ ...fontStyle(theme), fontSize: 14, lineHeight: 20, color: c["fg-muted"] }}
              >
                {body}
              </Text>
            ) : null}
          </View>
          {note.kind === "dismissed" ? (
            <Button
              label={msg("meetings.detailPage.undo")}
              onPress={() => props.onUndo(note.label, note.personId)}
            />
          ) : note.kind !== "offer" ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={msg("native.timeline.sheet.close")}
              hitSlop={10}
              onPress={props.onDismiss}
            >
              <Icon name="x" size={16} color={c["fg-subtle"]} />
            </Pressable>
          ) : null}
        </View>
        {note.kind === "offer" ? (
          <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
            <Button
              label={msg("native.meetings.meetingView.notNow")}
              variant="ghost"
              size="form"
              onPress={props.onDismiss}
            />
            <Button
              label={
                note.self
                  ? msg("meetings.detailPage.rememberMyVoice")
                  : msg("meetings.detailPage.rememberVoice")
              }
              variant="primary"
              size="form"
              busy={props.remembering}
              onPress={() => props.onRemember(note.person)}
            />
          </View>
        ) : null}
      </View>
    </View>
  );
}
