import type { LatencyMode, ReasoningEffort } from "@opengeni/sdk";
import { useCallback, useRef, useState } from "react";
import { useAppContext } from "../app-context";
import { useNavigate } from "./navigation";
import { toast } from "./toast";

export type ContinueInNewChatChoice = {
  model: string;
  reasoningEffort?: ReasoningEffort | undefined;
  latencyMode?: LatencyMode | undefined;
};

/**
 * Continue a chat in a new chat on another model and open it. Used when the
 * chat can't take that model, for example a chat frozen on Codex. The server
 * seeds the new chat from this one and links it back; this chat is unchanged.
 */
export function useContinueInNewChat(session: { id: string; workspaceId: string }) {
  const context = useAppContext();
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const continueWith = useCallback(
    async (choice: ContinueInNewChatChoice) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setPending(true);
      try {
        const next = await context.client.continueSessionInNewChat(
          session.workspaceId,
          session.id,
          {
            idempotencyKey: crypto.randomUUID(),
            model: choice.model,
            ...(choice.reasoningEffort ? { reasoningEffort: choice.reasoningEffort } : {}),
            ...(choice.latencyMode ? { latencyMode: choice.latencyMode } : {}),
          },
        );
        void navigate({
          to: "/workspaces/$workspaceId/sessions/$sessionId",
          params: { workspaceId: next.workspaceId, sessionId: next.id },
        });
      } catch (error) {
        toast.error("Couldn't start a new chat", {
          description: error instanceof Error ? error.message : undefined,
        });
      } finally {
        inFlight.current = false;
        setPending(false);
      }
    },
    [context.client, navigate, session.id, session.workspaceId],
  );
  return { continueWith, pending };
}
