// An agent's Sessions tab: its chats with the version each runs, and for a
// chat that changed the agent's settings, what it changed (the agent's value
// beside the chat's), with a link to the session's Console page.
import type { OrgAgent, OrgAgentSessionEntry } from "@opengeni/contracts";
import { Link } from "@tanstack/react-router";
import { ArrowLeftIcon, ArrowUpRightIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "@opengeni/react/ui/button";
import { DetailSection } from "@opengeni/react/ui/detail-sheet";
import { DiffView } from "@opengeni/react/ui/diff-view";
import { EmptyState } from "@opengeni/react/ui/empty-state";
import { ListRow, ListRowSkeleton, RowList } from "@opengeni/react/ui/list-row";
import { MetaChip } from "@opengeni/react/ui/meta-chip";
import { RelativeTime } from "@opengeni/react/ui/relative-time";

import { hasOverrides, overrideEntries, type OrgAgentsApi } from "@/lib/organization-agents";
import { ConsoleLoadError, EndUserName, useConsole, useConsoleQuery } from "./console-shared";
import { sessionStatus } from "./sessions";

export const CHANGED_BY_CHAT = "Changed by this chat";

function chatTitle(session: Pick<OrgAgentSessionEntry, "title">): string {
  return session.title?.trim() || "Untitled chat";
}

export function AgentSessions({
  agent,
  api,
  selected,
  onSelect,
}: {
  agent: OrgAgent;
  api: OrgAgentsApi;
  selected: string | undefined;
  onSelect: (sessionId: string | undefined) => void;
}) {
  const [cursor, setCursor] = useState<string | null>(null);
  const [pages, setPages] = useState<OrgAgentSessionEntry[]>([]);
  const page = useConsoleQuery(
    async (signal) => {
      const response = await api.listSessions(agent.id, { cursor, signal });
      setPages((current) => (cursor ? [...current, ...response.sessions] : response.sessions));
      return response;
    },
    [api, agent.id, cursor],
  );
  const rows = pages;
  const open = selected ? rows.find((session) => session.id === selected) : undefined;

  if (selected && open) {
    return <SessionChanges agent={agent} session={open} onBack={() => onSelect(undefined)} />;
  }

  return (
    <DetailSection title="Sessions">
      {page.error && rows.length === 0 ? (
        <ConsoleLoadError error={page.error} onRetry={page.reload} />
      ) : page.loading && rows.length === 0 ? (
        <ListRowSkeleton count={3} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No sessions yet"
          description="Chats your product starts with this agent appear here."
        />
      ) : (
        <div className="flex flex-col gap-4">
          <RowList
            variant="table"
            label="Sessions"
            nameLabel="Session"
            columns={[
              { id: "user", label: "End user", width: 176 },
              { id: "version", label: "Version", width: 80 },
              { id: "status", label: "Status", width: 112 },
              { id: "updated", label: "Updated", width: 112 },
            ]}
          >
            {rows.map((session) => (
              <ListRow
                key={session.id}
                title={chatTitle(session)}
                titleAddon={
                  hasOverrides(session.overrides) ? (
                    <MetaChip variant="soft">{CHANGED_BY_CHAT}</MetaChip>
                  ) : null
                }
                cells={{
                  user: <EndUserName endUser={session.endUser} />,
                  version: `v${session.agentVersion}`,
                  status: sessionStatus(session.status),
                  updated: <RelativeTime date={session.updatedAt} />,
                }}
                onOpen={() => onSelect(session.id)}
              />
            ))}
          </RowList>
          {page.data?.nextCursor ? (
            <div>
              <Button
                variant="outline"
                size="sm"
                disabled={page.loading}
                onClick={() => setCursor(page.data?.nextCursor ?? null)}
              >
                Show more
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </DetailSection>
  );
}

/** One chat: what it changed from its agent version, setting by setting. */
export function SessionChanges({
  agent,
  session,
  onBack,
}: {
  agent: Pick<OrgAgent, "name">;
  session: OrgAgentSessionEntry;
  onBack: () => void;
}) {
  const { search } = useConsole();
  const entries = overrideEntries(session.overrides);
  return (
    <DetailSection
      title={chatTitle(session)}
      description={
        entries.length > 0
          ? `Runs v${session.agentVersion} of ${agent.name}, with the changes below.`
          : `Runs v${session.agentVersion} of ${agent.name} as published.`
      }
      action={
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeftIcon aria-hidden="true" />
            Sessions
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link
              to="/console/sessions/$workspaceId/$sessionId"
              params={{ workspaceId: session.workspaceId, sessionId: session.id }}
              search={search}
            >
              <ArrowUpRightIcon aria-hidden="true" />
              Open session
            </Link>
          </Button>
        </div>
      }
    >
      {entries.length > 0 ? (
        <div className="flex flex-col gap-4">
          <MetaChip variant="soft" className="self-start">
            {CHANGED_BY_CHAT}
          </MetaChip>
          {entries.map((entry) => (
            <DiffView
              key={entry.setting}
              title={entry.label}
              meta="Agent → this chat"
              before={entry.agent}
              after={entry.chat}
              format={entry.setting === "instructions" ? "text" : "code"}
              context={Infinity}
            />
          ))}
        </div>
      ) : null}
    </DetailSection>
  );
}
