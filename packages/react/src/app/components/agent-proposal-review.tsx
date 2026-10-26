import type { AgentProfile, AgentProfileProposal } from "@opengeni/sdk";

import { AgentMark } from "../../ui/agent-mark";
import { Button } from "../../ui/button";
import { DiffView } from "../../ui/diff-view";

/**
 * One proposed instruction update for a saved agent: what the chat learned
 * (the reason), the change against the agent's current instructions, and the
 * decision. Accepting records a new version for every later chat; the person
 * reviews against the current version, so a proposal written against an older
 * one says so instead of silently overwriting what changed since.
 */
export function AgentProposalReview(props: {
  profile: AgentProfile;
  proposal: AgentProfileProposal;
  /** Where it came from, e.g. the chat title. */
  source?: string | null | undefined;
  busy?: boolean | undefined;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  const { profile, proposal } = props;
  const current = profile.config.agent?.instructions ?? "";
  const stale = proposal.baseVersion !== profile.version;
  return (
    <div className="flex flex-col gap-2" data-agent-profile-proposal={proposal.id}>
      <DiffView
        before={current}
        after={proposal.instructions}
        variant="inline"
        size="sm"
        label={`Proposed update to ${profile.name}'s instructions`}
        title={
          <span className="inline-flex items-center gap-2">
            <AgentMark avatar={profile.avatar} size={18} />
            Update {profile.name} for every chat
          </span>
        }
        meta={[proposal.reason, props.source ? `From ${props.source}` : null]
          .filter(Boolean)
          .join(" · ")}
        actions={
          <span className="inline-flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={props.busy}
              onClick={props.onDismiss}
            >
              Dismiss
            </Button>
            <Button type="button" size="sm" disabled={props.busy} onClick={props.onAccept}>
              Accept
            </Button>
          </span>
        }
      />
      {stale ? (
        <p className="text-xs text-status-waiting">
          Written against version {proposal.baseVersion}; {profile.name} is now on version{" "}
          {profile.version}. The diff shows the change against the current instructions.
        </p>
      ) : null}
    </div>
  );
}
