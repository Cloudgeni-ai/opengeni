/**
 * Agents as the app reads them. An agent is a name, an icon and what it helps
 * with, standing Instructions every one of its chats follows, and an optional
 * Memory. It lives in one workspace and is Only me or shared with
 * everyone there; it can also be available in Slack. Bot templates and Slack
 * agents became agents with the same ids, so `?botTemplateId=` links still
 * start a chat with one.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  BotTemplateFile,
  PortableSessionAvatar,
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
import { saveBlob } from "./save-blob";

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
  // Another list (All or Yours, another workspace) starts empty rather than
  // showing the previous one under the new heading.
  const listKey = `${workspaceId}:${filter}`;
  const [shownKey, setShownKey] = useState(listKey);
  if (shownKey !== listKey) {
    setShownKey(listKey);
    setAgents(undefined);
    setError(null);
  }
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

/** One agent with its Instructions. */
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
  // Each read of the first page starts a generation; a "Show more" from an
  // earlier one (another filter) is dropped when it answers.
  const generation = useRef(0);
  useEffect(() => {
    let live = true;
    generation.current += 1;
    setChats(undefined);
    setCursor(null);
    setError(null);
    setLoadingMore(false);
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
          const started = generation.current;
          setLoadingMore(true);
          client
            .listAgentChats(workspaceId, agentId, { filter, cursor, limit: AGENT_CHATS_PAGE })
            .then(
              (page) => {
                if (generation.current !== started) return;
                setChats((current) => [...(current ?? []), ...page.chats]);
                setCursor(page.nextCursor);
              },
              (reason: unknown) => {
                if (generation.current === started) setError(asError(reason));
              },
            )
            .finally(() => {
              if (generation.current === started) setLoadingMore(false);
            });
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

export const AGENT_FILE_FORMAT = "opengeni.agent";

/**
 * An agent as a file, to bring it to another workspace: what it is and what it
 * follows, without ids, owner, chats, Memory contents or Slack. An image
 * icon becomes the name's initials.
 */
export type AgentFile = {
  format: typeof AGENT_FILE_FORMAT;
  version: 1;
  name: string;
  description: string;
  avatar: CreateAgentRequest["avatar"];
  instructions: string;
  memoryEnabled: boolean;
  /** Who can use it; an import keeps an Only me agent Only me where it can. */
  visibility: "private" | "workspace";
};

export function agentFile(agent: Agent): AgentFile {
  return {
    format: AGENT_FILE_FORMAT,
    version: 1,
    name: agent.name,
    description: agent.description,
    avatar: agent.avatar && agent.avatar.kind !== "image" ? agent.avatar : null,
    instructions: agent.instructions,
    memoryEnabled: agent.memory.enabled,
    visibility: agent.visibility,
  };
}

export function agentFileName(agent: Pick<Agent, "name">): string {
  const slug = agent.name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${slug || "agent"}.agent.json`;
}

/** Download an agent as a file someone can import into their workspace. */
export function downloadAgentFile(agent: Agent): void {
  const blob = new Blob([`${JSON.stringify(agentFile(agent), null, 2)}\n`], {
    type: "application/json",
  });
  saveBlob(blob, agentFileName(agent));
}

const NOT_AN_AGENT = "This file isn't an agent. Choose an .agent.json or .bot.json file.";
const UNREADABLE = "This version can't read this file. Export it again, then import that file.";

function optionalText(value: unknown): string | undefined | null {
  return value === undefined ? undefined : typeof value === "string" ? value : null;
}

/**
 * The create request in an `.agent.json` file, or in an older bot template's
 * `.bot.json` (its setup text becomes the Instructions), or why it isn't one.
 * An older file's First message is sent as is; the server joins it to the
 * Instructions.
 * Lengths are left to the server, which says what it can't take.
 */
export function parseAgentFile(
  text: string,
): { ok: true; request: CreateAgentRequest } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: NOT_AN_AGENT };
  }
  if (raw !== null && typeof raw === "object" && "format" in raw) {
    const file = raw as Record<string, unknown>;
    if (file.format === AGENT_FILE_FORMAT) {
      if (file.version !== 1) return { ok: false, error: UNREADABLE };
      const description = optionalText(file.description);
      const instructions = optionalText(file.instructions);
      const firstMessage = optionalText(file.firstMessage);
      const avatar =
        file.avatar === undefined || file.avatar === null
          ? null
          : PortableSessionAvatar.safeParse(file.avatar);
      if (
        typeof file.name !== "string" ||
        description === null ||
        instructions === null ||
        firstMessage === null ||
        (file.memoryEnabled !== undefined && typeof file.memoryEnabled !== "boolean") ||
        (file.visibility !== undefined &&
          file.visibility !== "private" &&
          file.visibility !== "workspace") ||
        (avatar !== null && !avatar.success)
      ) {
        return { ok: false, error: UNREADABLE };
      }
      return {
        ok: true,
        request: {
          name: file.name,
          ...(description !== undefined ? { description } : {}),
          avatar: avatar?.success ? avatar.data : null,
          ...(instructions !== undefined ? { instructions } : {}),
          ...(firstMessage !== undefined ? { firstMessage } : {}),
          ...(typeof file.memoryEnabled === "boolean" ? { memoryEnabled: file.memoryEnabled } : {}),
          ...(file.visibility === "private" ? { visibility: "private" as const } : {}),
        },
      };
    }
  }
  const parsed = BotTemplateFile.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: raw !== null && typeof raw === "object" && "format" in raw ? UNREADABLE : NOT_AN_AGENT,
    };
  }
  const file = parsed.data;
  return {
    ok: true,
    request: {
      name: file.name,
      description: file.description,
      avatar: file.avatar,
      instructions: file.setupInstructions,
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
