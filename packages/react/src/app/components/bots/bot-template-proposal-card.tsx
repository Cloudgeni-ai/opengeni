import type {
  BotTemplateProposal,
  Session,
  SessionEvent,
  WorkspaceBotTemplate,
} from "@opengeni/sdk";
import { useEffect, useMemo, useState } from "react";

import { userErrorText } from "../../../ui/api-error";
import { useAppContext } from "../../app-context";
import { botTemplateProposalReceiptCount } from "../../lib/bot-template-proposals";
import { toast } from "../../lib/toast";
import { BotTemplateProposalReview } from "./bot-template-proposal-review";

/**
 * In a bot chat: the setup-instructions update it proposed for its template
 * (`bot_template_propose_update`), to accept for every new bot or dismiss.
 * Nothing changes until someone who may change the template accepts.
 */
export function BotTemplateProposalCard(props: {
  session: Session;
  events: readonly SessionEvent[];
}) {
  const { session } = props;
  const { client } = useAppContext();
  const trigger = useMemo(() => botTemplateProposalReceiptCount(props.events), [props.events]);
  const [state, setState] = useState<{
    proposal: BotTemplateProposal;
    template: WorkspaceBotTemplate;
  } | null>(null);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const [proposal] = await client.listBotTemplateProposals(session.workspaceId, {
          sessionId: session.id,
        });
        if (!proposal) {
          if (live) setState(null);
          return;
        }
        const template = await client.getBotTemplate(session.workspaceId, proposal.templateId);
        if (live) setState({ proposal, template });
      } catch {
        // A server without bot template proposals, or a deleted template: no card.
      }
    })();
    return () => {
      live = false;
    };
  }, [client, revision, session.id, session.workspaceId, trigger]);

  if (!state) return null;
  const { proposal, template } = state;

  const decide = async (accept: boolean) => {
    setBusy(true);
    try {
      if (accept) {
        const accepted = await client.acceptBotTemplateProposal(session.workspaceId, proposal.id, {
          expectedUpdatedAt: template.updatedAt,
        });
        toast.success(`Updated the ${accepted.template.name} template`, {
          description: "New bots started from it get this setup.",
        });
      } else {
        await client.dismissBotTemplateProposal(session.workspaceId, proposal.id);
      }
    } catch (error) {
      toast.error(`Couldn't update the ${template.name} template`, {
        description: userErrorText(error),
      });
    } finally {
      setBusy(false);
      setRevision((value) => value + 1);
    }
  };

  return (
    <section aria-label="Proposed bot template update" className="rounded-lg">
      <BotTemplateProposalReview
        template={template}
        proposal={proposal}
        busy={busy}
        onAccept={() => void decide(true)}
        onDismiss={() => void decide(false)}
      />
    </section>
  );
}
