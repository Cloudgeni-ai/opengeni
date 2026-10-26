import type { AgentProfile } from "@opengeni/sdk";
import { useNavigate } from "@tanstack/react-router";
import { PlusIcon, UsersIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useAppContext } from "@opengeni/react/app/app-context";
import {
  agentProfilesClientFor,
  useAppAgentProfiles,
} from "@opengeni/react/app/lib/agent-profiles";
import { AgentMark } from "@opengeni/react/ui/agent-mark";
import { Button } from "@opengeni/react/ui/button";
import { DropdownMenuItem } from "@opengeni/react/ui/dropdown-menu";
import { EmptyState } from "@opengeni/react/ui/empty-state";
import { ListRow, ListRowSkeleton, RowList } from "@opengeni/react/ui/list-row";
import { PageHeader } from "@opengeni/react/ui/page-header";
import { SegmentedControl } from "@opengeni/react/ui/segmented-control";

/**
 * Agents: the workspace's saved, reusable agents. One flat list; each row
 * opens the agent's own page. Archived agents stay one click away.
 */
export function AgentsListPage({ workspaceId }: { workspaceId: string }) {
  const navigate = useNavigate();
  const profiles = useAppAgentProfiles();
  const [view, setView] = useState<"active" | "archived">("active");
  const [archivedRevision, setArchivedRevision] = useState(0);
  const archived = useArchivedAgentProfiles(
    workspaceId,
    view === "archived" && profiles.enabled,
    archivedRevision,
  );
  const list = view === "active" ? profiles.profiles : archived;

  const open = (profile: AgentProfile) =>
    void navigate({
      to: "/workspaces/$workspaceId/agents/$profileId",
      params: { workspaceId, profileId: profile.id },
    });
  const openSubpage = (profile: AgentProfile, page: "chats" | "updates") =>
    void navigate({
      to: `/workspaces/$workspaceId/agents/$profileId/${page}`,
      params: { workspaceId, profileId: profile.id },
    });
  const startChat = (profile: AgentProfile) =>
    void navigate({
      to: "/workspaces/$workspaceId/sessions",
      params: { workspaceId },
      search: { agent: profile.id },
    });

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader
        title="Agents"
        icon={<UsersIcon aria-hidden="true" className="size-4" />}
        description="Reusable agents with their own name, instructions and settings."
        actions={
          <Button
            onClick={() =>
              void navigate({ to: "/workspaces/$workspaceId/agents/new", params: { workspaceId } })
            }
          >
            <PlusIcon aria-hidden="true" />
            New agent
          </Button>
        }
      />
      <SegmentedControl
        size="sm"
        aria-label="Show agents"
        className="self-start"
        value={view}
        onValueChange={setView}
        options={[
          { value: "active", label: "Active", count: profiles.profiles.length || undefined },
          { value: "archived", label: "Archived" },
        ]}
      />
      {profiles.loading ? (
        <ListRowSkeleton count={3} />
      ) : list.length === 0 ? (
        view === "active" ? (
          <EmptyState
            variant="page"
            icon={<UsersIcon aria-hidden="true" />}
            title="No agents yet"
            description="Save a chat that went well as an agent, or make one from scratch. Anyone in this workspace can then start a chat with it."
            action={
              <Button
                onClick={() =>
                  void navigate({
                    to: "/workspaces/$workspaceId/agents/new",
                    params: { workspaceId },
                  })
                }
              >
                <PlusIcon aria-hidden="true" />
                New agent
              </Button>
            }
          />
        ) : (
          <EmptyState variant="inline" title="No archived agents" />
        )
      ) : (
        <RowList label={view === "active" ? "Agents" : "Archived agents"}>
          {list.map((profile) => (
            <ListRow
              key={profile.id}
              leading={<AgentMark avatar={profile.avatar} size={32} />}
              title={profile.name}
              description={profile.role ?? undefined}
              meta={[
                profile.config.model ?? "Workspace default model",
                `v${profile.version}`,
                profile.homeSessionId ? "Home chat set" : null,
              ].filter(Boolean)}
              onOpen={() => open(profile)}
              menu={
                <>
                  {profile.status === "active" ? (
                    <DropdownMenuItem onSelect={() => startChat(profile)}>
                      Start chat
                    </DropdownMenuItem>
                  ) : null}
                  {profile.status === "active" && profile.homeSessionId ? (
                    <DropdownMenuItem
                      onSelect={() =>
                        void navigate({
                          to: "/workspaces/$workspaceId/sessions/$sessionId",
                          params: { workspaceId, sessionId: profile.homeSessionId! },
                        })
                      }
                    >
                      Open home chat
                    </DropdownMenuItem>
                  ) : null}
                  <DropdownMenuItem onSelect={() => open(profile)}>Open</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => openSubpage(profile, "chats")}>
                    Chats
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => openSubpage(profile, "updates")}>
                    Proposed updates
                  </DropdownMenuItem>
                  {profile.status === "active" ? (
                    <DropdownMenuItem onSelect={() => void profiles.archive(profile.id)}>
                      Archive
                    </DropdownMenuItem>
                  ) : (
                    <DropdownMenuItem
                      onSelect={() =>
                        void profiles
                          .restore(profile.id)
                          .then(() => setArchivedRevision((revision) => revision + 1))
                      }
                    >
                      Restore
                    </DropdownMenuItem>
                  )}
                </>
              }
            />
          ))}
        </RowList>
      )}
    </div>
  );
}

/** Archived agents are read only while that view is open. */
function useArchivedAgentProfiles(
  workspaceId: string,
  enabled: boolean,
  revision: number,
): AgentProfile[] {
  const { client } = useAppContext();
  const [items, setItems] = useState<AgentProfile[]>([]);
  useEffect(() => {
    const api = enabled ? agentProfilesClientFor(client) : null;
    if (!api) return;
    let live = true;
    api
      .listAgentProfiles(workspaceId, { status: "archived" })
      .then((response) => {
        if (live) setItems(response.profiles);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [client, enabled, revision, workspaceId]);
  return items;
}
