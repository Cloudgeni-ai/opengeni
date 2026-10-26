import type { AgentProfileProposal, Session, SessionEvent } from "@opengeni/sdk";
import { useEffect, useMemo, useState } from "react";

import { userErrorText } from "../../../ui/api-error";
import { useAppAgentProfiles } from "../../lib/agent-profiles";
import { toast } from "../../lib/toast";
import { AgentProposalReview } from "../agent-proposal-review";

/** Whether a tool output carried a proposal receipt, checked once per event object. */
const carriesProposal = new WeakMap<SessionEvent, boolean>();

/** How many proposal tool calls the loaded events contain: a cheap refetch trigger. */
function proposalCallCount(events: readonly SessionEvent[]): number {
  let count = 0;
  for (const event of events) {
    if (event.type !== "agent.toolCall.output") continue;
    let carries = carriesProposal.get(event);
    if (carries === undefined) {
      carries = JSON.stringify(event.payload ?? null).includes("agent_profile_proposal");
      carriesProposal.set(event, carries);
    }
    if (carries) count += 1;
  }
  return count;
}

/**
 * In a chat that wears a saved agent: the update this chat proposed for that
 * agent (`agent_profile_propose_update`), to accept for every later chat or
 * dismiss. Nothing changes until a person accepts.
 */
export function AgentProfileProposalCard(props: {
  session: Session;
  events: readonly SessionEvent[];
}) {
  const { session } = props;
  const profiles = useAppAgentProfiles();
  const profileId = session.agentProfile?.profileId ?? null;
  const profile = profiles.profiles.find((candidate) => candidate.id === profileId) ?? null;
  const trigger = useMemo(() => proposalCallCount(props.events), [props.events]);
  const [proposals, setProposals] = useState<AgentProfileProposal[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!profiles.enabled || !profiles.client || !profileId) return;
    let live = true;
    profiles.client
      .listAgentProfileProposals(session.workspaceId, profileId, { sessionId: session.id })
      .then((response) => {
        if (live) setProposals(response.proposals);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [profiles.enabled, profiles.client, profileId, session.id, session.workspaceId, trigger]);

  const proposal = proposals[0];
  if (!profiles.enabled || !profile || !proposal) return null;

  const decide = async (accept: boolean) => {
    setBusy(true);
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
      setProposals((current) => current.filter((candidate) => candidate.id !== proposal.id));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="Proposed agent update" className="rounded-lg">
      <AgentProposalReview
        profile={profile}
        proposal={proposal}
        busy={busy}
        onAccept={() => void decide(true)}
        onDismiss={() => void decide(false)}
      />
    </section>
  );
}
