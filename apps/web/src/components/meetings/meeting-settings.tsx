// Workspace settings → General → Meetings: who sees new meetings, which
// model transcribes them, and whether people are recognized by voice. All
// live under the workspace's `recordings` settings, which a patch replaces as
// a whole.
import { useState } from "react";
import { toast } from "sonner";

import {
  resolveWorkspaceRecordingSettings,
  type RecordingPerson,
  type RecordingRetention,
  type RecordingVisibility,
  type WorkspaceRecordingSettings,
} from "@opengeni/contracts";
import { useAppContext } from "@opengeni/react/app/app-context";
import {
  useRecordingModels,
  useRecordingPeople,
  type RecordingsClientOverride,
} from "@opengeni/react/recordings";
import { Button } from "@opengeni/react/ui/button";
import { ConfirmDialog } from "@opengeni/react/ui/confirm-dialog";
import { Section } from "@opengeni/react/ui/section";
import { SegmentedControl } from "@opengeni/react/ui/segmented-control";
import { NativeSelect, type SelectOption } from "@opengeni/react/ui/select-menu";
import { SettingRow, SettingRowLink } from "@opengeni/react/ui/setting-row";
import { Switch } from "@opengeni/react/ui/switch";

const DEFAULT = "default";
const KEEP = "keep";

const AUDIO_PERIODS = [0, 7, 30, 90, 365] as const;
const MEETING_PERIODS = [30, 90, 180, 365, 730] as const;

/** "30 days", "1 year", "2 years". */
export function retentionPeriodName(days: number): string {
  if (days % 365 === 0) return days === 365 ? "1 year" : `${days / 365} years`;
  return days === 1 ? "1 day" : `${days} days`;
}

/**
 * The confirmation for a retention change that deletes what's already
 * recorded, or null when the change deletes nothing sooner than before.
 */
export function retentionChangeWarning(
  before: RecordingRetention | undefined,
  after: RecordingRetention,
): { title: string; description: string; confirmLabel: string } | null {
  const shorter = (previous: number | undefined, next: number | undefined) =>
    next !== undefined && (previous === undefined || next < previous);
  if (shorter(before?.transcriptDays, after.transcriptDays)) {
    const period = retentionPeriodName(after.transcriptDays!);
    return {
      title: `Delete meetings after ${period}?`,
      description: `Meetings recorded more than ${period} ago, with their audio and transcripts, are deleted within a few minutes, and every meeting is deleted once it is ${period} old. This can't be undone.`,
      confirmLabel: "Delete old meetings",
    };
  }
  if (shorter(before?.audioDays, after.audioDays)) {
    const days = after.audioDays!;
    return {
      title:
        days === 0
          ? "Delete audio once transcribed?"
          : `Delete audio after ${retentionPeriodName(days)}?`,
      description:
        days === 0
          ? "The audio of every transcribed meeting is deleted within a few minutes, and from now on as soon as its transcript is ready. Transcripts stay, but meetings can't be played or transcribed again. This can't be undone."
          : `The audio of meetings recorded more than ${retentionPeriodName(days)} ago is deleted within a few minutes. Transcripts stay, but those meetings can't be played or transcribed again. This can't be undone.`,
      confirmLabel: days === 0 ? "Delete transcribed audio" : "Delete old audio",
    };
  }
  return null;
}

/** Who is looking at the settings, so they can agree to have their own voice remembered. */
export type MeetingSettingsViewer = { subjectId: string; name: string };

export function MeetingDefaultsSection({
  workspaceId,
  personal,
  canManage,
  onConnectModels,
}: {
  workspaceId: string;
  /** A Personal workspace has only its person, so visibility has nothing to choose. */
  personal: boolean;
  canManage: boolean;
  /** Opens where model accounts are added, for people who may add them. */
  onConnectModels?: (() => void) | undefined;
}) {
  const context = useAppContext();
  const workspace = context.workspaces.find((candidate) => candidate.id === workspaceId) ?? null;
  const viewer = context.accessContext;
  return (
    <MeetingDefaultsView
      workspaceId={workspaceId}
      settings={resolveWorkspaceRecordingSettings(workspace?.settings)}
      personal={personal}
      canManage={canManage}
      viewer={{ subjectId: viewer.subjectId, name: viewer.subjectLabel?.trim() || "Me" }}
      onConnectModels={onConnectModels}
      onSave={async (next) => {
        const accepted = context.captureWorkspaceInvocation(workspaceId);
        if (!accepted) return false;
        const updated = await context.updateWorkspaceSettings(workspaceId, { recordings: next });
        return Boolean(updated) && context.ownsWorkspaceInvocation(workspaceId, accepted);
      }}
    />
  );
}

/** The Meetings settings rows over plain values, so previews can render them. */
export function MeetingDefaultsView({
  workspaceId,
  settings: current,
  personal,
  canManage,
  viewer,
  onConnectModels,
  onSave,
  recordings,
}: {
  workspaceId: string;
  settings: WorkspaceRecordingSettings;
  personal: boolean;
  canManage: boolean;
  viewer: MeetingSettingsViewer;
  onConnectModels?: (() => void) | undefined;
  /** Saves the whole `recordings` settings; false when a newer change took over. */
  onSave: (next: WorkspaceRecordingSettings) => Promise<boolean>;
  /** A recordings client to use instead of the app's, for previews. */
  recordings?: RecordingsClientOverride["recordings"];
}) {
  const models = useRecordingModels({ workspaceId, ...(recordings ? { recordings } : {}) });
  const [saving, setSaving] = useState(false);
  const reason = canManage ? undefined : "Only workspace admins can change this.";

  /** False when the change failed or a newer one took over. */
  async function save(next: WorkspaceRecordingSettings, success: string): Promise<boolean> {
    setSaving(true);
    try {
      const saved = await onSave(next);
      if (saved) toast.success(success);
      return saved;
    } catch {
      toast.error("Couldn't update meeting settings");
      return false;
    } finally {
      setSaving(false);
    }
  }

  const visibility: RecordingVisibility = current.defaultVisibility ?? "private";
  const chooseVisibility = (next: RecordingVisibility) => {
    if (next === visibility) return;
    const { defaultVisibility: _previous, ...rest } = current;
    void save(
      next === "private" ? rest : { ...rest, defaultVisibility: next },
      next === "workspace"
        ? "New meetings are shared with the workspace"
        : "New meetings are private",
    );
  };

  const fallback = models.defaultModel;
  const fallbackName =
    models.models.find(
      (entry) => entry.providerId === fallback?.providerId && entry.model === fallback?.model,
    )?.name ?? null;
  const chosen = current.transcription
    ? `${current.transcription.providerId}/${current.transcription.model}`
    : DEFAULT;
  const modelOptions: SelectOption[] = [
    {
      value: DEFAULT,
      label: fallbackName ? `Default (${fallbackName})` : "Default",
    },
    ...models.models.map((entry) => ({
      value: `${entry.providerId}/${entry.model}`,
      label: entry.name,
      meta:
        entry.usdPerHour !== null ? `$${entry.usdPerHour.toFixed(2)} per hour` : entry.providerName,
      disabled: !entry.available,
      disabledReason: entry.available ? undefined : `Connect ${entry.providerName} first`,
    })),
  ];
  const chooseModel = (value: string) => {
    if (value === chosen) return;
    const { transcription: _previous, ...rest } = current;
    const entry = models.models.find(
      (candidate) => `${candidate.providerId}/${candidate.model}` === value,
    );
    void save(
      entry
        ? { ...rest, transcription: { providerId: entry.providerId, model: entry.model } }
        : rest,
      entry ? `New meetings use ${entry.name}` : "New meetings use the default model",
    );
  };
  const noneAvailable =
    !models.loading && !models.error && !models.models.some((entry) => entry.available);

  const voiceprints = current.voiceprints === true;
  const [confirmingOff, setConfirmingOff] = useState(false);
  const chooseVoiceprints = (next: boolean) => {
    if (next === voiceprints) return;
    if (!next) {
      setConfirmingOff(true);
      return;
    }
    void save({ ...current, voiceprints: true }, "People are recognized by voice");
  };

  const liveTranscript = current.liveTranscript === true;
  const liveModel = models.liveModels[0] ?? null;
  const liveAvailable = models.liveModels.some((entry) => entry.available);
  const chooseLiveTranscript = (next: boolean) => {
    if (next === liveTranscript) return;
    const { liveTranscript: _previous, ...rest } = current;
    void save(
      next ? { ...rest, liveTranscript: true } : rest,
      next ? "New meetings show a live transcript" : "New meetings don't show a live transcript",
    );
  };

  const retention = current.retention;
  const [pendingRetention, setPendingRetention] = useState<{
    next: RecordingRetention;
    success: string;
    warning: NonNullable<ReturnType<typeof retentionChangeWarning>>;
  } | null>(null);
  const saveRetention = (next: RecordingRetention, success: string) => {
    const { retention: _previous, ...rest } = current;
    const empty = next.audioDays === undefined && next.transcriptDays === undefined;
    return save(empty ? rest : { ...rest, retention: next }, success);
  };
  const chooseRetention = (field: "audioDays" | "transcriptDays", value: string) => {
    const days = value === KEEP ? undefined : Number(value);
    if (days === retention?.[field]) return;
    const next: RecordingRetention = {};
    const audioDays = field === "audioDays" ? days : retention?.audioDays;
    const transcriptDays = field === "transcriptDays" ? days : retention?.transcriptDays;
    if (transcriptDays !== undefined) next.transcriptDays = transcriptDays;
    // Audio never outlives its meeting; past that it simply goes with it.
    if (audioDays !== undefined && (transcriptDays === undefined || audioDays <= transcriptDays)) {
      next.audioDays = audioDays;
    }
    const success =
      field === "audioDays"
        ? days === undefined
          ? "Audio is kept as long as its meeting"
          : days === 0
            ? "Audio is deleted once the transcript is ready"
            : `Audio is deleted after ${retentionPeriodName(days)}`
        : days === undefined
          ? "Meetings are kept until someone deletes them"
          : `Meetings are deleted after ${retentionPeriodName(days)}`;
    const warning = retentionChangeWarning(retention, next);
    if (warning) {
      setPendingRetention({ next, success, warning });
      return;
    }
    void saveRetention(next, success);
  };
  const periodOptions = (
    periods: readonly number[],
    selected: number | undefined,
    keepLabel: string,
    limit: number | undefined,
  ): SelectOption[] => {
    const days = [...new Set([...periods, ...(selected === undefined ? [] : [selected])])].sort(
      (a, b) => a - b,
    );
    return [
      { value: KEEP, label: keepLabel },
      ...days.map((day) => {
        const tooLong = limit !== undefined && day > limit;
        return {
          value: String(day),
          label: day === 0 ? "Delete once transcribed" : retentionPeriodName(day),
          disabled: tooLong,
          disabledReason: tooLong
            ? `Meetings are deleted after ${retentionPeriodName(limit)}`
            : undefined,
        };
      }),
    ];
  };

  return (
    <Section
      title="Meetings"
      description="Defaults for new meetings, and how long meetings are kept."
    >
      {personal ? null : (
        <SettingRow
          label="Who sees new meetings"
          description={
            visibility === "workspace"
              ? "Everyone in this workspace can open a new meeting. Whoever recorded it can make it private."
              : "Only the person who recorded a meeting can open it, until they share it with the workspace."
          }
          controlWidth="auto"
          control={
            <SegmentedControl
              size="sm"
              value={visibility}
              onValueChange={(next) => chooseVisibility(next as RecordingVisibility)}
              options={[
                { value: "private", label: "Only me" },
                { value: "workspace", label: "Workspace" },
              ].map((option) => ({
                ...option,
                disabled: saving || !canManage,
                ...(reason ? { disabledReason: reason } : {}),
              }))}
            />
          }
        />
      )}
      <SettingRow
        label="Transcription model"
        description="Turns a meeting's audio into a transcript with speakers. A meeting can still be transcribed again with another model."
        controlWidth="select"
        hint={
          noneAvailable ? (
            onConnectModels ? (
              <SettingRowLink onClick={onConnectModels}>
                Connect a transcription provider to transcribe meetings
              </SettingRowLink>
            ) : (
              "An organization admin needs to connect a transcription provider before meetings are transcribed."
            )
          ) : undefined
        }
        control={
          <NativeSelect
            aria-label="Transcription model"
            options={modelOptions}
            value={chosen}
            onValueChange={chooseModel}
            loading={models.loading && models.models.length === 0}
            disabled={saving || !canManage}
            {...(reason ? { disabledReason: reason } : {})}
          />
        }
      />
      {liveModel ? (
        <SettingRow
          label="Live transcript"
          description={`Shows what's said while recording, as a preview until the transcript is ready. Anyone recording can turn it on or off for their meeting.${
            liveModel.usdPerHour !== null
              ? ` ${liveModel.providerName} charges about $${liveModel.usdPerHour.toFixed(2)} per hour of audio for it, on top of the transcript.`
              : ""
          }`}
          hint={
            !models.loading && !liveAvailable ? (
              onConnectModels ? (
                <SettingRowLink onClick={onConnectModels}>
                  Connect {liveModel.providerName} to show a live transcript
                </SettingRowLink>
              ) : (
                `An organization admin needs to connect ${liveModel.providerName} first.`
              )
            ) : undefined
          }
          control={
            <Switch
              aria-label="Live transcript"
              checked={liveTranscript}
              pending={saving}
              disabled={!canManage}
              {...(reason ? { disabledReason: reason } : {})}
              onCheckedChange={chooseLiveTranscript}
            />
          }
        />
      ) : null}
      <SettingRow
        label="Recognize people by voice"
        description={
          voiceprints
            ? "Suggests names for speakers it has heard before. Only people who agreed are recognized, and someone confirms each suggestion. Turning this off forgets every voice."
            : "Suggests names for speakers it has heard before. Only people who agreed are recognized."
        }
        control={
          <Switch
            aria-label="Recognize people by voice"
            checked={voiceprints}
            pending={saving}
            disabled={!canManage}
            {...(reason ? { disabledReason: reason } : {})}
            onCheckedChange={chooseVoiceprints}
          />
        }
      />
      {voiceprints ? (
        <VoiceRows
          workspaceId={workspaceId}
          viewer={viewer}
          {...(recordings ? { recordings } : {})}
        />
      ) : null}
      <SettingRow
        label="Keep meetings"
        description="Counted from when a meeting was recorded. After that the meeting is deleted with its audio and transcript, including meetings recorded before this was set."
        controlWidth="select"
        control={
          <NativeSelect
            aria-label="Keep meetings"
            options={periodOptions(
              MEETING_PERIODS,
              retention?.transcriptDays,
              "Until someone deletes them",
              undefined,
            )}
            value={
              retention?.transcriptDays === undefined ? KEEP : String(retention.transcriptDays)
            }
            onValueChange={(value) => chooseRetention("transcriptDays", value)}
            disabled={saving || !canManage}
            {...(reason ? { disabledReason: reason } : {})}
          />
        }
      />
      <SettingRow
        label="Keep audio"
        description="Deleting the audio keeps the transcript, but the meeting can't be played or transcribed again."
        controlWidth="select"
        control={
          <NativeSelect
            aria-label="Keep audio"
            options={periodOptions(
              AUDIO_PERIODS,
              retention?.audioDays,
              "As long as the meeting",
              retention?.transcriptDays,
            )}
            value={retention?.audioDays === undefined ? KEEP : String(retention.audioDays)}
            onValueChange={(value) => chooseRetention("audioDays", value)}
            disabled={saving || !canManage}
            {...(reason ? { disabledReason: reason } : {})}
          />
        }
      />
      <ConfirmDialog
        open={pendingRetention !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRetention(null);
        }}
        title={pendingRetention?.warning.title ?? ""}
        description={pendingRetention?.warning.description ?? ""}
        confirmLabel={pendingRetention?.warning.confirmLabel ?? ""}
        pendingLabel="Saving…"
        onConfirm={async () => {
          if (!pendingRetention) return false;
          return await saveRetention(pendingRetention.next, pendingRetention.success);
        }}
      />
      <ConfirmDialog
        open={confirmingOff}
        onOpenChange={setConfirmingOff}
        title="Stop recognizing people by voice?"
        description="Every voice remembered in this workspace is forgotten, and pending suggestions are removed. Names people already gave to speakers stay. Turning it back on starts from nothing."
        confirmLabel="Turn off and forget voices"
        pendingLabel="Forgetting…"
        onConfirm={async () => {
          const { voiceprints: _previous, ...rest } = current;
          return await save(rest, "Voices forgotten. People aren't recognized by voice anymore");
        }}
      />
    </Section>
  );
}

/**
 * "Your voice": each member decides for themselves. Agreeing lets Opengeni
 * learn the voice from meetings where they're named as a speaker.
 */
function VoiceRows({
  workspaceId,
  viewer,
  recordings,
}: {
  workspaceId: string;
  viewer: MeetingSettingsViewer;
  recordings?: RecordingsClientOverride["recordings"];
}) {
  const people = useRecordingPeople({ workspaceId, ...(recordings ? { recordings } : {}) });
  const [busy, setBusy] = useState(false);
  const me: RecordingPerson | null =
    people.people.find((person) => person.memberSubjectId === viewer.subjectId) ?? null;
  const voice = me?.voice ?? null;

  async function run(work: () => Promise<unknown>, success: string, failure: string) {
    setBusy(true);
    try {
      await work();
      toast.success(success);
    } catch (error) {
      toast.error(failure, { description: error instanceof Error ? error.message : undefined });
    } finally {
      setBusy(false);
    }
  }

  const remember = () =>
    void run(
      async () => {
        const person =
          me ??
          (await people.create({ displayName: viewer.name, memberSubjectId: viewer.subjectId }));
        await people.rememberVoice(person.id, "self");
      },
      "Your voice will be remembered",
      "Couldn't remember your voice",
    );
  const forget = () =>
    void run(
      async () => {
        if (me) await people.forgetVoice(me.id);
      },
      "Your voice is forgotten",
      "Couldn't forget your voice",
    );

  const others = people.people
    .filter((person) => person.voice && person.id !== me?.id)
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
  const forgetOther = (person: RecordingPerson) =>
    void run(
      async () => await people.forgetVoice(person.id),
      `${person.displayName}'s voice is forgotten`,
      "Couldn't forget this voice",
    );

  return (
    <>
      <SettingRow
        label="Your voice"
        description={
          voice
            ? voice.learned
              ? "Remembered. Meetings suggest your name when you speak. Forgetting it removes your voice right away."
              : "You agreed. Opengeni learns your voice the next time you're named as a speaker in a meeting."
            : "Lets meetings suggest your name when you speak. Opengeni learns your voice from meetings where you're named as a speaker. Only you can agree for yourself."
        }
        controlWidth="auto"
        control={
          voice ? (
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={forget}>
              Forget my voice
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy || people.loading}
              onClick={remember}
            >
              Remember my voice
            </Button>
          )
        }
      />
      <SettingRow
        label="Remembered voices"
        description={
          others.length === 0
            ? "Nobody else yet. People can agree for themselves here, and you can remember someone from outside the workspace from a speaker's menu in a meeting, once they agree."
            : "People whose voices suggest names in meetings. Members decide for themselves; anyone here can forget someone from outside the workspace."
        }
        controlWidth="auto"
      />
      {others.length > 0 ? (
        <ul aria-label="Remembered voices" className="grid gap-1 pb-2">
          {others.map((person) => (
            <li key={person.id} className="flex min-w-0 items-center gap-3 py-1">
              <span className="grid min-w-0 flex-1">
                <span className="truncate text-sm leading-5 text-fg">{person.displayName}</span>
                <span className="truncate text-xs leading-4 text-fg-muted">
                  {person.voice?.consent === "self"
                    ? "Agreed for themselves"
                    : "Someone confirmed they agreed"}
                  {person.voice?.learned ? "" : " · Not heard in a meeting yet"}
                </span>
              </span>
              {person.memberSubjectId ? (
                <span className="shrink-0 text-xs leading-4 text-fg-muted">
                  Only they can forget it
                </span>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  aria-label={`Forget ${person.displayName}'s voice`}
                  onClick={() => forgetOther(person)}
                >
                  Forget
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}
