import type { Session, SessionEvent } from "@opengeni/sdk";
import { SparkleIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { AgentMark } from "../../../ui/agent-mark";
import { userErrorText } from "../../../ui/api-error";
import { Button } from "../../../ui/button";
import { useAppContext } from "../../app-context";
import { writeAgentProfileDraftHandoff } from "../../lib/agent-profile-draft";
import {
  agentProfileSuggestionDismissed,
  currentAgentProfileSuggestion,
  dismissAgentProfileSuggestion,
} from "../../lib/agent-profile-suggestions";
import { useAppAgentProfiles } from "../../lib/agent-profiles";
import { useNavigate } from "../../lib/navigation";
import { toast } from "../../lib/toast";

/**
 * The agent's own suggestion (D1): after repeated work it proposes making a
 * reusable agent, with the name, emoji and drafted instructions it chose, or
 * switching to a saved agent that already does it. Nothing is saved until the
 * person accepts; "Not now" hides it for this chat.
 */
export function AgentProfileSuggestionCard(props: {
  session: Session;
  events: readonly SessionEvent[];
}) {
  const { session } = props;
  const context = useAppContext();
  const navigate = useNavigate();
  const profiles = useAppAgentProfiles();
  const suggestion = useMemo(
    () => currentAgentProfileSuggestion(session, props.events),
    [session, props.events],
  );
  const [dismissedEventId, setDismissedEventId] = useState<string | null>(null);

  if (!profiles.enabled || !suggestion) return null;
  if (
    dismissedEventId === suggestion.eventId ||
    agentProfileSuggestionDismissed(session.id, suggestion.eventId)
  )
    return null;
  if (suggestion.kind === "reuse" && session.agentProfile?.profileId === suggestion.profileId)
    return null;
  if (suggestion.kind === "create" && session.agentProfile?.profileId) return null;

  const dismiss = () => {
    dismissAgentProfileSuggestion(session.id, suggestion.eventId);
    setDismissedEventId(suggestion.eventId);
  };

  const review = () => {
    const draft = writeAgentProfileDraftHandoff({
      name: suggestion.name,
      ...(suggestion.role ? { role: suggestion.role } : {}),
      avatar: suggestion.avatar,
      ...(suggestion.instructions ? { instructions: suggestion.instructions } : {}),
    });
    dismiss();
    void navigate({
      to: "/workspaces/$workspaceId/agents/new",
      params: { workspaceId: session.workspaceId },
      search: { fromSession: session.id, draft },
    });
  };

  const switchTo = async () => {
    if (!suggestion.profileId) return;
    const updated = await profiles.applyToSession(
      session.id,
      suggestion.profileId,
      session.toolPolicyVersion ?? 1,
    );
    if (!updated) {
      toast.error(`Couldn't switch to ${suggestion.name}`, {
        description: profiles.mutationError ? userErrorText(profiles.mutationError) : undefined,
      });
      return;
    }
    context.adoptUpdatedSession?.(updated);
    dismiss();
    toast.success(`${suggestion.name} takes over from your next message`);
  };

  const create = suggestion.kind === "create";
  return (
    <section
      aria-label="Agent suggestion"
      data-agent-profile-suggestion=""
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
          <AgentMark avatar={suggestion.avatar} size={40} />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-fg">
              {create
                ? `Make this an agent: ${suggestion.name}`
                : `${suggestion.name} already does this`}
            </p>
            {suggestion.role ? (
              <p className="mt-0.5 text-sm text-fg-muted">{suggestion.role}</p>
            ) : null}
          </div>
        </div>
        {suggestion.reason ? <p className="text-xs text-fg-subtle">{suggestion.reason}</p> : null}
        <div className="flex flex-wrap items-center gap-2">
          {create ? (
            <Button type="button" size="sm" onClick={review}>
              Review and save
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              disabled={profiles.mutating}
              onClick={() => void switchTo()}
            >
              <AgentMark avatar={suggestion.avatar} size={16} />
              Switch to {suggestion.name}
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
