import type { ClientVoiceInputConfig, OpenGeniClient } from "@opengeni/sdk";
import type { RecorderPlatform } from "@opengeni/sdk/recordings";
import { useOpenGeniText } from "@opengeni/react/messages";
import {
  useVoiceInput,
  type UseVoiceInputResult,
  type VoiceInputRecordingsClient,
} from "@opengeni/react/recordings";
import { useCallback, useEffect, useRef, useState } from "react";
import type { NativeVoiceInput, NativeVoiceInputStatus } from "../voice-input";

export type UseNativeDictationOptions = {
  /** The SDK client; dictations are recorded through its recordings API. */
  client:
    | (Pick<OpenGeniClient, "transcribeAudio"> & Partial<Pick<OpenGeniClient, "requestJson">>)
    | null;
  workspaceId: string;
  /** The deployment's voice input, from the client config. */
  capability: ClientVoiceInputConfig | null;
  /** The phone's capture, from `useNativeRecorderPlatform`. */
  platform: RecorderPlatform;
  /** Whether this workspace allows voice input. */
  enabled?: boolean | undefined;
  value: string;
  setValue: (value: string) => void;
  /** Changing this (another session) ends a running capture; real speech is kept. */
  scope?: string | undefined;
  /** Host feedback (haptics) when recording starts and stops. */
  onFeedback?: ((event: "start" | "stop" | "cancel") => void) | undefined;
  /** A recordings client, such as a proxy. Built from `client` otherwise. */
  recordings?: Partial<VoiceInputRecordingsClient> | undefined;
};

/**
 * Dictation for a native composer, kept as a recording until its text is in
 * the draft: the phone records to its files, uploads as it goes and the
 * server transcribes it. A killed app, no signal or a failed transcription
 * loses nothing; the next composer in the workspace offers the text.
 *
 * The same dictation as the web composer's `useVoiceInput`, shaped for
 * the native composer.
 */
export function useNativeDictation(options: UseNativeDictationOptions): NativeVoiceInput {
  const t = useOpenGeniText();
  const voice = useVoiceInput({
    client: options.client,
    workspaceId: options.workspaceId,
    capability: options.capability,
    enabled: options.enabled ?? true,
    value: options.value,
    setValue: options.setValue,
    focusInput: () => undefined,
    platform: options.platform,
    ...(options.recordings ? { recordings: options.recordings } : {}),
  });
  const feedback = useRef(options.onFeedback);
  feedback.current = options.onFeedback;

  // The meter and clock tick while recording.
  const [tick, setTick] = useState<{ level: number | null; seconds: number }>({
    level: null,
    seconds: 0,
  });
  const recording = voice.status === "recording";
  const startedAt = voice.recordingStartedAt;
  const readLevel = voice.level;
  useEffect(() => {
    if (!recording) {
      setTick({ level: null, seconds: 0 });
      return;
    }
    feedback.current?.("start");
    const timer = setInterval(() => {
      setTick({
        level: readLevel(),
        seconds: startedAt === null ? 0 : Math.max(0, (Date.now() - startedAt) / 1_000),
      });
    }, 100);
    return () => clearInterval(timer);
  }, [readLevel, recording, startedAt]);

  // Another session: end capture the way Cancel does, keeping real speech.
  const cancelVoice = voice.cancel;
  const scope = options.scope;
  const lastScope = useRef(scope);
  useEffect(() => {
    if (lastScope.current === scope) return;
    lastScope.current = scope;
    cancelVoice();
  }, [cancelVoice, scope]);

  const held = voice.hasRecoverableRecording;
  const status = nativeStatus(voice.status, held);
  const error = voice.error ? nativeError(voice.error, held, t) : null;
  const { start: startVoice, insertSavedTranscript, retry: retryVoice, discard } = voice;
  const savedTranscript = held ? voice.savedTranscript : null;

  const start = useCallback(() => {
    // A kept dictation comes first; a new one never replaces it.
    if (savedTranscript !== null) {
      void insertSavedTranscript();
      return;
    }
    if (held) {
      retryVoice();
      return;
    }
    void startVoice();
  }, [held, insertSavedTranscript, retryVoice, savedTranscript, startVoice]);

  const stop = useCallback(() => {
    if (voice.status !== "recording") return;
    feedback.current?.("stop");
    voice.stop();
  }, [voice]);

  const cancel = useCallback(() => {
    if (voice.status === "recording") {
      feedback.current?.("cancel");
      cancelVoice();
      return;
    }
    if (held || voice.status === "error") {
      void discard();
      return;
    }
    cancelVoice();
  }, [cancelVoice, discard, held, voice.status]);

  return {
    available: voice.available,
    status,
    error,
    durationSeconds: recording ? tick.seconds : voice.durationSeconds,
    level: recording ? tick.level : null,
    maxDurationSeconds: voice.maxRecordingSeconds,
    hasSavedRecording: held,
    savedTranscript,
    start,
    stop,
    cancel,
    retry: () => (savedTranscript !== null ? void insertSavedTranscript() : retryVoice()),
    insertSaved: () => void insertSavedTranscript(),
    clearError: () => {
      if (!held) void discard();
    },
  };
}

function nativeStatus(
  status: UseVoiceInputResult["status"],
  held: boolean,
): NativeVoiceInputStatus {
  switch (status) {
    case "requesting-permission":
    case "recording":
      return status;
    case "saving":
    case "transcribing":
    case "retrying":
      // A kept dictation the server is still hearing waits quietly, not as a spinner.
      return held ? "error" : "transcribing";
    case "recovered":
    case "transcript-ready":
    case "error":
      return held || status === "error" ? "error" : "idle";
    default:
      return "idle";
  }
}

function nativeError(code: string, held: boolean, t: ReturnType<typeof useOpenGeniText>): string {
  switch (code) {
    case "permission_denied":
      return t("native.voiceInput.allowMicrophoneAccessInSettings");
    case "not_supported":
      return t("native.voiceInput.couldnTStartTheMicrophone");
    case "policy_blocked":
      return t("composerTranscriptionControl.voiceInputIsnTAllowed");
    case "insufficient_credits":
      return t("composerTranscriptionControl.voiceInputNeedsCreditsRecording");
    case "allowance_exhausted":
    case "monthly_model_cost_limit":
      return t("composerTranscriptionControl.usageLimitReachedRecordingSaved");
    case "too_large":
      return t("composerTranscriptionControl.recordingIsTooLargeTry");
    case "network":
    case "timeout":
    case "unavailable":
    case "provider":
      return held
        ? t("native.voiceInput.couldnTReachTranscriptionYour")
        : t("native.voiceInput.couldnTStartTheMicrophone");
    default:
      return held
        ? t("native.voiceInput.couldNotTranscribe")
        : t("native.voiceInput.couldnTStartTheMicrophone");
  }
}
