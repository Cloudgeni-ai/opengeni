/**
 * One meeting's own page: back to Meetings, the title with who can see it,
 * the player, then the transcript. The quiet card on the right names the
 * speakers and says which transcript version this is, with Transcribe again.
 *
 * Until the transcript exists the page says where the meeting is: still
 * uploading (from this browser or another device), transcribing, or failed
 * with the reason and what to try.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AudioLinesIcon,
  CheckIcon,
  ChevronDownIcon,
  GlobeIcon,
  LockIcon,
  PencilIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";
import { toast } from "sonner";
import type {
  Recording,
  RecordingTranscriptVersion,
  RecordingVisibility,
} from "@opengeni/contracts";
import {
  useRecording,
  useRecordingModels,
  useRecordingPeople,
  useRecordingsClient,
  useTranscript,
  type RecordingsClientOverride,
} from "@opengeni/react/recordings";

import { Button } from "@opengeni/react/ui/button";
import {
  DetailAside,
  DetailAsideItem,
  DetailMeta,
  DetailPage,
  DetailPageBody,
  DetailPageHeader,
} from "@opengeni/react/ui/detail-page";
import { DetailSection } from "@opengeni/react/ui/detail-sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@opengeni/react/ui/dropdown-menu";
import { EmptyState } from "@opengeni/react/ui/empty-state";
import { ErrorMessage } from "@opengeni/react/ui/error-message";
import { Field, FieldStack, TextInput } from "@opengeni/react/ui/field";
import { FormDialog } from "@opengeni/react/ui/form-dialog";
import { MoreMenu } from "@opengeni/react/ui/page-actions";
import { Notice } from "@opengeni/react/ui/notice";
import { formatAbsoluteTime } from "@opengeni/react/ui/relative-time";
import { NativeSelect, type SelectOption } from "@opengeni/react/ui/select-menu";
import { Skeleton } from "@opengeni/react/ui/skeleton";
import { StatusBadge } from "@opengeni/react/ui/status-badge";

import { DeleteMeetingDialog } from "./delete-meeting-dialog";
import {
  activeSegmentIndex,
  formatDuration,
  languageName,
  meetingPhase,
  speakerColorSlots,
  speakerDisplayName,
  transcriptErrorText,
} from "./meeting-model";
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
  type TranscriptActions,
} from "./meeting-transcript";
import { uploadLine } from "./recorder-panel";
import { useMeetingRecorder } from "./recorder-context";

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
      title="Rename meeting"
      submitLabel="Save"
      pendingLabel="Saving…"
      submitDisabled={!value.trim() || value.trim() === title}
      error={error}
      onSubmit={async () => {
        try {
          await onRename(value.trim());
        } catch (cause) {
          setError(errorText(cause) ?? "Couldn't rename this meeting.");
          return false;
        }
      }}
      onSubmitted={onClose}
    >
      <FieldStack>
        <Field label="Title">
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

const AUTO = "auto";
const COMMON_LANGUAGES = ["en", "nb", "sv", "da", "de", "fr", "es", "nl", "fi", "it", "pt", "pl"];

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
    language?: string;
    maxSpeakers?: number;
  }) => Promise<void>;
}) {
  const current = recording.transcript;
  const initialModel = current
    ? `${current.providerId}/${current.model}`
    : defaultModel
      ? `${defaultModel.providerId}/${defaultModel.model}`
      : "";
  const [model, setModel] = useState(initialModel);
  const [language, setLanguage] = useState<string>(recording.transcription.language ?? AUTO);
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
      entry.usdPerHour !== null ? `$${entry.usdPerHour.toFixed(2)} per hour` : entry.providerName,
    disabled: !entry.available,
    disabledReason: entry.available ? undefined : `Connect ${entry.providerName} first`,
  }));
  const selected = models.find((entry) => `${entry.providerId}/${entry.model}` === model);
  const languageOptions: SelectOption[] = [
    { value: AUTO, label: "Detect automatically" },
    ...COMMON_LANGUAGES.map((code) => ({ value: code, label: languageName(code) })),
  ];
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
      title="Transcribe again"
      description="Makes a new version from the full audio. Speaker names carry over; the current version stays until the new one is ready."
      submitLabel="Transcribe"
      pendingLabel="Starting…"
      submitDisabled={!selected || !selected.available || speakersInvalid}
      error={error}
      onSubmit={async () => {
        if (!selected) return false;
        try {
          await onRun({
            providerId: selected.providerId,
            model: selected.model,
            ...(language !== AUTO ? { language } : {}),
            ...(speakerCount !== undefined ? { maxSpeakers: speakerCount } : {}),
          });
        } catch (cause) {
          setError(errorText(cause) ?? "Couldn't start transcribing.");
          return false;
        }
      }}
      onSubmitted={onClose}
    >
      <FieldStack>
        <Field label="Model">
          <NativeSelect options={modelOptions} value={model} onValueChange={setModel} />
        </Field>
        <Field
          label="Language"
          hint="Set it when the meeting is in one language the model mishears."
        >
          <NativeSelect options={languageOptions} value={language} onValueChange={setLanguage} />
        </Field>
        {selected?.capabilities.diarization ? (
          <Field
            label="Most speakers"
            optional
            hint="The most people who spoke. Leave empty to let the model decide."
            error={speakersInvalid ? "Enter a whole number from 1 to 32." : undefined}
          >
            <TextInput
              inputMode="numeric"
              value={speakers}
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
  const options: Array<{ value: RecordingVisibility; label: string; description: string }> = [
    { value: "private", label: "Only me", description: "Only you can open it." },
    {
      value: "workspace",
      label: "Workspace",
      description: "Everyone in this workspace can open it and name speakers.",
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
          aria-label={`Who can see this: ${visibility === "private" ? "Only me" : "Workspace"}`}
        >
          {visibility === "private" ? (
            <LockIcon aria-hidden="true" />
          ) : (
            <GlobeIcon aria-hidden="true" />
          )}
          {visibility === "private" ? "Only me" : "Workspace"}
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

function PhaseNotice({
  recording,
  uploadingHere,
  onRetry,
}: {
  recording: Recording;
  uploadingHere: string | null;
  onRetry: () => void;
}) {
  const phase = meetingPhase(recording);
  if (phase.kind === "uploading") {
    return uploadingHere !== null ? (
      <Notice tone="waiting" title="Uploading the audio" live="polite">
        {uploadingHere}. Keep this tab open, or come back later: the audio is saved in this browser
        until it's uploaded.
      </Notice>
    ) : (
      <Notice tone="waiting" title="Still uploading">
        The audio is on the device that recorded it. The transcript starts once it's uploaded.
      </Notice>
    );
  }
  if (phase.kind === "transcribing") {
    return (
      <Notice tone="waiting" title="Transcribing" live="polite">
        This usually takes a minute or two. The page updates when it's done.
      </Notice>
    );
  }
  if (phase.kind === "failed") {
    return (
      <Notice
        tone="failed"
        title="The transcript failed"
        action={
          <Button type="button" size="sm" variant="outline" onClick={onRetry}>
            Try again
          </Button>
        }
      >
        {transcriptErrorText(phase.version?.errorCode ?? null)}
      </Notice>
    );
  }
  return null;
}

function versionLine(
  version: RecordingTranscriptVersion,
  modelName: (version: RecordingTranscriptVersion) => string,
): string {
  const parts = [`Version ${version.versionNumber}`, modelName(version)];
  if (version.state === "queued" || version.state === "processing") parts.push("transcribing");
  if (version.state === "failed") parts.push("failed");
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
  const newest = versions.reduce<RecordingTranscriptVersion | null>(
    (best, entry) => (!best || entry.versionNumber > best.versionNumber ? entry : best),
    null,
  );
  if (!newest || newest.versionNumber <= shownVersionNumber) return null;
  if (newest.state === "queued" || newest.state === "processing") {
    return (
      <Notice tone="waiting" live="polite">
        Transcribing again with {modelName(newest)}. This version stays until the new one is ready.
      </Notice>
    );
  }
  if (newest.state === "failed") {
    return (
      <Notice
        tone="failed"
        title="Transcribing again failed"
        action={
          <Button type="button" size="sm" variant="outline" onClick={onRetry}>
            Try again
          </Button>
        }
      >
        {transcriptErrorText(newest.errorCode)} This version is unchanged.
      </Notice>
    );
  }
  return null;
}

export function MeetingDetailPage({
  workspaceId,
  recordingId,
  viewerSubjectId,
  recordings: recordingsClient,
  onBack,
}: {
  workspaceId: string;
  recordingId: string;
  viewerSubjectId: string;
  /** A recordings client to use instead of the app's, for previews. */
  recordings?: RecordingsClientOverride["recordings"];
  onBack: () => void;
}) {
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
  const player = useRef<MeetingPlayerHandle>(null);
  const [position, setPosition] = useState(0);
  const [renaming, setRenaming] = useState(false);
  const [rerunning, setRerunning] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [namingFromAside, setNamingFromAside] = useState<string | null>(null);

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
  const actions: TranscriptActions = useMemo(
    () => ({
      nameSpeaker: transcript.nameSpeaker,
      moveSegment: transcript.moveSegment,
      editSegment: transcript.editSegment,
      createPerson: async (displayName: string) => await createPerson({ displayName }),
    }),
    [transcript.nameSpeaker, transcript.moveSegment, transcript.editSegment, createPerson],
  );

  if (!recording) {
    return (
      <DetailPage back={{ label: "Meetings", onClick: onBack }}>
        {meeting.error ? (
          isNotFound(meeting.error) ? (
            <EmptyState
              variant="page"
              icon={<AudioLinesIcon />}
              title="This meeting doesn't exist"
              description="It may have been deleted, or it's private to the person who recorded it."
              action={
                <Button type="button" variant="outline" onClick={onBack}>
                  Back to Meetings
                </Button>
              }
              className="pt-12"
            />
          ) : (
            <ErrorMessage
              align="center"
              title="Couldn't load this meeting"
              details={[{ label: "Error", value: meeting.error.message }]}
              action={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void meeting.refresh()}
                >
                  Try again
                </Button>
              }
            >
              Check your connection, then try again.
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
              Loading meeting
            </span>
          </div>
        )}
      </DetailPage>
    );
  }

  const owner = recording.ownerSubjectId === viewerSubjectId;
  const phase = meetingPhase(recording);
  const uploadingHere =
    recorder && recorder.recordingId === recording.id
      ? uploadLine(recorder, navigator.onLine)
      : null;
  const segments = transcript.segments;
  const speakerLabels = [...speakerColorSlots(segments).keys()];
  const slots = speakerColorSlots(segments);
  const activeSegment = sources.length > 0 ? activeSegmentIndex(segments, position) : null;
  const showTranscript = Boolean(transcriptVersionId);

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

  const header = (
    <DetailPageHeader
      title={recording.title}
      chips={
        phase.kind === "transcribing" ? (
          <StatusBadge variant="dot" tone="progress" pulse>
            Transcribing
          </StatusBadge>
        ) : phase.kind === "uploading" ? (
          <StatusBadge variant="dot" tone="progress" pulse>
            Uploading
          </StatusBadge>
        ) : undefined
      }
      meta={
        <DetailMeta>
          {formatAbsoluteTime(recording.startedAt)}
          {recording.durationMilliseconds > 0
            ? formatDuration(recording.durationMilliseconds)
            : null}
          {speakerLabels.length > 0
            ? `${speakerLabels.length} ${speakerLabels.length === 1 ? "speaker" : "speakers"}`
            : null}
          {!owner && recording.visibility === "workspace" ? "Shared with the workspace" : null}
        </DetailMeta>
      }
      actions={
        <>
          {owner ? (
            <VisibilityMenu
              visibility={recording.visibility}
              onChange={(visibility) =>
                void update({ visibility }, "Couldn't change who can see this").then(
                  () =>
                    toast.success(
                      visibility === "workspace"
                        ? "Shared with the workspace"
                        : "Only you can see this now",
                    ),
                  () => undefined,
                )
              }
            />
          ) : null}
          <MoreMenu label={`More actions for ${recording.title}`}>
            <DropdownMenuItem onSelect={() => setRenaming(true)}>
              <PencilIcon aria-hidden="true" />
              Rename
            </DropdownMenuItem>
            {recording.state !== "capturing" ? (
              <DropdownMenuItem onSelect={() => setRerunning(true)}>
                <RefreshCwIcon aria-hidden="true" />
                Transcribe again
              </DropdownMenuItem>
            ) : null}
            {owner ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(true)}>
                  <Trash2Icon aria-hidden="true" />
                  Delete meeting
                </DropdownMenuItem>
              </>
            ) : null}
          </MoreMenu>
        </>
      }
    />
  );

  const aside =
    showTranscript || meeting.versions.length > 0 ? (
      <DetailAside label="About this transcript">
        {speakerLabels.length > 0 ? (
          <DetailAsideItem label="Speakers">
            <ul className="grid w-full min-w-0 gap-1">
              {speakerLabels.map((label) => {
                const name = speakerDisplayName(label, transcript.speakers, recording.tracks);
                return (
                  <li key={label} className="min-w-0">
                    <SpeakerNameMenu
                      label={label}
                      displayName={name}
                      speakers={transcript.speakers}
                      people={people.people}
                      actions={actions}
                      onAddNew={setNamingFromAside}
                      align="end"
                    >
                      <button
                        type="button"
                        className="-mx-1.5 flex w-[calc(100%+0.75rem)] min-w-0 items-center gap-2 rounded-[6px] px-1.5 py-1 text-left text-sm leading-5 text-fg transition-colors duration-[120ms] hover:bg-hover pointer-coarse:min-h-11"
                      >
                        <SpeakerDot slot={slots.get(label)} />
                        <span className="min-w-0 flex-1 truncate">{name}</span>
                        <PencilIcon
                          aria-hidden="true"
                          className="size-3.5 shrink-0 text-fg-subtle"
                        />
                      </button>
                    </SpeakerNameMenu>
                  </li>
                );
              })}
            </ul>
          </DetailAsideItem>
        ) : null}
        {meeting.versions.length > 0 ? (
          <DetailAsideItem label="Transcript">
            <div className="grid w-full min-w-0 gap-2">
              {meeting.versions.length > 1 ? (
                <NativeSelect
                  options={meeting.versions.map((entry) => ({
                    value: entry.id,
                    label: versionLine(entry, modelName),
                    disabled: entry.state !== "complete",
                  }))}
                  value={transcriptVersionId ?? meeting.versions[0]!.id}
                  onValueChange={(versionId) =>
                    void meeting
                      .setCurrentVersion(versionId)
                      .catch((error: unknown) =>
                        toast.error("Couldn't switch versions", { description: errorText(error) }),
                      )
                  }
                  size="sm"
                />
              ) : (
                <span className="text-sm leading-5 text-fg">
                  {versionLine(meeting.versions[0]!, modelName)}
                </span>
              )}
              {version?.languages.length ? (
                <span className="text-xs leading-4.5 text-fg-muted">
                  {version.languages.map(languageName).join(", ")}
                </span>
              ) : null}
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setRerunning(true)}
                disabled={recording.state === "capturing"}
                className="w-fit rounded-[10px] pointer-coarse:h-11"
              >
                <RefreshCwIcon aria-hidden="true" />
                Transcribe again
              </Button>
            </div>
          </DetailAsideItem>
        ) : null}
      </DetailAside>
    ) : undefined;

  return (
    <DetailPage back={{ label: "Meetings", onClick: onBack }}>
      {header}
      <div className="mt-6 grid gap-4">
        <PhaseNotice
          recording={recording}
          uploadingHere={uploadingHere}
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
        {sources.length > 0 ? (
          <MeetingPlayer
            ref={player}
            sources={sources}
            durationMilliseconds={recording.durationMilliseconds}
            onTime={setPosition}
            onSourceError={reload}
            className="sticky top-2 z-10"
          />
        ) : null}
      </div>
      <DetailPageBody aside={aside}>
        <DetailSection title="Transcript">
          {!showTranscript ? (
            <p className="text-sm leading-5 text-fg-muted">
              {phase.kind === "failed"
                ? "No transcript yet."
                : phase.kind === "no_transcript"
                  ? "This meeting hasn't been transcribed."
                  : "The transcript shows here when it's ready."}
            </p>
          ) : transcript.loading && segments.length === 0 ? (
            <div className="space-y-3" aria-busy="true">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-4/5" />
            </div>
          ) : transcript.error && segments.length === 0 ? (
            <ErrorMessage
              title="Couldn't load the transcript"
              details={[{ label: "Error", value: transcript.error.message }]}
              action={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void transcript.refresh()}
                >
                  Try again
                </Button>
              }
            >
              Check your connection, then try again.
            </ErrorMessage>
          ) : segments.length === 0 ? (
            <p className="text-sm leading-5 text-fg-muted">
              No speech was found in this recording.
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
        </DetailSection>
      </DetailPageBody>
      <RenameDialog
        open={renaming}
        title={recording.title}
        onClose={() => setRenaming(false)}
        onRename={async (title) => await update({ title }, "Couldn't rename this meeting")}
      />
      <TranscribeAgainDialog
        open={rerunning}
        recording={recording}
        models={models.models}
        defaultModel={models.defaultModel}
        onClose={() => setRerunning(false)}
        onRun={async (options) => {
          await meeting.rerun(options);
          toast.success("Transcribing again", {
            description: "The new version replaces this one when it's ready.",
          });
        }}
      />
      <NewSpeakerNameDialog
        label={namingFromAside}
        displayName={
          namingFromAside
            ? speakerDisplayName(namingFromAside, transcript.speakers, recording.tracks)
            : ""
        }
        actions={actions}
        onClose={() => setNamingFromAside(null)}
      />
      <DeleteMeetingDialog
        recording={deleting ? recording : null}
        onClose={() => setDeleting(false)}
        onDelete={async () => await meeting.remove()}
        onDeleted={onBack}
      />
    </DetailPage>
  );
}
