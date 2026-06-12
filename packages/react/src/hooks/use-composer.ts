import { useCallback, useEffect, useRef, useState } from "react";
import { useOpenGeni, type ClientOverride } from "../provider";

export type UseComposerOptions = ClientOverride & {
  /** Called with the accepted text after a successful send. */
  onSent?: ((text: string) => void) | undefined;
};

export type ComposerState = {
  value: string;
  setValue: (value: string) => void;
  /** Send the draft (or an explicit text). No-op for blank drafts. */
  send: (text?: string) => Promise<boolean>;
  sending: boolean;
  canSend: boolean;
  /** Ask the agent to stop the current turn. */
  interrupt: (reason?: string) => Promise<void>;
  interrupting: boolean;
  error: Error | null;
  clearError: () => void;
};

/**
 * Draft + send + interrupt state for the chat composer — the only
 * human-to-agent input surface. The draft survives a failed send (nothing is
 * more hostile than losing a typed message); each send carries a generated
 * `clientEventId` so retries stay idempotent server-side.
 */
export function useComposer(sessionId: string | null | undefined, options: UseComposerOptions = {}): ComposerState {
  const { client, workspaceId } = useOpenGeni(options);
  const [value, setValue] = useState("");
  const [sending, setSending] = useState(false);
  const [interrupting, setInterrupting] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const pendingClientEventId = useRef<string | null>(null);
  const onSent = options.onSent;

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
    async (explicit?: string): Promise<boolean> => {
      const text = (explicit ?? value).trim();
      if (!text || !sessionId || sending) {
        return false;
      }
      // Reuse the clientEventId across retries of the same draft so a
      // timeout + resend cannot double-deliver the message.
      pendingClientEventId.current ??= generateClientEventId();
      setSending(true);
      setError(null);
      try {
        await client.sendMessage(workspaceId, sessionId, {
          text,
          clientEventId: pendingClientEventId.current,
        });
        pendingClientEventId.current = null;
        if (explicit === undefined) {
          setValue("");
        }
        onSent?.(text);
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

  const interrupt = useCallback(
    async (reason?: string): Promise<void> => {
      if (!sessionId || interrupting) {
        return;
      }
      setInterrupting(true);
      setError(null);
      try {
        await client.interrupt(workspaceId, sessionId, reason !== undefined ? { reason } : {});
      } catch (cause) {
        setError(cause instanceof Error ? cause : new Error(String(cause)));
      } finally {
        setInterrupting(false);
      }
    },
    [client, workspaceId, sessionId, interrupting],
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
    canSend: Boolean(sessionId) && !sending && value.trim().length > 0,
    interrupt,
    interrupting,
    error,
    clearError: useCallback(() => setError(null), []),
  };
}

/** Submit on plain Enter; Shift+Enter inserts a newline. Exported for tests. */
export function shouldSubmitOnKey(event: { key: string; shiftKey: boolean; nativeEvent?: { isComposing?: boolean } }): boolean {
  if (event.key !== "Enter" || event.shiftKey) {
    return false;
  }
  return event.nativeEvent?.isComposing !== true;
}

function generateClientEventId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && "randomUUID" in cryptoApi) {
    return cryptoApi.randomUUID();
  }
  return `ce-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
