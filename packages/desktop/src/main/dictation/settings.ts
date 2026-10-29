import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import type {
  DesktopDictationAudio,
  DesktopDictationHistoryEntry,
  DesktopDictationKeys,
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
/** Names and words a person's vocabulary holds, as transcription accepts them. */
export const DICTATION_VOCABULARY_MAX = 100;
export const DICTATION_VOCABULARY_TERM_MAX = 50;
/** The most speech one kept dictation may hold (about 2 hours of the recorder's audio). */
export const DICTATION_AUDIO_MAX_BYTES = 32 * 1024 * 1024;
const LANGUAGE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/u;
const PROFILE_ID = /^[A-Za-z0-9_-]{1,64}$/u;
const ENTRY_ID = /^[A-Za-z0-9_-]{1,100}$/u;
const AUDIO_TYPE = /^audio\/[\w.+-]+(;[\w=.,+\- ]*)?$/u;

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
    vocabulary: [],
    retryShortcut: null,
    cancelShortcut: null,
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

/** A key combination for the retry or cancel shortcut, or null when it isn't one. */
function parseKeys(value: unknown): DesktopDictationKeys | null {
  const shortcut = parseAppShotShortcut(value);
  return shortcut?.kind === "accelerator" ? shortcut : null;
}

/** The terms, trimmed and without repeats; undefined when it isn't a list. */
function parseVocabulary(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const term = item.trim().replace(/\s+/gu, " ");
    const key = term.toLocaleLowerCase();
    if (!term || term.length > DICTATION_VOCABULARY_TERM_MAX || seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
    if (terms.length === DICTATION_VOCABULARY_MAX) break;
  }
  return terms;
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
  const keys = (key: "retryShortcut" | "cancelShortcut"): DesktopDictationKeys | null => {
    const kept = current[key] ?? null;
    if (!(key in candidate)) return kept;
    const value = candidate[key];
    return value === null ? null : (parseKeys(value) ?? kept);
  };
  let retryShortcut = keys("retryShortcut");
  let cancelShortcut = keys("cancelShortcut");
  // One key combination does one thing: the change that would share one is refused.
  if (retryShortcut && cancelShortcut && sameShortcut(retryShortcut, cancelShortcut)) {
    if ("cancelShortcut" in candidate) cancelShortcut = current.cancelShortcut ?? null;
    else retryShortcut = current.retryShortcut ?? null;
    if (retryShortcut && cancelShortcut && sameShortcut(retryShortcut, cancelShortcut)) {
      cancelShortcut = null;
    }
  }
  // A dictation shortcut wins over an action on the same keys.
  const free = (shortcut: DesktopDictationKeys | null) =>
    shortcut && profiles.some((profile) => sameShortcut(profile.shortcut, shortcut))
      ? null
      : shortcut;
  return {
    enabled: typeof candidate.enabled === "boolean" ? candidate.enabled : current.enabled,
    profiles,
    output: OUTPUTS.includes(candidate.output as DesktopDictationOutput)
      ? (candidate.output as DesktopDictationOutput)
      : current.output,
    mode: candidate.mode === "toggle" || candidate.mode === "hold" ? candidate.mode : current.mode,
    vocabulary: parseVocabulary(candidate.vocabulary) ?? current.vocabulary ?? [],
    retryShortcut: free(retryShortcut),
    cancelShortcut: free(cancelShortcut),
  };
}

/** Speech a page sent with a finished dictation, or null when it isn't any. */
export function parseDictationAudio(value: unknown): DesktopDictationAudio | null {
  if (!value || typeof value !== "object") return null;
  const audio = value as Record<string, unknown>;
  const bytes = audio.bytes;
  if (
    typeof audio.mimeType !== "string" ||
    audio.mimeType.length > 200 ||
    !AUDIO_TYPE.test(audio.mimeType) ||
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength === 0 ||
    bytes.byteLength > DICTATION_AUDIO_MAX_BYTES
  ) {
    return null;
  }
  const duration = audio.durationMilliseconds;
  return {
    mimeType: audio.mimeType,
    bytes,
    durationMilliseconds:
      typeof duration === "number" && Number.isFinite(duration) && duration > 0
        ? Math.round(duration)
        : 0,
  };
}

function parseHistoryEntry(value: unknown): DesktopDictationHistoryEntry | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Record<string, unknown>;
  if (
    typeof entry.id !== "string" ||
    !ENTRY_ID.test(entry.id) ||
    typeof entry.text !== "string" ||
    typeof entry.at !== "string" ||
    typeof entry.profileName !== "string"
  ) {
    return null;
  }
  const language = parseLanguage(entry.language);
  const audio = entry.audio as Record<string, unknown> | null | undefined;
  return {
    id: entry.id,
    text: entry.text,
    at: entry.at,
    profileName: entry.profileName,
    language: language ?? null,
    audio:
      audio &&
      typeof audio.mimeType === "string" &&
      AUDIO_TYPE.test(audio.mimeType) &&
      typeof audio.durationMilliseconds === "number"
        ? { mimeType: audio.mimeType, durationMilliseconds: audio.durationMilliseconds }
        : null,
    ...(entry.cancelled === true ? { cancelled: true } : {}),
  };
}

/**
 * The settings, the permissions already asked for and recent dictations, in
 * the app's data folder (`dictation.json`, readable only by the person), and
 * the recent dictations' speech beside it (`dictation-audio/`).
 */
export class DictationSettingsStore {
  private readonly path: string;
  private readonly audioDir: string;
  /** The file as last read or written; only this store writes it. */
  private cached: Record<string, unknown> | null = null;

  constructor(
    dataDir: string,
    private readonly platform: NodeJS.Platform,
    /**
     * What the first shortcut hears until the person changes it; null detects.
     * A function is asked on every read, so the default follows the app's
     * language once it is known (after sign-in, say).
     */
    private readonly language: string | null | (() => string | null) = null,
  ) {
    this.path = join(dataDir, "dictation.json");
    this.audioDir = join(dataDir, "dictation-audio");
  }

  read(): DesktopDictationSettings {
    const language = typeof this.language === "function" ? this.language() : this.language;
    return mergeDictationSettings(defaultDictationSettings(this.platform, language), this.file());
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

  /**
   * Newest first; its speech is kept with it when given. A cancelled
   * dictation is kept only for its speech: without it, it is not kept.
   */
  remember(entry: DesktopDictationHistoryEntry, audio: DesktopDictationAudio | null = null): void {
    let kept: DesktopDictationHistoryEntry = { ...entry, audio: null };
    if (audio && ENTRY_ID.test(entry.id)) {
      try {
        mkdirSync(this.audioDir, { recursive: true, mode: 0o700 });
        const temporary = join(this.audioDir, `${entry.id}.tmp`);
        writeFileSync(temporary, audio.bytes, { mode: 0o600 });
        renameSync(temporary, this.audioFile(entry.id));
        kept = {
          ...entry,
          audio: { mimeType: audio.mimeType, durationMilliseconds: audio.durationMilliseconds },
        };
      } catch {
        // The text is kept without its speech.
      }
    }
    if (kept.cancelled && !kept.audio) return;
    const history = [kept, ...this.history().filter((item) => item.id !== entry.id)].slice(
      0,
      DICTATION_HISTORY_MAX,
    );
    this.save({ ...this.file(), history });
    this.pruneAudio(history);
  }

  /** A kept dictation's text, after it was transcribed again; a cancelled one is no longer. */
  replaceText(id: string, text: string): void {
    const history = this.history();
    if (!history.some((entry) => entry.id === id)) return;
    this.save({
      ...this.file(),
      history: history.map((entry) => {
        if (entry.id !== id) return entry;
        const next: DesktopDictationHistoryEntry = { ...entry, text };
        delete next.cancelled;
        return next;
      }),
    });
  }

  /** A kept dictation's speech; null when there is none. */
  audio(id: string): DesktopDictationAudio | null {
    const entry = this.history().find((item) => item.id === id);
    if (!entry?.audio) return null;
    try {
      const bytes = readFileSync(this.audioFile(id));
      return {
        mimeType: entry.audio.mimeType,
        bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
        durationMilliseconds: entry.audio.durationMilliseconds,
      };
    } catch {
      return null;
    }
  }

  clearHistory(): void {
    this.save({ ...this.file(), history: [] });
    this.pruneAudio([]);
  }

  private audioFile(id: string): string {
    return join(this.audioDir, `${id}.audio`);
  }

  /** Speech whose dictation is no longer kept is deleted. */
  private pruneAudio(history: DesktopDictationHistoryEntry[]): void {
    if (!existsSync(this.audioDir)) return;
    const kept = new Set(
      history.filter((entry) => entry.audio).map((entry) => `${entry.id}.audio`),
    );
    try {
      for (const name of readdirSync(this.audioDir)) {
        if (!kept.has(name)) rmSync(join(this.audioDir, name), { force: true });
      }
    } catch {
      // Tried again with the next dictation.
    }
  }

  private file(): Record<string, unknown> {
    if (this.cached) return this.cached;
    try {
      const value: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      this.cached = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    } catch {
      this.cached = {};
    }
    return this.cached;
  }

  private save(value: Record<string, unknown>): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.path);
    this.cached = value;
  }
}
