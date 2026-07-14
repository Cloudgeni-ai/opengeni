import type { SendMessageInput } from "@opengeni/sdk";
import { useCallback, useEffect, useRef, useState } from "react";
import { useOpenGeni, type ClientOverride } from "../provider";

export type ComposerSendExtras = Omit<SendMessageInput, "text" | "clientEventId">;

/**
 * Enter appends a prompt; Cmd/Ctrl+Enter steers it to the head and supersedes
 * the current inference.
 */
export type ComposerMode = "queue" | "steer";

export type UseComposerOptions = ClientOverride & {
  /** Called with the accepted text after a successful send. */
  onSent?: ((text: string) => void) | undefined;
  /**
   * Extra message fields (resources, tools, model, reasoningEffort) merged
   * into every send. A function is evaluated at send time so it can read the
   * surrounding UI state (attachment pickers, model selectors, ...).
   */
  sendExtras?: ComposerSendExtras | (() => ComposerSendExtras) | undefined;
};

export type ComposerState = {
  value: string;
  setValue: (value: string) => void;
  /** Send the draft (or explicit text). Queue is the default; steer is explicit. */
  send: (text?: string, mode?: ComposerMode) => Promise<boolean>;
  sending: boolean;
  canSend: boolean;
  /** Pause the session without deleting its prompt queue. */
  pause: (reason?: string) => Promise<void>;
  pausing: boolean;
  resume: (reason?: string) => Promise<void>;
  resuming: boolean;
  error: Error | null;
  clearError: () => void;
};

/**
 * Draft + send + Pause/Resume state for the chat composer — the only
 * human-to-agent input surface. The draft survives a failed send (nothing is
 * more hostile than losing a typed message); each send carries a generated
 * `clientEventId` so retries stay idempotent server-side.
 */
export function useComposer(
  sessionId: string | null | undefined,
  options: UseComposerOptions = {},
): ComposerState {
  const { client, workspaceId } = useOpenGeni(options);
  const [value, setValue] = useState("");
  const [sending, setSending] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const pendingClientEventId = useRef<string | null>(null);
  const onSent = options.onSent;
  // Read through a ref so a new extras closure (created every render by
  // callers passing inline functions) does not invalidate `send`.
  const sendExtrasRef = useRef(options.sendExtras);
  sendExtrasRef.current = options.sendExtras;

  // A composer is bound to one session: switching targets must not leak the
  // previous session's draft, error, or retry idempotency key.
  const targetKey = `${workspaceId}\u0000${sessionId ?? ""}`;
  const targetKeyRef = useRef(targetKey);
  useEffect(() => {
    if (targetKeyRef.current !== targetKey) {
      targetKeyRef.current = targetKey;
      pendingClientEventId.current = null;
      setValue("");
      setError(null);
    }
  }, [targetKey]);

  const send = useCallback(
    async (explicit?: string, delivery: ComposerMode = "queue"): Promise<boolean> => {
      const draftAtSend = value;
      const text = (explicit ?? draftAtSend).trim();
      // Resolve the extras once: a file-only message (empty text + ≥1 ready
      // resource) is legitimate, so we must not bail on empty text alone.
      const extras = resolveSendExtras(sendExtrasRef.current);
      const hasResources = (extras.resources?.length ?? 0) > 0;
      if ((!text && !hasResources) || !sessionId || sending) {
        return false;
      }
      // Reuse the clientEventId across retries of the same draft so a
      // timeout + resend cannot double-deliver the message.
      pendingClientEventId.current ??= generateClientEventId();
      setSending(true);
      setError(null);
      try {
        // The wire contract requires non-empty text (z.string().min(1)) and the
        // worker rejects whitespace-only text; a file-only message therefore
        // carries a minimal default so the attachments still get delivered.
        const sendText = text || FILE_ONLY_MESSAGE_TEXT;
        const input = composeSendInput(sendText, pendingClientEventId.current, extras);
        if (delivery === "steer") {
          await client.steerMessage(workspaceId, sessionId, input);
        } else {
          await client.sendMessage(workspaceId, sessionId, input);
        }
        pendingClientEventId.current = null;
        if (explicit === undefined) {
          // Clear only the draft that was sent: edits made while the request
          // was in flight were never delivered and must survive.
          setValue((current) => (current === draftAtSend ? "" : current));
        }
        onSent?.(sendText);
        return true;
      } catch (cause) {
        setError(cause instanceof Error ? cause : new Error(String(cause)));
        return false;
      } finally {
        setSending(false);
      }
    },
    [client, workspaceId, sessionId, value, sending, onSent],
  );

  // A send is possible with non-empty text OR with ≥1 attached resource (a
  // file-only message). Resources ride in `sendExtras`, so we resolve them here
  // — keeping useComposer attachment-agnostic while still lighting up the send
  // affordance the moment a file is ready. ChatComposer additionally gates this
  // on its `attachments.uploading` flag so a message never departs mid-upload.
  const hasReadyResources = (resolveSendExtras(sendExtrasRef.current).resources?.length ?? 0) > 0;

  const pause = useCallback(
    async (reason?: string): Promise<void> => {
      if (!sessionId || pausing) {
        return;
      }
      setPausing(true);
      setError(null);
      try {
        await client.pauseSession(workspaceId, sessionId, reason !== undefined ? { reason } : {});
      } catch (cause) {
        setError(cause instanceof Error ? cause : new Error(String(cause)));
      } finally {
        setPausing(false);
      }
    },
    [client, workspaceId, sessionId, pausing],
  );

  const resume = useCallback(
    async (reason?: string): Promise<void> => {
      if (!sessionId || resuming) return;
      setResuming(true);
      setError(null);
      try {
        await client.resumeSession(workspaceId, sessionId, reason !== undefined ? { reason } : {});
      } catch (cause) {
        setError(cause instanceof Error ? cause : new Error(String(cause)));
      } finally {
        setResuming(false);
      }
    },
    [client, workspaceId, sessionId, resuming],
  );

  const updateValue = useCallback((next: string) => {
    pendingClientEventId.current = null;
    setValue(next);
  }, []);

  return {
    value,
    setValue: updateValue,
    send,
    sending,
    canSend: Boolean(sessionId) && !sending && (value.trim().length > 0 || hasReadyResources),
    pause,
    pausing,
    resume,
    resuming,
    error,
    clearError: useCallback(() => setError(null), []),
  };
}

/**
 * Default text for a file-only message (attachment(s) present, no typed draft).
 * Kept non-empty so the wire contract (`text: z.string().min(1)`) and the
 * worker's non-whitespace guard accept it; the attached files still ride in
 * `resources`. Exported for tests.
 */
export const FILE_ONLY_MESSAGE_TEXT = "(see attached files)";

/** Resolve possibly-deferred extras to a concrete bag (function evaluated now). */
export function resolveSendExtras(
  extras: ComposerSendExtras | (() => ComposerSendExtras) | undefined,
): ComposerSendExtras {
  return (typeof extras === "function" ? extras() : extras) ?? {};
}

/**
 * Merge the draft text + idempotency key with caller-provided extras. The
 * text and clientEventId always win over extras. Exported for tests.
 */
export function composeSendInput(
  text: string,
  clientEventId: string,
  extras: ComposerSendExtras | (() => ComposerSendExtras) | undefined,
): SendMessageInput {
  return { ...resolveSendExtras(extras), text, clientEventId };
}

/** Submit on plain Enter; Shift+Enter inserts a newline. Exported for tests. */
export function shouldSubmitOnKey(event: {
  key: string;
  shiftKey: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  nativeEvent?: { isComposing?: boolean };
}): boolean {
  if (event.key !== "Enter" || event.shiftKey) {
    return false;
  }
  return event.nativeEvent?.isComposing !== true;
}

/** Cmd/Ctrl+Enter steers; ordinary Enter appends to the queue. */
export function composerModeForKey(event: { metaKey?: boolean; ctrlKey?: boolean }): ComposerMode {
  return event.metaKey || event.ctrlKey ? "steer" : "queue";
}

function generateClientEventId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && "randomUUID" in cryptoApi) {
    return cryptoApi.randomUUID();
  }
  return `ce-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
