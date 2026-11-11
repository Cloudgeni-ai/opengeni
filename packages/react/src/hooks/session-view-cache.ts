import { OpenGeniApiError } from "@opengeni/sdk";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { invalidateSharedQueries, peekSharedQuery, sharedQueryWriter } from "./shared-query";

/**
 * The last view of a conversation a person left, so reopening it draws at once
 * and then revalidates behind it.
 *
 * - It lives in the client-scoped shared-query store and inherits its privacy
 *   model: nothing is kept unless the host retains reads for that client
 *   (`OpenGeniProvider retainReadsAcrossMounts`, or `useRetainedReads(client)`),
 *   which hosts do only when every signed-in person gets their own client.
 *   Releasing the retention (sign-out, account switch) drops it. It is held in
 *   memory only; nothing is written to the device.
 * - Each read hook writes its last authoritative value when it leaves a
 *   conversation and shows the retained value only until its own first read
 *   for that conversation lands. Every open still reads every resource once;
 *   the retained view only removes the wait before the first paint.
 * - A read that says the person may no longer see the conversation (401,
 *   403, 404), or that the retained value no longer exists (a cleared goal),
 *   drops what was kept at once.
 * - Retained event windows together stay within one open conversation's
 *   window budget; the least recently left conversation goes first.
 */
export type SessionViewPart = "events" | "detail" | "queue" | "human-input" | "goal" | "lineage";

const SESSION_VIEW_ROOT = "session-view";

type Retained = { order: Map<string, { workspaceId: string; sessionId: string; bytes: number }> };
const retainedByClient = new WeakMap<object, Retained>();

function viewKey(workspaceId: string, sessionId: string): string {
  return `${workspaceId}\u0000${sessionId}`;
}

/** The value a hook left for this conversation, if the host retains reads. */
export function peekSessionView<T>(
  client: object,
  workspaceId: string,
  sessionId: string,
  part: SessionViewPart,
): T | null {
  return (
    peekSharedQuery<T>(client, [SESSION_VIEW_ROOT, workspaceId, sessionId, part])?.data ?? null
  );
}

function recordSessionView(
  client: object,
  write: ReturnType<typeof sharedQueryWriter>,
  workspaceId: string,
  sessionId: string,
  part: SessionViewPart,
  value: unknown,
  bytes: number,
  budgetBytes: number,
): void {
  if (!write([SESSION_VIEW_ROOT, workspaceId, sessionId, part], value)) return;
  let retained = retainedByClient.get(client);
  if (!retained) {
    retained = { order: new Map() };
    retainedByClient.set(client, retained);
  }
  const key = viewKey(workspaceId, sessionId);
  const previous = retained.order.get(key);
  retained.order.delete(key);
  retained.order.set(key, {
    workspaceId,
    sessionId,
    bytes: part === "events" ? bytes : (previous?.bytes ?? 0),
  });
  let total = 0;
  for (const entry of retained.order.values()) total += entry.bytes;
  for (const [oldestKey, oldest] of retained.order) {
    if (total <= budgetBytes || oldestKey === key) break;
    retained.order.delete(oldestKey);
    total -= oldest.bytes;
    void invalidateSharedQueries(client, [SESSION_VIEW_ROOT, oldest.workspaceId, oldest.sessionId]);
  }
}

/** A read failure that means the retained view must not be shown again. */
export function deniesRetainedView(error: unknown): boolean {
  return (
    error instanceof OpenGeniApiError &&
    (error.status === 401 || error.status === 403 || error.status === 404)
  );
}

/**
 * Show what this hook left for the conversation until `current` (its own
 * authoritative value) exists, and leave `current` behind when the hook moves
 * to another conversation or unmounts. Returns the retained value, or null.
 * `discard` (a denied read, or an authoritative "there is none") drops the
 * retained value now and keeps nothing for this conversation.
 */
export function useRetainedSessionView<T extends object>(
  client: object,
  workspaceId: string,
  sessionId: string | null | undefined,
  part: SessionViewPart,
  current: T | null,
  options: {
    enabled: boolean;
    bytes?: ((value: T) => number) | undefined;
    budgetBytes?: number | undefined;
    discard?: boolean | undefined;
  },
): T | null {
  const enabled = options.enabled && Boolean(sessionId);
  const discard = options.discard === true;
  const retained = useMemo(
    () => (enabled && sessionId ? peekSessionView<T>(client, workspaceId, sessionId, part) : null),
    [client, enabled, part, sessionId, workspaceId],
  );
  const target = enabled && sessionId ? `${viewKey(workspaceId, sessionId)}\u0000${part}` : null;
  // One box per target: a render for the next conversation must never write
  // its value into the previous conversation's box before that box is saved.
  const box = useRef<{ target: string; value: T | null; discard: boolean } | null>(null);
  const bytesRef = useRef(options.bytes);
  const budgetBytes = options.budgetBytes ?? Number.POSITIVE_INFINITY;
  useLayoutEffect(() => {
    bytesRef.current = options.bytes;
    if (box.current && box.current.target === target) {
      box.current.value = current;
      box.current.discard = discard;
    }
  });
  useEffect(() => {
    if (!discard || !enabled || !sessionId) return;
    void invalidateSharedQueries(client, [SESSION_VIEW_ROOT, workspaceId, sessionId, part]);
  }, [client, discard, enabled, part, sessionId, workspaceId]);
  useEffect(() => {
    if (!target || !sessionId) return;
    // Created before this conversation's reads start, so a clear (sign-out)
    // in between refuses the write.
    const write = sharedQueryWriter(client);
    const owned = { target, value: current, discard };
    box.current = owned;
    return () => {
      if (box.current === owned) box.current = null;
      const value = owned.value;
      if (owned.discard) {
        void invalidateSharedQueries(client, [SESSION_VIEW_ROOT, workspaceId, sessionId, part]);
        return;
      }
      if (value === null) return;
      recordSessionView(
        client,
        write,
        workspaceId,
        sessionId,
        part,
        value,
        bytesRef.current?.(value) ?? 0,
        budgetBytes,
      );
    };
    // `current` seeds the box once; later values arrive through the layout effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [budgetBytes, client, part, sessionId, target, workspaceId]);
  // Once dropped, the retained value stays hidden for this conversation even
  // if a later retry clears the error before its fresh value lands.
  const dropped = useRef<string | null>(null);
  if (discard && target) dropped.current = target;
  return discard || (target !== null && dropped.current === target) ? null : retained;
}
