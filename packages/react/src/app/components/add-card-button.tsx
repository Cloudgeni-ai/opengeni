import { CreditCardIcon, Loader2Icon } from "lucide-react";
import { useState } from "react";

import { Button } from "../../ui/button";
import { userErrorText } from "../../ui/api-error";
import { startCardVerification, type CardVerificationClient } from "../lib/card-verification";
import { toast } from "../lib/toast";

/** The one action for a missing card: Stripe Checkout in setup mode, no charge. */
export function AddCardButton(props: {
  client: CardVerificationClient | null | undefined;
  accountId: string | null | undefined;
  canManage: boolean;
  variant?: "default" | "outline";
}) {
  const client = props.client;
  const [busy, setBusy] = useState(false);
  if (!client || !props.accountId || !props.canManage) {
    return <span className="text-sm text-fg-muted">Ask the organization owner to add a card.</span>;
  }
  const accountId = props.accountId;
  return (
    <Button
      type="button"
      size="sm"
      variant={props.variant ?? "default"}
      disabled={busy}
      onClick={() => {
        setBusy(true);
        startCardVerification(client, accountId).catch((error: unknown) => {
          setBusy(false);
          toast.error("Couldn't add a card", { description: userErrorText(error) });
        });
      }}
    >
      {busy ? (
        <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
      ) : (
        <CreditCardIcon className="size-4" aria-hidden="true" />
      )}
      Add a card
    </Button>
  );
}
