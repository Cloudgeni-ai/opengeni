/**
 * The agent a new chat starts with, as the new-chat page uses it: `?agent=`
 * (or an older `?botTemplateId=` link) loads it and selects it, the composer
 * stays as it is (an agent's Instructions say what it does, so there is
 * nothing to fill in), and Send waits until it is ready or says why it can't
 * start.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Agent } from "@opengeni/sdk";

import { userErrorText } from "../../ui/api-error";
import { useAppContext } from "../app-context";
import type { ComposerAgentSelection } from "../components/agents/composer-agent-chip";
import { agentAvatar } from "./agent-avatar";

export const AGENT_ONLY_ME_UNAVAILABLE =
  "Only me agents need Only me chats, which aren't available here.";
export const AGENT_ONLY_ME_CHAT = "Only me agents have Only me chats.";

type Visibility = "private" | "workspace";

type Loaded =
  | { id: string; kind: "loading" }
  | { id: string; kind: "ready"; agent: Agent }
  | { id: string; kind: "error"; message: string };

export type ComposerAgent = {
  /** `?agent=`; undefined for Opengeni. */
  agentId: string | undefined;
  /** What the chip shows; null for Opengeni itself. */
  selection: ComposerAgentSelection | null;
  /** The agent the chat starts with, once it is loaded and can start a chat here. */
  agent: Agent | null;
  /** Still loading (the agent, or whether Only me chats are possible): Send waits. */
  loading: boolean;
  /** Why a chat can't start with this agent; null when it can, or for Opengeni. */
  blocker: string | null;
  /** The chosen agent's chats are Only me, so the chat can't be shared. */
  onlyMe: boolean;
  /** The person chose who can see the chat; their choice stays when the agent changes. */
  visibilityChosen: () => void;
};

export function useComposerAgent({
  workspaceId,
  agentId,
  canCreatePrivateChat,
  visibility,
  setVisibility,
  keepOnlyMe = false,
}: {
  workspaceId: string;
  /** `?agent=` (or `?botTemplateId=`); undefined for Opengeni. */
  agentId: string | undefined;
  /** Whether this workspace can start Only me chats; null until known. */
  canCreatePrivateChat: boolean | null;
  visibility: Visibility;
  setVisibility: (visibility: Visibility) => void;
  /** Something else needs the chat Only me (an Only me project): never restore a shared one. */
  keepOnlyMe?: boolean;
}): ComposerAgent {
  const { client } = useAppContext();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  useEffect(() => {
    if (!agentId) {
      setLoaded(null);
      return;
    }
    let live = true;
    setLoaded({ id: agentId, kind: "loading" });
    client.getAgent(workspaceId, agentId).then(
      (agent) => {
        if (live) setLoaded({ id: agentId, kind: "ready", agent });
      },
      (error: unknown) => {
        // The chip and the setup strip show why; no toast on top.
        if (live) setLoaded({ id: agentId, kind: "error", message: userErrorText(error) });
      },
    );
    return () => {
      live = false;
    };
  }, [agentId, client, workspaceId]);

  // Until the effect above catches up, an older agent's result is not this one's.
  const current = agentId && loaded?.id === agentId ? loaded : null;
  const ready = current?.kind === "ready" ? current.agent : null;
  const onlyMe = ready?.visibility === "private";
  const privateUnknown = onlyMe && canCreatePrivateChat === null;
  const privateUnavailable = onlyMe && canCreatePrivateChat === false;
  const loading =
    Boolean(agentId) && (current === null || current.kind === "loading" || privateUnknown);
  const blocker =
    current?.kind === "error"
      ? current.message
      : privateUnavailable
        ? AGENT_ONLY_ME_UNAVAILABLE
        : null;
  const agent = ready && !privateUnavailable && !privateUnknown ? ready : null;

  const selection: ComposerAgentSelection | null = !agentId
    ? null
    : current === null || current.kind === "loading"
      ? { kind: "loading", id: agentId }
      : current.kind === "error"
        ? { kind: "error", id: agentId, message: current.message }
        : privateUnavailable
          ? {
              kind: "error",
              id: agentId,
              name: current.agent.name,
              avatar: agentAvatar(current.agent),
              message: AGENT_ONLY_ME_UNAVAILABLE,
            }
          : {
              kind: "ready",
              id: agentId,
              name: current.agent.name,
              avatar: agentAvatar(current.agent),
            };

  // An Only me agent's chats are Only me (the server refuses a shared one).
  // Choosing one makes the chat Only me; going back to Opengeni or a shared
  // agent restores what it was, unless the person chose since.
  const restoreVisibilityRef = useRef<Visibility | null>(null);
  useEffect(() => {
    if (onlyMe) {
      if (canCreatePrivateChat === true && visibility !== "private") {
        restoreVisibilityRef.current ??= visibility;
        setVisibility("private");
      }
      return;
    }
    // While another agent loads, wait: it may be Only me too.
    if (loading) return;
    const restore = restoreVisibilityRef.current;
    if (restore === null) return;
    restoreVisibilityRef.current = null;
    if (restore !== visibility && !(keepOnlyMe && visibility === "private")) setVisibility(restore);
  }, [canCreatePrivateChat, keepOnlyMe, loading, onlyMe, setVisibility, visibility]);
  const visibilityChosen = useCallback(() => {
    restoreVisibilityRef.current = null;
  }, []);

  return {
    agentId,
    selection,
    agent,
    loading,
    blocker,
    onlyMe,
    visibilityChosen,
  };
}
