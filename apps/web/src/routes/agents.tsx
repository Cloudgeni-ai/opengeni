// Agents: the list, one agent, and the new and edit forms. The pages live in
// the shared app package; this route owns the scroll frame and the Slack part
// of an agent's page, which needs the Slack integration's own pieces.
import { useAppContext } from "@opengeni/react/app/app-context";
import { AgentPage } from "@opengeni/react/app/components/agents/agent-page";
import { AgentsPage } from "@opengeni/react/app/components/agents/agents-page";
import { EditAgentPage, NewAgentPage } from "@opengeni/react/app/components/agents/agent-form-page";
import { useAgent } from "@opengeni/react/app/lib/agents";
import { isPersonalWorkspace } from "@opengeni/react/app/lib/managed-self-context";
import { useNavigate } from "@opengeni/react/app/lib/navigation";
import { apiErrorDetails, userErrorText } from "@opengeni/react/ui/api-error";
import { Button } from "@opengeni/react/ui/button";
import { ContentPage } from "@opengeni/react/ui/content-layout";
import { DetailPage } from "@opengeni/react/ui/detail-page";
import { DetailSkeleton } from "@opengeni/react/ui/detail-sheet";
import { ErrorMessage } from "@opengeni/react/ui/error-message";

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
  const navigate = useNavigate();
  const workspace = workspaces.find((row) => row.id === workspaceId) ?? null;
  // A personal workspace's agents stay in the app.
  const slackPossible = workspace === null || !isPersonalWorkspace(workspace, managedSelfContext);
  return (
    <ContentPage width="standard" className={PAGE_FRAME}>
      <AgentPage
        key={agentId}
        workspaceId={workspaceId}
        agentId={agentId}
        renderSlack={
          slackPossible
            ? ({ agent, onAgentChange }) => (
                <AgentSlackSection
                  agent={agent}
                  onAgentChange={onAgentChange}
                  onIntroduce={(connectionId) =>
                    void navigate({
                      to: "/workspaces/$workspaceId/agents/$agentId/introduce/$connectionId",
                      params: { workspaceId, agentId: agent.id, connectionId },
                    })
                  }
                />
              )
            : undefined
        }
      />
    </ContentPage>
  );
}

/** Introduce an agent in Slack channels: its own URL, so Back returns to the agent. */
export function AgentSlackIntroRoute({
  workspaceId,
  agentId,
  connectionId,
}: {
  workspaceId: string;
  agentId: string;
  connectionId: string;
}) {
  const navigate = useNavigate();
  const state = useAgent(workspaceId, agentId);
  const close = () =>
    void navigate({
      to: "/workspaces/$workspaceId/agents/$agentId",
      params: { workspaceId, agentId },
    });
  const agent = state.agent;
  return (
    <ContentPage width="standard" className={PAGE_FRAME}>
      {agent ? (
        <AgentSlackIntroPage
          key={`${agent.id}:${connectionId}`}
          agent={agent}
          connectionId={connectionId}
          onClose={close}
        />
      ) : (
        <DetailPage back={{ label: "Agent", onClick: close }}>
          {agent === undefined ? (
            <DetailSkeleton sections={2} />
          ) : (
            <ErrorMessage
              title="This agent isn't available"
              {...(state.error ? apiErrorDetails(state.error) : {})}
              action={
                state.error ? (
                  <Button type="button" variant="outline" size="sm" onClick={state.reload}>
                    Try again
                  </Button>
                ) : undefined
              }
            >
              {state.error ? userErrorText(state.error) : "It was deleted, or you can't use it."}
            </ErrorMessage>
          )}
        </DetailPage>
      )}
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
