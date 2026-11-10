// The desktop app's dictation settings: turning dictation from anywhere on,
// its shortcuts and their languages, where the text goes, what the system
// must allow, the words to listen for, and the recent dictations kept on this
// computer, to copy, play or transcribe again.
import {
  getDesktopDictation,
  type DesktopDictation,
  type DesktopDictationAction,
  type DesktopDictationHistoryEntry,
  type DesktopDictationKeys,
  type DesktopDictationModel,
  type DesktopDictationModifier,
  type DesktopDictationOutput,
  type DesktopDictationPasteBlocker,
  type DesktopDictationPermissionId,
  type DesktopDictationProfile,
  type DesktopDictationSettings,
  type DesktopDictationShortcut,
  type DesktopDictationShortcutProblem,
  type DesktopDictationStatus,
  type DesktopPlatform,
} from "@opengeni/sdk/desktop-bridge";
import {
  Building2Icon,
  CheckIcon,
  CopyIcon,
  LockIcon,
  MicOffIcon,
  PlayIcon,
  RotateCcwIcon,
  SquareIcon,
  Trash2Icon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { copyTextToClipboard } from "../../lib/clipboard";
import { MEETING_LANGUAGES } from "../../meetings/meeting-languages";
import { useOpenGeniText, type OpenGeniText } from "../../messages/runtime";
import { languageName } from "../../recordings-model";
import { Button } from "../../ui/button";
import { RelativeTime } from "../../ui/relative-time";
import { Section } from "../../ui/section";
import { SelectMenu, type SelectOption } from "../../ui/select-menu";
import { SettingRow } from "../../ui/setting-row";
import { Switch } from "../../ui/switch";
import { WordListRow } from "../../ui/word-list-row";
import { acceleratorFromKey, desktopShortcutLabel, sameDesktopShortcut } from "./shortcuts";
import { dictationWorkspace, type DictationWorkspaceChoice } from "./workspace";

/** At most this many shortcuts, as the app keeps them. */
const PROFILES_MAX = 8;
const DETECT = "auto";
/** A shortcut without a model of its own: the workspace's voice input model. */
const WORKSPACE_MODEL = "workspace";
const CUSTOM = "custom";
/** Modifier keys held together that make a good shortcut on a Mac, the usual one first. */
const CHORDS: DesktopDictationModifier[][] = [
  ["control", "fn"],
  ["option", "fn"],
  ["command", "fn"],
  ["shift", "fn"],
];
/** Key combinations offered to a new shortcut where modifier keys can't be watched. */
const ACCELERATORS = [
  "Control+Shift+Space",
  "Control+Alt+Space",
  "Control+Shift+D",
  "Control+Alt+D",
];
const CHORD_ORDER: DesktopDictationModifier[] = ["command", "option", "control", "shift", "fn"];
/** What `recordingFor` holds while the retry or cancel shortcut's keys are recorded. */
const ACTION_PREFIX = "action:";
const NONE = "none";
const KEYS = "keys";
/** As the app keeps them. */

export type UseDesktopDictationResult = {
  /** The app's dictation, or null outside a desktop app that offers it. */
  dictation: DesktopDictation | null;
  /** Null until read. */
  status: DesktopDictationStatus | null;
  /** Newest first. */
  history: DesktopDictationHistoryEntry[];
  saving: boolean;
  /** A plain sentence when the last change couldn't be saved. */
  error: string | null;
  /** Saves a change; resolves to the app's status after it, or null when it wasn't saved. */
  update: (change: Partial<DesktopDictationSettings>) => Promise<DesktopDictationStatus | null>;
  requestPermission: (id: DesktopDictationPermissionId) => void;
  clearHistory: () => Promise<void>;
  /** Transcribe a kept dictation again; null in apps that can't. */
  transcribeAgain: ((id: string) => void) | null;
};

/** The app's dictation settings and recent dictations, kept current. */
export function useDesktopDictation(
  given?: DesktopDictation | null | undefined,
): UseDesktopDictationResult {
  const t = useOpenGeniText();
  const dictation = useMemo(() => (given === undefined ? getDesktopDictation() : given), [given]);
  const [status, setStatus] = useState<DesktopDictationStatus | null>(null);
  const [history, setHistory] = useState<DesktopDictationHistoryEntry[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    if (!dictation) return;
    void dictation.status().then(setStatus, () => undefined);
    void dictation.history().then(setHistory, () => undefined);
  }, [dictation]);

  useEffect(() => {
    if (!dictation) return;
    refresh();
    const off = dictation.onChange(refresh);
    // Permissions are granted in the system's settings, outside the app.
    const onFocus = () => refresh();
    globalThis.addEventListener?.("focus", onFocus);
    return () => {
      off();
      globalThis.removeEventListener?.("focus", onFocus);
    };
  }, [dictation, refresh]);

  const update = useCallback(
    async (change: Partial<DesktopDictationSettings>): Promise<DesktopDictationStatus | null> => {
      if (!dictation) return null;
      setSaving(true);
      setError(null);
      try {
        const next = await dictation.update(change);
        setStatus(next);
        return next;
      } catch {
        setError(t("desktopDictation.settings.saveFailed"));
        return null;
      } finally {
        setSaving(false);
      }
    },
    [dictation, t],
  );

  const requestPermission = useCallback(
    (id: DesktopDictationPermissionId) => {
      void dictation
        ?.requestPermission(id)
        .then(refresh)
        .catch(() => undefined);
    },
    [dictation, refresh],
  );

  const clearHistory = useCallback(async () => {
    if (!dictation) return;
    await dictation.clearHistory().catch(() => undefined);
    setHistory([]);
  }, [dictation]);

  const transcribeAgain = useCallback(
    (id: string) => void dictation?.transcribeAgain?.(id).catch(() => undefined),
    [dictation],
  );

  return {
    dictation,
    status,
    history,
    saving,
    error,
    update,
    requestPermission,
    clearHistory,
    transcribeAgain: typeof dictation?.transcribeAgain === "function" ? transcribeAgain : null,
  };
}

export type DesktopDictationSettingsProps = {
  /** The app's dictation. `getDesktopDictation()` by default. */
  dictation?: DesktopDictation | null | undefined;
  /** Languages offered for each shortcut, as ISO codes. Common languages by default. */
  languages?: readonly string[] | undefined;
  /**
   * The speech-to-text models a shortcut can pick, such as one for English
   * and another for Norwegian: the signed-in workspace's
   * `clientConfig.voiceInput.models`. Without them each shortcut uses the
   * workspace's voice input model and no model is offered.
   */
  models?: readonly DictationModelChoice[] | undefined;
  /** `models` are being read, such as after the workspace changed: the rows wait for them. */
  modelsLoading?: boolean | undefined;
  /**
   * The person's workspaces, and their default one. With more than one, in an
   * app that keeps the choice, the person picks the workspace every shortcut
   * dictation belongs to, whichever one the app shows; `models` are then that
   * workspace's (`dictationWorkspace` says which it is).
   */
  workspaces?: DictationWorkspaces | undefined;
  className?: string | undefined;
};

/** The workspaces dictation can belong to. */
export type DictationWorkspaces = {
  choices: readonly DictationWorkspaceChoice[];
  defaultWorkspaceId: string | null;
};

/** A model a dictation shortcut can pick, as the workspace's voice input lists it. */
export type DictationModelChoice = DesktopDictationModel & {
  providerName: string;
  /** The model's name, such as "MAI-Transcribe-2". */
  name: string;
};

/**
 * Settings for dictation from anywhere, shown only inside a desktop app that
 * offers it on this computer. Pair it with {@link DesktopDictationHost}
 * mounted on the signed-in pages.
 */
export function DesktopDictationSettings({
  dictation: given,
  languages = MEETING_LANGUAGES,
  models = NO_MODELS,
  modelsLoading = false,
  workspaces,
  className,
}: DesktopDictationSettingsProps) {
  const t = useOpenGeniText();
  const {
    dictation,
    status,
    history,
    saving,
    error,
    update,
    requestPermission,
    clearHistory,
    transcribeAgain,
  } = useDesktopDictation(given);
  const [recordingFor, setRecordingFor] = useState<string | null>(null);
  const [keysError, setKeysError] = useState<{ profileId: string; message: string } | null>(null);
  const playback = usePlayback(dictation);
  const platform: DesktopPlatform = status?.platform ?? "macos";
  const settings = status?.settings ?? null;

  const saveProfiles = useCallback(
    (profiles: DesktopDictationProfile[]) => {
      setKeysError(null);
      void update({ profiles });
    },
    [update],
  );

  // Recording a key combination: the next one pressed becomes the shortcut.
  useEffect(() => {
    if (!recordingFor || !settings) return;
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape" && !event.metaKey && !event.ctrlKey && !event.altKey) {
        setRecordingFor(null);
        return;
      }
      const accelerator = acceleratorFromKey(event, platform);
      if (!accelerator) return;
      setRecordingFor(null);
      const shortcut: DesktopDictationShortcut = { kind: "accelerator", accelerator };
      if (usedByAnother(settings, recordingFor, shortcut)) {
        setKeysError({
          profileId: recordingFor,
          message: t("desktopDictation.settings.usedByAnother"),
        });
        return;
      }
      if (recordingFor.startsWith(ACTION_PREFIX)) {
        const action = recordingFor.slice(ACTION_PREFIX.length) as DesktopDictationAction;
        void update({ [actionKey(action)]: { kind: "accelerator", accelerator } });
        return;
      }
      saveProfiles(
        settings.profiles.map((profile) =>
          profile.id === recordingFor ? { ...profile, shortcut } : profile,
        ),
      );
    };
    globalThis.addEventListener("keydown", onKey, true);
    return () => globalThis.removeEventListener("keydown", onKey, true);
  }, [platform, recordingFor, saveProfiles, settings, t, update]);

  if (!dictation || !status?.supported || !settings) return null;
  const { profiles } = settings;
  const single = profiles.length === 1;
  const modifierShortcuts = profiles.some((profile) => profile.shortcut.kind !== "accelerator");
  const accessibility = status.permissions.find((permission) => permission.id === "accessibility");
  const first = profiles[0]!;
  // Kept only by apps that keep it (older ones always use the default workspace).
  const home =
    workspaces && settings.workspace !== undefined
      ? dictationWorkspace(settings, workspaces.choices, workspaces.defaultWorkspaceId)
      : null;
  const homeChoice = workspaces?.choices.find((choice) => choice.id === home?.workspaceId);
  const voiceOff = homeChoice?.voiceInputOff === true;
  const offerWorkspaces =
    home !== null &&
    workspaces !== undefined &&
    (workspaces.choices.length > 1 || home.gone || voiceOff);
  // The workspace the models are of, to name in their rows.
  const modelsOf = home && !home.gone ? home.name : null;
  const workspaceError = home?.gone
    ? t("desktopDictation.settings.workspaceGone", { workspace: home.name ?? "" })
    : voiceOff
      ? t("desktopDictation.settings.workspaceVoiceOff", { workspace: homeChoice.name })
      : null;

  const languageOptions = (current: string | null): SelectOption[] => {
    const codes: string[] = [...languages];
    if (current && !codes.includes(current)) codes.push(current);
    return [
      { value: DETECT, label: t("desktopDictation.settings.detectAutomatically") },
      ...codes.map((code) => ({ value: code, label: languageName(code, t.locale) })),
    ];
  };

  const setLanguage = (id: string, value: string) => {
    const language = value === DETECT ? null : value;
    saveProfiles(
      profiles.map((profile) =>
        profile.id === id ? { ...profile, language, name: profileName(language, t) } : profile,
      ),
    );
  };

  const modelOptions = (current: DesktopDictationModel | null | undefined): SelectOption[] => [
    {
      value: WORKSPACE_MODEL,
      label: home?.personal
        ? t("desktopDictation.settings.workspaceModelPersonal")
        : modelsOf
          ? t("desktopDictation.settings.workspaceModelIn", { workspace: modelsOf })
          : t("desktopDictation.settings.workspaceModel"),
    },
    ...(current && !models.some((entry) => sameModel(entry, current))
      ? [
          {
            value: modelValue(current),
            // Named as it was when picked; older settings kept only its id.
            label: current.name ?? current.model,
            disabled: true,
            disabledReason: modelsOf
              ? t("desktopDictation.settings.modelUnavailableIn", { workspace: modelsOf })
              : t("desktopDictation.settings.modelUnavailable"),
          },
        ]
      : []),
    ...models.map((entry) => ({ value: modelValue(entry), label: modelLabel(entry) })),
  ];

  const setModel = (id: string, value: string) => {
    const chosen = models.find((entry) => modelValue(entry) === value);
    saveProfiles(
      profiles.map((profile) =>
        profile.id === id
          ? {
              ...profile,
              model: chosen
                ? {
                    providerId: chosen.providerId,
                    model: chosen.model,
                    name: modelLabel(chosen),
                  }
                : null,
            }
          : profile,
      ),
    );
  };
  // Offered once there is a choice, and always while a shortcut has one picked.
  const offerModels =
    modelsLoading || models.length > 0 || profiles.some((profile) => profile.model);
  // A shortcut's own model the workspace doesn't offer: every press fails until
  // another is picked, so its row says so. (With no list, the server takes any.)
  const modelProblem = (model: DesktopDictationModel | null | undefined): string | null =>
    model && !modelsLoading && models.length > 0 && !models.some((entry) => sameModel(entry, model))
      ? modelsOf
        ? t("desktopDictation.settings.modelNotOfferedIn", { workspace: modelsOf })
        : t("desktopDictation.settings.modelNotOffered")
      : null;

  const addProfile = () => {
    const used = new Set(profiles.map((profile) => profile.language));
    const language = [...languages].find((code) => !used.has(code)) ?? null;
    const shortcut = freeShortcut(profiles, status);
    if (!shortcut) return;
    const id = newProfileId(profiles);
    // With more than one, each is named for its language wherever it shows.
    saveProfiles([
      ...profiles.map((profile) => ({ ...profile, name: profileName(profile.language, t) })),
      { id, name: profileName(language, t), shortcut, language },
    ]);
  };

  const onToggle = (enabled: boolean) => {
    void update({ enabled }).then((next) => {
      // Typing into other apps needs Accessibility on a Mac: ask once it is on
      // (an app may keep it off, such as until the person agrees to something).
      const permission = next?.permissions.find((entry) => entry.id === "accessibility");
      if (
        next?.settings.enabled &&
        next.settings.output !== "copy" &&
        permission?.granted === false
      ) {
        requestPermission("accessibility");
      }
    });
  };

  return (
    <>
      <Section
        variant="group"
        title={t("desktopDictation.settings.title")}
        description={t("desktopDictation.settings.description")}
        className={className}
      >
        <SettingRow
          label={t("desktopDictation.settings.toggleLabel")}
          description={
            settings.enabled
              ? single
                ? t(
                    settings.mode === "hold" && first.shortcut.kind !== "accelerator"
                      ? "desktopDictation.settings.toggleOnHold"
                      : "desktopDictation.settings.toggleOn",
                    { shortcut: desktopShortcutLabel(first.shortcut, platform) },
                  )
                : t("desktopDictation.settings.toggleOnMany")
              : t("desktopDictation.settings.toggleOff")
          }
          error={error}
          control={
            <Switch
              checked={settings.enabled}
              pending={saving}
              aria-label={t("desktopDictation.settings.toggleLabel")}
              onCheckedChange={onToggle}
            />
          }
        />
        {settings.enabled ? (
          // Rows of their own, split by hairlines: the workspace every shortcut
          // uses, each shortcut with its language and model, then the rest.
          <>
            {offerWorkspaces ? (
              <SettingRow
                label={t("desktopDictation.settings.workspaceLabel")}
                description={t("desktopDictation.settings.workspaceDescription")}
                error={workspaceError}
                controlWidth="select"
                control={
                  <SelectMenu
                    size="sm"
                    className="w-56"
                    align="end"
                    variant={workspaces.choices.length > 8 ? "combobox" : "menu"}
                    disabled={saving}
                    aria-label={t("desktopDictation.settings.workspaceLabel")}
                    invalid={workspaceError !== null}
                    placeholder={t("desktopDictation.settings.workspacePlaceholder")}
                    searchPlaceholder={t("desktopDictation.settings.workspaceSearch")}
                    value={home.workspaceId}
                    options={workspaceOptions(workspaces, t)}
                    onValueChange={(id) => {
                      const chosen = workspaces.choices.find((choice) => choice.id === id);
                      if (chosen) void update({ workspace: { id, name: chosen.name } });
                    }}
                  />
                }
              />
            ) : null}
            {profiles.map((profile) => (
              <ProfileRows
                key={profile.id}
                profile={profile}
                profiles={profiles}
                status={status}
                single={single}
                saving={saving}
                recording={recordingFor === profile.id}
                error={
                  (keysError?.profileId === profile.id ? keysError.message : null) ??
                  shortcutProblemMessage(
                    status.shortcutErrors.find((item) => item.profileId === profile.id)?.problem,
                    t,
                  )
                }
                languageOptions={languageOptions(profile.language)}
                modelOptions={offerModels ? modelOptions(profile.model) : null}
                modelsLoading={modelsLoading}
                modelError={modelProblem(profile.model)}
                onModel={(value) => setModel(profile.id, value)}
                onRecord={(recording) => {
                  setKeysError(null);
                  setRecordingFor(recording ? profile.id : null);
                }}
                onShortcut={(shortcut) =>
                  saveProfiles(
                    profiles.map((item) => (item.id === profile.id ? { ...item, shortcut } : item)),
                  )
                }
                onLanguage={(value) => setLanguage(profile.id, value)}
                onRemove={() => saveProfiles(profiles.filter((item) => item.id !== profile.id))}
              />
            ))}
            {profiles.length < PROFILES_MAX && freeShortcut(profiles, status) ? (
              <SettingRow
                label={t("desktopDictation.settings.addLabel")}
                description={t("desktopDictation.settings.addDescription")}
                control={
                  <Button size="sm" variant="outline" disabled={saving} onClick={addProfile}>
                    {t("desktopDictation.settings.add")}
                  </Button>
                }
              />
            ) : null}
            {modifierShortcuts ? (
              <SettingRow
                label={t("desktopDictation.settings.modeLabel")}
                controlWidth="select"
                control={
                  <SelectMenu
                    size="sm"
                    className="w-56"
                    align="end"
                    disabled={saving}
                    aria-label={t("desktopDictation.settings.modeLabel")}
                    value={settings.mode}
                    options={[
                      {
                        value: "toggle",
                        label: t("desktopDictation.settings.modeToggle"),
                        description: t("desktopDictation.settings.modeToggleDescription"),
                      },
                      {
                        value: "hold",
                        label: t("desktopDictation.settings.modeHold"),
                        description: t("desktopDictation.settings.modeHoldDescription"),
                      },
                    ]}
                    onValueChange={(mode) => void update({ mode })}
                  />
                }
              />
            ) : null}
            <SettingRow
              label={t("desktopDictation.settings.outputLabel")}
              description={
                status.paste.available
                  ? t("desktopDictation.settings.outputDescription")
                  : pasteBlockedMessage(status.paste.blocker, t)
              }
              controlWidth="select"
              control={
                <SelectMenu<DesktopDictationOutput>
                  size="sm"
                  className="w-56"
                  align="end"
                  disabled={saving}
                  aria-label={t("desktopDictation.settings.outputLabel")}
                  value={settings.output}
                  options={[
                    {
                      value: "paste",
                      label: t("desktopDictation.settings.outputPaste"),
                      description: t("desktopDictation.settings.outputPasteDescription"),
                    },
                    {
                      value: "pasteAndCopy",
                      label: t("desktopDictation.settings.outputPasteAndCopy"),
                      description: t("desktopDictation.settings.outputPasteAndCopyDescription"),
                    },
                    {
                      value: "copy",
                      label: t("desktopDictation.settings.outputCopy"),
                      description: t("desktopDictation.settings.outputCopyDescription"),
                    },
                  ]}
                  onValueChange={(output) => void update({ output })}
                />
              }
            />
            {accessibility && settings.output !== "copy" ? (
              <SettingRow
                label={t("desktopDictation.settings.accessibilityLabel")}
                description={t("desktopDictation.settings.accessibilityDescription")}
                control={
                  accessibility.granted ? (
                    <span className="inline-flex items-center gap-1.5 text-sm text-fg-muted">
                      <CheckIcon className="size-4 text-status-success" aria-hidden />
                      {t("desktopDictation.settings.allowed")}
                    </span>
                  ) : (
                    <Button size="sm" onClick={() => requestPermission("accessibility")}>
                      {t("desktopDictation.settings.allow")}
                    </Button>
                  )
                }
              />
            ) : null}
            {settings.retryShortcut !== undefined
              ? (["retry", "cancel"] as const).map((action) => (
                  <ActionShortcutRow
                    key={action}
                    action={action}
                    keys={settings[actionKey(action)] ?? null}
                    platform={platform}
                    saving={saving}
                    recording={recordingFor === `${ACTION_PREFIX}${action}`}
                    error={
                      (keysError?.profileId === `${ACTION_PREFIX}${action}`
                        ? keysError.message
                        : null) ??
                      shortcutProblemMessage(
                        status.actionShortcutErrors?.find((item) => item.action === action)
                          ?.problem,
                        t,
                      )
                    }
                    onRecord={(recording) => {
                      setKeysError(null);
                      setRecordingFor(recording ? `${ACTION_PREFIX}${action}` : null);
                    }}
                    onClear={() => void update({ [actionKey(action)]: null })}
                  />
                ))
              : null}
            {settings.vocabulary !== undefined ? (
              <WordListRow
                words={settings.vocabulary}
                saving={saving}
                text={{
                  label: t("desktopDictation.settings.vocabularyLabel"),
                  description: t("desktopDictation.settings.vocabularyDescription"),
                  placeholder: t("desktopDictation.settings.vocabularyPlaceholder"),
                  termTooLong: (term, max) =>
                    t("desktopDictation.settings.vocabularyTermTooLong", {
                      term,
                      max: String(max),
                    }),
                  tooMany: (max) =>
                    t("desktopDictation.settings.vocabularyTooMany", { max: String(max) }),
                }}
                onChange={(vocabulary) => void update({ vocabulary })}
              />
            ) : null}
          </>
        ) : null}
      </Section>
      {history.length > 0 ? (
        <Section
          variant="group"
          title={t("desktopDictation.settings.historyTitle")}
          description={t("desktopDictation.settings.historyDescription")}
          action={
            <Button size="sm" variant="ghost" onClick={() => void clearHistory()}>
              {t("desktopDictation.settings.clearHistory")}
            </Button>
          }
        >
          {history.slice(0, 10).map((entry) => (
            <SettingRow
              key={entry.id}
              label={
                entry.cancelled ? (
                  <span className="font-normal text-fg-muted">
                    {t("desktopDictation.settings.cancelledDictation")}
                  </span>
                ) : (
                  <span className="line-clamp-2 font-normal break-words">{entry.text}</span>
                )
              }
              description={
                <>
                  <RelativeTime date={entry.at} focusable={false} />
                  {profiles.length > 1 ? ` · ${entry.profileName}` : null}
                </>
              }
              control={
                <div className="flex items-center gap-0.5">
                  {entry.audio && dictation.historyAudio ? (
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={t(
                        playback.playing === entry.id
                          ? "desktopDictation.settings.stopPlaying"
                          : "desktopDictation.settings.play",
                      )}
                      title={t(
                        playback.playing === entry.id
                          ? "desktopDictation.settings.stopPlaying"
                          : "desktopDictation.settings.play",
                      )}
                      onClick={() => playback.toggle(entry.id)}
                    >
                      {playback.playing === entry.id ? (
                        <SquareIcon aria-hidden />
                      ) : (
                        <PlayIcon aria-hidden />
                      )}
                    </Button>
                  ) : null}
                  {entry.audio && transcribeAgain ? (
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={t("desktopDictation.settings.transcribeAgain")}
                      title={t("desktopDictation.settings.transcribeAgain")}
                      onClick={() => transcribeAgain(entry.id)}
                    >
                      <RotateCcwIcon aria-hidden />
                    </Button>
                  ) : null}
                  {entry.text ? (
                    <CopyText text={entry.text} label={t("desktopDictation.settings.copyText")} />
                  ) : null}
                </div>
              }
            />
          ))}
        </Section>
      ) : null}
    </>
  );
}

/** Copies a dictation's text again; a check shows it worked. */
function CopyText({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <Button
      size="icon-sm"
      variant="ghost"
      aria-label={label}
      title={label}
      onClick={() => {
        void copyTextToClipboard(text).then((ok) => {
          if (!ok) return;
          setCopied(true);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1_600);
        });
      }}
    >
      {copied ? (
        <CheckIcon className="text-status-success" aria-hidden />
      ) : (
        <CopyIcon aria-hidden />
      )}
    </Button>
  );
}

/** The retry or cancel shortcut: none, or a key combination the person presses. */
function ActionShortcutRow({
  action,
  keys,
  platform,
  saving,
  recording,
  error,
  onRecord,
  onClear,
}: {
  action: DesktopDictationAction;
  keys: DesktopDictationKeys | null;
  platform: DesktopPlatform;
  saving: boolean;
  recording: boolean;
  error: string | null;
  onRecord: (recording: boolean) => void;
  onClear: () => void;
}) {
  const t = useOpenGeniText();
  const label = t(
    action === "retry"
      ? "desktopDictation.settings.retryShortcutLabel"
      : "desktopDictation.settings.cancelShortcutLabel",
  );
  const options: SelectOption[] = [
    { value: NONE, label: t("desktopDictation.settings.noShortcut") },
    ...(keys ? [{ value: KEYS, label: desktopShortcutLabel(keys, platform) }] : []),
    {
      value: CUSTOM,
      label: t(
        keys
          ? "desktopDictation.settings.otherKeyCombination"
          : "desktopDictation.settings.keyCombination",
      ),
      description: t("desktopDictation.settings.keyCombinationDescription"),
    },
  ];
  return (
    <SettingRow
      label={label}
      description={
        recording
          ? t("desktopDictation.settings.recordKeys")
          : t(
              action === "retry"
                ? "desktopDictation.settings.retryShortcutDescription"
                : "desktopDictation.settings.cancelShortcutDescription",
            )
      }
      error={error}
      controlWidth="select"
      control={
        recording ? (
          <Button size="sm" variant="outline" onClick={() => onRecord(false)}>
            {t("desktopDictation.settings.cancelRecording")}
          </Button>
        ) : (
          <SelectMenu
            size="sm"
            className="w-56"
            align="end"
            disabled={saving}
            aria-label={label}
            options={options}
            value={keys ? KEYS : NONE}
            onValueChange={(value) => {
              if (value === CUSTOM) onRecord(true);
              else if (value === NONE) onClear();
            }}
          />
        )
      }
    />
  );
}

/** Plays one kept dictation's speech at a time. */
function usePlayback(dictation: DesktopDictation | null): {
  playing: string | null;
  toggle: (id: string) => void;
} {
  const [playing, setPlaying] = useState<string | null>(null);
  const current = useRef<{ id: string; context: AudioContext } | null>(null);
  const stop = useCallback(() => {
    const now = current.current;
    current.current = null;
    setPlaying(null);
    void now?.context.close().catch(() => undefined);
  }, []);
  useEffect(() => stop, [stop]);
  const toggle = useCallback(
    (id: string) => {
      const wasPlaying = current.current?.id === id;
      stop();
      if (wasPlaying || !dictation?.historyAudio) return;
      const Context =
        (globalThis as { AudioContext?: typeof AudioContext }).AudioContext ??
        (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Context) return;
      const context = new Context();
      const mine = { id, context };
      current.current = mine;
      setPlaying(id);
      void (async () => {
        try {
          const audio = await dictation.historyAudio!(id);
          if (!audio || current.current !== mine) throw new Error("gone");
          // A copy: decoding takes the buffer over.
          const buffer = await context.decodeAudioData(audio.bytes.slice().buffer as ArrayBuffer);
          if (current.current !== mine) return;
          const source = context.createBufferSource();
          source.buffer = buffer;
          source.connect(context.destination);
          source.onended = () => {
            if (current.current === mine) stop();
          };
          source.start();
        } catch {
          if (current.current === mine) stop();
        }
      })();
    },
    [dictation, stop],
  );
  return { playing, toggle };
}

function ProfileRows({
  profile,
  profiles,
  status,
  single,
  saving,
  recording,
  error,
  languageOptions,
  modelOptions,
  modelsLoading,
  modelError,
  onRecord,
  onShortcut,
  onLanguage,
  onModel,
  onRemove,
}: {
  profile: DesktopDictationProfile;
  profiles: DesktopDictationProfile[];
  status: DesktopDictationStatus;
  single: boolean;
  saving: boolean;
  recording: boolean;
  error: string | null;
  languageOptions: SelectOption[];
  /** Null when there is no model to pick. */
  modelOptions: SelectOption[] | null;
  modelsLoading: boolean;
  /** Why the shortcut's model can't be used, when it can't. */
  modelError: string | null;
  onRecord: (recording: boolean) => void;
  onShortcut: (shortcut: DesktopDictationShortcut) => void;
  onLanguage: (value: string) => void;
  onModel: (value: string) => void;
  onRemove: () => void;
}) {
  const t = useOpenGeniText();
  const { shortcut } = profile;
  const options = shortcutOptions(profile, profiles, status, t);
  const hold = status.settings.mode === "hold";
  const description = recording
    ? t("desktopDictation.settings.recordKeys")
    : shortcut.kind === "modifierChord"
      ? t(hold ? "desktopDictation.settings.chordHold" : "desktopDictation.settings.chordToggle")
      : shortcut.kind === "modifierPair"
        ? t(hold ? "desktopDictation.settings.pairHold" : "desktopDictation.settings.pairToggle")
        : t("desktopDictation.settings.acceleratorToggle");
  return (
    <SettingRow
      label={single ? t("desktopDictation.settings.shortcutLabel") : profile.name}
      description={description}
      error={error}
      controlWidth="select"
      control={
        recording ? (
          <Button size="sm" variant="outline" onClick={() => onRecord(false)}>
            {t("desktopDictation.settings.cancelRecording")}
          </Button>
        ) : (
          <div className="flex w-full items-center gap-1">
            <SelectMenu
              size="sm"
              className="min-w-0 flex-1"
              align="end"
              disabled={saving}
              aria-label={t("desktopDictation.settings.shortcutLabel")}
              options={options}
              value={shortcutValue(shortcut)}
              onValueChange={(value) => {
                if (value === CUSTOM) {
                  onRecord(true);
                  return;
                }
                const next = shortcutFromValue(value);
                if (next) onShortcut(next);
              }}
            />
            {single ? null : (
              <Button
                size="icon-sm"
                variant="ghost"
                disabled={saving}
                aria-label={t("desktopDictation.settings.remove")}
                title={t("desktopDictation.settings.remove")}
                onClick={onRemove}
              >
                <Trash2Icon aria-hidden />
              </Button>
            )}
          </div>
        )
      }
    >
      <SettingRow
        label={t("desktopDictation.settings.languageLabel")}
        description={t("desktopDictation.settings.languageDescription")}
        controlWidth="select"
        control={
          <SelectMenu
            size="sm"
            className="w-56"
            align="end"
            disabled={saving}
            aria-label={t("desktopDictation.settings.languageLabel")}
            options={languageOptions}
            value={profile.language ?? DETECT}
            onValueChange={onLanguage}
          />
        }
      />
      {modelOptions ? (
        <SettingRow
          label={t("desktopDictation.settings.modelLabel")}
          description={t("desktopDictation.settings.modelDescription")}
          error={modelError}
          controlWidth="select"
          control={
            <SelectMenu
              size="sm"
              className="w-56"
              align="end"
              disabled={saving}
              loading={modelsLoading}
              invalid={modelError !== null}
              aria-label={t("desktopDictation.settings.modelLabel")}
              options={modelOptions}
              value={profile.model ? modelValue(profile.model) : WORKSPACE_MODEL}
              onValueChange={onModel}
            />
          }
        />
      ) : null}
    </SettingRow>
  );
}

const NO_MODELS: readonly DictationModelChoice[] = [];

/**
 * The workspaces to pick from, as the workspace switcher lists them: under
 * their organizations' names when there are several, each organization's by
 * name, and a Personal one with its lock. The closed control names the
 * organization too, which the menu's heading does. One with voice input off
 * can't take dictations.
 */
function workspaceOptions(workspaces: DictationWorkspaces, t: OpenGeniText): SelectOption[] {
  const severalOrganizations =
    new Set(workspaces.choices.map((choice) => choice.organization ?? "")).size > 1;
  const privately = t("desktopDictation.settings.workspacePrivate");
  return workspaces.choices.map((choice) => {
    const meta = choice.personal ? privately : undefined;
    const organization = severalOrganizations ? choice.organization : undefined;
    return {
      value: choice.id,
      label: choice.name,
      leading: <WorkspaceTile choice={choice} />,
      ...(meta ? { meta } : {}),
      ...(organization
        ? {
            group: organization,
            groupLeading: <OrganizationTile />,
            triggerMeta: meta ? `${meta} · ${organization}` : organization,
          }
        : {}),
      ...(choice.organization ? { keywords: [choice.organization] } : {}),
      ...(choice.voiceInputOff
        ? {
            disabled: true,
            disabledReason: t("desktopDictation.settings.workspaceVoiceOffOption"),
            // The lock already means Personal in this list.
            disabledIcon: <MicOffIcon />,
          }
        : {}),
    };
  });
}

/** An organization's tile, as in the workspace switcher. */
function OrganizationTile() {
  return (
    <span
      aria-hidden="true"
      className="flex size-4 shrink-0 items-center justify-center rounded-[4px] bg-surface-3 text-fg-muted [&_svg]:size-3"
    >
      <Building2Icon />
    </span>
  );
}

/** A workspace's tile, as in the workspace switcher: its initial, or a lock when Personal. */
function WorkspaceTile({ choice }: { choice: DictationWorkspaceChoice }) {
  return (
    <span
      aria-hidden="true"
      className="flex size-4 shrink-0 items-center justify-center rounded-[4px] bg-surface-3 text-2xs font-semibold text-fg-muted [&_svg]:size-3"
    >
      {choice.personal ? <LockIcon /> : (choice.name.trim()[0] ?? "W").toUpperCase()}
    </span>
  );
}

/** "Azure Speech · MAI-Transcribe-2". */
function modelLabel(entry: DictationModelChoice): string {
  return `${entry.providerName} · ${entry.name}`;
}

function modelValue(model: DesktopDictationModel): string {
  return `${model.providerId}::${model.model}`;
}

function sameModel(a: DesktopDictationModel, b: DesktopDictationModel): boolean {
  return a.providerId === b.providerId && a.model === b.model;
}

/** The shortcuts a profile can pick: modifier keys first where they work, then any combination. */
function shortcutOptions(
  profile: DesktopDictationProfile,
  profiles: DesktopDictationProfile[],
  status: DesktopDictationStatus,
  t: OpenGeniText,
): SelectOption[] {
  const { platform } = status;
  const candidates: DesktopDictationShortcut[] = [];
  if (status.modifierChords) {
    for (const modifiers of CHORDS) candidates.push({ kind: "modifierChord", modifiers });
  }
  for (const modifier of status.modifierPairs) candidates.push({ kind: "modifierPair", modifier });
  const own = profile.shortcut;
  if (own.kind !== "accelerator" && !candidates.some((item) => sameDesktopShortcut(item, own))) {
    candidates.unshift(own);
  }
  const options: SelectOption[] = candidates.map((candidate) => {
    const taken = usedByAnother({ ...status.settings, profiles }, profile.id, candidate);
    return {
      value: shortcutValue(candidate),
      label: desktopShortcutLabel(candidate, platform),
      disabled: taken,
      ...(taken ? { disabledReason: t("desktopDictation.settings.usedByAnother") } : {}),
    };
  });
  options.push({
    value: CUSTOM,
    label:
      own.kind === "accelerator"
        ? desktopShortcutLabel(own, platform)
        : t("desktopDictation.settings.keyCombination"),
    description: t("desktopDictation.settings.keyCombinationDescription"),
  });
  return options;
}

function shortcutValue(shortcut: DesktopDictationShortcut): string {
  if (shortcut.kind === "modifierPair") return `pair:${shortcut.modifier}`;
  if (shortcut.kind === "modifierChord") {
    return `chord:${CHORD_ORDER.filter((modifier) => shortcut.modifiers.includes(modifier)).join("+")}`;
  }
  return CUSTOM;
}

function shortcutFromValue(value: string): DesktopDictationShortcut | null {
  if (value.startsWith("pair:")) {
    const modifier = value.slice("pair:".length);
    return modifier === "fn" || !CHORD_ORDER.includes(modifier as DesktopDictationModifier)
      ? null
      : { kind: "modifierPair", modifier: modifier as Exclude<DesktopDictationModifier, "fn"> };
  }
  if (value.startsWith("chord:")) {
    const modifiers = value
      .slice("chord:".length)
      .split("+")
      .filter((part): part is DesktopDictationModifier =>
        CHORD_ORDER.includes(part as DesktopDictationModifier),
      );
    return modifiers.length >= 2 ? { kind: "modifierChord", modifiers } : null;
  }
  return null;
}

/** Another shortcut (a dictation's, or retry or cancel) uses these keys. */
function usedByAnother(
  settings: DesktopDictationSettings,
  ownerId: string,
  shortcut: DesktopDictationShortcut,
): boolean {
  if (
    settings.profiles.some(
      (profile) => profile.id !== ownerId && sameDesktopShortcut(profile.shortcut, shortcut),
    )
  ) {
    return true;
  }
  return (["retry", "cancel"] as const).some((action) => {
    const keys = settings[actionKey(action)];
    return `${ACTION_PREFIX}${action}` !== ownerId && keys
      ? sameDesktopShortcut(keys, shortcut)
      : false;
  });
}

function actionKey(action: DesktopDictationAction): "retryShortcut" | "cancelShortcut" {
  return action === "retry" ? "retryShortcut" : "cancelShortcut";
}

/** A shortcut no profile uses yet, for a new one. */
function freeShortcut(
  profiles: DesktopDictationProfile[],
  status: DesktopDictationStatus,
): DesktopDictationShortcut | null {
  const candidates: DesktopDictationShortcut[] = status.modifierChords
    ? CHORDS.map((modifiers) => ({ kind: "modifierChord", modifiers }))
    : [];
  for (const accelerator of ACCELERATORS) candidates.push({ kind: "accelerator", accelerator });
  return (
    candidates.find(
      (candidate) => !usedByAnother({ ...status.settings, profiles }, "", candidate),
    ) ?? null
  );
}

function newProfileId(profiles: DesktopDictationProfile[]): string {
  for (let index = profiles.length + 1; ; index += 1) {
    const id = `shortcut-${index}`;
    if (!profiles.some((profile) => profile.id === id)) return id;
  }
}

/** What a shortcut is called: its language, or "Any language" when it detects one. */
export function profileName(language: string | null, t: OpenGeniText): string {
  return language ? languageName(language, t.locale) : t("desktopDictation.settings.anyLanguage");
}

function shortcutProblemMessage(
  problem: DesktopDictationShortcutProblem | undefined,
  t: OpenGeniText,
): string | null {
  switch (problem) {
    case "taken":
      return t("desktopDictation.settings.shortcutTaken");
    case "unsupported":
      return t("desktopDictation.settings.shortcutUnsupported");
    case "stopped":
      return t("desktopDictation.settings.shortcutStopped");
    case "failed":
      return t("desktopDictation.settings.shortcutFailed");
    default:
      return null;
  }
}

/** Why the text is copied instead of typed, and what would change that. */
function pasteBlockedMessage(
  blocker: DesktopDictationPasteBlocker | null,
  t: OpenGeniText,
): string {
  switch (blocker) {
    case "accessibility":
      return t("desktopDictation.settings.pasteAccessibility");
    case "xdotool":
      return t("desktopDictation.settings.pasteXdotool");
    case "wtype":
      return t("desktopDictation.settings.pasteWtype");
    default:
      return t("desktopDictation.settings.pasteUnsupported");
  }
}
