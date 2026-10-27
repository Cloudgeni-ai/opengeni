// The desktop app's dictation settings: turning dictation from anywhere on,
// its shortcuts and their languages, where the text goes, what the system
// must allow, and the recent dictations kept on this computer.
import {
  getDesktopDictation,
  type DesktopDictation,
  type DesktopDictationHistoryEntry,
  type DesktopDictationModifier,
  type DesktopDictationOutput,
  type DesktopDictationPermissionId,
  type DesktopDictationProfile,
  type DesktopDictationSettings,
  type DesktopDictationShortcut,
  type DesktopDictationStatus,
  type DesktopPlatform,
} from "@opengeni/sdk/desktop-bridge";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { copyTextToClipboard } from "../../lib/clipboard";
import { MEETING_LANGUAGES } from "../../meetings/meeting-languages";
import { useOpenGeniText, type OpenGeniText } from "../../messages/runtime";
import { languageName } from "../../recordings-model";
import { Button } from "../../ui/button";
import { RelativeTime } from "../../ui/relative-time";
import { Section } from "../../ui/section";
import { SelectMenu, type SelectOption } from "../../ui/select-menu";
import { SettingRow, SettingRowLink } from "../../ui/setting-row";
import { Switch } from "../../ui/switch";
import { acceleratorFromKey, desktopShortcutLabel, sameDesktopShortcut } from "./shortcuts";

/** At most this many shortcuts, as the app keeps them. */
const PROFILES_MAX = 8;
const DETECT = "auto";
const CUSTOM = "custom";
/** Modifier keys held together that make a good shortcut on a Mac, Quedo's first. */
const CHORDS: DesktopDictationModifier[][] = [
  ["control", "fn"],
  ["option", "fn"],
  ["command", "fn"],
  ["shift", "fn"],
];
/** Key combinations offered to a new shortcut where modifier keys can't be watched. */
const ACCELERATORS = ["Control+Shift+Space", "Control+Alt+Space", "Control+Shift+D", "Control+Alt+D"];
const CHORD_ORDER: DesktopDictationModifier[] = ["command", "option", "control", "shift", "fn"];

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
  update: (change: Partial<DesktopDictationSettings>) => Promise<void>;
  requestPermission: (id: DesktopDictationPermissionId) => void;
  clearHistory: () => Promise<void>;
};

/** The app's dictation settings and recent dictations, kept current. */
export function useDesktopDictation(
  given?: DesktopDictation | null | undefined,
): UseDesktopDictationResult {
  const t = useOpenGeniText();
  const dictation = useMemo(
    () => (given === undefined ? getDesktopDictation() : given),
    [given],
  );
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
    async (change: Partial<DesktopDictationSettings>) => {
      if (!dictation) return;
      setSaving(true);
      setError(null);
      try {
        setStatus(await dictation.update(change));
      } catch {
        setError(t("desktopDictation.settings.saveFailed"));
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

  return { dictation, status, history, saving, error, update, requestPermission, clearHistory };
}

export type DesktopDictationSettingsProps = {
  /** The app's dictation. `getDesktopDictation()` by default. */
  dictation?: DesktopDictation | null | undefined;
  /** Languages offered for each shortcut, as ISO codes. Common languages by default. */
  languages?: readonly string[] | undefined;
  className?: string | undefined;
};

/**
 * Settings for dictation from anywhere, shown only inside a desktop app that
 * offers it on this computer. Pair it with {@link DesktopDictationHost}
 * mounted on the signed-in pages.
 */
export function DesktopDictationSettings({
  dictation: given,
  languages = MEETING_LANGUAGES,
  className,
}: DesktopDictationSettingsProps) {
  const t = useOpenGeniText();
  const { dictation, status, history, saving, error, update, requestPermission, clearHistory } =
    useDesktopDictation(given);
  const [recordingFor, setRecordingFor] = useState<string | null>(null);
  const [keysError, setKeysError] = useState<{ profileId: string; message: string } | null>(null);
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
      if (usedByAnother(settings.profiles, recordingFor, shortcut)) {
        setKeysError({
          profileId: recordingFor,
          message: t("desktopDictation.settings.usedByAnother"),
        });
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
  }, [platform, recordingFor, saveProfiles, settings, t]);

  if (!dictation || !status?.supported || !settings) return null;
  const { profiles } = settings;
  const single = profiles.length === 1;
  const modifierShortcuts = profiles.some((profile) => profile.shortcut.kind !== "accelerator");
  const accessibility = status.permissions.find((permission) => permission.id === "accessibility");
  const first = profiles[0]!;

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
        profile.id === id
          ? { ...profile, language, name: profileName(language, t) }
          : profile,
      ),
    );
  };

  const addProfile = () => {
    const used = new Set(profiles.map((profile) => profile.language));
    const language = [...languages].find((code) => !used.has(code)) ?? null;
    const shortcut = freeShortcut(profiles, status);
    if (!shortcut) return;
    const id = newProfileId(profiles);
    saveProfiles([...profiles, { id, name: profileName(language, t), shortcut, language }]);
  };

  const onToggle = (enabled: boolean) => {
    void update({ enabled });
    // Typing into other apps needs Accessibility on a Mac: ask when turned on.
    if (enabled && settings.output !== "copy" && accessibility && !accessibility.granted) {
      requestPermission("accessibility");
    }
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
        >
          {settings.enabled ? (
            <>
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
                    status.shortcutErrors.find((item) => item.profileId === profile.id)?.message ??
                    null
                  }
                  languageOptions={languageOptions(profile.language)}
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
                    : t("desktopDictation.settings.pasteUnavailable", {
                        reason: status.paste.reason ?? "",
                      })
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
                        <CheckIcon className="size-4 text-success" aria-hidden />
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
            </>
          ) : null}
        </SettingRow>
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
              label={<span className="line-clamp-2 font-normal break-words">{entry.text}</span>}
              description={
                <>
                  <RelativeTime date={entry.at} focusable={false} />
                  {profiles.length > 1 ? ` · ${entry.profileName}` : null}
                </>
              }
              control={<CopyText text={entry.text} label={t("desktopDictation.settings.copyText")} />}
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
      {copied ? <CheckIcon className="text-success" aria-hidden /> : <CopyIcon aria-hidden />}
    </Button>
  );
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
  onRecord,
  onShortcut,
  onLanguage,
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
  onRecord: (recording: boolean) => void;
  onShortcut: (shortcut: DesktopDictationShortcut) => void;
  onLanguage: (value: string) => void;
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
    <>
      <SettingRow
        label={single ? t("desktopDictation.settings.shortcutLabel") : profile.name}
        description={description}
        error={error}
        hint={
          single ? undefined : (
            <SettingRowLink onClick={onRemove} disabled={saving}>
              {t("desktopDictation.settings.remove")}
            </SettingRowLink>
          )
        }
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
          )
        }
      />
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
    </>
  );
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
    const taken = usedByAnother(profiles, profile.id, candidate);
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

function usedByAnother(
  profiles: DesktopDictationProfile[],
  profileId: string,
  shortcut: DesktopDictationShortcut,
): boolean {
  return profiles.some(
    (profile) => profile.id !== profileId && sameDesktopShortcut(profile.shortcut, shortcut),
  );
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
    candidates.find((candidate) => !usedByAnother(profiles, "", candidate)) ?? null
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
