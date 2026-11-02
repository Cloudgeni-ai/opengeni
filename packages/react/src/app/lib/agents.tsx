/**
 * Agents as the app reads them. An agent is a name, an icon and what it helps
 * with, standing Instructions every one of its chats follows, an optional
 * First message the app puts in the composer when a chat starts here, and an
 * optional Memory. It lives in one workspace and is Only me or shared with
 * everyone there; it can also be available in Slack. Bot templates and Slack
 * agents became agents with the same ids, so `?botTemplateId=` links still
 * start a chat with one.
 */
import { useCallback, useEffect, useState } from "react";
import {
  BotTemplateFile,
  type Agent,
  type AgentChat,
  type AgentChatsFilter,
  type AgentListFilter,
  type AgentSummary,
  type CreateAgentRequest,
  type ListAgentSlackInstallsResponse,
} from "@opengeni/contracts";

import { apiErrorFacts } from "../../ui/api-error";
import { useAppContext } from "../app-context";

export type AgentsState = {
  /** Undefined until the first read settles. */
  agents: AgentSummary[] | undefined;
  /** False on a server without agents. */
  supported: boolean;
  error: Error | null;
  reload: () => void;
  /** Shows a change made here without reading the list again. */
  replace: (update: (current: AgentSummary[]) => AgentSummary[]) => void;
};

function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

/** The agents the reader can use in this workspace (or only theirs), read once per mount. */
export function useAgents(
  workspaceId: string,
  options: { filter?: AgentListFilter | undefined; enabled?: boolean | undefined } = {},
): AgentsState {
  const { client } = useAppContext();
  const enabled = options.enabled ?? true;
  const filter = options.filter ?? "all";
  const [agents, setAgents] = useState<AgentSummary[] | undefined>(undefined);
  const [supported, setSupported] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    client.listAgents(workspaceId, { filter }).then(
      (next) => {
        if (!live) return;
        setAgents(next);
        setSupported(true);
        setError(null);
      },
      (reason: unknown) => {
        if (!live) return;
        if (apiErrorFacts(reason).status === 404) {
          setSupported(false);
          setAgents([]);
          return;
        }
        setError(asError(reason));
        setAgents((current) => current ?? []);
      },
    );
    return () => {
      live = false;
    };
  }, [attempt, client, enabled, filter, workspaceId]);
  const reload = useCallback(() => setAttempt((value) => value + 1), []);
  const replace = useCallback(
    (update: (current: AgentSummary[]) => AgentSummary[]) =>
      setAgents((current) => update(current ?? [])),
    [],
  );
  return { agents, supported, error, reload, replace };
}

export type AgentState = {
  /** Undefined while loading; null when it is gone or hidden from the reader. */
  agent: Agent | null | undefined;
  error: Error | null;
  reload: () => void;
  /** Shows a saved change without reading the agent again. */
  set: (agent: Agent) => void;
};

/** One agent with its Instructions and First message. */
export function useAgent(workspaceId: string, agentId: string | null): AgentState {
  const { client } = useAppContext();
  const [agent, setAgent] = useState<Agent | null | undefined>(undefined);
  const [error, setError] = useState<Error | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!agentId) {
      setAgent(null);
      return;
    }
    let live = true;
    setError(null);
    client.getAgent(workspaceId, agentId).then(
      (next) => {
        if (live) setAgent(next);
      },
      (reason: unknown) => {
        if (!live) return;
        if (apiErrorFacts(reason).status === 404) {
          setAgent(null);
          return;
        }
        setError(asError(reason));
        setAgent((current) => current ?? null);
      },
    );
    return () => {
      live = false;
    };
  }, [agentId, attempt, client, workspaceId]);
  const reload = useCallback(() => setAttempt((value) => value + 1), []);
  return { agent, error, reload, set: setAgent };
}

export type AgentChatsState = {
  chats: AgentChat[] | undefined;
  error: Error | null;
  /** Present while older chats remain. */
  loadMore: (() => void) | null;
  loadingMore: boolean;
  reload: () => void;
};

const AGENT_CHATS_PAGE = 20;

/** The agent's chats, newest first: the reader's own, or everyone's they can open. */
export function useAgentChats(
  workspaceId: string,
  agentId: string,
  filter: AgentChatsFilter,
): AgentChatsState {
  const { client } = useAppContext();
  const [chats, setChats] = useState<AgentChat[] | undefined>(undefined);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setChats(undefined);
    setError(null);
    client.listAgentChats(workspaceId, agentId, { filter, limit: AGENT_CHATS_PAGE }).then(
      (page) => {
        if (!live) return;
        setChats(page.chats);
        setCursor(page.nextCursor);
      },
      (reason: unknown) => {
        if (!live) return;
        setError(asError(reason));
        setChats([]);
        setCursor(null);
      },
    );
    return () => {
      live = false;
    };
  }, [agentId, attempt, client, filter, workspaceId]);
  const reload = useCallback(() => setAttempt((value) => value + 1), []);
  const loadMore =
    cursor && !loadingMore
      ? () => {
          setLoadingMore(true);
          client
            .listAgentChats(workspaceId, agentId, { filter, cursor, limit: AGENT_CHATS_PAGE })
            .then(
              (page) => {
                setChats((current) => [...(current ?? []), ...page.chats]);
                setCursor(page.nextCursor);
              },
              (reason: unknown) => setError(asError(reason)),
            )
            .finally(() => setLoadingMore(false));
        }
      : null;
  return { chats, error, loadMore, loadingMore, reload };
}

export type AgentSlackInstallsState = {
  /** Undefined while loading. */
  value: ListAgentSlackInstallsResponse | undefined;
  error: Error | null;
  reload: () => void;
  set: (value: ListAgentSlackInstallsResponse) => void;
};

/** The connected Slack workspaces the agent can be available in. */
export function useAgentSlackInstalls(
  workspaceId: string,
  agentId: string,
  enabled = true,
): AgentSlackInstallsState {
  const { client } = useAppContext();
  const [value, setValue] = useState<ListAgentSlackInstallsResponse | undefined>(undefined);
  const [error, setError] = useState<Error | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    setError(null);
    client.listAgentSlackInstalls(workspaceId, agentId).then(
      (next) => {
        if (live) setValue(next);
      },
      (reason: unknown) => {
        if (!live) return;
        setError(asError(reason));
        setValue((current) => current ?? { installs: [], routingEnabled: true });
      },
    );
    return () => {
      live = false;
    };
  }, [agentId, attempt, client, enabled, workspaceId]);
  const reload = useCallback(() => setAttempt((count) => count + 1), []);
  return { value, error, reload, set: setValue };
}

/** The reason code an agent refusal carries in `details.code`, such as `agent_slack_name_taken`. */
export function agentErrorCode(error: unknown): string | null {
  if (error === null || typeof error !== "object") return null;
  const details = (error as { details?: unknown }).details;
  if (details === null || typeof details !== "object") return null;
  const code = (details as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/** The create request in a `.bot.json` file, or why it isn't one. Its setup text becomes the First message. */
export function parseAgentFile(
  text: string,
): { ok: true; request: CreateAgentRequest } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "This file isn't an agent. Choose a .bot.json file." };
  }
  const parsed = BotTemplateFile.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: "This version can't read this file. Export it again, then import that file.",
    };
  }
  const file = parsed.data;
  return {
    ok: true,
    request: {
      name: file.name,
      description: file.description,
      avatar: file.avatar,
      firstMessage: file.setupInstructions,
    },
  };
}

/** How names compare: a clash hint, the same rule the server stores. */
export function agentNameKey(name: string): string {
  return name.trim().toLowerCase();
}

/** Names more than one agent in the list shares, in the order they first appear. */
export function duplicateAgentNames(agents: readonly Pick<AgentSummary, "name">[]): string[] {
  const seen = new Map<string, { name: string; count: number }>();
  for (const agent of agents) {
    const key = agentNameKey(agent.name);
    const entry = seen.get(key);
    if (entry) entry.count += 1;
    else seen.set(key, { name: agent.name.trim(), count: 1 });
  }
  return [...seen.values()].filter((entry) => entry.count > 1).map((entry) => entry.name);
}

/**
 * The First message this page put in a new chat's composer, kept per
 * workspace for the browser session. After a reload without the agent in the
 * URL, a composer that still holds exactly that text is cleared instead of
 * starting an ordinary chat with it.
 */
const PREFILL_KEY = "opengeni.agentFirstMessage.";

export function rememberAgentPrefill(workspaceId: string, text: string | null): void {
  try {
    if (text === null) window.sessionStorage.removeItem(PREFILL_KEY + workspaceId);
    else window.sessionStorage.setItem(PREFILL_KEY + workspaceId, text);
  } catch {
    // Storage can be unavailable (private mode); the prefill just isn't remembered.
  }
}

export function rememberedAgentPrefill(workspaceId: string): string | null {
  try {
    return window.sessionStorage.getItem(PREFILL_KEY + workspaceId);
  } catch {
    return null;
  }
}
