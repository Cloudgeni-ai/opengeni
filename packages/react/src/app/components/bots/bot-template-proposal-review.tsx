import type { BotTemplateProposal, WorkspaceBotTemplate } from "@opengeni/sdk";

import { Button } from "../../../ui/button";
import { DiffView } from "../../../ui/diff-view";

/**
 * One proposed setup-instructions update for a bot template: what changed in
 * the bot's setup (the reason), the change against the template's current
 * setup instructions, and the decision. Someone who may change the template
 * accepts or dismisses it; anyone else sees who can.
 */
export function BotTemplateProposalReview(props: {
  template: WorkspaceBotTemplate;
  proposal: BotTemplateProposal;
  /** Where it came from, e.g. the chat's name. */
  source?: string | null | undefined;
  busy?: boolean | undefined;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  const { template, proposal } = props;
  const canDecide = template.viewerAccess === "manage";
  const stale = Date.parse(proposal.baseUpdatedAt) !== Date.parse(template.updatedAt);
  return (
    <div className="flex flex-col gap-2" data-bot-template-proposal={proposal.id}>
      <DiffView
        before={template.setupInstructions}
        after={proposal.setupInstructions}
        variant="inline"
        size="sm"
        label={`Proposed update to the ${template.name} template's setup instructions`}
        title={`Update the ${template.name} template`}
        meta={[proposal.reason, props.source ? `From ${props.source}` : null]
          .filter(Boolean)
          .join(" · ")}
        actions={
          canDecide ? (
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
          ) : undefined
        }
      />
      {!canDecide ? (
        <p className="text-xs text-fg-subtle">
          Whoever saved this template, or a workspace admin, can accept it.
        </p>
      ) : null}
      {stale ? (
        <p className="text-xs text-status-waiting">
          The template changed after this was proposed. The diff shows the change against its
          current setup instructions.
        </p>
      ) : null}
    </div>
  );
}
