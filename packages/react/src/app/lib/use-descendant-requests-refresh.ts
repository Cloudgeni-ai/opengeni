// Keeps a parent session's view of its sub-sessions' waits current. The
// workspace's live session-list hints (the same ones that move the orange dot
// in the rail, batched by the server) re-read the tree when they name a
// sub-session, and this session's agent answering or steering one re-reads it
// once that call has run, so a card appears and clears without waiting for
// the lineage poll.
import type { LineageNode, SessionEvent } from "@opengeni/sdk";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { EmbeddedSessionEventClientLike } from "../../client";
import { useDebouncedCallback, useSessionEventTrigger } from "../../hooks/internal";
import { useOpenGeni } from "../../session-context";
import {
  descendantsRunning,
  hintTouchesTree,
  isSubSessionResponseOutput,
  lineageSessionIds,
  subSessionResponseCallIds,
  waitingDescendants,
} from "./descendant-requests";

/** The lineage poll: the default, and while sub-sessions are active without live hints. */
export const LINEAGE_POLL_MS = 30_000;
export const LINEAGE_POLL_ACTIVE_WITHOUT_HINTS_MS = 15_000;

/** Whether a tree has a sub-session that is running or waiting on the person. */
export function treeNeedsWatching(nodes: readonly LineageNode[]): boolean {
  return descendantsRunning(nodes) || waitingDescendants(nodes).length > 0;
}

/**
 * How often to re-read the lineage. Live hints make a fast poll unnecessary;
 * without them (an embed authorized per session gets none) the poll speeds up
 * only while a sub-session is running or waiting. The tree comes from the
 * read this interval drives, so the page reports it through `observeTree`.
 */
export function useLineagePollInterval(workspaceId: string): {
  pollIntervalMs: number;
  observeTree: (nodes: readonly LineageNode[]) => void;
} {
  const { workspaceSessionListEvent } = useOpenGeni();
  const [active, setActive] = useState(false);
  const observeTree = useCallback(
    (nodes: readonly LineageNode[]) => setActive(treeNeedsWatching(nodes)),
    [],
  );
  const live =
    workspaceSessionListEvent?.workspaceId === workspaceId &&
    workspaceSessionListEvent.available === true;
  return {
    pollIntervalMs: !live && active ? LINEAGE_POLL_ACTIVE_WITHOUT_HINTS_MS : LINEAGE_POLL_MS,
    observeTree,
  };
}

/**
 * Re-read the lineage when a hint names a descendant (or, while one runs, a
 * session the read has not seen yet, which it may have just spawned), and
 * when this session's agent has answered or steered a sub-session. Waiting
 * items re-read their requests when the re-read tree shows their sub-session
 * moved on; the returned signal increments after an agent answer, so every
 * open item re-reads even if the tree read raced the answer.
 */
export function useDescendantRequestsRefresh(options: {
  client: EmbeddedSessionEventClientLike;
  workspaceId: string;
  sessionId: string;
  events: SessionEvent[];
  /** The session's descendants (its lineage children), never the session itself. */
  nodes: readonly LineageNode[];
  refreshLineage: () => Promise<void>;
}): number {
  const { client, workspaceId, sessionId, events, nodes, refreshLineage } = options;
  const { workspaceSessionListEvent } = useOpenGeni();
  const [signal, setSignal] = useState(0);
  const refreshLineageRef = useRef(refreshLineage);
  useEffect(() => {
    refreshLineageRef.current = refreshLineage;
  }, [refreshLineage]);
  const refreshTreeSoon = useDebouncedCallback(() => {
    void refreshLineageRef.current();
  }, 150);
  const refreshAllSoon = useDebouncedCallback(() => {
    void refreshLineageRef.current();
    setSignal((value) => value + 1);
  }, 150);

  const tree = useMemo(
    () => ({ ids: lineageSessionIds(nodes), running: descendantsRunning(nodes) }),
    [nodes],
  );
  const treeRef = useRef(tree);
  useEffect(() => {
    treeRef.current = tree;
  }, [tree]);

  useEffect(() => {
    const hint = workspaceSessionListEvent;
    if (!hint || hint.workspaceId !== workspaceId || !hint.available) return;
    // A hidden tab catches up through the lineage poll when it is shown again.
    if (document.visibilityState === "hidden") return;
    const current = treeRef.current;
    // This session's own spawns reach the tree through its feed; only a
    // running descendant can add a session the read has not seen yet.
    const unseen =
      current.running &&
      (hint.sessionIds ?? []).some((id) => id !== sessionId && !current.ids.has(id));
    if (hintTouchesTree(hint, current.ids) || unseen) refreshTreeSoon();
  }, [refreshTreeSoon, sessionId, workspaceId, workspaceSessionListEvent]);

  // An output carries only its call id: match it to the call that answered.
  const responseCallIds = useMemo(() => subSessionResponseCallIds(events), [events]);
  const matchResponse = useCallback(
    (event: SessionEvent) => isSubSessionResponseOutput(event, responseCallIds),
    [responseCallIds],
  );
  // The tree is read when the page opens, so answers already in the first
  // history page this session's feed loads are reflected; only later ones
  // trigger a re-read.
  const [history, setHistory] = useState<{ sessionId: string; through: number } | null>(null);
  const newest = events.at(-1);
  if (newest && newest.sessionId === sessionId && history?.sessionId !== sessionId) {
    setHistory({ sessionId, through: newest.sequence });
  }
  const readThrough = history?.sessionId === sessionId ? history.through : "reading";
  const onResponse = useCallback(() => refreshAllSoon(), [refreshAllSoon]);
  useSessionEventTrigger(client, workspaceId, sessionId, matchResponse, onResponse, {
    events,
    readThrough,
  });
  return signal;
}
