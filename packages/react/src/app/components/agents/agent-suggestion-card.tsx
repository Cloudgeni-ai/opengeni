import type { Session, SessionAgentSuggestion } from "@opengeni/sdk";
import { SparkleIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../../../ui/button";
import { agentAvatar, sessionAgentRef } from "../../../session-avatar-model";
import {
  agentSuggestionDismissed,
  dismissAgentSuggestion,
} from "../../lib/agent-suggestion-dismissal";
import { useNavigate } from "../../lib/navigation";
import { SessionAvatar } from "../session/session-avatar";

/**
 * The agent's own suggestion (`agent_suggest`), as a card under the chat.
 * `create`: make an agent from this chat; the "Make this an agent" form opens
 * filled in with the name, icon, description and Instructions
 * the agent drafted. `reuse`: start a chat with the agent that already does
 * this work. Nothing changes until the person acts; "Not now" hides it here.
 */
export function AgentSuggestionCard(props: {
  session: Pick<Session, "id" | "workspaceId"> & { agentId?: string | null | undefined };
  /** The chat's current suggestion (`currentAgentSuggestion`). */
  suggestion: SessionAgentSuggestion | null;
}) {
  const { session, suggestion } = props;
  const navigate = useNavigate();
  const [dismissedId, setDismissedId] = useState<string | null>(null);

  if (!suggestion) return null;
  if (dismissedId === suggestion.id || agentSuggestionDismissed(session.id, suggestion.id)) {
    return null;
  }
  // A chat that already belongs to an agent no longer needs to be offered one.
  if (sessionAgentRef(session)) return null;

  const create = suggestion.kind === "create";
  const avatar = agentAvatar({
    id: suggestion.agentId ?? suggestion.id,
    name: suggestion.name,
    avatar: suggestion.avatar,
  });
  const dismiss = () => {
    dismissAgentSuggestion(session.id, suggestion.id);
    setDismissedId(suggestion.id);
  };
  // The form dismisses the card once the agent is made, so it stays until then.
  const makeAgent = () =>
    void navigate({
      to: "/workspaces/$workspaceId/agents/new",
      params: { workspaceId: session.workspaceId },
      search: { sourceSessionId: session.id, suggestion: suggestion.id },
    });
  const chatWithAgent = () => {
    if (!suggestion.agentId) return;
    dismiss();
    void navigate({
      to: "/workspaces/$workspaceId/sessions",
      params: { workspaceId: session.workspaceId },
      search: { agent: suggestion.agentId },
    });
  };

  return (
    <section
      aria-label="Agent suggestion"
      data-agent-suggestion=""
      className="relative overflow-hidden rounded-lg border border-border-strong bg-surface p-4"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(420px_120px_at_0%_0%,var(--color-glow-teal),transparent)]"
      />
      <div className="relative flex flex-col gap-3">
        <span className="inline-flex items-center gap-1.5 text-2xs font-medium text-fg-muted">
          <SparkleIcon aria-hidden="true" className="size-3" />
          Suggestion
        </span>
        <div className="flex items-start gap-3">
          <SessionAvatar
            avatar={avatar}
            name={suggestion.name}
            workspaceId={session.workspaceId}
            seed={suggestion.agentId ?? suggestion.id}
            size="lg"
          />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-fg">
              {create
                ? `Make an agent from this chat: ${suggestion.name}`
                : `${suggestion.name} already does this`}
            </p>
            {suggestion.description ? (
              <p className="mt-0.5 text-sm text-fg-muted">{suggestion.description}</p>
            ) : null}
          </div>
        </div>
        {suggestion.reason ? <p className="text-xs text-fg-subtle">{suggestion.reason}</p> : null}
        <div className="flex flex-wrap items-center gap-2">
          {create ? (
            <Button type="button" size="sm" onClick={makeAgent}>
              Make this an agent…
            </Button>
          ) : (
            <Button type="button" size="sm" onClick={chatWithAgent}>
              Chat with {suggestion.name}
            </Button>
          )}
          <Button type="button" size="sm" variant="ghost" onClick={dismiss}>
            Not now
          </Button>
        </div>
      </div>
    </section>
  );
}
