/**
 * Where a trigger's runs go: a new chat with the agent each run (the
 * default), one chat the trigger keeps, or an existing chat with this agent.
 * The existing chats are read only once that choice is made, and only chats
 * started with this agent are offered.
 */
import { useEffect, useState } from "react";
import type { Agent } from "@opengeni/sdk";

type AgentChat = { id: string; title?: string | null | undefined };

import { Field, FieldStack } from "../../../ui/field";
import { SelectMenu } from "../../../ui/select-menu";
import { useAppContext } from "../../app-context";
import { agentTriggerChats, type AgentTriggerChat } from "./agent-trigger-model";

const MODES: { value: AgentTriggerChat["mode"]; label: string }[] = [
  { value: "new_session_per_run", label: "New chat each run" },
  { value: "reusable_session", label: "One chat for this trigger" },
  { value: "existing_session", label: "An existing chat" },
];

export function AgentTriggerChatField({
  agent,
  workspaceId,
  value,
  onChange,
  error,
}: {
  agent: Pick<Agent, "id" | "name">;
  workspaceId: string;
  value: AgentTriggerChat;
  onChange: (chat: AgentTriggerChat) => void;
  error?: string | undefined;
}) {
  const existing = value.mode === "existing_session";
  const chats = useAgentChats(workspaceId, agent, existing);
  return (
    <FieldStack>
      <Field label="Chat">
        <SelectMenu
          options={MODES}
          value={value.mode}
          onValueChange={(mode) =>
            onChange(
              mode === "existing_session"
                ? { mode, sessionId: "" }
                : { mode: mode as "new_session_per_run" | "reusable_session" },
            )
          }
          className="max-w-full"
        />
      </Field>
      {existing ? (
        <Field
          label="Existing chat"
          error={error}
          hint={chats?.length === 0 ? `No chats with ${agent.name} yet.` : undefined}
        >
          <SelectMenu
            variant={(chats?.length ?? 0) > 8 ? "combobox" : "menu"}
            options={(chats ?? []).map((session) => ({
              value: session.id,
              label: session.title?.trim() || "Untitled chat",
            }))}
            value={value.sessionId || null}
            onValueChange={(sessionId) => onChange({ mode: "existing_session", sessionId })}
            placeholder="Choose a chat"
            searchPlaceholder="Search chats"
            loading={chats === undefined}
            className="max-w-full"
          />
        </Field>
      ) : null}
    </FieldStack>
  );
}

/** This agent's chats, read once they are needed; an unreadable list reads as none. */
function useAgentChats(
  workspaceId: string,
  agent: Pick<Agent, "id">,
  enabled: boolean,
): AgentChat[] | undefined {
  const { client } = useAppContext();
  const [chats, setChats] = useState<AgentChat[] | undefined>(undefined);
  useEffect(() => {
    if (!enabled || chats !== undefined) return;
    let live = true;
    client.listSessions(workspaceId, { limit: 200 }).then(
      (sessions) => live && setChats(agentTriggerChats(agent, sessions)),
      () => live && setChats([]),
    );
    return () => {
      live = false;
    };
  }, [agent, chats, client, enabled, workspaceId]);
  return chats;
}
