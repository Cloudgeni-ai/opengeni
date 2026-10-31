/**
 * What an audio file brought into the app is: whether recordings take it, and
 * a name for its meeting. No native modules, so hosts and tests can use it
 * anywhere.
 */

/** The audio types a recording takes, by file extension. */
const AUDIO_TYPES: Record<string, string> = {
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  aac: "audio/aac",
  webm: "audio/webm",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
};

/** Types another app may state for the same files. */
const TYPE_ALIASES: Record<string, string> = {
  "audio/x-m4a": "audio/mp4",
  "audio/m4a": "audio/mp4",
  "audio/mp4a-latm": "audio/mp4",
  "audio/x-aac": "audio/aac",
  "audio/opus": "audio/ogg",
};

export class AudioImportError extends Error {
  constructor(
    /** `unsupported`: not a kind of audio recordings take (such as MP3 or WAV). */
    readonly reason: "unsupported" | "unreadable",
    message: string,
  ) {
    super(message);
    this.name = "AudioImportError";
  }
}

export function fileName(uri: string): string {
  const path = uri.split(/[?#]/)[0] ?? uri;
  const last = path.slice(path.lastIndexOf("/") + 1);
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/**
 * The recording type for a file, from its stated type or its name's
 * extension; null when recordings don't take it.
 */
export function audioImportMimeType(
  name: string,
  statedType?: string | null,
): string | null {
  const stated = statedType?.split(";")[0]?.trim().toLowerCase();
  if (stated) {
    const known = TYPE_ALIASES[stated] ?? stated;
    if (Object.values(AUDIO_TYPES).includes(known)) return known;
  }
  const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  return name.includes(".") ? (AUDIO_TYPES[extension] ?? null) : null;
}

/**
 * A name for the meeting from the file's, when it says something ("Call with
 * Ola"). Kept as the app's guess: Opengeni replaces it with a better one from
 * the conversation. Null for names that say nothing, such as an id.
 */
export function importedAudioTitle(name: string): string | null {
  const stem = (
    name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : name
  )
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!/\p{L}/u.test(stem)) return null;
  if (/^[0-9a-f-]{16,}$/i.test(stem)) return null;
  if (
    /^(audio|recording|new recording|untitled|opptak|lydopptak)( \d+)?$/i.test(
      stem,
    )
  ) {
    return null;
  }
  return stem.slice(0, 200);
}

/** A link that hands the app an audio file, rather than one of its own screens. */
export function isSharedAudioUrl(url: string): boolean {
  if (!/^(file|content):\/\//i.test(url)) return false;
  // Android content links often carry no extension; the type is read on import.
  return (
    url.toLowerCase().startsWith("content://") ||
    audioImportMimeType(fileName(url)) !== null
  );
}

/**
 * For expo-router's `app/+native-intent.tsx` `redirectSystemPath`: an audio
 * file shared to the app opens the meetings screen, where
 * {@link useSharedAudioImport} imports it, instead of an unknown screen.
 */
export function sharedAudioRedirect(
  path: string,
  meetingsPath = "/meetings",
): string | null {
  return isSharedAudioUrl(path) ? meetingsPath : null;
}
