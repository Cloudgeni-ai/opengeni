// The app's read-only view of organization agents: the ones available in
// this workspace, under the workspace's own agents. They are edited only in
// Console, so nothing here changes them; admins get one way to Console.
// Anyone who can start chats gets one Chat action per agent.
import type { WorkspaceOrgAgent } from "@opengeni/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowUpRightIcon, BotIcon, MessageSquareIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { useAppContext } from "@opengeni/react/app/app-context";
import { hasWorkspacePermission } from "@opengeni/react/app/lib/permissions";
import { administersOrganization } from "@opengeni/react/app/lib/workspaces";
import { userErrorText } from "@opengeni/react/ui/api-error";
import { Button } from "@opengeni/react/ui/button";
import { DetailSection } from "@opengeni/react/ui/detail-sheet";
import { ListRow, RowList } from "@opengeni/react/ui/list-row";
import { LogoTile } from "@opengeni/react/ui/logo-tile";

import { listWorkspaceOrgAgents } from "@/lib/organization-agents";

export const MANAGED_IN_CONSOLE = "Managed in Console";

export function ManagedInConsoleAgents({ workspaceId }: { workspaceId: string }) {
  const { client, clientConfig, accessContext, workspaces } = useAppContext();
  const accountId = workspaces.find((workspace) => workspace.id === workspaceId)?.accountId ?? null;
  const navigate = useNavigate();
  const [agents, setAgents] = useState<WorkspaceOrgAgent[]>([]);
  const [starting, setStarting] = useState<string | null>(null);
  useEffect(() => {
    setAgents([]);
    const controller = new AbortController();
    listWorkspaceOrgAgents(client, workspaceId, controller.signal).then(
      (response) => {
        if (!controller.signal.aborted) setAgents(response.agents);
      },
      // The server lists none while the organization's flag is off; an older
      // server has no such route. Either way there is nothing to show.
      () => {},
    );
    return () => controller.abort();
  }, [client, workspaceId]);

  if (!accountId || agents.length === 0) return null;
  const admin = administersOrganization({ accessContext, clientConfig, accountId });
  const canChat = hasWorkspacePermission(accessContext, workspaceId, "sessions:create");
  // A chat with the agent's published version, by key, in this workspace.
  const startChat = async (agent: WorkspaceOrgAgent) => {
    if (starting) return;
    setStarting(agent.id);
    try {
      const session = await client.createSession(workspaceId, {
        agent: agent.key,
        idempotencyKey: crypto.randomUUID(),
      });
      await navigate({
        to: "/workspaces/$workspaceId/sessions/$sessionId",
        params: { workspaceId, sessionId: session.id },
      });
    } catch (error) {
      toast.error(userErrorText(error, "Couldn't start the chat. Try again."));
    } finally {
      setStarting(null);
    }
  };

  return (
    <DetailSection
      title={MANAGED_IN_CONSOLE}
      description="Your organization's agents. Only owners and admins change them, in Console."
      action={
        admin ? (
          <Button variant="outline" size="sm" asChild>
            <Link to="/console/agents" search={{ org: accountId }}>
              <ArrowUpRightIcon aria-hidden="true" />
              Open Console
            </Link>
          </Button>
        ) : undefined
      }
    >
      <RowList label={MANAGED_IN_CONSOLE} variant="catalog">
        {agents.map((agent) => (
          <ListRow
            key={agent.id}
            leading={<LogoTile name={agent.name} icon={<BotIcon />} />}
            title={agent.name}
            description={agent.description || undefined}
            control={
              canChat ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={starting !== null}
                  onClick={() => void startChat(agent)}
                  aria-label={`Chat with ${agent.name}`}
                >
                  <MessageSquareIcon aria-hidden="true" />
                  Chat
                </Button>
              ) : undefined
            }
          />
        ))}
      </RowList>
    </DetailSection>
  );
}
