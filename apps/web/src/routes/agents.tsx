// Agents: the workspace's saved, reusable agents (agent profiles). The list,
// one agent's page (edit, Start chat, archive), New agent, and "Save as agent"
// from a chat (?fromSession). Every page needs the agent profiles flag; with it
// off they send people to the chats.
import { Navigate } from "@tanstack/react-router";

import { AgentFormPage, type AgentFormMode } from "@/components/agents/agent-form-page";
import { AgentsListPage } from "@/components/agents/agents-list-page";
import { useAgentProfilesEnabled } from "@opengeni/react/app/lib/agent-profiles";
import { ContentPage } from "@opengeni/react/ui/content-layout";

/** Form pages draw their own frame, back link and padding. */
const PAGE_FRAME = "max-w-none px-0 py-0 pb-0 sm:px-0 lg:px-0";

function useGate(workspaceId: string) {
  const enabled = useAgentProfilesEnabled();
  return enabled ? null : (
    <Navigate to="/workspaces/$workspaceId/sessions" params={{ workspaceId }} replace />
  );
}

export function AgentsRoute({ workspaceId }: { workspaceId: string }) {
  const gate = useGate(workspaceId);
  if (gate) return gate;
  return (
    <ContentPage width="standard" className="pt-6">
      <AgentsListPage workspaceId={workspaceId} />
    </ContentPage>
  );
}

export function AgentFormRoute({
  workspaceId,
  mode,
}: {
  workspaceId: string;
  mode: AgentFormMode;
}) {
  const gate = useGate(workspaceId);
  if (gate) return gate;
  return (
    <ContentPage width="standard" className={PAGE_FRAME}>
      <AgentFormPage
        key={mode.kind === "edit" ? mode.profileId : (mode.fromSession ?? mode.draftKey ?? "new")}
        workspaceId={workspaceId}
        mode={mode}
      />
    </ContentPage>
  );
}
