// @opengeni/react-native/expo: ready-made adapters for Expo hosts.
//
// Hosts own persistence (where drafts and pending operations live, and how they are
// namespaced per signed-in principal); everything else here is the standard Expo
// implementation of the adapter contract.
import { AppState } from "react-native";
import type { ChatClient } from "@opengeni/sdk";
import { useMemo } from "react";
import * as Crypto from "expo-crypto";
import * as DocumentPicker from "expo-document-picker";
import { fetch as expoFetch } from "expo/fetch";
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
} from "expo-audio";
import { Directory, File, Paths, UploadType } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import type { FetchLike, FileUploadSource, OpenGeniClient } from "@opengeni/sdk";
import type {
  NativeLifecycleState,
  NativePersistenceAdapter,
  NativePickedFile,
  OpenGeniReactNativeAdapters,
} from "./adapters";
import {
  NativeTranscriptionError,
  type NativeVoiceRecorder,
  type NativeVoiceRecording,
} from "./voice-input";

export { createExpoCallAdapter, parseNativeCallEvent } from "./realtime/expo-call";

function lifecycleState(value: string | null | undefined): NativeLifecycleState {
  if (value === "active") return "active";
  if (value === "background") return "background";
  return "inactive";
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = globalThis.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function fallbackFilename(uri: string, contentType: string): string {
  const raw = uri.split("/").at(-1)?.split("?")[0];
  if (raw) {
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  if (contentType.startsWith("image/")) return "image";
  return contentType.startsWith("video/") ? "video" : "document";
}

// The picker names the type it knows; these cover a video it could not type.
const VIDEO_TYPES_BY_EXTENSION: Record<string, string> = {
  mov: "video/quicktime",
  mp4: "video/mp4",
  m4v: "video/x-m4v",
  "3gp": "video/3gpp",
  webm: "video/webm",
};

/** A photo or video from the library or camera, as the composer attaches it. */
export function pickedMediaFile(
  asset: Pick<
    ImagePicker.ImagePickerAsset,
    "uri" | "type" | "mimeType" | "fileName" | "fileSize" | "duration"
  >,
  id: string,
): NativePickedFile {
  const video = asset.type === "video";
  const extension = (asset.fileName ?? asset.uri).split("?")[0]?.split(".").at(-1)?.toLowerCase();
  const contentType =
    asset.mimeType ??
    (video
      ? ((extension && VIDEO_TYPES_BY_EXTENSION[extension]) ?? "video/quicktime")
      : "image/jpeg");
  return {
    id,
    uri: asset.uri,
    name: asset.fileName ?? fallbackFilename(asset.uri, contentType),
    contentType,
    sizeBytes: asset.fileSize ?? null,
    ...(video
      ? {
          kind: "video" as const,
          ...(typeof asset.duration === "number" && asset.duration > 0
            ? { durationSeconds: asset.duration / 1000 }
            : {}),
        }
      : { kind: "image" as const, previewUri: asset.uri }),
  };
}

function isRuntimeFetchResponse(value: unknown): value is Response {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    typeof value.status === "number" &&
    "headers" in value &&
    typeof value.headers === "object" &&
    value.headers !== null &&
    "json" in value &&
    typeof value.json === "function" &&
    "text" in value &&
    typeof value.text === "function" &&
    "arrayBuffer" in value &&
    typeof value.arrayBuffer === "function" &&
    "clone" in value &&
    typeof value.clone === "function"
  );
}

/** Streaming fetch backed by Expo's native implementation (required for live event streams). */
export const expoStreamingFetch: FetchLike = async (input, init) => {
  const response = await expoFetch(input as string, init as never);
  // Preserve Expo's native response object: re-wrapping its body corrupts JSON reads on iOS.
  if (!isRuntimeFetchResponse(response)) {
    throw new TypeError("Expo fetch returned an incompatible response");
  }
  return response;
};

export const expoLifecycleAdapter: OpenGeniReactNativeAdapters["lifecycle"] = {
  currentState: () => lifecycleState(AppState.currentState),
  subscribe: (listener) => {
    const subscription = AppState.addEventListener("change", (state) =>
      listener(lifecycleState(state)),
    );
    return () => subscription.remove();
  },
};

export const expoCryptoAdapter: OpenGeniReactNativeAdapters["crypto"] = {
  randomUUID: Crypto.randomUUID,
  sha256Hex: async (bytes) => {
    const digestInput: Uint8Array<ArrayBuffer> =
      bytes.buffer instanceof ArrayBuffer
        ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        : Uint8Array.from(bytes);
    const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, digestInput);
    return bytesToHex(new Uint8Array(digest));
  },
};

export const expoFileAdapter: OpenGeniReactNativeAdapters["files"] = {
  pickDocuments: async () => {
    const result = await DocumentPicker.getDocumentAsync({
      copyToCacheDirectory: true,
      multiple: true,
    });
    if (result.canceled) return [];
    return result.assets.map(
      (asset): NativePickedFile => ({
        id: Crypto.randomUUID(),
        uri: asset.uri,
        name: asset.name,
        contentType: asset.mimeType ?? "application/octet-stream",
        sizeBytes: asset.size ?? null,
        kind: "document",
      }),
    );
  },
  // Photos and videos, as the system library shows them. Videos keep their
  // original file (passthrough, often HEVC in a .MOV): no slow re-encode before
  // sending, and the agent gets exactly what the person filmed.
  pickImages: async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      allowsMultipleSelection: true,
      mediaTypes: ["images", "videos"],
      quality: 1,
    });
    if (result.canceled) return [];
    return result.assets.map((asset) => pickedMediaFile(asset, Crypto.randomUUID()));
  },
  // The system camera with its Photo and Video modes.
  takePhoto: async () => {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      throw new Error(
        permission.canAskAgain
          ? "Camera access is needed to take photos and videos."
          : "Camera access is off for this app. Turn it on in Settings to take photos and videos.",
      );
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ["images", "videos"],
      quality: 0.9,
    });
    if (result.canceled) return [];
    return result.assets.map((asset) => pickedMediaFile(asset, Crypto.randomUUID()));
  },
  // Expo FileSystem's iOS `bytes()` requests write authority that read-only photo-picker
  // exports do not grant; `base64()` uses read authority, so decode once here.
  readBytes: async (source) => base64ToBytes(await new File(source.uri).base64()),
  uploadSource: (source, onProgress) => expoFileUploadSource(new File(source.uri), onProgress),
};

/**
 * A file on disk as an upload the system sends itself: a native PUT streamed
 * from the file with progress, which on iOS keeps going while the app is in
 * the background. Nothing is read into JavaScript memory, so a long video
 * uploads like a photo.
 */
export function expoFileUploadSource(
  file: Pick<File, "exists" | "size" | "upload">,
  onProgress: (fraction: number) => void,
): FileUploadSource {
  if (!file.exists) {
    throw new Error("This file is no longer on the device. Attach it again.");
  }
  return {
    sizeBytes: file.size,
    send: async ({ url, headers, signal }) => {
      const result = await file.upload(url, {
        httpMethod: "PUT",
        uploadType: UploadType.BINARY_CONTENT,
        // Exactly the signed headers (content type included); the signed URL is the authority.
        headers,
        signal,
        onProgress: ({ bytesSent, totalBytes }) => {
          if (totalBytes > 0) onProgress(bytesSent / totalBytes);
        },
      });
      return { status: result.status };
    },
  };
}

/** Standard Expo adapters; the host supplies persistence. */
export function createExpoOpenGeniAdapters(input: {
  persistence: NativePersistenceAdapter;
}): OpenGeniReactNativeAdapters {
  return {
    lifecycle: expoLifecycleAdapter,
    crypto: expoCryptoAdapter,
    files: expoFileAdapter,
    fetch: expoStreamingFetch,
    persistence: input.persistence,
  };
}

// Mono AAC in an MPEG-4 container: small uploads, accepted by every transcription provider.
const DICTATION_RECORDING = {
  ...RecordingPresets.HIGH_QUALITY,
  numberOfChannels: 1,
  bitRate: 64_000,
  isMeteringEnabled: true,
};

function discardRecordingFile(uri: string | null) {
  if (!uri) return;
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // A leftover cache file is harmless; the system clears the cache directory.
  }
}

/** Move a finished recording out of the recorder's scratch path into its own file. */
async function keepRecordingFile(uri: string): Promise<string> {
  try {
    const directory = new Directory(Paths.document, "opengeni-dictation");
    if (!directory.exists) directory.create({ intermediates: true, idempotent: true });
    const kept = new File(directory, `${Crypto.randomUUID()}.m4a`);
    await new File(uri).copy(kept);
    discardRecordingFile(uri);
    return kept.uri;
  } catch {
    // Keeping the original path is still better than losing the recording.
    return uri;
  }
}

/** Dictation recorder backed by expo-audio. */
export function useExpoVoiceRecorder(): NativeVoiceRecorder {
  const recorder = useAudioRecorder(DICTATION_RECORDING);
  return useMemo<NativeVoiceRecorder>(
    () => ({
      async requestPermission() {
        const permission = await requestRecordingPermissionsAsync();
        return permission.granted;
      },
      async start() {
        await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
        await recorder.prepareToRecordAsync();
        recorder.record();
      },
      async stop() {
        const durationSeconds = recorder.getStatus().durationMillis / 1000;
        await recorder.stop();
        await setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
        const uri = recorder.uri;
        if (!uri) return null;
        // Kept until its text is in the draft: a following segment or a retry
        // must never find the recorder has reused or cleared this file.
        return { uri: await keepRecordingFile(uri), mimeType: "audio/mp4", durationSeconds };
      },
      async cancel() {
        if (recorder.isRecording) await recorder.stop();
        await setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
        discardRecordingFile(recorder.uri);
      },
      discard(recording) {
        discardRecordingFile(recording.uri);
      },
      durationSeconds() {
        return recorder.getStatus().durationMillis / 1000;
      },
      level() {
        // Metering is in decibels (silence is about -160); map the useful -55…0 range.
        const decibels = recorder.getStatus().metering;
        if (typeof decibels !== "number") return null;
        return Math.max(0, Math.min(1, (decibels + 55) / 55));
      },
    }),
    [recorder],
  );
}

/**
 * Send a recording to the deployment's transcription API. The device file is
 * streamed as multipart form data and kept: dictation deletes it only once its
 * text is in the draft. Failures carry the HTTP status (null when offline).
 */
export async function transcribeExpoRecording(input: {
  client: Pick<ChatClient<OpenGeniClient>, "fetchApi">;
  workspaceId: string;
  recording: NativeVoiceRecording;
  /** The language spoken ("nb", "en"); omitted or null detects it. */
  language?: string | null | undefined;
}): Promise<string> {
  const form = new FormData();
  // expo-file-system's File is a Blob, which Expo's fetch uploads from disk.
  form.append("audio", new File(input.recording.uri) as unknown as Blob, "dictation.m4a");
  form.append("mimeType", input.recording.mimeType);
  form.append("durationSeconds", input.recording.durationSeconds.toFixed(3));
  const language = input.language?.trim();
  if (language) form.append("language", language);
  try {
    const response = await input.client.fetchApi(
      `/v1/workspaces/${encodeURIComponent(input.workspaceId)}/transcriptions`,
      { method: "POST", body: form },
    );
    const text = await response.text();
    let body: { text?: unknown; error?: { message?: unknown }; message?: unknown } = {};
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      // A non-JSON body is reported by status below.
    }
    if (!response.ok) {
      const message =
        typeof body.error?.message === "string"
          ? body.error.message
          : typeof body.message === "string"
            ? body.message
            : `Transcription failed (${response.status}).`;
      throw new NativeTranscriptionError(message, response.status);
    }
    return typeof body.text === "string" ? body.text : "";
  } catch (cause) {
    if (cause instanceof NativeTranscriptionError) throw cause;
    // No response at all: offline, timed out or dropped. The recording is kept.
    throw new NativeTranscriptionError(
      cause instanceof Error ? cause.message : "Network request failed",
      null,
    );
  }
}
