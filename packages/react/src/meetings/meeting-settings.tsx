// Workspace settings → General → Meetings: who sees new meetings, which
// model transcribes them, and whether people are recognized by voice. All
// live under the workspace's `recordings` settings, which a patch replaces as
// a whole.
import { useOpenGeniText, createOpenGeniText, type OpenGeniText } from "../messages/runtime";
import { useState, type ComponentProps } from "react";
import { toast } from "sonner";

import {
  type RecordingPerson,
  type RecordingRetention,
  type RecordingTranscriptionModel,
  type RecordingVisibility,
  type WorkspaceRecordingSettings,
} from "@opengeni/contracts";
import {
  languageName,
  useRecordingModels,
  useRecordingPeople,
  type RecordingsClientOverride,
} from "../recordings";
import { Button } from "../ui/button";
import { ConfirmDialog } from "../ui/confirm-dialog";
import { Section } from "../ui/section";
import { SegmentedControl } from "../ui/segmented-control";
import { NativeSelect, type SelectOption } from "../ui/select-menu";
import { SettingRow, SettingRowLink } from "../ui/setting-row";
import { Switch } from "../ui/switch";

import { DETECT_LANGUAGE, meetingLanguageOptions } from "./meeting-languages";
import { MeetingsOverlayScope } from "./overlay-scope";

const defaultText = createOpenGeniText();

const DEFAULT = "default";
const KEEP = "keep";

const AUDIO_PERIODS = [0, 7, 30, 90, 365] as const;
const MEETING_PERIODS = [30, 90, 180, 365, 730] as const;

/** What a model costs and who pays, beside its name in the picker. */
export function transcriptionModelMeta(
  entry: RecordingTranscriptionModel,
  msg: OpenGeniText = defaultText,
): string {
  if (entry.funding === "workspace_subscription") return msg("meetings.settings.yourSubscription");
  if (entry.usdPerHour !== null && entry.usdPerHour > 0) {
    return msg("meetings.settings.valuePerHour", { value: entry.usdPerHour.toFixed(2) });
  }
  return entry.providerName;
}

/** Why a model can't be picked yet, and what makes it pickable. */
export function transcriptionModelUnavailableReason(
  entry: RecordingTranscriptionModel,
  msg: OpenGeniText = defaultText,
): string {
  const providerName = entry.providerName;
  switch (entry.funding) {
    case "workspace_subscription":
      return msg("meetings.settings.connectYourProvidernameFirst", { providerName });
    case "workspace_key":
      return msg("meetings.settings.connectProvidernameFirst", { providerName });
    case "deployment":
      return msg("meetings.settings.providernameIsnTAvailableHere", { providerName });
  }
}

/** "30 days", "1 year", "2 years". */
export function retentionPeriodName(days: number, msg: OpenGeniText = defaultText): string {
  if (days % 365 === 0) return msg("meetings.settings.countYears", { count: days / 365 });
  return msg("meetings.settings.countDays", { count: days });
}

/**
 * The confirmation for a retention change that deletes what's already
 * recorded, or null when the change deletes nothing sooner than before.
 */
export function retentionChangeWarning(
  before: RecordingRetention | undefined,
  after: RecordingRetention,
  msg: OpenGeniText = defaultText,
): { title: string; description: string; confirmLabel: string } | null {
  const shorter = (previous: number | undefined, next: number | undefined) =>
    next !== undefined && (previous === undefined || next < previous);
  if (shorter(before?.transcriptDays, after.transcriptDays)) {
    const period = retentionPeriodName(after.transcriptDays!, msg);
    return {
      title: msg("meetings.settings.deleteMeetingsAfterPeriod", { period: period }),
      description: msg("meetings.settings.meetingsRecordedMoreThanPeriod", {
        period: period,
      }),
      confirmLabel: msg("meetings.settings.deleteOldMeetings"),
    };
  }
  if (shorter(before?.audioDays, after.audioDays)) {
    const days = after.audioDays!;
    return {
      title:
        days === 0
          ? msg("meetings.settings.deleteAudioOnceTranscribed")
          : msg("meetings.settings.deleteAudioAfterRetentionperiodname", {
              retentionPeriodName: retentionPeriodName(days, msg),
            }),
      description:
        days === 0
          ? msg("meetings.settings.theAudioOfEveryTranscribed")
          : msg("meetings.settings.theAudioOfMeetingsRecorded", {
              retentionPeriodName: retentionPeriodName(days, msg),
            }),
      confirmLabel:
        days === 0
          ? msg("meetings.settings.deleteTranscribedAudio")
          : msg("meetings.settings.deleteOldAudio"),
    };
  }
  return null;
}

/** Who is looking at the settings, so they can agree to have their own voice remembered. */
export type MeetingSettingsViewer = { subjectId: string; name: string };

function MeetingDefaultsViewContent({
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
  const msg = useOpenGeniText();
  const models = useRecordingModels({ workspaceId, ...(recordings ? { recordings } : {}) });
  const [saving, setSaving] = useState(false);
  const reason = canManage ? undefined : msg("meetings.settings.onlyWorkspaceAdminsCanChange");

  /** False when the change failed or a newer one took over. */
  async function save(next: WorkspaceRecordingSettings, success: string): Promise<boolean> {
    setSaving(true);
    try {
      const saved = await onSave(next);
      if (saved) toast.success(success);
      return saved;
    } catch {
      toast.error(msg("meetings.settings.couldnTUpdateMeetingSettings"));
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
        ? msg("meetings.settings.newMeetingsAreSharedWith")
        : msg("meetings.settings.newMeetingsArePrivate"),
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
      // A pinned deployment has only that model, so it is not a default.
      label: fallbackName
        ? models.pinned
          ? fallbackName
          : msg("meetings.settings.defaultFallbackname", { fallbackName: fallbackName })
        : msg("meetings.settings.default"),
    },
    ...models.models.map((entry) => ({
      value: `${entry.providerId}/${entry.model}`,
      label: entry.name,
      meta: transcriptionModelMeta(entry, msg),
      disabled: !entry.available,
      disabledReason: entry.available ? undefined : transcriptionModelUnavailableReason(entry, msg),
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
      entry
        ? msg("meetings.settings.newMeetingsUseName", { name: entry.name })
        : msg("meetings.settings.newMeetingsUseTheDefault"),
    );
  };
  const noneAvailable =
    !models.loading && !models.error && !models.models.some((entry) => entry.available);

  const language = current.language ?? DETECT_LANGUAGE;
  const chooseLanguage = (value: string) => {
    if (value === language) return;
    const { language: _previous, ...rest } = current;
    void save(
      value === DETECT_LANGUAGE ? rest : { ...rest, language: value },
      value === DETECT_LANGUAGE
        ? msg("meetings.settings.newMeetingsDetectTheirLanguage")
        : msg("meetings.settings.newMeetingsAreTranscribedIn", {
            languageName: languageName(value, msg.locale),
          }),
    );
  };

  const voiceprints = current.voiceprints === true;
  const [confirmingOff, setConfirmingOff] = useState(false);
  const chooseVoiceprints = (next: boolean) => {
    if (next === voiceprints) return;
    if (!next) {
      setConfirmingOff(true);
      return;
    }
    void save(
      { ...current, voiceprints: true },
      msg("meetings.settings.peopleAreRecognizedByVoice"),
    );
  };

  const liveTranscript = current.liveTranscript === true;
  const liveModel = models.liveModels[0] ?? null;
  const liveAvailable = models.liveModels.some((entry) => entry.available);
  const chooseLiveTranscript = (next: boolean) => {
    if (next === liveTranscript) return;
    const { liveTranscript: _previous, ...rest } = current;
    void save(
      next ? { ...rest, liveTranscript: true } : rest,
      next
        ? msg("meetings.settings.newMeetingsShowALive")
        : msg("meetings.settings.newMeetingsDonTShow"),
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
          ? msg("meetings.settings.audioIsKeptAsLong")
          : days === 0
            ? msg("meetings.settings.audioIsDeletedOnceThe")
            : msg("meetings.settings.audioIsDeletedAfterRetentionperiodname", {
                retentionPeriodName: retentionPeriodName(days, msg),
              })
        : days === undefined
          ? msg("meetings.settings.meetingsAreKeptUntilSomeone")
          : msg("meetings.settings.meetingsAreDeletedAfterRetentionperiodname", {
              retentionPeriodName: retentionPeriodName(days, msg),
            });
    const warning = retentionChangeWarning(retention, next, msg);
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
          label:
            day === 0
              ? msg("meetings.settings.deleteOnceTranscribed")
              : retentionPeriodName(day, msg),
          disabled: tooLong,
          disabledReason: tooLong
            ? msg("meetings.settings.meetingsAreDeletedAfterRetentionperiodname", {
                retentionPeriodName: retentionPeriodName(limit, msg),
              })
            : undefined,
        };
      }),
    ];
  };

  return (
    <Section
      title={msg("meetings.settings.meetings")}
      description={msg("meetings.settings.defaultsForNewMeetingsAnd")}
    >
      {personal ? null : (
        <SettingRow
          label={msg("meetings.settings.whoSeesNewMeetings")}
          description={
            visibility === "workspace"
              ? msg("meetings.settings.everyoneInThisWorkspaceCan")
              : msg("meetings.settings.onlyThePersonWhoRecorded")
          }
          controlWidth="auto"
          control={
            <SegmentedControl
              size="sm"
              value={visibility}
              onValueChange={(next) => chooseVisibility(next as RecordingVisibility)}
              options={[
                { value: "private", label: msg("meetings.settings.onlyMe") },
                { value: "workspace", label: msg("meetings.settings.workspace") },
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
        label={msg("meetings.settings.transcriptionModel")}
        description={
          models.pinned
            ? msg("meetings.settings.turnsAMeetingSAudioPinned")
            : msg("meetings.settings.turnsAMeetingSAudio")
        }
        controlWidth="select"
        hint={
          noneAvailable ? (
            onConnectModels ? (
              <SettingRowLink onClick={onConnectModels}>
                {msg("meetings.settings.connectATranscriptionProviderTo")}
              </SettingRowLink>
            ) : (
              msg("meetings.settings.anOrganizationAdminNeedsTo")
            )
          ) : undefined
        }
        control={
          <NativeSelect
            aria-label={msg("meetings.settings.transcriptionModel")}
            options={modelOptions}
            value={chosen}
            onValueChange={chooseModel}
            loading={models.loading && models.models.length === 0}
            disabled={saving || !canManage || models.pinned}
            {...(models.pinned
              ? { disabledReason: msg("meetings.settings.thisDeploymentUsesOneModel") }
              : reason
                ? { disabledReason: reason }
                : {})}
          />
        }
      />
      <SettingRow
        label={msg("meetings.settings.meetingLanguage")}
        description={msg("meetings.settings.newMeetingsAreTranscribedIn2")}
        controlWidth="select"
        control={
          <NativeSelect
            aria-label={msg("meetings.settings.meetingLanguage")}
            options={meetingLanguageOptions(language, undefined, msg)}
            value={language}
            onValueChange={chooseLanguage}
            disabled={saving || !canManage}
            {...(reason ? { disabledReason: reason } : {})}
          />
        }
      />
      {liveModel ? (
        <SettingRow
          label={msg("meetings.settings.liveTranscript")}
          description={msg("meetings.settings.showsWhatSSaidWhile", {
            value:
              liveModel.usdPerHour !== null
                ? msg("meetings.settings.providernameChargesAboutValuePer", {
                    providerName: liveModel.providerName,
                    value: liveModel.usdPerHour.toFixed(2),
                  })
                : "",
          })}
          hint={
            !models.loading && !liveAvailable ? (
              onConnectModels ? (
                <SettingRowLink onClick={onConnectModels}>
                  {msg("meetings.settings.connectProvidernameToShowA", {
                    providerName: liveModel.providerName,
                  })}
                </SettingRowLink>
              ) : (
                msg("meetings.settings.anOrganizationAdminNeedsTo2", {
                  providerName: liveModel.providerName,
                })
              )
            ) : undefined
          }
          control={
            <Switch
              aria-label={msg("meetings.settings.liveTranscript")}
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
        label={msg("meetings.settings.recognizePeopleByVoice")}
        description={
          voiceprints
            ? msg("meetings.settings.suggestsNamesForSpeakersIt")
            : msg("meetings.settings.suggestsNamesForSpeakersIt2")
        }
        control={
          <Switch
            aria-label={msg("meetings.settings.recognizePeopleByVoice")}
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
        label={msg("meetings.settings.keepMeetings")}
        description={msg("meetings.settings.countedFromWhenAMeeting")}
        controlWidth="select"
        control={
          <NativeSelect
            aria-label={msg("meetings.settings.keepMeetings")}
            options={periodOptions(
              MEETING_PERIODS,
              retention?.transcriptDays,
              msg("meetings.settings.untilSomeoneDeletesThem"),
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
        label={msg("meetings.settings.keepAudio")}
        description={msg("meetings.settings.deletingTheAudioKeepsThe")}
        controlWidth="select"
        control={
          <NativeSelect
            aria-label={msg("meetings.settings.keepAudio")}
            options={periodOptions(
              AUDIO_PERIODS,
              retention?.audioDays,
              msg("meetings.settings.asLongAsTheMeeting"),
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
        pendingLabel={msg("meetings.settings.saving")}
        onConfirm={async () => {
          if (!pendingRetention) return false;
          return await saveRetention(pendingRetention.next, pendingRetention.success);
        }}
      />
      <ConfirmDialog
        open={confirmingOff}
        onOpenChange={setConfirmingOff}
        title={msg("meetings.settings.stopRecognizingPeopleByVoice")}
        description={msg("meetings.settings.everyVoiceRememberedInThis")}
        confirmLabel={msg("meetings.settings.turnOffAndForgetVoices")}
        pendingLabel={msg("meetings.settings.forgetting")}
        onConfirm={async () => {
          const { voiceprints: _previous, ...rest } = current;
          return await save(rest, msg("meetings.settings.voicesForgottenPeopleArenT"));
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
  const msg = useOpenGeniText();
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
      msg("meetings.settings.yourVoiceWillBeRemembered"),
      msg("meetings.settings.couldnTRememberYourVoice"),
    );
  const forget = () =>
    void run(
      async () => {
        if (me) await people.forgetVoice(me.id);
      },
      msg("meetings.settings.yourVoiceIsForgotten"),
      msg("meetings.settings.couldnTForgetYourVoice"),
    );

  const others = people.people
    .filter((person) => person.voice && person.id !== me?.id)
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
  const forgetOther = (person: RecordingPerson) =>
    void run(
      async () => await people.forgetVoice(person.id),
      msg("meetings.settings.displaynameSVoiceIsForgotten", { displayName: person.displayName }),
      msg("meetings.settings.couldnTForgetThisVoice"),
    );

  return (
    <>
      <SettingRow
        label={msg("meetings.settings.yourVoice")}
        description={
          voice
            ? voice.learned
              ? msg("meetings.settings.rememberedMeetingsSuggestYourName")
              : msg("meetings.settings.youAgreedOpengeniLearnsYour")
            : msg("meetings.settings.letsMeetingsSuggestYourName")
        }
        controlWidth="auto"
        control={
          voice ? (
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={forget}>
              {msg("meetings.settings.forgetMyVoice")}
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy || people.loading}
              onClick={remember}
            >
              {msg("meetings.settings.rememberMyVoice")}
            </Button>
          )
        }
      />
      <SettingRow
        label={msg("meetings.settings.rememberedVoices")}
        description={
          others.length === 0
            ? msg("meetings.settings.nobodyElseYetPeopleCan")
            : msg("meetings.settings.peopleWhoseVoicesSuggestNames")
        }
        controlWidth="auto"
      />
      {others.length > 0 ? (
        <ul aria-label={msg("meetings.settings.rememberedVoices")} className="grid gap-1 pb-2">
          {others.map((person) => (
            <li key={person.id} className="flex min-w-0 items-center gap-3 py-1">
              <span className="grid min-w-0 flex-1">
                <span className="truncate text-sm leading-5 text-fg">{person.displayName}</span>
                <span className="truncate text-xs leading-4 text-fg-muted">
                  {person.voice?.consent === "self"
                    ? person.voice?.learned
                      ? msg("meetings.settings.agreedForThemselves")
                      : msg("meetings.settings.agreedForThemselvesNotHeard")
                    : person.voice?.learned
                      ? msg("meetings.settings.someoneConfirmedTheyAgreed")
                      : msg("meetings.settings.someoneConfirmedTheyAgreedNot")}
                </span>
              </span>
              {person.memberSubjectId ? (
                <span className="shrink-0 text-xs leading-4 text-fg-muted">
                  {msg("meetings.settings.onlyTheyCanForgetIt")}
                </span>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  aria-label={msg("meetings.settings.forgetDisplaynameSVoice", {
                    displayName: person.displayName,
                  })}
                  onClick={() => forgetOther(person)}
                >
                  {msg("meetings.settings.forget")}
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

export function MeetingDefaultsView(props: ComponentProps<typeof MeetingDefaultsViewContent>) {
  return (
    <MeetingsOverlayScope>
      <MeetingDefaultsViewContent {...props} />
    </MeetingsOverlayScope>
  );
}
