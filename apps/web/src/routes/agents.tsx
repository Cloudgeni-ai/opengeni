// Agents: the list, one agent, and the new and edit forms. The pages live in
// the shared app package; this route owns the scroll frame and the Slack part
// of an agent's page, which needs the Slack integration's own pieces.
import { useState } from "react";
import type { Agent } from "@opengeni/sdk";
import { useAppContext } from "@opengeni/react/app/app-context";
import { AgentPage } from "@opengeni/react/app/components/agents/agent-page";
import { AgentsPage } from "@opengeni/react/app/components/agents/agents-page";
import { EditAgentPage, NewAgentPage } from "@opengeni/react/app/components/agents/agent-form-page";
import { isPersonalWorkspace } from "@opengeni/react/app/lib/managed-self-context";
import { ContentPage } from "@opengeni/react/ui/content-layout";

import { AgentSlackIntroPage } from "@/components/agents/agent-slack-intro-page";
import { AgentSlackSection } from "@/components/agents/agent-slack-section";

/** Detail pages draw their own 960px frame, back link and padding. */
const PAGE_FRAME = "max-w-none px-0 py-0 pb-0 sm:px-0 lg:px-0";

export function AgentsRoute({ workspaceId }: { workspaceId: string }) {
  return (
    <ContentPage width="standard" className={PAGE_FRAME}>
      <AgentsPage workspaceId={workspaceId} />
    </ContentPage>
  );
}

export function AgentRoute({ workspaceId, agentId }: { workspaceId: string; agentId: string }) {
  const { workspaces, managedSelfContext } = useAppContext();
  const [intro, setIntro] = useState<{ agent: Agent; connectionId: string } | null>(null);
  const workspace = workspaces.find((row) => row.id === workspaceId) ?? null;
  // A personal workspace's agents stay in the app.
  const slackPossible = workspace === null || !isPersonalWorkspace(workspace, managedSelfContext);
  if (intro) {
    return (
      <ContentPage width="standard" className={PAGE_FRAME}>
        <AgentSlackIntroPage
          key={`${intro.agent.id}:${intro.connectionId}`}
          agent={intro.agent}
          connectionId={intro.connectionId}
          onClose={() => setIntro(null)}
        />
      </ContentPage>
    );
  }
  return (
    <ContentPage width="standard" className={PAGE_FRAME}>
      <AgentPage
        key={agentId}
        workspaceId={workspaceId}
        agentId={agentId}
        slack={
          slackPossible
            ? ({ agent, onAgentChange }) => (
                <AgentSlackSection
                  agent={agent}
                  onAgentChange={onAgentChange}
                  onIntroduce={(connectionId) => setIntro({ agent, connectionId })}
                />
              )
            : undefined
        }
      />
    </ContentPage>
  );
}

export function NewAgentRoute({
  workspaceId,
  sourceSessionId,
}: {
  workspaceId: string;
  sourceSessionId?: string | undefined;
}) {
  return (
    <ContentPage width="standard" className={PAGE_FRAME}>
      <NewAgentPage
        key={sourceSessionId ?? "new"}
        workspaceId={workspaceId}
        sourceSessionId={sourceSessionId}
      />
    </ContentPage>
  );
}

export function EditAgentRoute({ workspaceId, agentId }: { workspaceId: string; agentId: string }) {
  return (
    <ContentPage width="standard" className={PAGE_FRAME}>
      <EditAgentPage key={agentId} workspaceId={workspaceId} agentId={agentId} />
    </ContentPage>
  );
}
