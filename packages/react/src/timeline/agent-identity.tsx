import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { TimelineItem } from "./types";

/**
 * Host lookup from a session id to its current display title. Return null or
 * undefined when the session is unknown; the timeline then falls back to the
 * title given at spawn time, then to generic copy.
 */
export type ResolveSessionTitle = (sessionId: string) => string | null | undefined;

type AgentIdentity = {
  /** The best known display title for an agent session, or null. */
  titleFor: (sessionId: string | null | undefined) => string | null;
  onOpenSession?: ((sessionId: string) => void) | undefined;
};

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AGENT_TITLE_MAX_LENGTH = 80;

/** Typed routing coordinates only: a session reference is always a UUID. */
export function isSessionId(value: string | null | undefined): value is string {
  return typeof value === "string" && SESSION_ID.test(value);
}

/** One bounded display line, or null for an empty or non-string title. */
export function displayAgentTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const title = value.replace(/\s+/g, " ").trim();
  if (!title) return null;
  return title.length > AGENT_TITLE_MAX_LENGTH
    ? `${title.slice(0, AGENT_TITLE_MAX_LENGTH - 1).trimEnd()}…`
    : title;
}

const AgentIdentityContext = createContext<AgentIdentity>({ titleFor: () => null });

export function useAgentIdentity(): AgentIdentity {
  return useContext(AgentIdentityContext);
}

/**
 * Names the agents a timeline talks to. The host resolver wins (it follows
 * renames); otherwise the title the manager passed when spawning that session
 * in this same timeline is used.
 */
export function AgentIdentityProvider({
  items,
  resolveSessionTitle,
  onOpenSession,
  children,
}: {
  items: readonly TimelineItem[];
  resolveSessionTitle?: ResolveSessionTitle | undefined;
  onOpenSession?: ((sessionId: string) => void) | undefined;
  children: ReactNode;
}) {
  // Streaming replaces the item array on every delta; key the index by its
  // content so the context (and every agent row) only changes with a title.
  const spawnTitleKey = JSON.stringify(
    items.flatMap((item) =>
      item.kind === "worker" &&
      item.action === "spawn" &&
      isSessionId(item.workerSessionId) &&
      item.title
        ? [[item.workerSessionId.toLowerCase(), item.title]]
        : [],
    ),
  );
  const value = useMemo<AgentIdentity>(() => {
    const spawnTitles = new Map<string, string>(JSON.parse(spawnTitleKey) as [string, string][]);
    return {
      titleFor: (sessionId) => {
        if (!isSessionId(sessionId)) return null;
        return (
          displayAgentTitle(resolveSessionTitle?.(sessionId)) ??
          displayAgentTitle(spawnTitles.get(sessionId.toLowerCase())) ??
          null
        );
      },
      onOpenSession,
    };
  }, [spawnTitleKey, resolveSessionTitle, onOpenSession]);
  return <AgentIdentityContext.Provider value={value}>{children}</AgentIdentityContext.Provider>;
}
