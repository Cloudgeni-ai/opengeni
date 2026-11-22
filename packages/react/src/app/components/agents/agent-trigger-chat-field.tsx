/**
 * Where a trigger's runs go: a new chat with the agent each run (the
 * default), one chat the trigger keeps, or an existing chat with this agent.
 * The existing chats are read only once that choice is made, and only chats
 * started with this agent are offered; a failed read says so.
 */
import { useEffect, useRef, useState } from "react";
import type { Agent, AgentChat } from "@opengeni/sdk";

import { userErrorText } from "../../../ui/api-error";
import { Field, FieldStack } from "../../../ui/field";
import { SelectMenu } from "../../../ui/select-menu";
import { useAppContext } from "../../app-context";
import { listAgentChats } from "../../lib/agent-chats";
import type { AgentTriggerChat } from "./agent-trigger-model";

type AgentChats =
  | { status: "loading" }
  | { status: "ready"; chats: AgentChat[] }
  | { status: "error"; message: string };

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
  const read = useAgentChats(workspaceId, agent, existing);
  const chats = read.result.status === "ready" ? read.result.chats : undefined;
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
          error={
            read.result.status === "error" ? (
              <>
                {`Couldn't load chats with ${agent.name}. ${read.result.message} `}
                <button type="button" className="og-link" onClick={read.retry}>
                  Try again
                </button>
              </>
            ) : (
              error
            )
          }
          hint={chats?.length === 0 ? `No chats with ${agent.name} yet.` : undefined}
        >
          <SelectMenu
            variant={(chats?.length ?? 0) > 8 ? "combobox" : "menu"}
            options={(chats ?? []).map((session) => ({
              value: session.sessionId,
              label: session.title?.trim() || "Untitled chat",
            }))}
            value={value.sessionId || null}
            onValueChange={(sessionId) => onChange({ mode: "existing_session", sessionId })}
            placeholder="Choose a chat"
            searchPlaceholder="Search chats"
            loading={read.result.status === "loading"}
            className="max-w-full"
          />
        </Field>
      ) : null}
    </FieldStack>
  );
}

/** This agent's chats, read once they are needed. */
function useAgentChats(
  workspaceId: string,
  agent: Pick<Agent, "id">,
  enabled: boolean,
): { result: AgentChats; retry: () => void } {
  const { client } = useAppContext();
  const [result, setResult] = useState<AgentChats>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  // Read once per agent (and per Try again), not each time the choice is made.
  const readFor = useRef<string | null>(null);
  const key = `${workspaceId}:${agent.id}:${attempt}`;
  useEffect(() => {
    if (!enabled || readFor.current === key) return;
    readFor.current = key;
    setResult({ status: "loading" });
    const abort = new AbortController();
    let done = false;
    listAgentChats(client, workspaceId, agent.id, { signal: abort.signal })
      .then(
        (chats) => !abort.signal.aborted && setResult({ status: "ready", chats }),
        (caught: unknown) =>
          !abort.signal.aborted && setResult({ status: "error", message: userErrorText(caught) }),
      )
      .finally(() => {
        done = true;
      });
    return () => {
      // An interrupted read starts again next time.
      if (done) return;
      abort.abort();
      if (readFor.current === key) readFor.current = null;
    };
  }, [agent.id, client, enabled, key, workspaceId]);
  return { result, retry: () => setAttempt((value) => value + 1) };
}
