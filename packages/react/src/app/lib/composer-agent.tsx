/**
 * The agent a new chat starts with, as the new-chat page uses it: `?agent=`
 * (or an older `?botTemplateId=` link) loads it, its First message fills the
 * composer, and Send waits until it is ready or says why it can't start.
 *
 * The First message this page put in the composer stays out of the saved
 * draft until the person changes it. The saved draft follows them to other
 * tabs and devices, where an untouched First message without its agent would
 * otherwise start an ordinary chat.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { Agent } from "@opengeni/sdk";

import { userErrorText } from "../../ui/api-error";
import { useAppContext } from "../app-context";
import type { ComposerAgentSelection } from "../components/agents/composer-agent-chip";
import { agentAvatar } from "./agent-avatar";
import { toast } from "./toast";

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
  /** The composer text the saved draft keeps: none while it is the untouched First message. */
  draftText: string;
  /** The person chose who can see the chat; their choice stays when the agent changes. */
  visibilityChosen: () => void;
  /** The First message this page put in the composer, kept by useAgentFirstMessage. */
  prefill: { text: string | null; set: Dispatch<SetStateAction<string | null>> };
};

export function useComposerAgent({
  workspaceId,
  agentId,
  message,
  canCreatePrivateChat,
  visibility,
  setVisibility,
}: {
  workspaceId: string;
  /** `?agent=` (or `?botTemplateId=`); undefined for Opengeni. */
  agentId: string | undefined;
  /** The composer's text, for what the saved draft keeps. */
  message: string;
  /** Whether this workspace can start Only me chats; null until known. */
  canCreatePrivateChat: boolean | null;
  visibility: Visibility;
  setVisibility: (visibility: Visibility) => void;
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
        if (!live) return;
        const reason = userErrorText(error);
        setLoaded({ id: agentId, kind: "error", message: reason });
        toast.error("Couldn't open the agent", { description: reason });
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
    if (restore !== visibility) setVisibility(restore);
  }, [canCreatePrivateChat, loading, onlyMe, setVisibility, visibility]);
  const visibilityChosen = useCallback(() => {
    restoreVisibilityRef.current = null;
  }, []);

  // The First message this page put in the composer (see useAgentFirstMessage).
  const [prefilled, setPrefilled] = useState<string | null>(null);
  const draftText = prefilled !== null && message === prefilled ? "" : message;
  return {
    agentId,
    selection,
    agent,
    loading,
    blocker,
    onlyMe,
    draftText,
    visibilityChosen,
    prefill: { text: prefilled, set: setPrefilled },
  };
}

/**
 * The chosen agent's First message in the composer: it fills an empty
 * composer once the saved draft has loaded (so the draft can't overwrite it),
 * is replaced when another agent is chosen, and goes when the person goes
 * back to Opengeni, unless they changed it. Text they typed themselves stays;
 * they can still start the chat with it.
 */
export function useAgentFirstMessage(
  composerAgent: ComposerAgent,
  {
    message,
    setMessage,
    draftLoading,
  }: {
    message: string;
    setMessage: Dispatch<SetStateAction<string>>;
    /** The saved draft is still loading. */
    draftLoading: boolean;
  },
): void {
  const { agentId, agent: ready } = composerAgent;
  const setPrefilled = composerAgent.prefill.set;
  const prefilledRef = useRef<string | null>(null);
  const prefilledForRef = useRef<string | null>(null);
  const fill = useCallback(
    (text: string) => {
      prefilledRef.current = text || null;
      setPrefilled(text || null);
      setMessage(text);
    },
    [setMessage, setPrefilled],
  );
  useEffect(() => {
    if (!ready || draftLoading) return;
    if (prefilledForRef.current === ready.id) return;
    prefilledForRef.current = ready.id;
    const firstMessage = ready.firstMessage;
    if (
      message.trim().length === 0 ||
      message === firstMessage ||
      message === prefilledRef.current
    ) {
      // Switching agents replaces the previous one's untouched First message.
      if (firstMessage || prefilledRef.current !== null) fill(firstMessage);
    } else if (firstMessage) {
      toast.info("Kept your unsent message", {
        description: `Clear it to use ${ready.name}'s first message instead.`,
        action: { label: "Use first message", onClick: () => fill(firstMessage) },
      });
    }
  }, [draftLoading, fill, message, ready]);
  // Back to Opengeni: an untouched First message goes too.
  useEffect(() => {
    if (agentId) return;
    prefilledForRef.current = null;
    const text = prefilledRef.current;
    if (text === null) return;
    prefilledRef.current = null;
    setPrefilled(null);
    setMessage((value) => (value === text ? "" : value));
  }, [agentId, setMessage, setPrefilled]);
}
