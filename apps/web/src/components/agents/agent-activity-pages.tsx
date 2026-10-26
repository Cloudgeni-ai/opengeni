import type { AgentProfile, AgentProfileProposal, AgentProfileSessionSummary } from "@opengeni/sdk";
import { useNavigate } from "@tanstack/react-router";
import { HouseIcon, MessageSquareIcon, MessagesSquareIcon, SparklesIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { AgentProposalReview } from "@opengeni/react/app/components/agent-proposal-review";
import { useAppAgentProfiles } from "@opengeni/react/app/lib/agent-profiles";
import { AgentMark } from "@opengeni/react/ui/agent-mark";
import { userErrorText } from "@opengeni/react/ui/api-error";
import { Button } from "@opengeni/react/ui/button";
import { DetailPage, DetailPageHeader } from "@opengeni/react/ui/detail-page";
import { DropdownMenuItem } from "@opengeni/react/ui/dropdown-menu";
import { EmptyState } from "@opengeni/react/ui/empty-state";
import { FLUSH_DETAIL_PAGE_CLASS } from "@opengeni/react/ui/flush-form-page";
import { ListRow, ListRowSkeleton, RowList } from "@opengeni/react/ui/list-row";
import { MetaChip } from "@opengeni/react/ui/meta-chip";
import { formatRelativeTime } from "@opengeni/react/ui/relative-time";
import { SegmentedControl } from "@opengeni/react/ui/segmented-control";

/* ----------------------------------------------------------------------------
   One saved agent's activity: its chats (with the home chat that @mentions
   are sent to) and the instruction updates its chats proposed. Both are pages
   under the agent's own page, reached from its header.
   -------------------------------------------------------------------------- */

/** The agent from the shared list, or loaded directly when it is archived. */
function useAgentProfile(profileId: string) {
  const profiles = useAppAgentProfiles();
  const cached = profiles.profiles.find((profile) => profile.id === profileId) ?? null;
  const [loaded, setLoaded] = useState<AgentProfile | null>(null);
  const [error, setError] = useState<unknown>(null);
  const { get } = profiles;
  useEffect(() => {
    if (cached) return;
    let live = true;
    get(profileId)
      .then((profile) => {
        if (!live) return;
        if (profile) setLoaded(profile);
        else setError(new Error("This agent could not be loaded."));
      })
      .catch((cause: unknown) => live && setError(cause));
    return () => {
      live = false;
    };
  }, [cached, get, profileId]);
  return { profiles, profile: cached ?? loaded, error };
}

function useAgentSessions(workspaceId: string, profileId: string, revision = 0) {
  const { client } = useAppAgentProfiles();
  const [sessions, setSessions] = useState<AgentProfileSessionSummary[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (!client) return;
    let live = true;
    client
      .listAgentProfileSessions(workspaceId, profileId)
      .then((response) => live && setSessions(response.sessions))
      .catch((cause: unknown) => live && setError(cause));
    return () => {
      live = false;
    };
  }, [client, profileId, revision, workspaceId]);
  return { sessions, error };
}

function AgentPageHeader(props: {
  profile: AgentProfile;
  page: "chats" | "updates";
  workspaceId: string;
}) {
  const navigate = useNavigate();
  const { profile, workspaceId } = props;
  return (
    <DetailPageHeader
      leading={<AgentMark avatar={profile.avatar} size={40} />}
      title={props.page === "chats" ? `${profile.name}'s chats` : `Updates to ${profile.name}`}
      chips={profile.status === "archived" ? <MetaChip>Archived</MetaChip> : null}
      meta={[
        profile.role ? <span key="role">{profile.role}</span> : null,
        <span key="version">Version {profile.version}</span>,
      ]}
      actions={
        profile.status === "active" ? (
          <Button
            variant="outline"
            onClick={() =>
              void navigate({
                to: "/workspaces/$workspaceId/sessions",
                params: { workspaceId },
                search: { agent: profile.id },
              })
            }
          >
            <MessageSquareIcon aria-hidden="true" />
            New chat with {profile.name}
          </Button>
        ) : null
      }
    />
  );
}

function backTo(
  navigate: ReturnType<typeof useNavigate>,
  workspaceId: string,
  profile: AgentProfile | null,
) {
  return {
    label: profile?.name ?? "Agent",
    onClick: () =>
      void navigate({
        to: "/workspaces/$workspaceId/agents/$profileId",
        params: { workspaceId, profileId: profile?.id ?? "" },
      }),
  };
}

/**
 * Every chat that wears the agent, newest first. One of them can be its home
 * chat: the long-running chat that @mentions of the agent are sent to, so the
 * work keeps that chat's context instead of starting over.
 */
export function AgentChatsPage({
  workspaceId,
  profileId,
}: {
  workspaceId: string;
  profileId: string;
}) {
  const navigate = useNavigate();
  const { profiles, profile, error } = useAgentProfile(profileId);
  const [revision, setRevision] = useState(0);
  const { sessions, error: sessionsError } = useAgentSessions(workspaceId, profileId, revision);
  const back = backTo(navigate, workspaceId, profile);

  const setHome = async (sessionId: string | null) => {
    if (!profile) return;
    const updated = await profiles.setHome(profile.id, sessionId);
    if (!updated) {
      toast.error("Couldn't change the home chat", {
        description: profiles.mutationError ? userErrorText(profiles.mutationError) : undefined,
      });
      return;
    }
    toast.success(
      sessionId ? `Mentions of ${profile.name} now go to this chat` : "Home chat cleared",
    );
    setRevision((value) => value + 1);
  };

  const openChat = (sessionId: string) =>
    void navigate({
      to: "/workspaces/$workspaceId/sessions/$sessionId",
      params: { workspaceId, sessionId },
    });

  if (!profile) {
    return (
      <DetailPage back={back} className={FLUSH_DETAIL_PAGE_CLASS}>
        {error ? (
          <EmptyState
            variant="inline"
            title="Couldn't load this agent"
            description={userErrorText(error)}
          />
        ) : (
          <ListRowSkeleton count={3} />
        )}
      </DetailPage>
    );
  }

  const homeId = profile.homeSessionId ?? null;
  const ordered = sessions
    ? [...sessions].sort((left, right) => Number(right.id === homeId) - Number(left.id === homeId))
    : null;

  return (
    <DetailPage back={back} className={FLUSH_DETAIL_PAGE_CLASS}>
      <AgentPageHeader profile={profile} page="chats" workspaceId={workspaceId} />
      <p className="mt-6 mb-4 text-sm text-fg-muted">
        {homeId
          ? `When someone @mentions ${profile.name} in another chat, the request goes to its home chat, which keeps its context.`
          : `Pick a home chat to give ${profile.name} one long-running conversation: @mentions in other chats are sent there instead of starting a new chat.`}
      </p>
      {sessionsError ? (
        <EmptyState
          variant="inline"
          title="Couldn't load the chats"
          description={userErrorText(sessionsError)}
        />
      ) : !ordered ? (
        <ListRowSkeleton count={4} />
      ) : ordered.length === 0 ? (
        <EmptyState
          variant="page"
          icon={<MessagesSquareIcon aria-hidden="true" />}
          title={`No chats with ${profile.name} yet`}
          description="Chats started with this agent, or switched to it, show up here."
        />
      ) : (
        <RowList label={`${profile.name}'s chats`}>
          {ordered.map((session) => {
            const home = session.id === homeId;
            return (
              <ListRow
                key={session.id}
                leading={<AgentMark avatar={profile.avatar} size={32} />}
                title={session.title ?? "Untitled chat"}
                titleAddon={
                  home ? (
                    <MetaChip variant="outline" icon={<HouseIcon aria-hidden="true" />}>
                      Home
                    </MetaChip>
                  ) : undefined
                }
                meta={[
                  session.parentSessionId ? "Handed over from another chat" : null,
                  session.profileVersion ? `v${session.profileVersion}` : null,
                  `updated ${formatRelativeTime(session.updatedAt).toLowerCase()}`,
                ].filter(Boolean)}
                onOpen={() => openChat(session.id)}
                menu={
                  <>
                    <DropdownMenuItem onSelect={() => openChat(session.id)}>Open</DropdownMenuItem>
                    {profile.status === "active" ? (
                      home ? (
                        <DropdownMenuItem onSelect={() => void setHome(null)}>
                          Clear home chat
                        </DropdownMenuItem>
                      ) : (
                        <DropdownMenuItem onSelect={() => void setHome(session.id)}>
                          <HouseIcon aria-hidden="true" />
                          Make home chat
                        </DropdownMenuItem>
                      )
                    ) : null}
                  </>
                }
              />
            );
          })}
        </RowList>
      )}
    </DetailPage>
  );
}

/**
 * Instruction updates the agent's chats proposed after a person corrected it
 * (`agent_profile_propose_update`). Accepting one records a new version for
 * every later chat; nothing changes until someone accepts.
 */
export function AgentUpdatesPage({
  workspaceId,
  profileId,
}: {
  workspaceId: string;
  profileId: string;
}) {
  const navigate = useNavigate();
  const { profiles, profile, error } = useAgentProfile(profileId);
  const { sessions } = useAgentSessions(workspaceId, profileId);
  const [view, setView] = useState<"pending" | "past">("pending");
  const [proposals, setProposals] = useState<AgentProfileProposal[] | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const back = backTo(navigate, workspaceId, profile);
  const { client } = profiles;

  const load = useCallback(async () => {
    if (!client) return;
    try {
      const response = await client.listAgentProfileProposals(workspaceId, profileId, {
        status: "all",
      });
      setProposals(response.proposals);
    } catch (cause) {
      setLoadError(cause);
    }
  }, [client, profileId, workspaceId]);
  useEffect(() => {
    void load();
  }, [load]);

  const titles = useMemo(
    () => new Map((sessions ?? []).map((session) => [session.id, session.title] as const)),
    [sessions],
  );
  const pending = (proposals ?? []).filter((proposal) => proposal.status === "pending");
  const past = (proposals ?? []).filter((proposal) => proposal.status !== "pending");

  const decide = async (proposal: AgentProfileProposal, accept: boolean) => {
    if (!profile) return;
    setBusyId(proposal.id);
    try {
      if (accept) {
        const updated = await profiles.acceptProposal(profile.id, proposal.id, profile.version);
        if (!updated) {
          toast.error(`Couldn't update ${profile.name}`, {
            description: profiles.mutationError
              ? userErrorText(profiles.mutationError)
              : "The agent changed since you opened this. Review it again.",
          });
          await profiles.refresh();
          return;
        }
        toast.success(`${profile.name} updated for every new chat (version ${updated.version})`);
      } else {
        await profiles.dismissProposal(profile.id, proposal.id);
      }
      await load();
    } finally {
      setBusyId(null);
    }
  };

  if (!profile) {
    return (
      <DetailPage back={back} className={FLUSH_DETAIL_PAGE_CLASS}>
        {error ? (
          <EmptyState
            variant="inline"
            title="Couldn't load this agent"
            description={userErrorText(error)}
          />
        ) : (
          <ListRowSkeleton count={3} />
        )}
      </DetailPage>
    );
  }

  return (
    <DetailPage back={back} className={FLUSH_DETAIL_PAGE_CLASS}>
      <AgentPageHeader profile={profile} page="updates" workspaceId={workspaceId} />
      <SegmentedControl
        size="sm"
        aria-label="Show updates"
        className="mt-6 mb-4 self-start"
        value={view}
        onValueChange={setView}
        options={[
          { value: "pending", label: "To review", count: pending.length || undefined },
          { value: "past", label: "Decided" },
        ]}
      />
      {loadError ? (
        <EmptyState
          variant="inline"
          title="Couldn't load the updates"
          description={userErrorText(loadError)}
        />
      ) : !proposals ? (
        <ListRowSkeleton count={2} />
      ) : view === "pending" ? (
        pending.length === 0 ? (
          <EmptyState
            variant="page"
            icon={<SparklesIcon aria-hidden="true" />}
            title="Nothing to review"
            description={`When you correct ${profile.name} in a chat in a way that should last, it proposes the change here so later chats keep the lesson.`}
          />
        ) : (
          <div className="flex flex-col gap-6">
            {pending.map((proposal) => (
              <AgentProposalReview
                key={proposal.id}
                profile={profile}
                proposal={proposal}
                source={titles.get(proposal.sessionId) ?? "one of its chats"}
                busy={busyId === proposal.id || profile.status !== "active"}
                onAccept={() => void decide(proposal, true)}
                onDismiss={() => void decide(proposal, false)}
              />
            ))}
          </div>
        )
      ) : past.length === 0 ? (
        <EmptyState variant="inline" title="No decided updates yet" />
      ) : (
        <RowList label="Decided updates">
          {past.map((proposal) => (
            <ListRow
              key={proposal.id}
              title={proposal.reason}
              meta={[
                proposal.status === "accepted"
                  ? `Accepted as version ${proposal.acceptedVersion ?? "?"}`
                  : proposal.decidedBy === "superseded"
                    ? "Replaced by a newer proposal"
                    : "Dismissed",
                titles.get(proposal.sessionId) ? `from ${titles.get(proposal.sessionId)}` : null,
                proposal.decidedAt ? formatRelativeTime(proposal.decidedAt).toLowerCase() : null,
              ].filter(Boolean)}
              onOpen={() =>
                void navigate({
                  to: "/workspaces/$workspaceId/sessions/$sessionId",
                  params: { workspaceId, sessionId: proposal.sessionId },
                })
              }
            />
          ))}
        </RowList>
      )}
    </DetailPage>
  );
}
