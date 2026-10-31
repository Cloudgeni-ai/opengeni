/**
 * Meetings from audio recorded somewhere else: a phone call recorded with the
 * Phone app's own button, a voice memo, or any audio file. The person shares
 * it to the app (or picks it with Import), and it becomes a meeting with a
 * transcript and notes, uploaded the way a recording made here is.
 *
 * Sharing reaches the app as a link to the file: on iPhone a copy in the
 * app's Documents/Inbox (set up by the config plugin's `audioImport: true`),
 * on Android a content link from "Open with". {@link useSharedAudioImport}
 * takes those in, and {@link sharedAudioRedirect} keeps the router from
 * treating them as a screen.
 */
import type { OpenGeniText } from "@opengeni/react/messages";
import { useEffect, useRef } from "react";
import { Alert, Linking } from "react-native";
import { Directory, File, Paths } from "expo-file-system";
import {
  AudioImportError,
  audioImportMimeType,
  fileName,
  importedAudioTitle,
  isSharedAudioUrl,
} from "./audio-files";
import { useMeetingRecorder } from "./recorder";

export {
  AudioImportError,
  audioImportMimeType,
  importedAudioTitle,
  isSharedAudioUrl,
  sharedAudioRedirect,
} from "./audio-files";

/** Say why a file didn't become a meeting, in the person's terms. */
export function showAudioImportError(msg: OpenGeniText, error: unknown): void {
  const body =
    error instanceof AudioImportError && error.reason === "unsupported"
      ? msg("native.meetings.audioImport.unsupported")
      : msg("native.meetings.audioImport.unreadable");
  Alert.alert(msg("native.meetings.audioImport.couldntImport"), body);
}

export type ImportAudioFileInput = {
  /** A `file://` path, or an Android `content://` link. */
  uri: string;
  /** The file's name, when the picker knows it. From the link otherwise. */
  name?: string | null;
  /** Its type, when the picker knows it. */
  mimeType?: string | null;
  /** Recorded with this id (a project, a customer), as a recording started here would be. */
  externalRef?: string | null;
  /** Delete the file once its audio is saved with the recording: a copy made for the import. */
  deleteAfter?: boolean;
};

type Importer = NonNullable<
  ReturnType<typeof useMeetingRecorder>
>["importAudio"];

/**
 * Make a meeting from one audio file. Resolves with the meeting's id once its
 * audio is saved with the app's recordings; the upload and transcript follow
 * in the background, as for a recording made here.
 */
export async function importAudioFile(
  importAudio: Importer,
  input: ImportAudioFileInput,
): Promise<string> {
  const name = input.name || fileName(input.uri);
  const file = new File(input.uri);
  const mimeType = audioImportMimeType(name, input.mimeType ?? file.type);
  if (!mimeType) {
    throw new AudioImportError(
      "unsupported",
      `Recordings don't take this kind of audio: ${name}`,
    );
  }
  if (!file.exists)
    throw new AudioImportError("unreadable", `The file isn't there: ${name}`);
  const title = importedAudioTitle(name);
  const recordingId = await importAudio({
    // expo-file-system's File is a Blob that reads from disk.
    audio: file as unknown as Blob,
    mimeType,
    ...(title ? { title, titleSource: "app" as const } : {}),
    ...(input.externalRef ? { externalRef: input.externalRef } : {}),
  });
  if (input.deleteAfter) {
    try {
      file.delete();
    } catch {
      // Left for the system to clear with the app's other temporary files.
    }
  }
  return recordingId;
}

/** Where iOS puts files shared to the app, until the app takes them. */
function sharedInbox(): Directory | null {
  try {
    const inbox = new Directory(Paths.document, "Inbox");
    return inbox.exists ? inbox : null;
  } catch {
    return null;
  }
}

/**
 * One key per shared file. iOS names the same Inbox file under `/private/var`
 * in the link it opens the app with and under `/var` in a directory listing.
 */
function sharedFileKey(uri: string): string {
  const inbox = uri.indexOf("/Documents/Inbox/");
  return inbox >= 0
    ? `inbox:${uri.slice(inbox + "/Documents/Inbox/".length)}`
    : uri;
}

function isInInbox(uri: string): boolean {
  return sharedFileKey(uri).startsWith("inbox:");
}

function isGone(uri: string): boolean {
  if (!uri.toLowerCase().startsWith("file://")) return false;
  try {
    return !new File(uri).exists;
  } catch {
    return true;
  }
}

export type UseSharedAudioImportOptions = {
  /** A meeting was made from a shared file; open it or say so. */
  onImported?: (recordingId: string) => void;
  /** A shared file couldn't be imported. */
  onError?: (error: unknown, uri: string) => void;
  /** Recorded with this id, as recordings started here are. */
  externalRef?: string | null;
};

/**
 * Import audio files shared to the app. Mount it once inside the
 * {@link MeetingRecorderProvider}; it takes the file the app was opened with,
 * files shared while it runs, and, on iPhone, files shared while the app
 * couldn't take them (closed before it got to them). Files are imported into
 * the workspace the recorder is in.
 */
export function useSharedAudioImport(
  options: UseSharedAudioImportOptions = {},
): void {
  const recorder = useMeetingRecorder();
  const importAudio = recorder?.importAudio ?? null;
  const latest = useRef(options);
  latest.current = options;
  const waiting = useRef<string[]>([]);
  const taken = useRef(new Set<string>());
  const importer = useRef<Importer | null>(null);
  importer.current = importAudio;
  const drain = useRef<() => void>(() => {});

  drain.current = () => {
    const run = importer.current;
    if (!run) return;
    const uris = waiting.current.splice(0);
    for (const uri of uris) {
      void importAudioFile(run, {
        uri,
        externalRef: latest.current.externalRef ?? null,
        // The app's own copy; Android's content links belong to the other app.
        deleteAfter: isInInbox(uri),
      }).then(
        (recordingId) => latest.current.onImported?.(recordingId),
        (error: unknown) => latest.current.onError?.(error, uri),
      );
    }
  };

  useEffect(() => {
    const take = (url: string | null | undefined) => {
      if (!url || !isSharedAudioUrl(url)) return;
      const key = sharedFileKey(url);
      // Once each; and the link the app opened with stays after its file is imported.
      if (taken.current.has(key) || isGone(url)) return;
      taken.current.add(key);
      waiting.current.push(url);
      drain.current();
    };
    void Linking.getInitialURL().then(take, () => undefined);
    for (const file of sharedInbox()?.list() ?? []) {
      if (file instanceof File) take(file.uri);
    }
    const subscription = Linking.addEventListener("url", ({ url }) =>
      take(url),
    );
    return () => subscription.remove();
  }, []);

  // Files that came before the recorder was ready (signing in, the workspace loading).
  useEffect(() => {
    if (importAudio) drain.current();
  }, [importAudio]);
}
