/**
 * Chat search across the person's workspaces, as the web command menu does it:
 * chat titles in this workspace and in the other workspaces they can open,
 * ranked by the same title rules, plus the workspaces whose names match.
 */
import {
  LOOSE_MATCH_BELOW,
  rankLabel,
  sessionDisplayTitle,
} from "@opengeni/react/session-list-model";
import type { OpenGeniClient, Session, Workspace } from "@opengeni/sdk";
import { useEffect, useState } from "react";

/** Other workspaces whose titles the server searches too. */
export const OTHER_WORKSPACES_SEARCHED = 9;
const CHAT_RESULT_LIMIT = 15;
const WORKSPACE_RESULT_LIMIT = 4;
/** A chat in another workspace ranks just below an equal match here. */
const ELSEWHERE_PENALTY = 10;
/** Rank for a chat the server matched on its first message rather than its title. */
const SERVER_ONLY_MATCH = 50;
const SEARCH_DEBOUNCE_MS = 150;

export interface ChatSearchHit {
  session: Session;
  workspaceId: string;
  /** True when the server matched it (title or first message), not only the local list. */
  fromServer: boolean;
}

/**
 * The workspaces to search: this one first, then the rest of its organization,
 * then the person's other organizations, as many as the search covers.
 */
export function workspacesToSearch(
  currentWorkspaceId: string | null,
  workspaces: readonly Workspace[],
): string[] {
  const current = workspaces.find((workspace) => workspace.id === currentWorkspaceId);
  const sameOrganization = workspaces.filter(
    (workspace) =>
      workspace.id !== currentWorkspaceId && workspace.accountId === current?.accountId,
  );
  const elsewhere = workspaces.filter(
    (workspace) =>
      workspace.id !== currentWorkspaceId && workspace.accountId !== current?.accountId,
  );
  const others = [...sameOrganization, ...elsewhere]
    .slice(0, OTHER_WORKSPACES_SEARCHED)
    .map((workspace) => workspace.id);
  return currentWorkspaceId ? [currentWorkspaceId, ...others] : others;
}

function updatedAtMs(session: Session): number {
  const at = Date.parse(session.updatedAt);
  return Number.isFinite(at) ? at : 0;
}

/**
 * Ranks chats and workspaces for what the person typed. Chats come from this
 * workspace's loaded list and from the server's title search in every searched
 * workspace; a chat appears once. Letters-in-order guesses only show when
 * nothing really matches.
 */
export function rankChatSearch(input: {
  query: string;
  currentWorkspaceId: string | null;
  /** This workspace's loaded chats (pins and recents). */
  local: readonly Session[];
  remote: readonly ChatSearchHit[];
  workspaces: readonly Workspace[];
}): { chats: ChatSearchHit[]; workspaces: Workspace[] } {
  const query = input.query.trim();
  if (!query) return { chats: [], workspaces: [] };
  const hits = new Map<string, ChatSearchHit>();
  if (input.currentWorkspaceId) {
    for (const session of input.local) {
      hits.set(session.id, {
        session,
        workspaceId: input.currentWorkspaceId,
        fromServer: false,
      });
    }
  }
  for (const hit of input.remote) {
    const known = hits.get(hit.session.id);
    hits.set(
      hit.session.id,
      known ? { ...hit, fromServer: known.fromServer || hit.fromServer } : hit,
    );
  }
  const chats: Array<{ hit: ChatSearchHit; rank: number; loose: boolean }> = [];
  for (const hit of hits.values()) {
    // Sub-agent chats open from their parent, as in the sidebar.
    if (hit.session.parentSessionId) continue;
    let rank = rankLabel(sessionDisplayTitle(hit.session), query);
    const loose = rank !== null && rank < LOOSE_MATCH_BELOW;
    if (rank === null && hit.fromServer) rank = SERVER_ONLY_MATCH;
    if (rank === null) continue;
    if (hit.session.pinned) rank += 5;
    if (hit.workspaceId !== input.currentWorkspaceId) rank -= ELSEWHERE_PENALTY;
    chats.push({ hit, rank, loose });
  }
  const workspaces: Array<{ workspace: Workspace; rank: number; loose: boolean }> = [];
  for (const workspace of input.workspaces) {
    if (workspace.id === input.currentWorkspaceId) continue;
    const rank = rankLabel(workspace.name, query);
    if (rank !== null) workspaces.push({ workspace, rank, loose: rank < LOOSE_MATCH_BELOW });
  }
  // Letters-in-order guesses only help when nothing really matches.
  const realMatch = chats.some((entry) => !entry.loose) || workspaces.some((entry) => !entry.loose);
  return {
    chats: chats
      .filter((entry) => !realMatch || !entry.loose)
      .sort((a, b) => b.rank - a.rank || updatedAtMs(b.hit.session) - updatedAtMs(a.hit.session))
      .slice(0, CHAT_RESULT_LIMIT)
      .map((entry) => entry.hit),
    workspaces: workspaces
      .filter((entry) => !realMatch || !entry.loose)
      .sort((a, b) => b.rank - a.rank)
      .slice(0, WORKSPACE_RESULT_LIMIT)
      .map((entry) => entry.workspace),
  };
}

/**
 * The server's title search in each workspace, side by side; each workspace's
 * matches join as they arrive. A failed workspace just adds nothing.
 */
export function useServerChatSearch(
  client: OpenGeniClient,
  workspaceIds: readonly string[],
  query: string,
): { query: string; hits: ChatSearchHit[]; loading: boolean } {
  const [state, setState] = useState<{ query: string; hits: ChatSearchHit[]; loading: boolean }>({
    query: "",
    hits: [],
    loading: false,
  });
  const searchKey = workspaceIds.join(",");
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed || !searchKey) {
      setState({ query: "", hits: [], loading: false });
      return;
    }
    setState((current) => ({ ...current, loading: true }));
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const targets = searchKey.split(",");
      let pending = targets.length;
      let first = true;
      const settle = (hits: ChatSearchHit[]) => {
        if (controller.signal.aborted) return;
        pending -= 1;
        const replace = first;
        first = false;
        setState((current) => ({
          query: trimmed,
          hits: replace || current.query !== trimmed ? hits : [...current.hits, ...hits],
          loading: pending > 0,
        }));
      };
      targets.forEach((workspaceId, index) => {
        client
          .listSessionPage(workspaceId, {
            search: trimmed,
            parentSessionId: null,
            // This workspace first and fullest; a few from each of the others.
            limit: index === 0 ? 20 : 6,
            signal: controller.signal,
          })
          .then((page) =>
            settle([
              // Pins come with every page; only the matched list counts as the server's match.
              ...page.pinned.map((session) => ({ session, workspaceId, fromServer: false })),
              ...page.sessions.map((session) => ({ session, workspaceId, fromServer: true })),
            ]),
          )
          .catch(() => settle([]));
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [client, searchKey, query]);
  return state;
}
