/**
 * One meeting's own page: back to Meetings, the title with who can see it,
 * Summary · Transcript · Notepad under it, then the player and the open tab.
 * Summary is the written notes (with mention chips and Copy), Transcript the
 * turns as speaker bubbles, Notepad what people jotted down; Summary and
 * Transcript end with "Ask about this meeting" when the host answers it. The
 * quiet card on the right names the speakers and says which transcript
 * version this is, with Transcribe again.
 *
 * Until the transcript exists the page says where the meeting is: still
 * recording here (with Pause and Stop, so taking notes never hides it), not
 * finished yet on another device, transcribing, or failed with the reason and
 * what to try. Audio uploads while it records, so after Stop it reads
 * Transcribing, not Uploading.
 */
import { useOpenGeniText, createOpenGeniText, type OpenGeniText } from "../messages/runtime";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AudioLinesIcon,
  CheckIcon,
  ChevronDownIcon,
  GlobeIcon,
  LoaderCircleIcon,
  LockIcon,
  PencilIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";
import { toast } from "sonner";
import type {
  Recording,
  RecordingNote,
  RecordingPerson,
  RecordingTranscriptVersion,
  RecordingVisibility,
} from "@opengeni/contracts";
import {
  activeSegmentIndex,
  defaultSpeakerName,
  formatDuration,
  languageName,
  meetingHereStatus,
  meetingPhase,
  ownerLiveLaneName,
  speakerColorSlots,
  speakerDisplayName,
  speakerIsNamed,
  meetingTitle,
  transcriptErrorText,
  useRecording,
  useRecordingModels,
  useRecordingNotes,
  useRecordingPeople,
  useRecordingsClient,
  useLiveTranscript,
  useTranscript,
  type MeetingHereStatus,
  type RecordingsClientOverride,
} from "../recordings";

import { Button } from "../ui/button";
import { ConfirmDialog } from "../ui/confirm-dialog";
import {
  DetailAside,
  DetailAsideItem,
  DetailMeta,
  DetailPage,
  DetailPageBody,
  DetailPageHeader,
} from "../ui/detail-page";
import { DetailSection } from "../ui/detail-sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { EmptyState } from "../ui/empty-state";
import { ErrorMessage } from "../ui/error-message";
import { Field, FieldStack, TextInput } from "../ui/field";
import { FormDialog } from "../ui/form-dialog";
import { MoreMenu } from "../ui/page-actions";
import { Notice } from "../ui/notice";
import { formatAbsoluteTime } from "../ui/relative-time";
import { SegmentedControl } from "../ui/segmented-control";
import { NativeSelect, type SelectOption } from "../ui/select-menu";
import { Skeleton } from "../ui/skeleton";
import { cn } from "../app/lib/utils";

import { DeleteMeetingDialog } from "./delete-meeting-dialog";
import { DETECT_LANGUAGE, meetingLanguageOptions } from "./meeting-languages";
import {
  MeetingPlayer,
  type MeetingPlayerHandle,
  type MeetingPlayerSource,
} from "./meeting-player";
import {
  MeetingTranscript,
  NewSpeakerNameDialog,
  SpeakerDot,
  SpeakerNameMenu,
  speakerIsSuggested,
  type TranscriptActions,
} from "./meeting-transcript";
import {
  liveSpeakerName,
  RecordingBar,
  recorderLiveLines,
  uploadLine,
  useOnline,
} from "./recorder-panel";
import { LiveTranscript, liveStatus } from "./live-transcript";
import { MeetingAsk, type MeetingAskResult } from "./meeting-ask";
import { meetingMentionResolver } from "./meeting-mentions";
import { MeetingNotepad, MeetingNotesSection, MeetingSummary } from "./meeting-notes";
import { useMeetingRecorder, type MeetingRecorder } from "./recorder-context";
import { MeetingsOverlayScope } from "./overlay-scope";

const defaultText = createOpenGeniText();

function errorText(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

function isNotFound(error: Error | null): boolean {
  return Boolean(error && /not found|404/iu.test(error.message));
}

/** Fresh playback links for every prepared track. Links expire, so a failed one refetches. */
function useTrackSources(
  recording: Recording | null,
  getAudio: (trackNumber: number) => Promise<{ url: string }>,
): { sources: MeetingPlayerSource[]; reload: () => void } {
  const [sources, setSources] = useState<MeetingPlayerSource[]>([]);
  const [generation, setGeneration] = useState(0);
  const playable = useMemo(
    () =>
      (recording?.tracks ?? []).filter((track) => track.playable).map((track) => track.trackNumber),
    [recording?.tracks],
  );
  const key = playable.join(",");
  const getAudioRef = useRef(getAudio);
  getAudioRef.current = getAudio;
  useEffect(() => {
    if (!key) {
      setSources([]);
      return;
    }
    let cancelled = false;
    void Promise.all(
      key.split(",").map(async (value) => {
        const trackNumber = Number(value);
        try {
          const audio = await getAudioRef.current(trackNumber);
          return { trackNumber, url: audio.url };
        } catch {
          return null;
        }
      }),
    ).then((loaded) => {
      if (!cancelled) {
        setSources(loaded.filter((source): source is MeetingPlayerSource => source !== null));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [key, generation]);
  const reload = useCallback(() => setGeneration((value) => value + 1), []);
  return { sources, reload };
}

function RenameDialog({
  open,
  title,
  onClose,
  onRename,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  onRename: (title: string) => Promise<void>;
}) {
  const msg = useOpenGeniText();
  const [value, setValue] = useState(title);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setValue(title);
      setError(null);
    }
  }, [open, title]);
  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={msg("meetings.detailPage.renameMeeting")}
      submitLabel={msg("meetings.detailPage.save")}
      pendingLabel={msg("meetings.detailPage.saving")}
      submitDisabled={!value.trim() || value.trim() === title}
      error={error}
      onSubmit={async () => {
        try {
          await onRename(value.trim());
        } catch (cause) {
          setError(errorText(cause) ?? msg("meetings.detailPage.couldnTRenameThisMeeting"));
          return false;
        }
      }}
      onSubmitted={onClose}
    >
      <FieldStack>
        <Field label={msg("meetings.detailPage.title")}>
          <TextInput
            value={value}
            maxLength={300}
            onChange={(event) => setValue(event.target.value)}
          />
        </Field>
      </FieldStack>
    </FormDialog>
  );
}

function TranscribeAgainDialog({
  open,
  recording,
  models,
  defaultModel,
  onClose,
  onRun,
}: {
  open: boolean;
  recording: Recording;
  models: ReturnType<typeof useRecordingModels>["models"];
  defaultModel: ReturnType<typeof useRecordingModels>["defaultModel"];
  onClose: () => void;
  onRun: (options: {
    providerId: string;
    model: string;
    /** Null detects it, even when the workspace names a meeting language. */
    language: string | null;
    maxSpeakers?: number;
  }) => Promise<void>;
}) {
  const msg = useOpenGeniText();
  const current = recording.transcript;
  const initialModel = current
    ? `${current.providerId}/${current.model}`
    : defaultModel
      ? `${defaultModel.providerId}/${defaultModel.model}`
      : "";
  const [model, setModel] = useState(initialModel);
  const [language, setLanguage] = useState<string>(
    recording.transcription.language ?? DETECT_LANGUAGE,
  );
  const [speakers, setSpeakers] = useState(
    recording.transcription.maxSpeakers ? String(recording.transcription.maxSpeakers) : "",
  );
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setModel(initialModel);
      setError(null);
    }
  }, [open, initialModel]);
  const modelOptions: SelectOption[] = models.map((entry) => ({
    value: `${entry.providerId}/${entry.model}`,
    label: entry.name,
    meta:
      entry.usdPerHour !== null
        ? msg("meetings.detailPage.valuePerHour", { value: entry.usdPerHour.toFixed(2) })
        : entry.providerName,
    disabled: !entry.available,
    disabledReason: entry.available
      ? undefined
      : msg("meetings.detailPage.connectProvidernameFirst", { providerName: entry.providerName }),
  }));
  const selected = models.find((entry) => `${entry.providerId}/${entry.model}` === model);
  const estimate =
    selected?.usdPerHour != null && recording.durationMilliseconds > 0
      ? (selected.usdPerHour * recording.durationMilliseconds) / 3_600_000
      : null;
  const languageOptions = meetingLanguageOptions(language, undefined, msg);
  const speakerCount = speakers.trim() ? Number(speakers) : undefined;
  const speakersInvalid =
    speakerCount !== undefined &&
    (!Number.isInteger(speakerCount) || speakerCount < 1 || speakerCount > 32);
  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={msg("meetings.detailPage.transcribeAgain")}
      description={msg("meetings.detailPage.makesANewVersionFrom")}
      submitLabel={msg("meetings.detailPage.transcribe")}
      pendingLabel={msg("meetings.detailPage.starting")}
      submitDisabled={!selected || !selected.available || speakersInvalid}
      error={error}
      onSubmit={async () => {
        if (!selected) return false;
        try {
          await onRun({
            providerId: selected.providerId,
            model: selected.model,
            language: language === DETECT_LANGUAGE ? null : language,
            ...(speakerCount !== undefined ? { maxSpeakers: speakerCount } : {}),
          });
        } catch (cause) {
          setError(errorText(cause) ?? msg("meetings.detailPage.couldnTStartTranscribing"));
          return false;
        }
      }}
      onSubmitted={onClose}
    >
      <FieldStack>
        <Field
          label={msg("meetings.detailPage.model")}
          hint={
            estimate !== null
              ? estimate < 0.01
                ? msg("meetings.detailPage.aboutLessThan001", {
                    duration: formatDuration(recording.durationMilliseconds, msg),
                  })
                : msg("meetings.detailPage.aboutEstimateForThisDuration", {
                    estimate: estimate.toFixed(2),
                    duration: formatDuration(recording.durationMilliseconds, msg),
                  })
              : undefined
          }
        >
          <NativeSelect options={modelOptions} value={model} onValueChange={setModel} />
        </Field>
        <Field
          label={msg("meetings.detailPage.language")}
          hint={msg("meetings.detailPage.setItWhenTheMeeting")}
        >
          <NativeSelect options={languageOptions} value={language} onValueChange={setLanguage} />
        </Field>
        {selected?.capabilities.diarization ? (
          <Field
            label={msg("meetings.detailPage.maximumNumberOfSpeakers")}
            optional
            hint={msg("meetings.detailPage.leaveEmptyToLetThe")}
            error={speakersInvalid ? msg("meetings.detailPage.enterAWholeNumberFrom") : undefined}
          >
            <TextInput
              inputMode="numeric"
              value={speakers}
              placeholder={msg("meetings.detailPage.auto")}
              onChange={(event) => setSpeakers(event.target.value.replace(/[^0-9]/gu, ""))}
              className="max-w-24"
            />
          </Field>
        ) : null}
      </FieldStack>
    </FormDialog>
  );
}

function VisibilityMenu({
  visibility,
  onChange,
}: {
  visibility: RecordingVisibility;
  onChange: (visibility: RecordingVisibility) => void;
}) {
  const msg = useOpenGeniText();
  const options: Array<{ value: RecordingVisibility; label: string; description: string }> = [
    {
      value: "private",
      label: msg("meetings.detailPage.onlyMe"),
      description: msg("meetings.detailPage.onlyYouCanOpenIt"),
    },
    {
      value: "workspace",
      label: msg("meetings.detailPage.workspace"),
      description: msg("meetings.detailPage.everyoneInThisWorkspaceCan"),
    },
  ];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="rounded-[10px] pointer-coarse:h-11"
          aria-label={msg("meetings.detailPage.whoCanSeeThisValue", {
            value:
              visibility === "private"
                ? msg("meetings.detailPage.onlyMe")
                : msg("meetings.detailPage.workspace"),
          })}
        >
          {visibility === "private" ? (
            <LockIcon aria-hidden="true" />
          ) : (
            <GlobeIcon aria-hidden="true" />
          )}
          {visibility === "private"
            ? msg("meetings.detailPage.onlyMe")
            : msg("meetings.detailPage.workspace")}
          <ChevronDownIcon aria-hidden="true" className="text-fg-subtle" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        {options.map((option) => (
          <DropdownMenuItem
            key={option.value}
            onSelect={() => {
              if (option.value !== visibility) onChange(option.value);
            }}
            className="items-start"
          >
            <span className="grid min-w-0 flex-1 gap-0.5">
              <span className="text-sm leading-5 text-fg">{option.label}</span>
              <span className="text-xs leading-4.5 text-fg-muted">{option.description}</span>
            </span>
            {option.value === visibility ? (
              <CheckIcon aria-hidden="true" className="mt-0.5 text-brand" />
            ) : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const SPINNER = (
  <LoaderCircleIcon aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
);

function PhaseNotice({
  recording,
  recorder,
  here,
  recordingElsewhere,
  onRetry,
}: {
  recording: Recording;
  recorder: MeetingRecorder | null;
  /** What this device's recorder knows about the meeting; null when it isn't recording it. */
  here: MeetingHereStatus | null;
  /** It's captured on another device with the live preview on. */
  recordingElsewhere: boolean;
  onRetry: () => void;
}) {
  const msg = useOpenGeniText();
  const phase = meetingPhase(recording);
  if (phase.kind === "uploading" && recorder && (here === "recording" || here === "paused")) {
    return <RecordingBar recorder={recorder} />;
  }
  if (phase.kind === "uploading" && here === "waiting_for_connection") {
    return (
      <Notice tone="waiting" live="polite">
        {msg("meetings.recorderPanel.notUploadingNoConnectionThe")}
      </Notice>
    );
  }
  if (phase.kind === "uploading" && recorder && here === "upload_failed") {
    return (
      <Notice tone="failed" live="polite">
        {uploadLine(recorder, true, msg)}
      </Notice>
    );
  }
  if (phase.kind === "uploading" && here !== "transcribing") {
    return (
      <Notice
        tone="waiting"
        icon={SPINNER}
        title={msg("meetings.detailPage.notFinishedYet")}
        live="polite"
      >
        {recordingElsewhere
          ? msg("meetings.detailPage.itSStillBeingRecorded")
          : msg("meetings.detailPage.theAudioIsOnThe")}
      </Notice>
    );
  }
  if (phase.kind === "transcribing" || phase.kind === "uploading") {
    return (
      <Notice tone="waiting" icon={SPINNER} live="polite">
        {msg("meetings.detailPage.transcribingThisUsuallyTakesA")}
      </Notice>
    );
  }
  if (phase.kind === "failed") {
    return (
      <Notice
        tone="failed"
        title={msg("meetings.detailPage.theTranscriptFailed")}
        action={
          <Button type="button" size="sm" variant="outline" onClick={onRetry}>
            {msg("meetings.detailPage.transcribeAgain")}
          </Button>
        }
      >
        {transcriptErrorText(phase.version?.errorCode ?? null, msg)}
      </Notice>
    );
  }
  return null;
}

function versionLine(
  version: RecordingTranscriptVersion,
  modelName: (version: RecordingTranscriptVersion) => string,
  msg: OpenGeniText = defaultText,
): string {
  const parts = [
    msg("meetings.detailPage.versionVersionnumber", { versionNumber: version.versionNumber }),
    modelName(version),
  ];
  if (version.state === "queued" || version.state === "processing")
    parts.push(msg("meetings.detailPage.transcribing"));
  if (version.state === "failed") parts.push(msg("meetings.detailPage.failed"));
  if (version.state === "complete" && version.languages.length > 0) {
    parts.push(version.languages.map((code) => languageName(code, msg.locale)).join(", "));
  }
  return parts.join(" · ");
}

/**
 * A newer version than the one shown: still running, or failed. The current
 * transcript stays readable either way, so this is a quiet line, not a block.
 */
function RerunNotice({
  versions,
  shownVersionNumber,
  modelName,
  onRetry,
}: {
  versions: readonly RecordingTranscriptVersion[];
  shownVersionNumber: number;
  modelName: (version: RecordingTranscriptVersion) => string;
  onRetry: () => void;
}) {
  const msg = useOpenGeniText();
  const newest = versions.reduce<RecordingTranscriptVersion | null>(
    (best, entry) => (!best || entry.versionNumber > best.versionNumber ? entry : best),
    null,
  );
  if (!newest || newest.versionNumber <= shownVersionNumber) return null;
  if (newest.state === "queued" || newest.state === "processing") {
    return (
      <Notice tone="waiting" icon={SPINNER} live="polite">
        {msg("meetings.detailPage.transcribingAgainWithModelnameThis", {
          modelName: modelName(newest),
        })}
      </Notice>
    );
  }
  if (newest.state === "failed") {
    return (
      <Notice
        tone="failed"
        title={msg("meetings.detailPage.transcribingAgainFailed")}
        action={
          <Button type="button" size="sm" variant="outline" onClick={onRetry}>
            {msg("meetings.detailPage.transcribeAgain")}
          </Button>
        }
      >
        {msg("meetings.detailPage.transcripterrortextThisVersionIsUnchanged", {
          transcriptErrorText: transcriptErrorText(newest.errorCode, msg),
        })}
      </Notice>
    );
  }
  return null;
}

/** The meeting page's tabs. */
type MeetingTab = "summary" | "transcript" | "notepad";

/** Summary when there are written notes to read, else Transcript. */
export function openingMeetingTab(notes: RecordingNote | null): MeetingTab {
  return notes?.body.trim() ? "summary" : "transcript";
}

/** One of the host's own lines about a meeting, such as its project. */
export type MeetingDetail = { id: string; label: string; content: ReactNode };

type MeetingDetailPageProps = {
  workspaceId: string;
  recordingId: string;
  viewerSubjectId: string;
  /** The reader's name, for the people list when they name a speaker as themselves. */
  viewerName?: string;
  /** The workspace recognizes people by voice, so speakers can be suggested and voices remembered. */
  voiceRecognition?: boolean;
  /** A recordings client to use instead of the app's, for previews. */
  recordings?: RecordingsClientOverride["recordings"];
  onBack: () => void;
  /** Opens Meetings settings, where voice recognition is turned on. */
  onOpenSettings?: (() => void) | undefined;
  /**
   * The host's own lines about this meeting, shown first beside the
   * transcript, such as the project it belongs to.
   */
  details?: ((recording: Recording) => readonly MeetingDetail[]) | undefined;
  /** Opens a chat, such as the one whose agent wrote the notes. */
  onOpenChat?: ((sessionId: string) => void) | undefined;
  /**
   * Answers "Ask about this meeting", usually by starting a chat with the
   * meeting attached and the question as its first message. Without it the
   * page has no Ask input. Resolve false to keep the question in the input
   * when the host couldn't take it and has already said why.
   */
  onAsk?:
    | ((recordingId: string, question: string) => MeetingAskResult | Promise<MeetingAskResult>)
    | undefined;
};

/**
 * Each meeting starts fresh, even when the host keeps the page mounted and
 * only changes `recordingId`: its own opening tab, drafts and dialogs.
 */
export function MeetingDetailPage(props: MeetingDetailPageProps) {
  return (
    <MeetingsOverlayScope>
      <MeetingDetailPageForRecording key={props.recordingId} {...props} />
    </MeetingsOverlayScope>
  );
}

function MeetingDetailPageForRecording({
  workspaceId,
  recordingId,
  viewerSubjectId,
  viewerName,
  voiceRecognition = false,
  recordings: recordingsClient,
  onBack,
  onOpenSettings,
  details,
  onOpenChat,
  onAsk,
}: MeetingDetailPageProps) {
  const msg = useOpenGeniText();
  const override = { workspaceId, ...(recordingsClient ? { recordings: recordingsClient } : {}) };
  const meeting = useRecording(recordingId, override);
  const recording = meeting.recording;
  const version = recording?.transcript ?? null;
  const transcriptVersionId =
    version?.state === "complete"
      ? version.id
      : meeting.versions.find((candidate) => candidate.isCurrent && candidate.state === "complete")
          ?.id;
  const transcript = useTranscript(recordingId, {
    ...override,
    ...(transcriptVersionId ? { versionId: transcriptVersionId } : {}),
    refreshKey: transcriptVersionId ?? null,
    enabled: Boolean(transcriptVersionId),
  });
  const people = useRecordingPeople(override);
  const models = useRecordingModels(override);
  const { client } = useRecordingsClient(override);
  const { recorder } = useMeetingRecorder();
  const online = useOnline();
  // The live preview, while a meeting is recorded and until its transcript is
  // ready: this browser's own recorder has it first; anyone else reads what
  // the recorder saved.
  const recordingHere = Boolean(recorder && recorder.recordingId === recordingId && recorder.live);
  const previewing =
    Boolean(recording?.tracks.some((track) => track.live)) &&
    !transcriptVersionId &&
    (recording?.state === "capturing" || recording?.state === "processing");
  const savedLive = useLiveTranscript(recordingId, {
    ...override,
    enabled: previewing && !recordingHere,
  });
  const player = useRef<MeetingPlayerHandle>(null);
  const [position, setPosition] = useState(0);
  const [renaming, setRenaming] = useState(false);
  const [rerunning, setRerunning] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [namingFromAside, setNamingFromAside] = useState<string | null>(null);
  const [rememberingVoice, setRememberingVoice] = useState<RecordingPerson | null>(null);
  const notes = useRecordingNotes(recordingId, override);
  // Summary when the meeting has written notes, else Transcript: decided once
  // the notes load, so notes written later don't move the reader.
  const [openingTab, setOpeningTab] = useState<MeetingTab | null>(null);
  const [chosenTab, setChosenTab] = useState<MeetingTab | null>(null);
  if (openingTab === null && !notes.loading) {
    setOpeningTab(openingMeetingTab(notes.notes));
  }
  const tab = chosenTab ?? openingTab;
  const slots = useMemo(() => speakerColorSlots(transcript.segments), [transcript.segments]);
  const mentionTracks = recording?.tracks;
  const mentions = useMemo(
    () =>
      meetingMentionResolver({
        speakers: transcript.speakers,
        tracks: mentionTracks ?? [],
        people: people.people,
        slots,
        msg,
      }),
    [transcript.speakers, mentionTracks, people.people, slots, msg],
  );

  const { sources, reload } = useTrackSources(recording, (trackNumber) =>
    client.getRecordingTrackAudio(workspaceId, recordingId, trackNumber),
  );

  const modelName = useCallback(
    (entry: RecordingTranscriptVersion) =>
      models.models.find(
        (candidate) => candidate.providerId === entry.providerId && candidate.model === entry.model,
      )?.name ?? entry.model,
    [models.models],
  );

  const createPerson = people.create;
  const { rememberVoice, forgetVoice } = people;
  const refreshTranscript = transcript.refresh;
  const rejectSuggestion = transcript.rejectSuggestion;
  const nameSpeaker = transcript.nameSpeaker;
  const transcriptSpeakers = transcript.speakers;
  const peopleList = people.people;
  // Without voice recognition a name is only for this meeting; say so once,
  // the first time someone is named here.
  const toldNotRemembered = useRef(false);
  const tellNotRemembered = useCallback(() => {
    if (voiceRecognition || toldNotRemembered.current) return;
    toldNotRemembered.current = true;
    toast(msg("meetings.detailPage.namesArenTSuggestedIn"), {
      description: msg("meetings.detailPage.voiceRecognitionIsOffIn"),
      ...(onOpenSettings
        ? { action: { label: msg("meetings.detailPage.settings"), onClick: onOpenSettings } }
        : {}),
    });
  }, [msg, voiceRecognition, onOpenSettings]);
  const actions: TranscriptActions = useMemo(
    () => ({
      nameSpeaker: async (label, name) => {
        await nameSpeaker(label, name);
        if (name) tellNotRemembered();
      },
      viewerSubjectId,
      nameSelf: async (label: string) => {
        const me =
          peopleList.find((person) => person.memberSubjectId === viewerSubjectId) ??
          (await createPerson({
            displayName: viewerName ?? msg("meetings.detailPage.me"),
            memberSubjectId: viewerSubjectId,
          }));
        await nameSpeaker(label, { personId: me.id });
        if (!voiceRecognition) {
          tellNotRemembered();
        } else if (!me.voice) {
          // Naming yourself is when remembering your voice makes sense.
          toast.success(msg("meetings.detailPage.namedYou"), {
            description: msg("meetings.detailPage.rememberYourVoiceAndLater"),
            action: {
              label: msg("meetings.detailPage.rememberMyVoice"),
              onClick: () =>
                void rememberVoice(me.id, "self").then(
                  () => toast.success(msg("meetings.detailPage.yourVoiceWillBeRemembered")),
                  (error: unknown) =>
                    toast.error(msg("meetings.detailPage.couldnTRememberYourVoice"), {
                      description: errorText(error),
                    }),
                ),
            },
          });
        }
      },
      rejectSuggestion: async (label: string) => {
        const suggested = speakerIsSuggested(label, transcriptSpeakers);
        await rejectSuggestion(label);
        const personId = suggested?.personId;
        toast.success(
          suggested
            ? msg("meetings.detailPage.suggestionDismissed")
            : msg("meetings.detailPage.leftUnnamed"),
          suggested && personId
            ? {
                description: msg("meetings.detailPage.thisSpeakerIsUnnamedAgain"),
                // A mis-tap on "Not them" is easy; naming them puts it right.
                action: {
                  label: msg("meetings.detailPage.undo"),
                  onClick: () =>
                    void nameSpeaker(label, { personId }).catch((error: unknown) =>
                      toast.error(msg("meetings.detailPage.couldnTNameThisSpeaker"), {
                        description: errorText(error),
                      }),
                    ),
                },
              }
            : undefined,
        );
      },
      moveSegment: transcript.moveSegment,
      editSegment: transcript.editSegment,
      createPerson: async (displayName: string) => await createPerson({ displayName }),
      voices: voiceRecognition
        ? {
            viewerSubjectId,
            remember: (person) => {
              if (person.memberSubjectId !== viewerSubjectId) {
                setRememberingVoice(person);
                return;
              }
              void rememberVoice(person.id, "self").then(
                () => toast.success(msg("meetings.detailPage.yourVoiceWillBeRemembered")),
                (error: unknown) =>
                  toast.error(msg("meetings.detailPage.couldnTRememberYourVoice"), {
                    description: errorText(error),
                  }),
              );
            },
            forget: async (person) => {
              await forgetVoice(person.id);
              // Forgetting also removes the names it suggested in this meeting.
              await refreshTranscript();
              toast.success(
                person.memberSubjectId === viewerSubjectId
                  ? msg("meetings.detailPage.yourVoiceIsForgotten")
                  : msg("meetings.detailPage.displaynameSVoiceIsForgotten", {
                      displayName: person.displayName,
                    }),
              );
            },
          }
        : null,
    }),
    [
      msg,
      nameSpeaker,
      rejectSuggestion,
      transcriptSpeakers,
      transcript.moveSegment,
      transcript.editSegment,
      createPerson,
      voiceRecognition,
      viewerSubjectId,
      viewerName,
      peopleList,
      tellNotRemembered,
      rememberVoice,
      forgetVoice,
      refreshTranscript,
    ],
  );

  if (!recording) {
    return (
      <DetailPage back={{ label: msg("meetings.detailPage.meetings"), onClick: onBack }}>
        {meeting.error ? (
          isNotFound(meeting.error) ? (
            <EmptyState
              variant="page"
              icon={<AudioLinesIcon />}
              title={msg("meetings.detailPage.thisMeetingDoesnTExist")}
              description={msg("meetings.detailPage.itMayHaveBeenDeleted")}
              action={
                <Button type="button" variant="outline" onClick={onBack}>
                  {msg("meetings.detailPage.backToMeetings")}
                </Button>
              }
              className="pt-12"
            />
          ) : (
            <ErrorMessage
              align="center"
              title={msg("meetings.detailPage.couldnTLoadThisMeeting")}
              details={[{ label: msg("meetings.detailPage.error"), value: meeting.error.message }]}
              action={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void meeting.refresh()}
                >
                  {msg("meetings.detailPage.tryAgain")}
                </Button>
              }
            >
              {msg("meetings.detailPage.checkYourConnectionThenTry")}
            </ErrorMessage>
          )
        ) : (
          <div aria-busy="true" className="grid gap-6">
            <div className="space-y-2">
              <Skeleton className="h-7 w-72" />
              <Skeleton className="h-4 w-96 max-w-full" />
            </div>
            <Skeleton className="h-12 w-full rounded-[14px]" />
            <div className="space-y-3">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-5/6" />
            </div>
            <span className="sr-only" role="status">
              {msg("meetings.detailPage.loadingMeeting")}
            </span>
          </div>
        )}
      </DetailPage>
    );
  }

  const owner = recording.ownerSubjectId === viewerSubjectId;
  // The person recording, as the transcript will name their microphone.
  const ownerName =
    peopleList.find((person) => person.memberSubjectId === recording.ownerSubjectId)?.displayName ??
    (owner ? (viewerName ?? null) : null);
  const phase = meetingPhase(recording);
  // Only while the server still waits for audio: this device may know more.
  const here =
    recording.state === "capturing" ? meetingHereStatus(recorder, recording.id, online) : null;
  const capturingHere = here === "recording" || here === "paused";
  // Recorded on this device: one page with the bar, the notepad and the live
  // preview, as before. Otherwise Summary · Transcript · Notepad.
  const tabbed = !(capturingHere || recordingHere);
  const askable = Boolean(onAsk);
  const segments = transcript.segments;
  const speakerLabels = [...slots.keys()];
  const activeSegment = sources.length > 0 ? activeSegmentIndex(segments, position) : null;
  const showTranscript = Boolean(transcriptVersionId);
  const shownVersionNumber = version?.state === "complete" ? version.versionNumber : 0;
  const rerunPending = meeting.versions.some(
    (entry) =>
      entry.versionNumber > shownVersionNumber &&
      (entry.state === "queued" || entry.state === "processing"),
  );
  // Gone once retention deleted it, or when none was ever uploaded. Uploaded
  // audio without a playable copy yet (while it's transcribed, or after a
  // failure before that step) can still be transcribed again.
  const audioGone =
    recording.audioDeletedAt !== null ||
    (recording.state !== "capturing" &&
      !recording.tracks.some((track) => track.playable || track.chunkCount > 0));
  const canRerun = recording.state !== "capturing" && !audioGone && !rerunPending;
  // Pending before any transcript is done, it is the first one, not "again".
  const firstPending = rerunPending && shownVersionNumber === 0;
  const unnamedCount = speakerLabels.filter(
    (label) => !speakerIsNamed(label, transcript.speakers),
  ).length;
  const suggestedCount = speakerLabels.filter((label) =>
    speakerIsSuggested(label, transcript.speakers),
  ).length;
  // Speakers that still need someone to say who they are: unnamed, or a
  // name suggested from a voice that nobody has confirmed yet.
  const reviewLabels = speakerLabels.filter(
    (label) =>
      !speakerIsNamed(label, transcript.speakers) ||
      Boolean(speakerIsSuggested(label, transcript.speakers)),
  );

  const speakerButtons = (variant: "list" | "chips", labels: readonly string[] = speakerLabels) =>
    labels.map((label) => {
      const name = speakerDisplayName(label, transcript.speakers, recording.tracks, msg);
      const suggested = speakerIsSuggested(label, transcript.speakers);
      const unnamed = !speakerIsNamed(label, transcript.speakers);
      const menuLabel = suggested
        ? msg("meetings.detailPage.nameSuggestedFromTheirVoice", { name: name })
        : unnamed
          ? msg("meetings.detailPage.nameNameThisSpeaker", { name: name })
          : msg("meetings.detailPage.nameChangeWhoThisIs", { name: name });
      return (
        <li key={label} className="min-w-0">
          <SpeakerNameMenu
            label={label}
            displayName={name}
            speakers={transcript.speakers}
            people={people.people}
            actions={actions}
            onAddNew={setNamingFromAside}
            align={variant === "list" ? "end" : "start"}
          >
            {variant === "list" ? (
              <button
                type="button"
                aria-label={menuLabel}
                className="-mx-1.5 flex w-[calc(100%+0.75rem)] min-w-0 items-center gap-2 rounded-[6px] px-1.5 py-1 text-left text-sm leading-5 text-fg transition-colors duration-[120ms] hover:bg-hover data-[state=open]:bg-hover pointer-coarse:min-h-11"
              >
                <SpeakerDot slot={slots.get(label)} />
                <span className="grid min-w-0 flex-1">
                  <span className="truncate">{name}</span>
                  {suggested ? (
                    <span className="truncate text-xs leading-4 text-fg-muted">
                      {msg("meetings.detailPage.suggestedFromTheirVoice")}
                    </span>
                  ) : null}
                </span>
                <PencilIcon aria-hidden="true" className="size-3.5 shrink-0 text-fg-subtle" />
              </button>
            ) : (
              <button
                type="button"
                aria-label={menuLabel}
                className={cn(
                  "flex max-w-52 min-w-0 items-center gap-2 rounded-full border border-border bg-surface px-3 py-1 text-sm leading-5 text-fg transition-colors duration-[120ms] hover:bg-hover data-[state=open]:bg-hover pointer-coarse:min-h-11",
                  (suggested || unnamed) && "border-dashed border-border-strong",
                )}
              >
                <SpeakerDot slot={slots.get(label)} />
                <span className="min-w-0 truncate">
                  {name}
                  {suggested ? "?" : ""}
                </span>
                <PencilIcon aria-hidden="true" className="size-3 shrink-0 text-fg-subtle" />
              </button>
            )}
          </SpeakerNameMenu>
          {suggested && variant === "list" ? (
            <div className="mt-1 flex flex-wrap gap-1.5 pl-4">
              <Button
                type="button"
                size="xs"
                className="pointer-coarse:h-11"
                variant="outline"
                aria-label={msg("meetings.detailPage.yesItSName", { name: name })}
                onClick={() =>
                  void actions
                    .nameSpeaker(label, { personId: suggested.personId! })
                    .catch((error: unknown) =>
                      toast.error(msg("meetings.detailPage.couldnTConfirmThisName"), {
                        description: errorText(error),
                      }),
                    )
                }
              >
                <CheckIcon aria-hidden="true" />
                {msg("meetings.detailPage.confirm")}
              </Button>
              <Button
                type="button"
                size="xs"
                className="pointer-coarse:h-11"
                variant="ghost"
                aria-label={msg("meetings.detailPage.notName", { name: name })}
                onClick={() =>
                  void actions.rejectSuggestion(label).catch((error: unknown) =>
                    toast.error(msg("meetings.detailPage.couldnTTurnDownThis"), {
                      description: errorText(error),
                    }),
                  )
                }
              >
                {msg("meetings.detailPage.notThem")}
              </Button>
            </div>
          ) : null}
        </li>
      );
    });
  const reviewLine =
    reviewLabels.length === 0
      ? null
      : unnamedCount > 0 && suggestedCount > 0
        ? suggestedCount === 1
          ? msg("meetings.detailPage.whoSpokeSpeakersToNameOneName", {
              count: unnamedCount,
              suggestedCount: suggestedCount,
            })
          : msg("meetings.detailPage.whoSpokeSpeakersToNameNames", {
              count: unnamedCount,
              suggestedCount: suggestedCount,
            })
        : unnamedCount > 0
          ? msg("meetings.detailPage.whoSpokeSpeakersHaveNoName", { count: unnamedCount })
          : msg("meetings.detailPage.whoSpokeNamesWereSuggested", { count: suggestedCount });

  const update = async (
    request: Parameters<typeof meeting.update>[0],
    failure: string,
  ): Promise<void> => {
    try {
      await meeting.update(request);
    } catch (error) {
      toast.error(failure, { description: errorText(error) });
      throw error;
    }
  };

  const shownTitle = meetingTitle(recording, msg);
  const header = (
    <DetailPageHeader
      title={shownTitle}
      tabs={
        !tabbed ? undefined : tab === null ? (
          <Skeleton className="h-9 w-64 rounded-[10px]" />
        ) : (
          <SegmentedControl
            aria-label={msg("meetings.detailPage.show")}
            value={tab}
            onValueChange={setChosenTab}
            options={[
              { value: "summary", label: msg("meetings.detailPage.summary") },
              { value: "transcript", label: msg("meetings.detailPage.transcript") },
              { value: "notepad", label: msg("meetings.notes.notepad") },
            ]}
          />
        )
      }
      meta={
        <DetailMeta>
          {formatAbsoluteTime(recording.startedAt, { text: msg })}
          {recording.durationMilliseconds > 0
            ? formatDuration(recording.durationMilliseconds, msg)
            : null}
          {speakerLabels.length > 0
            ? msg("meetings.detailPage.countSpeakers", { count: speakerLabels.length })
            : null}
          {!owner && recording.visibility === "workspace"
            ? msg("meetings.detailPage.sharedWithTheWorkspace")
            : null}
        </DetailMeta>
      }
      actions={
        <>
          {owner ? (
            <VisibilityMenu
              visibility={recording.visibility}
              onChange={(visibility) =>
                void update({ visibility }, msg("meetings.detailPage.couldnTChangeWhoCan")).then(
                  () =>
                    toast.success(
                      visibility === "workspace"
                        ? msg("meetings.detailPage.sharedWithTheWorkspace")
                        : msg("meetings.detailPage.onlyYouCanSeeThis"),
                    ),
                  () => undefined,
                )
              }
            />
          ) : null}
          <MoreMenu label={msg("meetings.detailPage.moreActionsForTitle", { title: shownTitle })}>
            <DropdownMenuItem onSelect={() => setRenaming(true)}>
              <PencilIcon aria-hidden="true" />
              {msg("meetings.detailPage.rename")}
            </DropdownMenuItem>
            {recording.state !== "capturing" ? (
              <DropdownMenuItem disabled={!canRerun} onSelect={() => setRerunning(true)}>
                <RefreshCwIcon aria-hidden="true" />
                {rerunPending && !firstPending
                  ? msg("meetings.detailPage.transcribingAgain")
                  : msg("meetings.detailPage.transcribeAgain")}
              </DropdownMenuItem>
            ) : null}
            {owner ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(true)}>
                  <Trash2Icon aria-hidden="true" />
                  {msg("meetings.detailPage.deleteMeeting")}
                </DropdownMenuItem>
              </>
            ) : null}
          </MoreMenu>
        </>
      }
    />
  );

  const hostDetails = details?.(recording) ?? [];
  const aside =
    showTranscript || meeting.versions.length > 0 || hostDetails.length > 0 ? (
      <DetailAside label={msg("meetings.detailPage.aboutThisTranscript")}>
        {hostDetails.map((detail) => (
          <DetailAsideItem key={detail.id} label={detail.label}>
            {detail.content}
          </DetailAsideItem>
        ))}
        {speakerLabels.length > 0 ? (
          <DetailAsideItem label={msg("meetings.detailPage.speakers")}>
            <ul className="grid w-full min-w-0 gap-1">{speakerButtons("list")}</ul>
          </DetailAsideItem>
        ) : null}
        {meeting.versions.length > 0 ? (
          <DetailAsideItem label={msg("meetings.detailPage.transcript")}>
            <div className="grid w-full min-w-0 gap-2">
              {meeting.versions.length > 1 ? (
                <NativeSelect
                  options={meeting.versions.map((entry) => ({
                    value: entry.id,
                    label: versionLine(entry, modelName, msg),
                    disabled: entry.state !== "complete",
                  }))}
                  value={transcriptVersionId ?? meeting.versions[0]!.id}
                  onValueChange={(versionId) =>
                    void meeting.setCurrentVersion(versionId).catch((error: unknown) =>
                      toast.error(msg("meetings.detailPage.couldnTSwitchVersions"), {
                        description: errorText(error),
                      }),
                    )
                  }
                  size="sm"
                />
              ) : (
                <span className="text-sm leading-5 text-fg">
                  {versionLine(meeting.versions[0]!, modelName, msg)}
                </span>
              )}
              {phase.kind === "failed" || firstPending ? null : (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setRerunning(true)}
                  disabled={!canRerun}
                  className="w-fit rounded-[10px] pointer-coarse:h-11"
                >
                  {rerunPending ? SPINNER : <RefreshCwIcon aria-hidden="true" />}
                  {rerunPending
                    ? msg("meetings.detailPage.transcribingAgain")
                    : msg("meetings.detailPage.transcribeAgain")}
                </Button>
              )}
            </div>
          </DetailAsideItem>
        ) : null}
      </DetailAside>
    ) : undefined;

  // What the Transcript shows: who still needs a name, then the transcript,
  // or why there isn't one yet.
  const transcriptBody = (
    <>
      {showTranscript && reviewLabels.length > 0 ? (
        // Beside the speakers card, the speakers still to review sit at
        // the top of the transcript, where the reader starts. Only the outer
        // wrapper hides, so no display class competes with the container query.
        <div className="mb-5 @max-[620px]/detail:hidden">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm leading-5 text-fg-muted">{reviewLine}</p>
            <ul
              aria-label={msg("meetings.detailPage.speakersToReview")}
              className="flex flex-wrap gap-2"
            >
              {speakerButtons("chips", reviewLabels)}
            </ul>
          </div>
        </div>
      ) : null}
      {showTranscript && speakerLabels.length > 0 ? (
        // Only while the speakers card sits below the transcript. The
        // wrapper carries no display class, so the container query wins.
        <div className="mb-5 @[620px]/detail:hidden">
          <div className="grid gap-2">
            <ul aria-label={msg("meetings.detailPage.speakers")} className="flex flex-wrap gap-2">
              {speakerButtons("chips")}
            </ul>
            {reviewLine ? (
              <p className="text-xs leading-4.5 text-fg-muted">
                {msg("meetings.detailPage.reviewlineTapADashedName", {
                  reviewLine: reviewLine,
                })}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
      {!showTranscript && (previewing || recordingHere) ? (
        <div className="grid gap-3">
          <p className="text-sm leading-5 text-fg-muted">
            <span className="mr-2 inline-flex rounded-full border border-border px-1.5 text-xs leading-4 font-medium text-fg-label">
              {msg("meetings.detailPage.preview")}
            </span>
            {recording.state === "capturing" && here !== "transcribing"
              ? msg("meetings.detailPage.whatSSaidSoFar")
              : msg("meetings.detailPage.whatWasSaidAsIt")}
          </p>
          {recordingHere && recorder?.live ? (
            <LiveTranscript
              heading={false}
              lines={recorderLiveLines(recorder)}
              partials={recorder.live.map((track) => ({
                trackNumber: track.trackNumber,
                text: track.partial,
              }))}
              speakerName={(trackNumber) => liveSpeakerName(recorder, trackNumber, msg, ownerName)}
              status={liveStatus(recorder.live, msg)}
              empty={msg("meetings.detailPage.listeningWhatSSaidShows")}
            />
          ) : (
            <LiveTranscript
              heading={false}
              lines={savedLive.segments}
              speakerName={(trackNumber) => {
                const source = defaultSpeakerName(`track-${trackNumber}`, recording.tracks, msg);
                return (
                  ownerLiveLaneName(recording.tracks, trackNumber, ownerName ?? source, msg) ??
                  source
                );
              }}
              status={
                savedLive.error
                  ? { text: msg("meetings.detailPage.canTLoadThePreview"), tone: "waiting" }
                  : null
              }
              empty={
                recording.state === "capturing"
                  ? msg("meetings.detailPage.nothingSaidYetTextShows")
                  : msg("meetings.detailPage.noLiveTextWasSaved")
              }
            />
          )}
        </div>
      ) : !showTranscript ? (
        <p className="text-sm leading-5 text-fg-muted">
          {phase.kind === "failed"
            ? msg("meetings.detailPage.noTranscriptYet")
            : phase.kind === "no_transcript"
              ? msg("meetings.detailPage.thisMeetingHasnTBeen")
              : msg("meetings.detailPage.theTranscriptShowsHereWhen")}
        </p>
      ) : transcript.loading && segments.length === 0 ? (
        <div className="space-y-3" aria-busy="true">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-4/5" />
        </div>
      ) : transcript.error && segments.length === 0 ? (
        <ErrorMessage
          title={msg("meetings.detailPage.couldnTLoadTheTranscript")}
          details={[{ label: msg("meetings.detailPage.error"), value: transcript.error.message }]}
          action={
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void transcript.refresh()}
            >
              {msg("meetings.detailPage.tryAgain")}
            </Button>
          }
        >
          {msg("meetings.detailPage.checkYourConnectionThenTry")}
        </ErrorMessage>
      ) : segments.length === 0 ? (
        <p className="text-sm leading-5 text-fg-muted">
          {msg("meetings.detailPage.noSpeechWasFoundIn")}
        </p>
      ) : (
        <MeetingTranscript
          segments={segments}
          speakers={transcript.speakers}
          tracks={recording.tracks}
          people={people.people}
          activeSegment={activeSegment}
          actions={actions}
          onSeek={sources.length > 0 ? (ms) => player.current?.playFrom(ms) : null}
        />
      )}
    </>
  );

  return (
    <DetailPage back={{ label: msg("meetings.detailPage.meetings"), onClick: onBack }}>
      {header}
      <div className="mt-6 grid gap-4 empty:hidden">
        <PhaseNotice
          recording={recording}
          recorder={recorder}
          here={here}
          recordingElsewhere={previewing && !recordingHere}
          onRetry={() => setRerunning(true)}
        />
        {phase.kind === "ready" ? (
          <RerunNotice
            versions={meeting.versions}
            shownVersionNumber={phase.version.versionNumber}
            modelName={modelName}
            onRetry={() => setRerunning(true)}
          />
        ) : null}
        {audioGone ? (
          <Notice tone="muted">
            {recording.audioDeletedAt
              ? msg("meetings.detailPage.theAudioWasDeletedOn", {
                  formatAbsoluteTime: formatAbsoluteTime(recording.audioDeletedAt, { text: msg }),
                })
              : msg("meetings.detailPage.theAudioForThisMeeting")}
          </Notice>
        ) : null}
      </div>
      {sources.length > 0 && !recording.audioDeletedAt ? (
        // A direct child of the page, so it stays in view through the whole transcript.
        <div className="sticky top-0 z-10 -mx-1 mt-4 bg-bg px-1 pt-2 pb-2">
          <MeetingPlayer
            ref={player}
            sources={sources}
            durationMilliseconds={recording.durationMilliseconds}
            onTime={setPosition}
            onSourceError={reload}
          />
        </div>
      ) : null}
      <DetailPageBody aside={aside}>
        {tabbed ? (
          // One column under the tabs; Ask keeps its draft across Summary and
          // Transcript. The Summary stays mounted while hidden, so an edit in
          // progress survives a look at the transcript.
          <div className="flex min-w-0 flex-col">
            {tab === null ? (
              <DetailSection>
                <div aria-busy="true" className="grid gap-3">
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-1/2" />
                </div>
              </DetailSection>
            ) : (
              <>
                <div hidden={tab !== "summary"} data-meeting-tab="summary">
                  <DetailSection className={askable ? "pb-2" : undefined}>
                    <MeetingSummary notes={notes} onOpenChat={onOpenChat} mentions={mentions} />
                  </DetailSection>
                </div>
                {tab === "transcript" ? (
                  <DetailSection key="transcript" className={askable ? "pb-2" : undefined}>
                    {transcriptBody}
                  </DetailSection>
                ) : tab === "notepad" ? (
                  <DetailSection key="notepad">
                    <MeetingNotepad notes={notes} />
                  </DetailSection>
                ) : null}
              </>
            )}
            {askable && onAsk && tab !== "notepad" ? (
              <MeetingAsk onAsk={(question) => onAsk(recording.id, question)} />
            ) : null}
          </div>
        ) : (
          // Recording here: the notepad first, then the live preview, as one page.
          <>
            <MeetingNotesSection
              notes={notes}
              capturing={recording.state === "capturing"}
              onOpenChat={onOpenChat}
              mentions={mentions}
            />
            <DetailSection title={msg("meetings.detailPage.transcript")}>
              {transcriptBody}
            </DetailSection>
          </>
        )}
      </DetailPageBody>
      <RenameDialog
        open={renaming}
        title={shownTitle}
        onClose={() => setRenaming(false)}
        onRename={async (title) =>
          await update({ title }, msg("meetings.detailPage.couldnTRenameThisMeeting2"))
        }
      />
      <TranscribeAgainDialog
        open={rerunning}
        recording={recording}
        models={models.models}
        defaultModel={models.defaultModel}
        onClose={() => setRerunning(false)}
        onRun={async (options) => {
          await meeting.rerun(options);
          toast.success(msg("meetings.detailPage.transcribingAgain2"), {
            description: msg("meetings.detailPage.theNewVersionReplacesThis"),
          });
        }}
      />
      <NewSpeakerNameDialog
        label={namingFromAside}
        displayName={
          namingFromAside
            ? speakerDisplayName(namingFromAside, transcript.speakers, recording.tracks, msg)
            : ""
        }
        actions={actions}
        onClose={() => setNamingFromAside(null)}
      />
      <ConfirmDialog
        open={rememberingVoice !== null}
        onOpenChange={(open) => {
          if (!open) setRememberingVoice(null);
        }}
        destructive={false}
        title={msg("meetings.detailPage.rememberValueSVoice", {
          value: rememberingVoice?.displayName ?? msg("meetings.detailPage.their"),
        })}
        description={msg("meetings.detailPage.onlyDoThisIfValue", {
          value: rememberingVoice?.displayName ?? msg("meetings.detailPage.they"),
        })}
        confirmLabel={msg("meetings.detailPage.theyAgreedRemember")}
        pendingLabel={msg("meetings.detailPage.saving")}
        onConfirm={async () => {
          const person = rememberingVoice;
          if (!person) return;
          try {
            await rememberVoice(person.id, "attested");
            toast.success(
              msg("meetings.detailPage.displaynameSVoiceWillBe", {
                displayName: person.displayName,
              }),
            );
          } catch (error) {
            toast.error(msg("meetings.detailPage.couldnTRememberThisVoice"), {
              description: errorText(error),
            });
            return false;
          }
        }}
      />
      <DeleteMeetingDialog
        recording={deleting ? { id: recording.id, title: shownTitle } : null}
        onClose={() => setDeleting(false)}
        onDelete={async () => await meeting.remove()}
        onDeleted={onBack}
      />
    </DetailPage>
  );
}
