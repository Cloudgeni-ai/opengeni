// @opengeni/react-native/expo: ready-made adapters for Expo hosts.
//
// Hosts own persistence (where drafts and pending operations live, and how they are
// namespaced per signed-in principal); everything else here is the standard Expo
// implementation of the adapter contract.
import { AppState } from "react-native";
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
import { File } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import type { FetchLike, OpenGeniClient } from "@opengeni/sdk";
import type {
  NativeLifecycleState,
  NativePersistenceAdapter,
  NativePickedFile,
  OpenGeniReactNativeAdapters,
} from "./adapters";
import type { NativeVoiceRecorder, NativeVoiceRecording } from "./voice-input";

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
  return contentType.startsWith("image/") ? "image" : "document";
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
  pickImages: async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      allowsMultipleSelection: true,
      mediaTypes: ["images"],
      quality: 1,
    });
    if (result.canceled) return [];
    return result.assets.map((asset): NativePickedFile => {
      const contentType = asset.mimeType ?? "image/jpeg";
      return {
        id: Crypto.randomUUID(),
        uri: asset.uri,
        name: asset.fileName ?? fallbackFilename(asset.uri, contentType),
        contentType,
        sizeBytes: asset.fileSize ?? null,
        kind: "image",
        previewUri: asset.uri,
      };
    });
  },
  // Expo FileSystem's iOS `bytes()` requests write authority that read-only photo-picker
  // exports do not grant; `base64()` uses read authority, so decode once here.
  readBytes: async (source) => base64ToBytes(await new File(source.uri).base64()),
};

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
        return uri ? { uri, mimeType: "audio/mp4", durationSeconds } : null;
      },
      async cancel() {
        if (recorder.isRecording) await recorder.stop();
        await setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
        discardRecordingFile(recorder.uri);
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
 * streamed as multipart form data, then removed.
 */
export async function transcribeExpoRecording(input: {
  client: Pick<OpenGeniClient, "fetchApi">;
  workspaceId: string;
  recording: NativeVoiceRecording;
}): Promise<string> {
  const form = new FormData();
  // expo-file-system's File is a Blob, which Expo's fetch uploads from disk.
  form.append("audio", new File(input.recording.uri) as unknown as Blob, "dictation.m4a");
  form.append("mimeType", input.recording.mimeType);
  form.append("durationSeconds", input.recording.durationSeconds.toFixed(3));
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
      throw new Error(message);
    }
    return typeof body.text === "string" ? body.text : "";
  } finally {
    discardRecordingFile(input.recording.uri);
  }
}
