import { useEffect, useMemo, useRef } from "react";
import type { SessionEvent } from "@opengeni/sdk";
import { sessionAttentionReadThroughSequence } from "@opengeni/react/session-attention-model";

/** The optional attention mutation a host client may expose (the SDK client does). */
export type SessionAttentionClientLike = {
  updateSessionAttention?(
    workspaceId: string,
    sessionId: string,
    body: { unread?: boolean; acknowledgedThroughSequence?: number },
  ): Promise<unknown>;
};

/**
 * Where an open conversation should be acknowledged through, and whether it
 * needs it: the server says unread, or newer attention events have arrived
 * since the session row was read.
 */
export function readAcknowledgementFrontier(
  session: { unread?: boolean; lastSequence?: number } | null,
  attentionThrough: number,
): { readThrough: number; unread: boolean } {
  const lastSequence = session?.lastSequence ?? 0;
  return {
    readThrough: Math.max(lastSequence, attentionThrough),
    unread: Boolean(session?.unread) || attentionThrough > lastSequence,
  };
}

/**
 * Mark the open conversation read, as the web session page does: while it is on
 * screen and the app is in the foreground, acknowledge through the latest
 * delivered attention boundary (completed reply, question, failure), never per
 * streaming flush. Reading a session does not acknowledge it on the server;
 * without this, every reply stays unread and attention notifications (pushes,
 * webhooks a host turns into alerts) fire even while the person watches it.
 */
export function useNativeReadAcknowledgement(input: {
  client: SessionAttentionClientLike;
  workspaceId: string;
  sessionId: string;
  session: { unread?: boolean; lastSequence?: number } | null;
  events: readonly SessionEvent[];
  active: boolean;
}) {
  const { client, workspaceId, sessionId, session, events, active } = input;
  const attentionThrough = useMemo(() => sessionAttentionReadThroughSequence(events), [events]);
  const { readThrough, unread } = readAcknowledgementFrontier(session, attentionThrough);
  const acknowledged = useRef<{ key: string; retried: boolean } | null>(null);

  useEffect(() => {
    if (!active || !session || !unread || readThrough <= 0) return;
    if (!client.updateSessionAttention) return;
    const key = `${workspaceId}:${sessionId}:${readThrough}`;
    const previous = acknowledged.current;
    if (previous?.key === key) return;
    acknowledged.current = { key, retried: false };
    const send = (): Promise<unknown> =>
      client.updateSessionAttention!(workspaceId, sessionId, {
        unread: false,
        acknowledgedThroughSequence: readThrough,
      });
    send().catch(() => {
      // Retry one transient failure for this exact frontier, then stop: a
      // permanent rejection must not become a request loop.
      const current = acknowledged.current;
      if (current?.key !== key || current.retried) return;
      current.retried = true;
      void send().catch(() => undefined);
    });
  }, [active, client, readThrough, session, sessionId, unread, workspaceId]);
}
