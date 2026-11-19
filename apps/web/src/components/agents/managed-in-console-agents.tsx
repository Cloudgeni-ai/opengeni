// The app's read-only view of organization agents: the ones available in
// this workspace, under the workspace's own agents. They are edited only in
// Console, so nothing here changes them; admins get one way to Console.
import type { WorkspaceOrgAgent } from "@opengeni/contracts";
import { Link } from "@tanstack/react-router";
import { ArrowUpRightIcon, BotIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useAppContext } from "@opengeni/react/app/app-context";
import { administersOrganization } from "@opengeni/react/app/lib/workspaces";
import { Button } from "@opengeni/react/ui/button";
import { DetailSection } from "@opengeni/react/ui/detail-sheet";
import { ListRow, RowList } from "@opengeni/react/ui/list-row";
import { LogoTile } from "@opengeni/react/ui/logo-tile";
import { MetaChip } from "@opengeni/react/ui/meta-chip";

import { listWorkspaceOrgAgents } from "@/lib/organization-agents";

export const MANAGED_IN_CONSOLE = "Managed in Console";

export function ManagedInConsoleAgents({ workspaceId }: { workspaceId: string }) {
  const { client, clientConfig, accessContext, workspaces } = useAppContext();
  const accountId = workspaces.find((workspace) => workspace.id === workspaceId)?.accountId ?? null;
  const [agents, setAgents] = useState<WorkspaceOrgAgent[]>([]);
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
            titleAddon={<MetaChip variant="soft">{MANAGED_IN_CONSOLE}</MetaChip>}
            description={agent.description || undefined}
          />
        ))}
      </RowList>
    </DetailSection>
  );
}
