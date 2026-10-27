import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type {
  DesktopDictationHistoryEntry,
  DesktopDictationModifier,
  DesktopDictationOutput,
  DesktopDictationPermissionId,
  DesktopDictationProfile,
  DesktopDictationSettings,
  DesktopDictationShortcut,
} from "../../contract";
import { parseAppShotShortcut } from "../app-shots/settings";

const CHORD_MODIFIERS: readonly DesktopDictationModifier[] = [
  "command",
  "option",
  "control",
  "shift",
  "fn",
];
const OUTPUTS: readonly DesktopDictationOutput[] = ["paste", "copy", "pasteAndCopy"];
/** More shortcuts than anyone dictates in languages. */
export const DICTATION_PROFILES_MAX = 8;
/** Finished dictations kept on this computer. */
export const DICTATION_HISTORY_MAX = 50;
const LANGUAGE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/u;
const PROFILE_ID = /^[A-Za-z0-9_-]{1,64}$/u;

/**
 * Off, with one shortcut: Control and Fn held together on a Mac, a key
 * combination elsewhere. It hears `language` (an ISO code), or detects the
 * language when that is null or not a language code.
 */
export function defaultDictationSettings(
  platform: NodeJS.Platform,
  language: string | null = null,
): DesktopDictationSettings {
  return {
    enabled: false,
    profiles: [
      {
        id: "default",
        name: "Dictate",
        shortcut:
          platform === "darwin"
            ? { kind: "modifierChord", modifiers: ["control", "fn"] }
            : { kind: "accelerator", accelerator: "Control+Shift+Space" },
        language: parseLanguage(language) ?? null,
      },
    ],
    output: "paste",
    mode: "toggle",
  };
}

/** A shortcut as stored or sent by the page, or null when it isn't one. */
export function parseDictationShortcut(value: unknown): DesktopDictationShortcut | null {
  if (value && typeof value === "object") {
    const candidate = value as Record<string, unknown>;
    if (candidate.kind === "modifierChord" && Array.isArray(candidate.modifiers)) {
      const modifiers = CHORD_MODIFIERS.filter((modifier) =>
        (candidate.modifiers as unknown[]).includes(modifier),
      );
      // Two or more keys: one modifier alone is pressed all the time while typing.
      return modifiers.length >= 2 && modifiers.length === candidate.modifiers.length
        ? { kind: "modifierChord", modifiers }
        : null;
    }
  }
  return parseAppShotShortcut(value);
}

function parseLanguage(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return LANGUAGE.test(trimmed) ? trimmed : undefined;
}

function parseProfile(value: unknown): DesktopDictationProfile | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const shortcut = parseDictationShortcut(candidate.shortcut);
  const language = parseLanguage(candidate.language);
  if (
    typeof candidate.id !== "string" ||
    !PROFILE_ID.test(candidate.id) ||
    typeof candidate.name !== "string" ||
    !shortcut ||
    language === undefined
  ) {
    return null;
  }
  const name = candidate.name.trim().slice(0, 60);
  return { id: candidate.id, name: name || "Dictate", shortcut, language };
}

/** The same physical keys, so two shortcuts never fight over one press. */
export function sameShortcut(a: DesktopDictationShortcut, b: DesktopDictationShortcut): boolean {
  if (a.kind === "accelerator" && b.kind === "accelerator") {
    return a.accelerator.toLowerCase() === b.accelerator.toLowerCase();
  }
  if (a.kind === "modifierPair" && b.kind === "modifierPair") return a.modifier === b.modifier;
  if (a.kind === "modifierChord" && b.kind === "modifierChord") {
    return [...a.modifiers].sort().join("+") === [...b.modifiers].sort().join("+");
  }
  return false;
}

/** Applies a page's partial change; anything malformed keeps the current value. */
export function mergeDictationSettings(
  current: DesktopDictationSettings,
  change: unknown,
): DesktopDictationSettings {
  if (!change || typeof change !== "object") return current;
  const candidate = change as Record<string, unknown>;
  let profiles = current.profiles;
  if (Array.isArray(candidate.profiles)) {
    const parsed = candidate.profiles.map(parseProfile);
    const ids = new Set(parsed.map((profile) => profile?.id));
    const valid =
      parsed.length >= 1 &&
      parsed.length <= DICTATION_PROFILES_MAX &&
      parsed.every((profile) => profile !== null) &&
      ids.size === parsed.length &&
      parsed.every((profile, index) =>
        parsed.every(
          (other, otherIndex) =>
            otherIndex <= index || !sameShortcut(profile!.shortcut, other!.shortcut),
        ),
      );
    if (valid) profiles = parsed as DesktopDictationProfile[];
  }
  return {
    enabled: typeof candidate.enabled === "boolean" ? candidate.enabled : current.enabled,
    profiles,
    output: OUTPUTS.includes(candidate.output as DesktopDictationOutput)
      ? (candidate.output as DesktopDictationOutput)
      : current.output,
    mode: candidate.mode === "toggle" || candidate.mode === "hold" ? candidate.mode : current.mode,
  };
}

function parseHistoryEntry(value: unknown): DesktopDictationHistoryEntry | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Record<string, unknown>;
  if (
    typeof entry.id !== "string" ||
    typeof entry.text !== "string" ||
    typeof entry.at !== "string" ||
    typeof entry.profileName !== "string"
  ) {
    return null;
  }
  const language = parseLanguage(entry.language);
  return {
    id: entry.id,
    text: entry.text,
    at: entry.at,
    profileName: entry.profileName,
    language: language ?? null,
  };
}

/**
 * The settings, the permissions already asked for and recent dictations, in
 * the app's data folder (`dictation.json`, readable only by the person).
 */
export class DictationSettingsStore {
  private readonly path: string;

  constructor(
    dataDir: string,
    private readonly platform: NodeJS.Platform,
    /** What the first shortcut hears until the person changes it; null detects. */
    private readonly language: string | null = null,
  ) {
    this.path = join(dataDir, "dictation.json");
  }

  read(): DesktopDictationSettings {
    return mergeDictationSettings(
      defaultDictationSettings(this.platform, this.language),
      this.file(),
    );
  }

  write(settings: DesktopDictationSettings): void {
    this.save({ ...this.file(), ...settings });
  }

  requested(): DesktopDictationPermissionId[] {
    const value = this.file().requested;
    return Array.isArray(value) && value.includes("accessibility") ? ["accessibility"] : [];
  }

  markRequested(id: DesktopDictationPermissionId): void {
    if (!this.requested().includes(id)) this.save({ ...this.file(), requested: [id] });
  }

  history(): DesktopDictationHistoryEntry[] {
    const value = this.file().history;
    if (!Array.isArray(value)) return [];
    return value
      .map(parseHistoryEntry)
      .filter((entry): entry is DesktopDictationHistoryEntry => entry !== null)
      .slice(0, DICTATION_HISTORY_MAX);
  }

  /** Newest first. */
  remember(entry: DesktopDictationHistoryEntry): void {
    this.save({
      ...this.file(),
      history: [entry, ...this.history().filter((kept) => kept.id !== entry.id)].slice(
        0,
        DICTATION_HISTORY_MAX,
      ),
    });
  }

  clearHistory(): void {
    this.save({ ...this.file(), history: [] });
  }

  private file(): Record<string, unknown> {
    try {
      const value: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  private save(value: Record<string, unknown>): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.path);
  }
}
