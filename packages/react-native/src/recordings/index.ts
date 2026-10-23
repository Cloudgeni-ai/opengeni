// @opengeni/react-native/recordings: meeting and site-walk recording on phones.
//
// The microphone is recorded natively (AAC, cut into chunk files every few
// seconds) into the app's files, and uploaded in the background straight to
// storage. A crash, a killed app or a day without signal loses at most the
// last few seconds; the next start finishes and uploads what was left.
//
//   const platform = useNativeRecorderPlatform();
//   const recorder = useRecorder({ platform, title: "Site walk" });
//
// `useRecorder` and the reading hooks come from `@opengeni/react/recordings`.
import { useMemo } from "react";
import { requireOptionalNativeModule } from "expo-modules-core";
import { Directory, File, Paths } from "expo-file-system";
import * as Crypto from "expo-crypto";
import { requestRecordingPermissionsAsync } from "expo-audio";
import { fetch as expoFetch } from "expo/fetch";
import { useOpenGeniText } from "@opengeni/react/messages";
import type { RecorderPlatform } from "@opengeni/sdk/recordings";
import {
  createFileRecordingChunkStore,
  type FileRecordingChunkStore,
  type RecordingFileSystem,
} from "./file-store";
import { createNativeRecorder, type NativeAudioCapture } from "./native-recorder";

export { readAdtsFrame, wholeAdtsFrames } from "./adts";
export {
  createFileRecordingChunkStore,
  parseRecordingChunkFileName,
  recordingChunkFileName,
  type FileRecordingChunkStore,
  type RecordingFileSystem,
} from "./file-store";
export {
  createNativeRecorder,
  NATIVE_RECORDING_MIME_TYPE,
  type NativeAudioCapture,
  type NativeAudioChunkEvent,
  type NativeAudioErrorEvent,
  type NativeAudioStateEvent,
  type NativeRecorderOptions,
} from "./native-recorder";

/** The native capture module, or null in a build without it (Expo Go, web). */
export function nativeAudioCapture(): NativeAudioCapture | null {
  return requireOptionalNativeModule<NativeAudioCapture>("OpenGeniAudioCapture");
}

/** {@link RecordingFileSystem} on expo-file-system. */
export const expoRecordingFileSystem: RecordingFileSystem = {
  async list(directory) {
    const folder = new Directory(directory);
    if (!folder.exists) return [];
    return folder.list().map((entry) => entry.name);
  },
  async readBytes(path) {
    const file = new File(path);
    return file.exists ? await file.bytes() : null;
  },
  async readText(path) {
    const file = new File(path);
    return file.exists ? await file.text() : null;
  },
  async writeBytes(path, bytes) {
    replaceFile(path, bytes);
  },
  async writeText(path, text) {
    replaceFile(path, text);
  },
  async rename(from, to) {
    new File(from).moveSync(new File(to), { overwrite: true });
  },
  async remove(path) {
    const file = new File(path);
    if (file.exists) {
      file.delete();
      return;
    }
    const folder = new Directory(path);
    if (folder.exists) folder.delete();
  },
  async makeDirectory(path) {
    const folder = new Directory(path);
    if (!folder.exists) folder.create({ intermediates: true });
  },
};

/** Write next to the target, then move it over, so a crash never leaves half a file. */
function replaceFile(path: string, content: string | Uint8Array): void {
  const temporary = new File(`${path}.tmp`);
  if (temporary.exists) temporary.delete();
  temporary.create({ intermediates: true });
  temporary.write(content);
  temporary.moveSync(new File(path), { overwrite: true });
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes as never);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const stores = new Map<string, FileRecordingChunkStore>();

/**
 * A recording store in the app's documents, kept until uploaded:
 * `opengeni-recordings`, or `opengeni-recordings/<scope>` with a scope.
 */
export function expoRecordingChunkStore(scope?: string): FileRecordingChunkStore {
  const key = scope ?? "";
  let store = stores.get(key);
  if (!store) {
    const base = new Directory(Paths.document, "opengeni-recordings");
    const directory = scope ? new Directory(base, safeScope(scope)) : base;
    store = createFileRecordingChunkStore({
      fs: expoRecordingFileSystem,
      root: directory.uri.replace(/\/+$/u, ""),
      sha256: sha256Hex,
    });
    stores.set(key, store);
  }
  return store;
}

function safeScope(scope: string): string {
  return scope.replace(/[^A-Za-z0-9._-]/gu, "_");
}

export type NativeRecorderPlatformOptions = {
  /** The ongoing notification Android shows while recording. Defaults to a generic one. */
  notification?: { title: string; text: string };
  /** AAC bit rate. Default 64 kbps, about 29 MB an hour. */
  bitRate?: number;
  /**
   * Keeps unsent audio apart per signed-in account, for apps with several:
   * pass the account's id. Recordings are only ever uploaded with the client
   * of the store they were saved in.
   */
  storeScope?: string;
};

/** The phone's capture for `useRecorder`, or an unsupported platform without the native module. */
export function nativeRecorderPlatform(
  options: NativeRecorderPlatformOptions & { notification: { title: string; text: string } },
): RecorderPlatform {
  const native = nativeAudioCapture();
  const store = expoRecordingChunkStore(options.storeScope);
  const fetchImpl = expoFetch as unknown as typeof fetch;
  return {
    supported: native !== null,
    systemAudioSupported: false,
    fetch: fetchImpl,
    createStore: () => store,
    createRecorder: (recorderOptions) => {
      if (!native) throw new Error("This build has no native audio capture module.");
      return createNativeRecorder({
        ...recorderOptions,
        native,
        store,
        fs: expoRecordingFileSystem,
        randomUUID: () => Crypto.randomUUID(),
        requestPermission: async () => (await requestRecordingPermissionsAsync()).granted,
        notification: options.notification,
        fetch: fetchImpl,
        ...(options.bitRate ? { bitRate: options.bitRate } : {}),
      });
    },
    isCaptureActive: async (recordingId) => native?.activeRecordingId() === recordingId,
    recover: async () => {
      const active = native?.activeRecordingId() ?? null;
      await store.recover({ skip: (recordingId) => recordingId === active });
    },
  };
}

/** {@link nativeRecorderPlatform} for a component, with the notification in the app's language. */
export function useNativeRecorderPlatform(
  options: NativeRecorderPlatformOptions = {},
): RecorderPlatform {
  const t = useOpenGeniText();
  const title = options.notification?.title ?? t("native.recorder.notificationTitle");
  const text = options.notification?.text ?? t("native.recorder.notificationText");
  const bitRate = options.bitRate;
  const storeScope = options.storeScope;
  return useMemo(
    () =>
      nativeRecorderPlatform({
        notification: { title, text },
        ...(bitRate ? { bitRate } : {}),
        ...(storeScope ? { storeScope } : {}),
      }),
    [title, text, bitRate, storeScope],
  );
}
