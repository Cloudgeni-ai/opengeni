// Keeps a parent session's view of its sub-sessions' waits current: the
// workspace's live session-list hints (the same ones that move the orange dot
// in the rail) and the parent agent answering a sub-session itself both
// re-read the tree at once, so a card appears and clears without waiting for
// the lineage poll.
import type { LineageNode, SessionEvent } from "@opengeni/sdk";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { EmbeddedSessionEventClientLike } from "../../client";
import { useDebouncedCallback, useSessionEventTrigger } from "../../hooks/internal";
import { useOpenGeni } from "../../session-context";
import {
  hintTouchesTree,
  isSubSessionResponseEvent,
  lineageSessionIds,
} from "./descendant-requests";

/** Lineage poll while live list hints arrive, and the fallback without them. */
export const LINEAGE_POLL_WITH_HINTS_MS = 30_000;
export const LINEAGE_POLL_WITHOUT_HINTS_MS = 15_000;

/** How often to re-read the lineage: hints make a fast poll unnecessary. */
export function useLineagePollInterval(workspaceId: string): number {
  const { workspaceSessionListEvent } = useOpenGeni();
  const live =
    workspaceSessionListEvent?.workspaceId === workspaceId &&
    workspaceSessionListEvent.available === true;
  return live ? LINEAGE_POLL_WITH_HINTS_MS : LINEAGE_POLL_WITHOUT_HINTS_MS;
}

function treeRuns(nodes: readonly LineageNode[]): boolean {
  return nodes.some((node) => node.session.status === "running" || treeRuns(node.children));
}

/**
 * Re-read the lineage when a hint names this session or a descendant (or a
 * running tree may have spawned one the read has not seen yet), and when this
 * session's agent answers or steers a sub-session. Returns a signal that
 * increments on each such change so open cards re-read their requests too.
 */
export function useDescendantRequestsRefresh(options: {
  client: EmbeddedSessionEventClientLike;
  workspaceId: string;
  sessionId: string;
  events: SessionEvent[];
  nodes: readonly LineageNode[];
  sessionRunning: boolean;
  refreshLineage: () => Promise<void>;
}): number {
  const { client, workspaceId, sessionId, events, nodes, sessionRunning, refreshLineage } = options;
  const { workspaceSessionListEvent } = useOpenGeni();
  const [signal, setSignal] = useState(0);
  const refreshLineageRef = useRef(refreshLineage);
  useEffect(() => {
    refreshLineageRef.current = refreshLineage;
  }, [refreshLineage]);
  const refreshSoon = useDebouncedCallback(() => {
    void refreshLineageRef.current();
    setSignal((value) => value + 1);
  }, 150);

  const tree = useMemo(() => {
    const ids = lineageSessionIds(nodes);
    ids.add(sessionId);
    return { ids, running: sessionRunning || treeRuns(nodes) };
  }, [nodes, sessionId, sessionRunning]);
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
    const unseen = (hint.sessionIds ?? []).some((id) => !current.ids.has(id));
    if (hintTouchesTree(hint, current.ids) || (current.running && unseen)) refreshSoon();
  }, [refreshSoon, workspaceId, workspaceSessionListEvent]);

  const onResponse = useCallback(() => refreshSoon(), [refreshSoon]);
  useSessionEventTrigger(client, workspaceId, sessionId, isSubSessionResponseEvent, onResponse, {
    events,
  });
  return signal;
}
