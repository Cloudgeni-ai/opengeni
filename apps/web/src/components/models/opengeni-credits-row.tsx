import { useNavigate } from "@tanstack/react-router";

import { ListRow } from "@opengeni/react/ui/list-row";
import { OpenGeniCreditsTile } from "@opengeni/react/app/components/models/provider-mark";
import { currentPageReturnTo, returnToSearch } from "@opengeni/react/app/lib/return-to";
import type { OpenGeniCredits } from "@/lib/opengeni-credits";

/* ----------------------------------------------------------------------------
   Opengeni credits in Settings > Models: on a deployment that bills credits,
   the organization's credit balance pays for credit models, so it is the
   first row of the Accounts list. Billing admins open organization Billing
   from it; everyone else sees a plain row. The balance itself comes from
   useOpenGeniCredits in lib/opengeni-credits.
   -------------------------------------------------------------------------- */

export function OpenGeniCreditsRow({
  credits,
  workspaceId,
  workspaceName,
  scope,
}: {
  credits: OpenGeniCredits;
  workspaceId: string;
  workspaceName: string;
  /** "Everyone in Acme": credits belong to the whole organization. */
  scope?: string | undefined;
}) {
  const navigate = useNavigate();
  if (!credits.visible) return null;
  const openBilling = () =>
    void navigate({
      to: "/workspaces/$workspaceId/organization",
      params: { workspaceId },
      search: {
        section: "billing",
        ...returnToSearch(currentPageReturnTo(`${workspaceName} · Models`)),
      },
    });
  return (
    <ListRow
      leading={<OpenGeniCreditsTile />}
      title="Opengeni credits"
      meta={[scope, "Pay as you go", credits.balanceLabel]}
      {...(credits.canOpenBilling ? { onOpen: openBilling, indicator: "open" as const } : {})}
    />
  );
}
