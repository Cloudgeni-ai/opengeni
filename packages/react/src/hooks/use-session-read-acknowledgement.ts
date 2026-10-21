import type { SessionEvent } from "@opengeni/sdk";
import { useEffect, useMemo, useRef } from "react";
import {
  readAcknowledgementFrontier,
  sessionAttentionReadThroughSequence,
} from "../session-attention-model";

/** The optional attention mutation a host client may expose (the SDK client does). */
export type SessionAttentionClientLike = {
  updateSessionAttention?(
    workspaceId: string,
    sessionId: string,
    request: { unread?: boolean; acknowledgedThroughSequence?: number },
  ): Promise<unknown>;
};

export type UseSessionReadAcknowledgementInput = {
  client: SessionAttentionClientLike;
  workspaceId: string;
  sessionId: string;
  /** The session row as last read. A row for another session is ignored. */
  session:
    | {
        id?: string | undefined;
        unread?: boolean | undefined;
        lastSequence?: number | undefined;
      }
    | null
    | undefined;
  /** The conversation's delivered events (the shared feed). */
  events: readonly SessionEvent[];
  /**
   * True only while the person can actually see the conversation: on the web
   * its timeline is on screen, the page is visible and the window focused; on
   * a phone the screen is focused and the app in the foreground.
   */
  active: boolean;
};

/** Delay before the single retry of a transient failure. */
export const SESSION_READ_ACKNOWLEDGEMENT_RETRY_MS = 1_000;

/** A rejection that will not change on retry (no permission, route not offered). */
function isPermanentRejection(error: unknown): boolean {
  const status =
    error && typeof error === "object" ? (error as { status?: unknown }).status : undefined;
  return (
    typeof status === "number" && status >= 400 && status < 500 && status !== 408 && status !== 429
  );
}

/**
 * Mark an open conversation read while the person is looking at it. Reading a
 * session never acknowledges it on the server; without this every reply stays
 * unread, and attention signals built on it (unread dots, pushes, webhooks a
 * host turns into notifications) fire even while the person watches the reply.
 *
 * It acknowledges through the latest delivered attention boundary (a completed
 * reply, question, approval or failure), never per streaming flush, and sends
 * `acknowledgedThroughSequence`, so a request that arrives late can never
 * consume a newer reply. One transient failure is retried once; after that the
 * frontier is released and the next foreground change retries it, so a failing
 * server never becomes a request loop. A permanent rejection (4xx) stops
 * acknowledgement for that session until the component remounts.
 */
export function useSessionReadAcknowledgement(input: UseSessionReadAcknowledgementInput): void {
  const { client, workspaceId, sessionId, events, active } = input;
  const session =
    input.session && (input.session.id ?? sessionId) === sessionId ? input.session : null;
  const attentionThrough = useMemo(() => sessionAttentionReadThroughSequence(events), [events]);
  const { readThrough, unread } = readAcknowledgementFrontier(session, attentionThrough);
  const hasSession = session !== null;
  /** The frontier currently being acknowledged or already acknowledged. */
  const receipt = useRef<string | null>(null);
  /** Sessions whose acknowledgement the server refused for good. */
  const refused = useRef(new Set<string>());
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (retryTimer.current !== null) clearTimeout(retryTimer.current);
      retryTimer.current = null;
      receipt.current = null;
    },
    [],
  );

  useEffect(() => {
    if (!active || !hasSession || !unread || readThrough <= 0) return;
    if (!workspaceId || !sessionId || typeof client.updateSessionAttention !== "function") return;
    const scope = `${workspaceId}:${sessionId}`;
    if (refused.current.has(scope)) return;
    const key = `${scope}:${readThrough}`;
    if (receipt.current === key) return;
    receipt.current = key;
    if (retryTimer.current !== null) clearTimeout(retryTimer.current);
    retryTimer.current = null;

    const attempt = (retried: boolean) => {
      void Promise.resolve()
        .then(() =>
          client.updateSessionAttention!(workspaceId, sessionId, {
            unread: false,
            acknowledgedThroughSequence: readThrough,
          }),
        )
        .catch((error: unknown) => {
          // A newer frontier (or another session) owns acknowledgement now.
          if (receipt.current !== key) return;
          if (isPermanentRejection(error)) {
            refused.current.add(scope);
            return;
          }
          if (!retried) {
            retryTimer.current = setTimeout(() => {
              retryTimer.current = null;
              if (receipt.current === key) attempt(true);
            }, SESSION_READ_ACKNOWLEDGEMENT_RETRY_MS);
            return;
          }
          // Release this frontier so the next focus or visibility change can
          // try again, without retrying on our own.
          receipt.current = null;
        });
    };
    attempt(false);
  }, [active, client, hasSession, readThrough, sessionId, unread, workspaceId]);
}
