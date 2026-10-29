// Records and transcribes for the desktop app's dictation shortcut. The app
// owns the shortcut, the small window that shows progress and where the text
// goes; this page records with the signed-in account, as the composer does.
import { resolveWorkspaceVoiceInputEnabled } from "@opengeni/contracts";
import type { ClientConfig, ClientVoiceInputConfig, OpenGeniClient } from "@opengeni/sdk";
import {
  getDesktopDictation,
  type DesktopDictation,
  type DesktopDictationAudio,
  type DesktopDictationReport,
  type DesktopDictationRequest,
} from "@opengeni/sdk/desktop-bridge";
import type { RecorderPlatform } from "@opengeni/sdk/recordings";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useVoiceInput,
  type UseVoiceInputResult,
  type VoiceInputRecordingsClient,
} from "../../hooks/use-voice-input";
import { readClientConfig } from "../../lib/client-config-read";
import { useOpenGeniText, type OpenGeniText } from "../../messages/runtime";

export type DesktopDictationClient = Pick<OpenGeniClient, "transcribeAudio"> &
  Partial<Pick<OpenGeniClient, "requestJson" | "getClientConfig" | "getWorkspace">>;

export type DesktopDictationHostProps = {
  /** The signed-in SDK client; dictations are recordings of this account. */
  client: DesktopDictationClient | null;
  /** The workspace that hears dictations; null records nothing. */
  workspaceId: string | null;
  /** The workspace's voice input. Read from the client's config when omitted. */
  capability?: ClientVoiceInputConfig | null | undefined;
  /** The workspace allows voice input. Read from its settings when omitted. */
  enabled?: boolean | undefined;
  /**
   * Asked before each dictation takes the microphone, such as a consent
   * check. Resolving false (or throwing) keeps the microphone off.
   */
  beforeStart?: (() => boolean | Promise<boolean>) | undefined;
  /** A recordings client, such as a host proxy. Built from `client` otherwise. */
  recordings?: Partial<VoiceInputRecordingsClient> | undefined;
  /** How this device records; the browser's by default. */
  platform?: RecorderPlatform | undefined;
  /** The app's dictation. `getDesktopDictation()` by default. */
  dictation?: DesktopDictation | null | undefined;
};

/** The voice input this page may record with, once it is known. */
type HostVoiceInput = { key: string; capability: ClientVoiceInputConfig | null; enabled: boolean };

/** The app's dictation this page is recording: what it last reported. */
type Current = {
  id: string;
  phase: "starting" | "recording" | "transcribing" | "failed";
  /** Start returned without recording and without an error: it was declined. */
  declined: boolean;
  /** Speech the app kept, transcribed again rather than recorded. */
  again: boolean;
};

/** What the next render starts: a recording, or kept speech to transcribe. */
type Pending = { id: string; audio: DesktopDictationAudio | null };

const LEVEL_REPORT_MILLISECONDS = 100;
const CONFIG_RETRY_MILLISECONDS = [2_000, 10_000, 30_000, 60_000];
const NO_WORDS: readonly string[] = [];

/**
 * Mount once on a signed-in page inside a desktop app with dictation from
 * anywhere (`getDesktopDictation()`). It renders nothing: when the person
 * presses the dictation shortcut in any app, it records the microphone here
 * and transcribes with the workspace's voice input, and the app types the
 * text where their cursor is. A dictation that fails stays saved, and the
 * composer offers it later. A cancelled one is deleted; its speech goes to the
 * app's recent dictations only, to play or transcribe again there.
 */
export function DesktopDictationHost(props: DesktopDictationHostProps): null {
  const t = useOpenGeniText();
  const dictation = useMemo(
    () => (props.dictation === undefined ? getDesktopDictation() : props.dictation),
    [props.dictation],
  );
  const { client, workspaceId } = props;
  const voiceInput = useHostVoiceInput(
    dictation ? client : null,
    workspaceId,
    props.capability,
    props.enabled,
  );
  const [language, setLanguage] = useState<string | null>(null);
  const [vocabulary, setVocabulary] = useState<readonly string[]>(NO_WORDS);
  const [pending, setPending] = useState<Pending | null>(null);
  const [declined, setDeclined] = useState(0);
  const current = useRef<Current | null>(null);
  /** The speech of the dictation being recorded, read for the app to keep. */
  const kept = useRef<{ id: string; audio: Promise<DesktopDictationAudio | null> } | null>(null);
  /** While the app's Cancel runs: the cancelled dictation's speech, when it is worth keeping. */
  const cancelling = useRef<{ audio: Promise<DesktopDictationAudio | null> | null } | null>(null);

  const report = useCallback(
    (next: DesktopDictationReport) => {
      try {
        dictation?.report(next);
      } catch {
        // The app went away; its own watchdog ends the dictation.
      }
    },
    [dictation],
  );

  const voice = useVoiceInput({
    client,
    workspaceId: workspaceId ?? "",
    capability: voiceInput?.capability ?? null,
    enabled: voiceInput?.enabled ?? false,
    // The text goes to the app, never into a draft here.
    value: "",
    setValue: (text) => {
      const active = current.current;
      if (!active) return;
      current.current = null;
      const audio = kept.current?.id === active.id ? kept.current.audio : null;
      kept.current = null;
      if (!audio) {
        report({ dictationId: active.id, phase: "done", text });
        return;
      }
      void audio.then((speech) =>
        report({
          dictationId: active.id,
          phase: "done",
          text,
          ...(speech ? { audio: speech } : {}),
        }),
      );
    },
    focusInput: noop,
    language,
    keyterms: vocabulary,
    beforeStart: props.beforeStart,
    // Dictations an earlier page left are for the composer to offer.
    recover: false,
    // The app keeps each dictation's speech with its text, to play or transcribe
    // again, and a cancelled dictation's speech on its own.
    onAudio: ({ audio, durationMilliseconds, cancelled }) => {
      const asked = cancelled ? cancelling.current : null;
      if (asked) {
        asked.audio = readSpeech(audio, durationMilliseconds);
        return;
      }
      const active = current.current;
      if (!active || active.again) return;
      if (cancelled) {
        // The page's own Escape: the dictation ends here.
        current.current = null;
        kept.current = null;
        void readSpeech(audio, durationMilliseconds).then((speech) =>
          report({
            dictationId: active.id,
            phase: "cancelled",
            ...(speech ? { audio: speech } : {}),
          }),
        );
        return;
      }
      kept.current = { id: active.id, audio: readSpeech(audio, durationMilliseconds) };
    },
    recordings: props.recordings,
    platform: props.platform,
  });
  const voiceRef = useRef<UseVoiceInputResult>(voice);
  voiceRef.current = voice;
  const available = Boolean(voiceInput?.capability?.available && voiceInput.enabled);
  const availableRef = useRef(available);
  availableRef.current = available;

  const words = useRef({ t, report });
  words.current = { t, report };

  const handle = useCallback((request: DesktopDictationRequest) => {
    const voiceNow = voiceRef.current;
    const { t: text, report: send } = words.current;
    if (request.kind === "start" || request.kind === "transcribe") {
      if (!availableRef.current) {
        send({
          dictationId: request.dictationId,
          phase: "failed",
          message: text("desktopDictation.host.voiceInputOff"),
          retryable: false,
        });
        return;
      }
      // A dictation still held here (one that failed) stays saved for the
      // composer; this one starts fresh.
      if (voiceNow.status !== "idle") voiceNow.release();
      const again = request.kind === "transcribe";
      current.current = { id: request.dictationId, phase: "starting", declined: false, again };
      kept.current = null;
      setLanguage(request.language);
      setVocabulary(request.vocabulary ?? NO_WORDS);
      setPending({ id: request.dictationId, audio: again ? request.audio : null });
      return;
    }
    const active = current.current;
    if (!active || active.id !== request.dictationId) return;
    switch (request.kind) {
      case "stop":
        voiceNow.stop();
        return;
      case "cancel": {
        current.current = null;
        kept.current = null;
        if (active.again) {
          // The app still has the speech: nothing here needs keeping.
          void voiceNow.discard();
          send({ dictationId: active.id, phase: "cancelled" });
          return;
        }
        // Deleted here; speech worth keeping comes back for the app's recent dictations.
        const asked: { audio: Promise<DesktopDictationAudio | null> | null } = { audio: null };
        cancelling.current = asked;
        try {
          voiceNow.cancel();
        } finally {
          cancelling.current = null;
        }
        const { audio } = asked;
        if (!audio) {
          send({ dictationId: active.id, phase: "cancelled" });
          return;
        }
        void audio.then((speech) =>
          send({
            dictationId: active.id,
            phase: "cancelled",
            ...(speech ? { audio: speech } : {}),
          }),
        );
        return;
      }
      case "dismiss":
        current.current = null;
        if (active.again) void voiceNow.discard();
        else voiceNow.release();
        return;
      case "retry":
        voiceNow.retry();
        return;
    }
  }, []);

  // Record for the app's shortcut once this workspace's voice input is known,
  // so a press that opened this page waits for it rather than failing.
  const listening = Boolean(dictation && workspaceId && voiceInput);
  useEffect(() => {
    if (!dictation || !listening) return;
    const off = dictation.onRequest(handle);
    return () => {
      off();
      const active = current.current;
      current.current = null;
      if (active) {
        voiceRef.current.release();
        const { t: text, report: send } = words.current;
        send({
          dictationId: active.id,
          phase: "failed",
          message: text("desktopDictation.host.stopped"),
          retryable: false,
        });
      }
    };
  }, [dictation, handle, listening, workspaceId]);

  // Start after the render that applied the dictation's language and vocabulary.
  useEffect(() => {
    if (!pending) return;
    setPending(null);
    const { id, audio } = pending;
    // Cancelled before it could start: nothing to record.
    if (current.current?.id !== id) return;
    const starting = audio
      ? voiceRef.current.transcribe(new Blob([audio.bytes as BlobPart], { type: audio.mimeType }), {
          durationMilliseconds: audio.durationMilliseconds,
        })
      : voiceRef.current.start();
    void starting.then(
      (started) => {
        const active = current.current;
        if (started || active?.id !== id) return;
        active.declined = true;
        setDeclined((count) => count + 1);
      },
      () => {
        const active = current.current;
        if (active?.id !== id) return;
        active.declined = true;
        setDeclined((count) => count + 1);
      },
    );
  }, [pending]);

  const { status, error, hasRecoverableRecording, recordingStartedAt } = voice;
  useEffect(() => {
    const active = current.current;
    if (!active) return;
    switch (status) {
      case "requesting-permission":
        return;
      case "recording":
        if (active.phase === "starting") {
          active.phase = "recording";
          report({
            dictationId: active.id,
            phase: "recording",
            startedAt: recordingStartedAt ?? Date.now(),
            level: voiceRef.current.level(),
          });
        }
        return;
      case "saving":
      case "transcribing":
      case "retrying":
        if (active.phase !== "transcribing") {
          active.phase = "transcribing";
          report({ dictationId: active.id, phase: "transcribing" });
        }
        return;
      case "transcript-ready":
        // Held while something else had the page; it is this dictation's text.
        void voiceRef.current.insertSavedTranscript();
        return;
      case "error":
        if (active.phase !== "failed") {
          active.phase = "failed";
          report({
            dictationId: active.id,
            phase: "failed",
            message: dictationErrorMessage(error, t),
            retryable: hasRecoverableRecording,
          });
        }
        return;
      case "recovered":
        // Set aside here without transcribing: it stays saved for the composer.
        current.current = null;
        report({ dictationId: active.id, phase: "cancelled" });
        return;
      case "idle":
        if (active.phase === "recording" || active.phase === "transcribing") {
          // Nothing was heard (the text arrives through `setValue` otherwise).
          current.current = null;
          report({ dictationId: active.id, phase: "done", text: "" });
        } else if (active.phase === "starting" && active.declined) {
          current.current = null;
          report({ dictationId: active.id, phase: "cancelled" });
        }
        return;
    }
  }, [declined, error, hasRecoverableRecording, recordingStartedAt, report, status, t]);

  // The level drives the bars in the app's window.
  useEffect(() => {
    if (status !== "recording") return;
    const timer = setInterval(() => {
      const active = current.current;
      if (active?.phase !== "recording") return;
      report({
        dictationId: active.id,
        phase: "recording",
        startedAt: recordingStartedAt ?? Date.now(),
        level: voiceRef.current.level(),
      });
    }, LEVEL_REPORT_MILLISECONDS);
    return () => clearInterval(timer);
  }, [recordingStartedAt, report, status]);

  return null;
}

/** The workspace's voice input and whether its settings allow it, read once per workspace. */
function useHostVoiceInput(
  client: DesktopDictationClient | null,
  workspaceId: string | null,
  capability: ClientVoiceInputConfig | null | undefined,
  enabled: boolean | undefined,
): HostVoiceInput | null {
  const [state, setState] = useState<HostVoiceInput | null>(null);
  // By value: a host may pass a fresh object on every render.
  const capabilityKey = capability === undefined ? null : JSON.stringify(capability);
  const given = useRef(capability);
  given.current = capability;
  useEffect(() => {
    if (!client || !workspaceId) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const key = workspaceId;
    const readCapability = async (): Promise<ClientVoiceInputConfig | null> => {
      if (capabilityKey !== null) return given.current ?? null;
      if (typeof client.getClientConfig !== "function") return null;
      const config = await readClientConfig<ClientConfig>(
        client as Pick<OpenGeniClient, "getClientConfig">,
        workspaceId,
      );
      return config.voiceInput ?? null;
    };
    const readEnabled = async (): Promise<boolean> => {
      if (enabled !== undefined) return enabled;
      if (typeof client.getWorkspace !== "function") return true;
      // The transcription request still enforces the setting.
      return client.getWorkspace(workspaceId).then(
        (workspace) => resolveWorkspaceVoiceInputEnabled(workspace.settings) ?? true,
        () => true,
      );
    };
    const read = (attempt: number) => {
      Promise.all([readCapability(), readEnabled()]).then(
        ([nextCapability, nextEnabled]) => {
          if (live) setState({ key, capability: nextCapability, enabled: nextEnabled });
        },
        () => {
          // Offline at start: try again, and record nothing until it is known.
          if (!live) return;
          const delay =
            CONFIG_RETRY_MILLISECONDS[Math.min(attempt, CONFIG_RETRY_MILLISECONDS.length - 1)]!;
          timer = setTimeout(() => read(attempt + 1), delay);
        },
      );
    };
    read(0);
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [capabilityKey, client, enabled, workspaceId]);
  return state && state.key === workspaceId ? state : null;
}

/** A short sentence for the app's dictation window. */
export function dictationErrorMessage(code: string | null, t: OpenGeniText): string {
  switch (code) {
    case "permission_denied":
      return t("desktopDictation.host.microphoneBlocked");
    case "not_supported":
      return t("desktopDictation.host.cantRecord");
    case "unavailable":
      return t("desktopDictation.host.voiceInputOff");
    case "insufficient_credits":
      return t("desktopDictation.host.needsCredits");
    case "allowance_exhausted":
    case "monthly_model_cost_limit":
      return t("desktopDictation.host.usageLimit");
    case "policy_blocked":
      return t("desktopDictation.host.notAllowed");
    case "too_large":
      return t("desktopDictation.host.tooLong");
    case "invalid_audio":
      return t("desktopDictation.host.unreadable");
    case "storage_unavailable":
      return t("desktopDictation.host.notSaved");
    case "network":
    case "provider":
    case "timeout":
      return t("desktopDictation.host.transcriptionFailed");
    default:
      return t("desktopDictation.host.couldNotStart");
  }
}

function noop(): void {}

/** A dictation's speech as the app keeps it, or null when it can't be read. */
function readSpeech(
  audio: Blob,
  durationMilliseconds: number,
): Promise<DesktopDictationAudio | null> {
  return audio.arrayBuffer().then(
    (buffer) => ({
      mimeType: audio.type || "audio/webm",
      bytes: new Uint8Array(buffer),
      durationMilliseconds,
    }),
    () => null,
  );
}
