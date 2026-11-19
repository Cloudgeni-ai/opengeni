// Console > Agents > one agent: Settings (the editor), Test, Versions and
// Sessions. The header's one primary is Publish while a draft waits; Export
// as YAML, who manages it and Archive are in the ⋯ menu. A code-managed agent
// opens read-only; an organization owner can move it to Console.
import type { OrgAgent, OrgAgentPublishOperation } from "@opengeni/contracts";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { BotIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { useAppContext } from "@opengeni/react/app/app-context";
import { DestructiveConfirm } from "@opengeni/react/app/components/ui/destructive-confirm";
import { userErrorText } from "@opengeni/react/ui/api-error";
import { Button } from "@opengeni/react/ui/button";
import { ConfirmDialog } from "@opengeni/react/ui/confirm-dialog";
import { DetailPage, DetailPageHeader } from "@opengeni/react/ui/detail-page";
import { DropdownMenuItem, DropdownMenuSeparator } from "@opengeni/react/ui/dropdown-menu";
import { LineTabsLink, LineTabsNav } from "@opengeni/react/ui/line-tabs";
import { LogoTile } from "@opengeni/react/ui/logo-tile";
import { MetaChip } from "@opengeni/react/ui/meta-chip";
import { Notice } from "@opengeni/react/ui/notice";
import { MoreMenu } from "@opengeni/react/ui/page-actions";
import { RelativeTime } from "@opengeni/react/ui/relative-time";
import { Skeleton } from "@opengeni/react/ui/skeleton";
import { Switch } from "@opengeni/react/ui/switch";

import type { ConsoleAgentSearch, ConsoleAgentTab } from "@/lib/console-route";
import { downloadOrgAgentYaml } from "@/lib/organization-agents";
import { AgentEditor, initialDefinition } from "./agent-editor";
import { AgentSessions } from "./agent-sessions";
import { AgentTestChat } from "./agent-test-chat";
import { AgentVersions, PublishDialog, usePublishOperation } from "./agent-versions";
import {
  ConsoleLoadError,
  useConsole,
  useConsoleQuery,
  useOrgAgentsApi,
  useOrgAgentsEnabled,
} from "./console-shared";

const TABS: { id: ConsoleAgentTab; label: string }[] = [
  { id: "settings", label: "Settings" },
  { id: "test", label: "Test" },
  { id: "versions", label: "Versions" },
  { id: "sessions", label: "Sessions" },
];

export const MANAGED_BY_CODE = "Managed by code";

/** Whether the signed-in person owns this organization (who manages an agent is owner-only). */
export function useIsOrganizationOwner(): boolean {
  const { accessContext } = useAppContext();
  const { organizationId } = useConsole();
  return accessContext.accountGrants.some(
    (grant) =>
      grant.accountId === organizationId &&
      grant.subjectId === accessContext.subjectId &&
      grant.role === "owner",
  );
}

export function ConsoleAgentRoute() {
  const enabled = useOrgAgentsEnabled();
  const { search } = useConsole();
  const navigate = useNavigate();
  const { agentId = "" } = useParams({ strict: false }) as { agentId?: string };
  const query = useSearch({ strict: false }) as ConsoleAgentSearch;
  const tab = query.tab ?? "settings";
  const api = useOrgAgentsApi();
  const owner = useIsOrganizationOwner();
  const loaded = useConsoleQuery((signal) => api.getAgent(agentId, signal), [api, agentId]);
  const toolServers = useConsoleQuery((signal) => api.listToolServers(signal), [api]);
  const [agent, setAgent] = useState<OrgAgent | null>(null);
  useEffect(() => {
    if (loaded.data) setAgent(loaded.data);
  }, [loaded.data]);
  const [dirty, setDirty] = useState(false);
  const [publishing, setPublishing] = useState<number | null>(null);
  const [startedOperation, setStartedOperation] = useState<OrgAgentPublishOperation | null>(null);
  const operation = usePublishOperation(api, agentId, startedOperation);
  const [management, setManagement] = useState<"console" | "code" | null>(null);
  const [archiving, setArchiving] = useState(false);

  const go = useCallback(
    (next: ConsoleAgentSearch) =>
      void navigate({
        to: "/console/agents/$agentId",
        params: { agentId },
        search: { ...search, ...next },
      }),
    [agentId, navigate, search],
  );
  const back = {
    label: "Agents",
    onClick: () => void navigate({ to: "/console/agents", search }),
  };

  if (!enabled) {
    return (
      <DetailPage back={back} className="px-0 pt-0 max-sm:px-0">
        <Notice>Console agents aren't on for this organization.</Notice>
      </DetailPage>
    );
  }
  if (loaded.error && !agent) {
    return (
      <DetailPage back={back} className="px-0 pt-0 max-sm:px-0">
        <ConsoleLoadError error={loaded.error} onRetry={loaded.reload} />
      </DetailPage>
    );
  }
  if (!agent) {
    return (
      <DetailPage back={back} className="px-0 pt-0 max-sm:px-0">
        <div className="flex flex-col gap-3" aria-busy="true">
          <Skeleton className="h-7 w-72" />
          <Skeleton className="h-4 w-56" />
          <Skeleton className="mt-6 h-[420px] w-full rounded-lg" />
        </div>
      </DetailPage>
    );
  }

  const code = agent.managedBy === "code";
  const draftWaiting =
    agent.publishedVersion === null || agent.latestVersion > agent.publishedVersion;

  return (
    <DetailPage back={back} className="px-0 pt-0 max-sm:px-0">
      <DetailPageHeader
        leading={<LogoTile name={agent.name} icon={<BotIcon />} />}
        title={agent.name}
        chips={
          <>
            {code ? <MetaChip variant="soft">{MANAGED_BY_CODE}</MetaChip> : null}
            {draftWaiting ? <MetaChip variant="outline">Draft v{agent.latestVersion}</MetaChip> : null}
          </>
        }
        meta={[
          <span key="key" translate="no" className="font-mono">
            {agent.key}
          </span>,
          agent.publishedVersion === null ? "Not published" : `Published v${agent.publishedVersion}`,
          <RelativeTime key="updated" date={agent.updatedAt} prefix="Updated" />,
        ]}
        actions={
          <>
            {!code && draftWaiting ? (
              <Button size="sm" disabled={dirty} onClick={() => setPublishing(agent.latestVersion)}>
                Publish v{agent.latestVersion}
              </Button>
            ) : null}
            <MoreMenu label="More actions">
              <DropdownMenuItem
                onSelect={() => downloadOrgAgentYaml(agent.key, initialDefinition(agent))}
              >
                Export as YAML
              </DropdownMenuItem>
              {owner && !code ? (
                <DropdownMenuItem onSelect={() => setManagement("code")}>
                  Manage by code
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => setArchiving(true)}>
                Archive
              </DropdownMenuItem>
            </MoreMenu>
          </>
        }
        tabs={
          <LineTabsNav aria-label="Agent">
            {TABS.map((entry) => (
              <LineTabsLink key={entry.id} asChild active={tab === entry.id}>
                <Link
                  to="/console/agents/$agentId"
                  params={{ agentId }}
                  search={{ ...search, tab: entry.id }}
                >
                  {entry.label}
                </Link>
              </LineTabsLink>
            ))}
          </LineTabsNav>
        }
      />

      {code ? (
        <Notice
          className="mt-6"
          title={MANAGED_BY_CODE}
          action={
            owner ? (
              <label className="flex items-center gap-2 text-sm text-fg">
                Manage in Console
                <Switch checked={false} onCheckedChange={() => setManagement("console")} />
              </label>
            ) : undefined
          }
        >
          Deploys from your repository change it. Here it's read-only.
        </Notice>
      ) : null}

      {tab === "settings" ? (
        <AgentEditor
          agent={agent}
          api={api}
          toolServers={toolServers.data?.toolServers ?? null}
          onSaved={setAgent}
          onDirtyChange={setDirty}
        />
      ) : tab === "test" ? (
        <AgentTestChat
          agent={agent}
          api={api}
          toolServers={toolServers.data?.toolServers ?? null}
          unsaved={dirty}
        />
      ) : tab === "versions" ? (
        <AgentVersions
          agent={agent}
          api={api}
          from={query.from}
          to={query.to}
          onCompare={(from, to) => go({ tab: "versions", from, to })}
          onPublish={setPublishing}
          operation={operation}
        />
      ) : (
        <AgentSessions
          agent={agent}
          api={api}
          selected={query.session}
          onSelect={(session) => go({ tab: "sessions", ...(session ? { session } : {}) })}
        />
      )}

      <PublishDialog
        agent={agent}
        api={api}
        version={publishing}
        onOpenChange={(open) => {
          if (!open) setPublishing(null);
        }}
        onPublished={(next, started) => {
          setAgent(next);
          setStartedOperation(started);
          setPublishing(null);
        }}
      />
      <ConfirmDialog
        open={management !== null}
        onOpenChange={(open) => {
          if (!open) setManagement(null);
        }}
        destructive={false}
        title={management === "console" ? "Manage this agent in Console?" : "Manage this agent by code?"}
        description={
          management === "console"
            ? "You can then edit and publish it here. Code deploys of this agent are refused until an owner switches it back."
            : "It becomes read-only here. Export it as YAML first, then deploy it from your repository."
        }
        confirmLabel={management === "console" ? "Manage in Console" : "Manage by code"}
        pendingLabel="Switching…"
        onConfirm={async () => {
          if (!management) return;
          try {
            const next = await api.setManagement(agent.id, {
              managedBy: management,
              expectedVersion: agent.rowVersion,
            });
            setAgent(next);
            toast.success(
              management === "console" ? "Managed in Console" : `${MANAGED_BY_CODE} now`,
            );
          } catch (error) {
            toast.error("Couldn't switch who manages it", { description: userErrorText(error) });
            return false;
          }
        }}
      />
      <DestructiveConfirm
        open={archiving}
        onOpenChange={setArchiving}
        title={`Archive ${agent.name}?`}
        consequences={[`New chats can't start with ${agent.key}.`]}
        confirmLabel="Archive agent"
        pendingLabel="Archiving…"
        onConfirm={async () => {
          try {
            await api.archiveAgent(agent.id, agent.rowVersion);
          } catch (error) {
            throw new Error(`Couldn't archive ${agent.name}. ${userErrorText(error)}`, {
              cause: error,
            });
          }
          toast.success(`Archived ${agent.name}`);
          void navigate({ to: "/console/agents", search });
        }}
      />
    </DetailPage>
  );
}
