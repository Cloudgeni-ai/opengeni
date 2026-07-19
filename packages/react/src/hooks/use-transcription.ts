import { useCallback, useEffect, useReducer, useRef } from "react";

import { initialTranscriptionState, transcriptionReducer } from "../transcription/reducer";
import type {
  TranscriptionEvent,
  TranscriptionPrivacyRequest,
  TranscriptionProvider,
  TranscriptionSession,
  TranscriptionState,
} from "../transcription/types";

export type UseTranscriptionOptions = {
  provider: TranscriptionProvider | null;
  value: string;
  setValue: (value: string) => void;
  disabled?: boolean;
  language?: string;
  diarization?: boolean;
  privacy?: TranscriptionPrivacyRequest;
  sessionIdFactory?: () => string;
  onFocusComposer?: () => void;
};

export type UseTranscriptionResult = {
  state: TranscriptionState;
  supported: boolean;
  active: boolean;
  start: () => Promise<boolean>;
  cancel: () => Promise<void>;
  retry: () => Promise<boolean>;
};

const defaultPrivacy: TranscriptionPrivacyRequest = {
  retainAudio: false,
  retainTranscript: false,
  trainingAllowed: false,
};

export function appendFinalTranscript(currentDraft: string, finalTranscript: string): string {
  const finalText = finalTranscript.trim();
  if (!finalText) {
    return currentDraft;
  }
  if (!currentDraft.trim()) {
    return finalText;
  }
  return `${currentDraft}${/\s$/u.test(currentDraft) ? "" : " "}${finalText}`;
}

function isPermissionDenied(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "NotAllowedError" || error.name === "PermissionDeniedError")
  );
}

function errorMessage(permissionDenied: boolean): string {
  if (permissionDenied) {
    return "Microphone permission was denied. Allow microphone access, then retry.";
  }
  return "Voice dictation could not start. Please retry.";
}

async function closeQuietly(session: TranscriptionSession | null): Promise<void> {
  try {
    await session?.close();
  } catch {
    // A best-effort cleanup failure must not replace the actionable provider error.
  }
}

export function useTranscription(options: UseTranscriptionOptions): UseTranscriptionResult {
  const {
    provider,
    value,
    setValue,
    disabled,
    language,
    diarization,
    privacy,
    sessionIdFactory,
    onFocusComposer,
  } = options;
  const [state, dispatch] = useReducer(transcriptionReducer, initialTranscriptionState);
  const sessionRef = useRef<TranscriptionSession | null>(null);
  const generationRef = useRef(0);
  const startingRef = useRef(false);
  const valueRef = useRef(value);
  const setValueRef = useRef(setValue);
  const focusComposerRef = useRef(onFocusComposer);
  const insertedCommitIdsRef = useRef(new Set<string>());

  valueRef.current = value;
  setValueRef.current = setValue;
  focusComposerRef.current = onFocusComposer;

  useEffect(() => {
    let inserted = false;
    for (const commit of state.acceptedCommits) {
      if (insertedCommitIdsRef.current.has(commit.id)) {
        continue;
      }
      insertedCommitIdsRef.current.add(commit.id);
      const nextValue = appendFinalTranscript(valueRef.current, commit.text);
      if (nextValue !== valueRef.current) {
        valueRef.current = nextValue;
        setValueRef.current(nextValue);
      }
      inserted = true;
    }
    if (inserted) {
      focusComposerRef.current?.();
    }
  }, [state.acceptedCommits]);

  const start = useCallback(async (): Promise<boolean> => {
    if (!provider || disabled || startingRef.current) {
      return false;
    }

    startingRef.current = true;
    const generation = ++generationRef.current;
    const sessionId = sessionIdFactory?.() ?? crypto.randomUUID();
    const previous = sessionRef.current;
    sessionRef.current = null;
    dispatch({ type: "start.requested", sessionId });
    let session: TranscriptionSession | null = null;
    let highestSequence = 0;
    let terminalEventReceived = false;

    try {
      await closeQuietly(previous);
      if (generationRef.current !== generation) {
        return false;
      }
      session = provider.createSession(
        {
          sessionId,
          ...(language ? { language } : {}),
          ...(diarization === undefined ? {} : { diarization }),
          privacy: privacy ?? defaultPrivacy,
        },
        (event) => {
          if (generationRef.current !== generation) {
            return;
          }
          highestSequence = Math.max(highestSequence, event.sequence);
          if (
            event.sessionId === sessionId &&
            (event.type === "error" || event.type === "closed")
          ) {
            terminalEventReceived = true;
          }
          dispatch({ type: "provider.event", event });
        },
      );
      sessionRef.current = session;
      if (terminalEventReceived) {
        sessionRef.current = null;
        await closeQuietly(session);
        return false;
      }
      await session.start();
      if (generationRef.current !== generation || terminalEventReceived) {
        if (generationRef.current === generation) {
          sessionRef.current = null;
        }
        await closeQuietly(session);
        return false;
      }
      return true;
    } catch (error) {
      if (generationRef.current === generation) {
        if (!terminalEventReceived) {
          const permissionDenied = isPermissionDenied(error);
          const event: TranscriptionEvent = {
            type: "error",
            sessionId,
            providerId: provider.id,
            sequence: highestSequence + 1,
            code: permissionDenied ? "permission_denied" : "start_failed",
            message: errorMessage(permissionDenied),
            retryable: true,
            permissionDenied,
          };
          dispatch({ type: "provider.event", event });
        }
        sessionRef.current = null;
      }
      await closeQuietly(session);
      return false;
    } finally {
      startingRef.current = false;
    }
  }, [provider, disabled, sessionIdFactory, language, diarization, privacy]);

  const cancel = useCallback(async (): Promise<void> => {
    ++generationRef.current;
    const session = sessionRef.current;
    sessionRef.current = null;
    dispatch({ type: "cancel.requested" });
    try {
      await session?.cancel("user_cancelled");
    } finally {
      await closeQuietly(session);
      dispatch({ type: "cancel.completed" });
      focusComposerRef.current?.();
    }
  }, []);

  useEffect(
    () => () => {
      ++generationRef.current;
      const session = sessionRef.current;
      sessionRef.current = null;
      void closeQuietly(session);
    },
    [],
  );

  return {
    state,
    supported: provider !== null,
    active: state.phase === "listening" || state.phase === "reconnecting",
    start,
    cancel,
    retry: start,
  };
}
